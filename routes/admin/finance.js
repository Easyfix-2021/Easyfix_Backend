const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const { sendXlsx } = require('../../utils/xlsx-export');
const { renderInvoicePdf } = require('../../utils/pdf-invoice');
const archiver = require('archiver');
const { PassThrough } = require('stream');
const { buildRequestScope, assertEntityInScope } = require('../../lib/scope');

/*
 * Row-level scope guard for every invoice `/invoices/:id*` endpoint.
 * Fetches the invoice's client, asserts the caller's manage_clients
 * scope covers it, and attaches the row at `req.scopedInvoice` so
 * downstream handlers can reuse it without a second SELECT.
 * Returns 404 (not 403) on scope failure to avoid leaking ids.
 */
async function scopedInvoice(req, res, next) {
  try {
    const [[inv]] = await pool.query(
      `SELECT id, fk_client_id, total_invoice_amount, total_paid_amount,
              total_tds_deducted, is_paid, is_raised
         FROM tbl_client_invoice WHERE id = ? LIMIT 1`,
      [req.params.id]
    );
    if (!inv) return modernError(res, 404, 'invoice not found');
    const guard = assertEntityInScope(req, { client_id: inv.fk_client_id });
    if (!guard.ok) return modernError(res, 404, 'invoice not found');
    req.scopedInvoice = inv;
    return next();
  } catch (e) { next(e); }
}

/*
 * Easyfixer-side scope guard for /payouts/:id*, /ndm-recharges/:id*,
 * /efr-transactions, and similar. Loads the EFR's city to assert the
 * caller's manage_cities scope covers it. The fetcher accepts the
 * efr_id directly via req.body.efrId (POSTs) or by joining through
 * the parent row (passed via `efrIdResolver`).
 */
async function assertEfrInScope(req, efrId) {
  if (!efrId) return { ok: true }; // dimension absent
  const [[e]] = await pool.query(
    'SELECT efr_cityId FROM tbl_easyfixer WHERE efr_id = ? AND NOT (tbl_easyfixer.efr_status <=> 3) LIMIT 1',
    [efrId]
  );
  if (!e) return { ok: false, reason: 'easyfixer not found' };
  return assertEntityInScope(req, { city_id: e.efr_cityId });
}

// Shared helper: load the invoice + client + flat line items used by
// both /excel and /pdf. Keeps the two endpoints in lock-step.
async function loadInvoiceArtifactData(invoiceId) {
  logger.info('Load invoice artifact data · invoiceId=' + invoiceId);
  const [[inv]] = await pool.query(
    `SELECT id, fk_client_id, invoice_number, invoice_date,
            billing_from_date, billing_to_date, total_invoice_amount,
            total_paid_amount, total_tds_deducted,
            current_due_amount, previous_due_amount,
            invoiced_job_ids, invoice_desc
       FROM tbl_client_invoice WHERE id = ?`,
    [invoiceId]
  );
  if (!inv) return null;

  const [[client]] = await pool.query(
    'SELECT client_id, client_name FROM tbl_client WHERE client_id = ?',
    [inv.fk_client_id]
  );

  let jobs;
  if (inv.invoiced_job_ids && String(inv.invoiced_job_ids).trim()) {
    const ids = String(inv.invoiced_job_ids)
      .split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) {
      jobs = [];
    } else {
      const placeholders = ids.map(() => '?').join(',');
      const [rows] = await pool.query(
        `SELECT j.job_id, j.job_reference_id, j.client_ref_id,
                j.requested_date_time, j.checkout_date_time,
                cu.customer_name, cu.customer_mob_no, ci.city_name
           FROM tbl_job j
           LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
           LEFT JOIN tbl_address  ad ON ad.address_id  = j.fk_address_id
           LEFT JOIN tbl_city     ci ON ci.city_id     = ad.city_id
          WHERE j.job_id IN (${placeholders})
          ORDER BY j.job_id`,
        ids
      );
      jobs = rows;
    }
  } else {
    const [rows] = await pool.query(
      `SELECT j.job_id, j.job_reference_id, j.client_ref_id,
              j.requested_date_time, j.checkout_date_time,
              cu.customer_name, cu.customer_mob_no, ci.city_name
         FROM tbl_job j
         LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
         LEFT JOIN tbl_address  ad ON ad.address_id  = j.fk_address_id
         LEFT JOIN tbl_city     ci ON ci.city_id     = ad.city_id
        WHERE j.fk_client_id = ?
          AND j.job_status IN (3, 5)
          AND j.checkout_date_time BETWEEN ? AND ?
        ORDER BY j.checkout_date_time, j.job_id`,
      [inv.fk_client_id, inv.billing_from_date, inv.billing_to_date]
    );
    jobs = rows;
  }

  const jobIds = jobs.map((j) => j.job_id);
  const servicesByJob = new Map();
  if (jobIds.length > 0) {
    const placeholders = jobIds.map(() => '?').join(',');
    const [svcRows] = await pool.query(
      `SELECT js.job_id, js.quantity, js.total_charge, js.material_charge,
              CR.crc_ratecard_name AS service_name
         FROM tbl_job_services js
         LEFT JOIN tbl_client_service   CS ON CS.client_service_id = js.service_id
         LEFT JOIN tbl_client_rate_card CR ON CR.crc_id = CS.rate_card_id
        WHERE js.job_id IN (${placeholders})
        ORDER BY js.job_id, js.job_service_id`,
      jobIds
    );
    for (const s of svcRows) {
      if (!servicesByJob.has(s.job_id)) servicesByJob.set(s.job_id, []);
      servicesByJob.get(s.job_id).push(s);
    }
  }

  const lines = [];
  for (const j of jobs) {
    const svcs = servicesByJob.get(j.job_id) || [];
    if (svcs.length === 0) {
      lines.push({
        job_id: j.job_id, job_ref: j.job_reference_id, client_ref: j.client_ref_id,
        customer: j.customer_name, mobile: j.customer_mob_no, city: j.city_name,
        completed_on: j.checkout_date_time,
        service: '—', quantity: 0, unit_charge: 0, material: 0, line_total: 0,
      });
    } else {
      for (const s of svcs) {
        const qty = Number(s.quantity || 1);
        const charge = Number(s.total_charge || 0);
        const mat = Number(s.material_charge || 0);
        lines.push({
          job_id: j.job_id, job_ref: j.job_reference_id, client_ref: j.client_ref_id,
          customer: j.customer_name, mobile: j.customer_mob_no, city: j.city_name,
          completed_on: j.checkout_date_time,
          service: s.service_name || '—', quantity: qty,
          unit_charge: charge, material: mat, line_total: charge * qty + mat,
        });
      }
    }
  }

  logger.info('Invoice artifact built · invoiceId=' + invoiceId + ' jobs=' + jobs.length + ' lines=' + lines.length);
  return { inv, client: client || { client_name: '—' }, lines };
}

// ─── Invoices ───────────────────────────────────────────────────────
router.get('/invoices', async (req, res, next) => {
  try {
    const { clientId, isPaid, from, to } = req.query;
    logger.info('List invoices · clientId=' + (clientId ?? 'all') + ' isPaid=' + (isPaid ?? 'all') + ' from=' + (from || '') + ' to=' + (to || ''));
    const clauses = [], params = [];
    // RBAC: limit visible invoices to the caller's manage_clients scope.
    const scope = buildRequestScope(req);
    if (scope?.clients) {
      const c = scope.clients;
      if (c.mode === 'none') clauses.push('1=0');
      else if (c.mode === 'allow' && c.ids.length) {
        clauses.push(`fk_client_id IN (${c.ids.map(() => '?').join(',')})`);
        params.push(...c.ids);
      }
    }
    if (clientId != null) { clauses.push('fk_client_id = ?'); params.push(clientId); }
    if (isPaid === '1' || isPaid === 'true')  clauses.push('is_paid = 1');
    if (isPaid === '0' || isPaid === 'false') clauses.push('is_paid = 0');
    if (from) { clauses.push('billing_from_date >= ?'); params.push(from); }
    if (to)   { clauses.push('billing_to_date   <= ?'); params.push(to); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;
    params.push(limit, offset);
    const [rows] = await pool.query(
      `SELECT id, fk_client_id, billing_from_date, billing_to_date, total_invoice_amount,
              total_paid_amount, is_paid, is_raised, amount_due_date, file_path_pdf
         FROM tbl_client_invoice ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      params);
    logger.info('Found ' + rows.length + ' invoices');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/invoices/:id', scopedInvoice, async (req, res, next) => {
  try {
    logger.info('Get invoice · id=' + req.params.id);
    const [[full]] = await pool.query('SELECT * FROM tbl_client_invoice WHERE id = ?', [req.params.id]);
    const [payments] = await pool.query('SELECT * FROM tbl_client_invoice_paid WHERE fk_invoice_id = ?', [req.params.id]);
    logger.info('Found ' + payments.length + ' payments for invoice · id=' + req.params.id);
    modernOk(res, { ...full, payments });
  } catch (e) { next(e); }
});

router.post('/invoices/generate', validate(Joi.object({
  clientId: Joi.number().integer().positive().required(),
  from: Joi.date().iso().required(), to: Joi.date().iso().required(),
})), async (req, res, next) => {
  try {
    const { clientId, from, to } = req.body;
    logger.info('Generate invoice · clientId=' + clientId + ' from=' + from + ' to=' + to);
    // RBAC: caller can only generate invoices for clients in their scope.
    const guard = assertEntityInScope(req, { client_id: clientId });
    if (!guard.ok) return modernError(res, 403, 'client outside your scope');
    // Sum of completed jobs in range — simplified; real legacy pulls job_services totals
    const [[sum]] = await pool.query(
      `SELECT COALESCE(SUM(js.total_charge * js.quantity), 0) AS total, COUNT(DISTINCT j.job_id) AS jobCount
         FROM tbl_job j LEFT JOIN tbl_job_services js ON js.job_id = j.job_id
        WHERE j.fk_client_id = ? AND j.job_status IN (3,5)
          AND j.checkout_date_time BETWEEN ? AND ?`,
      [clientId, from, to]);
    // VERIFIED — only columns present in Invoice.java JPA model are
    // written. `updated_by` is NOT a real column on tbl_client_invoice.
    const [ins] = await pool.query(
      `INSERT INTO tbl_client_invoice (fk_client_id, billing_from_date, billing_to_date,
          current_due_amount, total_invoice_amount, total_paid_amount,
          is_raised, is_paid, invoice_date)
       VALUES (?, ?, ?, ?, ?, 0, 1, 0, NOW())`,
      [clientId, from, to, sum.total, sum.total]);
    res.status(201);
    logger.info('Invoice generated · id=' + ins.insertId + ' clientId=' + clientId + ' jobCount=' + sum.jobCount);
    modernOk(res, { invoiceId: ins.insertId, jobCount: sum.jobCount, totalAmount: sum.total }, 'invoice generated');
  } catch (e) { next(e); }
});

// VERIFIED 2026-05-12 against InvoicePaidDaoImpl.java:49-56 +
// InvoicePaid.java JPA model:
//   tbl_client_invoice_paid: paid_id (PK), fk_invoice_id, fk_client_id,
//     paid_amount, paid_date, paid_by, comments, upload_documents
//   PK is `paid_id` not `id`. The earlier version wrote to columns
//   `tds_deducted` and `insert_date` that DO NOT exist on this table —
//   bug fixed. TDS is tracked on the parent invoice
//   (tbl_client_invoice.total_tds_deducted) only.
router.post('/invoices/:id/payment', validate(Joi.object({
  amount: Joi.number().positive().required(),
  tdsDeducted: Joi.number().min(0).optional(),
  paidDate: Joi.date().iso().optional(),
  comments: Joi.string().max(500).optional(),
  uploadDocuments: Joi.string().max(255).allow('', null).optional(),
})), scopedInvoice, async (req, res, next) => {
  try {
    const invId = Number(req.params.id);
    logger.info('Record invoice payment · invoiceId=' + invId + ' amount=' + req.body.amount);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Read totals inside the tx with a row lock so concurrent payments
      // can't compute newPaid/newTds off a stale pre-tx snapshot.
      const [[inv]] = await conn.query(
        `SELECT fk_client_id, total_invoice_amount,
                COALESCE(total_paid_amount, 0) AS total_paid_amount,
                COALESCE(total_tds_deducted, 0) AS total_tds_deducted
           FROM tbl_client_invoice WHERE id = ? FOR UPDATE`,
        [invId]
      );
      if (!inv) { await conn.rollback(); return modernError(res, 404, 'invoice not found'); }
      await conn.query(
        `INSERT INTO tbl_client_invoice_paid
           (fk_invoice_id, fk_client_id, paid_amount, paid_date, paid_by, comments, upload_documents)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          invId, inv.fk_client_id, req.body.amount,
          req.body.paidDate || new Date(),
          req.user.user_id,
          req.body.comments || null,
          req.body.uploadDocuments || null,
        ]
      );
      const newPaid = Number(inv.total_paid_amount) + Number(req.body.amount);
      const newTds = Number(inv.total_tds_deducted) + Number(req.body.tdsDeducted || 0);
      const fullyPaid = (newPaid + newTds) >= Number(inv.total_invoice_amount) ? 1 : 0;
      await conn.query(
        `UPDATE tbl_client_invoice
            SET total_paid_amount = ?, total_tds_deducted = ?, is_paid = ?
          WHERE id = ?`,
        [newPaid, newTds, fullyPaid, invId]
      );
      await conn.commit();
      logger.info('Invoice payment recorded · invoiceId=' + invId + ' totalPaid=' + newPaid + ' isPaid=' + !!fullyPaid);
      modernOk(res, {
        recorded: true,
        totalPaid: newPaid,
        totalTds: newTds,
        isPaid: !!fullyPaid,
      });
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  } catch (e) { next(e); }
});

// VERIFIED 2026-05-12 — only columns that exist on tbl_client_invoice.
// Earlier version referenced `updated_by` which is NOT in the JPA
// model or legacy SQL. Removed.
router.patch('/invoices/:id/status', validate(Joi.object({
  isRaised: Joi.boolean().optional(),
  isPaid: Joi.boolean().optional(),
  comments: Joi.string().max(500).optional(),
}).min(1)), scopedInvoice, async (req, res, next) => {
  try {
    logger.info('Update invoice status · id=' + req.params.id + ' isRaised=' + req.body.isRaised + ' isPaid=' + req.body.isPaid);
    const sets = [], vals = [];
    if (req.body.isRaised !== undefined) { sets.push('is_raised = ?'); vals.push(req.body.isRaised ? 1 : 0); }
    if (req.body.isPaid !== undefined)   { sets.push('is_paid = ?');   vals.push(req.body.isPaid ? 1 : 0); }
    if (req.body.comments)                { sets.push('updated_comments = ?'); vals.push(req.body.comments); }
    if (sets.length === 0) return modernError(res, 400, 'nothing to update');
    vals.push(req.params.id);
    await pool.query(`UPDATE tbl_client_invoice SET ${sets.join(', ')} WHERE id = ?`, vals);
    logger.info('Invoice status updated · id=' + req.params.id);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

// ─── /admin/finance/invoices/:id/excel — master sheet download ──────
// Generates the invoice "master sheet" — per-job line items for the
// invoice's billing window. Mirrors the legacy `file_path_excel`
// artifact (`invoiceMasterSheet` in the legacy Invoice model) that ops
// teams email to clients.
//
// VERIFIED 2026-05-12 schemas:
//   tbl_client_invoice:
//     id, fk_client_id, invoice_number, invoice_date, billing_from_date,
//     billing_to_date, total_invoice_amount, total_paid_amount,
//     total_tds_deducted, current_due_amount, previous_due_amount,
//     invoiced_job_ids (CSV), invoice_desc, file_path_excel
//   tbl_job_services (JobDaoImpl.java:2560): job_service_id, job_id,
//     service_id, quantity, total_charge, material_charge,
//     job_service_status. Service name via two-hop tbl_client_service →
//     tbl_client_rate_card.crc_ratecard_name.
//
// Scope rule: include completed jobs (status 3 or 5) for the client
// where `checkout_date_time` falls in the billing window. If
// `invoiced_job_ids` CSV is set on the invoice, honour that list
// instead (legacy ops sometimes hand-picks which jobs go in).
router.get('/invoices/:id/excel', scopedInvoice, async (req, res, next) => {
  try {
    logger.info('Export invoice master sheet XLSX · id=' + req.params.id);
    const data = await loadInvoiceArtifactData(Number(req.params.id));
    if (!data) return modernError(res, 404, 'invoice not found');
    const { inv, lines } = data;
    sendXlsx(res, {
      filename: `invoice-${inv.invoice_number || inv.id}-mastersheet.xlsx`,
      sheetName: `Inv-${inv.id}`,
      columns: [
        { key: 'job_id',       header: 'Job ID',         width: 10 },
        { key: 'job_ref',      header: 'Job Reference',  width: 18 },
        { key: 'client_ref',   header: 'Client Ref',     width: 18 },
        { key: 'customer',     header: 'Customer',       width: 22 },
        { key: 'mobile',       header: 'Mobile',         width: 14 },
        { key: 'city',         header: 'City',           width: 14 },
        { key: 'completed_on', header: 'Completed On',   width: 18 },
        { key: 'service',      header: 'Service',        width: 36 },
        { key: 'quantity',     header: 'Qty',            width: 6  },
        { key: 'unit_charge',  header: 'Unit Charge',    width: 12 },
        { key: 'material',     header: 'Material Chg',   width: 12 },
        { key: 'line_total',   header: 'Line Total',     width: 12 },
      ],
      rows: lines,
    });
  } catch (e) { next(e); }
});

// ─── /admin/finance/invoices/:id/pdf — formal PDF invoice ───────────
// Uses utils/pdf-invoice.js (pdfkit). The PDF is the formal client-
// facing artifact (mirrors legacy `file_path_pdf` / `invoicePdf`).
router.get('/invoices/:id/pdf', scopedInvoice, async (req, res, next) => {
  try {
    logger.info('Render invoice PDF · id=' + req.params.id);
    const data = await loadInvoiceArtifactData(Number(req.params.id));
    if (!data) return modernError(res, 404, 'invoice not found');
    const { inv, client, lines } = data;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="invoice-${inv.invoice_number || inv.id}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    renderInvoicePdf({ invoice: inv, client, lines, stream: res });
  } catch (e) { next(e); }
});

// ─── /admin/finance/invoices/zip — bulk ZIP of all invoices ─────────
// Mirrors legacy `zipAndDownloadAllInvoices`. Streams a .zip containing
// each invoice as a PDF. Filter optional by clientId / billing window.
// Streams progressively — large client portfolios won't blow memory.
router.get('/invoices/zip', async (req, res, next) => {
  try {
    const { clientId, from, to } = req.query;
    logger.info('Bulk zip invoices · clientId=' + (clientId ?? 'all') + ' from=' + (from || '') + ' to=' + (to || ''));
    const clauses = [], params = [];
    // RBAC: only zip invoices for clients in the caller's scope.
    const scope = buildRequestScope(req);
    if (scope?.clients) {
      const c = scope.clients;
      if (c.mode === 'none') return modernError(res, 403, 'no client access');
      if (c.mode === 'allow' && c.ids.length) {
        clauses.push(`fk_client_id IN (${c.ids.map(() => '?').join(',')})`);
        params.push(...c.ids);
      }
    }
    if (clientId) { clauses.push('fk_client_id = ?'); params.push(clientId); }
    if (from)     { clauses.push('billing_from_date >= ?'); params.push(from); }
    if (to)       { clauses.push('billing_to_date   <= ?'); params.push(to); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT id FROM tbl_client_invoice ${where} ORDER BY id DESC LIMIT 500`,
      params
    );
    if (rows.length === 0) return modernError(res, 404, 'no invoices match');
    logger.info('Zipping ' + rows.length + ' invoices');

    const ts = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="invoices-${ts}.zip"`);
    res.setHeader('Cache-Control', 'no-store');

    const zip = archiver('zip', { zlib: { level: 9 } });
    zip.on('error', (e) => { try { res.destroy(e); } catch (_) {} });
    zip.pipe(res);

    for (const r of rows) {
      const data = await loadInvoiceArtifactData(r.id);
      if (!data) continue;
      const { inv, client, lines } = data;
      const pdfStream = new PassThrough();
      const fn = `invoice-${inv.invoice_number || inv.id}.pdf`;
      zip.append(pdfStream, { name: fn });
      renderInvoicePdf({ invoice: inv, client, lines, stream: pdfStream });
      // wait for this PDF to finish writing into the zip before queuing the
      // next; otherwise PassThroughs may interleave on backpressure
      await new Promise((resolve) => pdfStream.on('end', resolve));
    }
    zip.finalize();
  } catch (e) { next(e); }
});

// ─── /admin/finance/email-statement — email invoice to client SPOCs ─
// Replaces legacy `sendEmailTransactionList` + `sendEmailEFrTransactionList`.
// Streams the invoice PDF as an inline attachment via the email service.
// Recipients = all active SPOCs for the invoice's client unless `to` is
// supplied. Failures are reported per-recipient.
const emailServiceForFinance = require('../../services/email.service');
router.post('/email-statement', validate(Joi.object({
  invoiceId: Joi.number().integer().positive().required(),
  to: Joi.array().items(Joi.string().email()).optional(),
  ccOps: Joi.boolean().default(true),
})), async (req, res, next) => {
  try {
    logger.info('Email invoice statement · invoiceId=' + req.body.invoiceId + ' ccOps=' + req.body.ccOps);
    const data = await loadInvoiceArtifactData(Number(req.body.invoiceId));
    if (!data) return modernError(res, 404, 'invoice not found');
    const { inv, client, lines } = data;
    // RBAC: caller must have scope over the invoice's client.
    const guard = assertEntityInScope(req, { client_id: inv.fk_client_id });
    if (!guard.ok) return modernError(res, 404, 'invoice not found');

    let recipients = req.body.to || [];
    if (recipients.length === 0) {
      const [contacts] = await pool.query(
        `SELECT contact_email FROM tbl_client_contacts
          WHERE client_id = ? AND status = 1 AND contact_email IS NOT NULL AND contact_email <> ''`,
        [inv.fk_client_id]
      );
      recipients = contacts.map((c) => c.contact_email);
    }
    if (recipients.length === 0) {
      logger.warn('Email invoice statement — no recipients found · invoiceId=' + req.body.invoiceId);
      return modernError(res, 400, 'no recipients found for this client');
    }

    // Render PDF into a Buffer so we can attach. PassThrough collects chunks.
    const { PassThrough } = require('stream');
    const buf = await new Promise((resolve, reject) => {
      const chunks = [];
      const sink = new PassThrough();
      sink.on('data', (c) => chunks.push(c));
      sink.on('end', () => resolve(Buffer.concat(chunks)));
      sink.on('error', reject);
      renderInvoicePdf({ invoice: inv, client, lines, stream: sink });
    });

    const cc = req.body.ccOps ? [process.env.OPS_FINANCE_INBOX || 'finance@easyfix.in'] : undefined;
    // The PDF is attached via email.service.send()'s `attachments` parameter,
    // which Graph translates to `#microsoft.graph.fileAttachment` items.
    // A backup download link is included in the body so recipients on
    // attachment-stripping mail gateways can still retrieve the PDF.
    await emailServiceForFinance.send({
      to: recipients,
      cc,
      subject: `EasyFix Invoice ${inv.invoice_number || inv.id} — ${client.client_name || ''}`,
      text: `Please find your invoice ${inv.invoice_number || inv.id} for the period `
        + `${inv.billing_from_date} to ${inv.billing_to_date}.\n\n`
        + `Total invoice amount: ${inv.total_invoice_amount}\n`
        + `Amount due: ${inv.current_due_amount}\n\n`
        + `Download PDF: ${process.env.API_BASE_URL || ''}/api/admin/finance/invoices/${inv.id}/pdf\n\n`
        + `Regards,\nEasyFix Finance`,
      category: 'finance.invoice',
      attachments: [
        { filename: `invoice-${inv.invoice_number || inv.id}.pdf`, content: buf, contentType: 'application/pdf' },
      ],
    });
    logger.info('Invoice statement emailed · invoiceId=' + (inv.id) + ' recipients=' + recipients.length);
    modernOk(res, { sent: true, recipients });
  } catch (e) { next(e); }
});

// ─── /admin/finance/efr-transactions — Easyfixer ledger ────────────
// VERIFIED 2026-05-12 against live INFORMATION_SCHEMA:
//   tbl_easyfixer_transaction columns:
//     transaction_id, easyfixer_id, source, description, transaction_type,
//     transaction_date, amount, balance, created_date, created_by,
//     job_id, trans_reason_code
//   transaction_type values: 1 (credit) and 2 (debit) per the legacy
//   convention. The Finance sidebar's "Easyfixer Debit" and "Easyfixer
//   Credit" sub-menus both point here with a different ?type= filter.
router.get('/efr-transactions', async (req, res, next) => {
  try {
    const { efrId, type, from, to } = req.query;
    logger.info('List easyfixer transactions · efrId=' + (efrId ?? 'all') + ' type=' + (type ?? 'all') + ' from=' + (from || '') + ' to=' + (to || ''));
    const clauses = [], params = [];
    // RBAC city scope — filter rows by the easyfixer's city
    const scope = buildRequestScope(req);
    if (scope?.cities) {
      const ci = scope.cities;
      if (ci.mode === 'none') clauses.push('1=0');
      else if (ci.mode === 'allow' && ci.ids.length) {
        clauses.push(`e.efr_cityId IN (${ci.ids.map(() => '?').join(',')})`);
        params.push(...ci.ids);
      }
    }
    if (efrId != null) { clauses.push('et.easyfixer_id = ?'); params.push(efrId); }
    if (type != null)  { clauses.push('et.transaction_type = ?'); params.push(type); }
    if (from)          { clauses.push('et.transaction_date >= ?'); params.push(from); }
    if (to)            { clauses.push('et.transaction_date <= ?'); params.push(to); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const [rows] = await pool.query(
      `SELECT et.transaction_id, et.easyfixer_id, et.source, et.description,
              et.transaction_type, et.transaction_date, et.amount, et.balance,
              et.job_id, et.trans_reason_code,
              e.efr_name, e.efr_no
         FROM tbl_easyfixer_transaction et
         LEFT JOIN tbl_easyfixer e ON e.efr_id = et.easyfixer_id
         ${where}
        ORDER BY et.transaction_id DESC
        LIMIT ?`,
      [...params, limit]
    );
    logger.info('Found ' + rows.length + ' easyfixer transactions');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

// ─── Transactions (ledger) ──────────────────────────────────────────
router.get('/transactions', async (req, res, next) => {
  try {
    const { clientId, jobId } = req.query;
    logger.info('List client transactions · clientId=' + (clientId ?? 'all') + ' jobId=' + (jobId ?? 'all'));
    const clauses = [], params = [];
    // RBAC: filter by manage_clients
    const scope = buildRequestScope(req);
    if (scope?.clients) {
      const c = scope.clients;
      if (c.mode === 'none') clauses.push('1=0');
      else if (c.mode === 'allow' && c.ids.length) {
        clauses.push(`client_id IN (${c.ids.map(() => '?').join(',')})`);
        params.push(...c.ids);
      }
    }
    if (clientId != null) { clauses.push('client_id = ?'); params.push(clientId); }
    if (jobId != null)    { clauses.push('job_id = ?');    params.push(jobId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    params.push(limit);
    const [rows] = await pool.query(
      `SELECT * FROM tbl_client_transaction ${where} ORDER BY client_trans_id DESC LIMIT ?`, params);
    logger.info('Found ' + rows.length + ' client transactions');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post('/transactions', validate(Joi.object({
  clientId: Joi.number().integer().positive().required(),
  jobId: Joi.number().integer().positive().optional(),
  transactionType: Joi.number().integer().required(),
  amount: Joi.number().required(),
  description: Joi.string().max(500).optional(),
})), async (req, res, next) => {
  try {
    logger.info('Create client transaction · clientId=' + req.body.clientId + ' type=' + req.body.transactionType + ' amount=' + req.body.amount);
    // RBAC: caller must have scope over the target client.
    const guard = assertEntityInScope(req, { client_id: req.body.clientId });
    if (!guard.ok) return modernError(res, 403, 'client outside your scope');
    const conn = await pool.getConnection();
    try {
      // Per-client advisory lock serialises concurrent ledger writes so the
      // read-prior-balance / insert-new-balance pair is race-free.
      const [[lk]] = await conn.query(
        "SELECT GET_LOCK(CONCAT('client_ledger_', ?), 5) AS got",
        [req.body.clientId]);
      if (lk.got !== 1) { logger.warn('Client ledger busy · clientId=' + req.body.clientId); return modernError(res, 503, 'ledger busy, retry'); }
      await conn.beginTransaction();
      const [[prior]] = await conn.query(
        'SELECT balance FROM tbl_client_transaction WHERE client_id = ? ORDER BY client_trans_id DESC LIMIT 1',
        [req.body.clientId]);
      const newBalance = Number(prior?.balance || 0) + Number(req.body.amount); // DECIMAL arrives as string — coerce
      const [ins] = await conn.query(
        `INSERT INTO tbl_client_transaction (client_id, job_id, transaction_type, amount, balance, description, transaction_date, created_date, created_by)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), ?)`,
        [req.body.clientId, req.body.jobId || null, req.body.transactionType, req.body.amount, newBalance, req.body.description || null, req.user.user_id]);
      await conn.commit();
      res.status(201);
      logger.info('Client transaction created · id=' + ins.insertId + ' clientId=' + req.body.clientId + ' newBalance=' + newBalance);
      modernOk(res, { transactionId: ins.insertId, newBalance });
    } catch (e) { await conn.rollback(); throw e; } finally {
      await conn.query("SELECT RELEASE_LOCK(CONCAT('client_ledger_', ?))", [req.body.clientId]);
      conn.release();
    }
  } catch (e) { next(e); }
});

// ─── Purchase Orders ────────────────────────────────────────────────
router.get('/purchase-orders', async (req, res, next) => {
  try {
    const { clientId } = req.query;
    logger.info('List purchase orders · clientId=' + (clientId ?? 'all'));
    const clauses = [], params = [];
    // RBAC: filter by manage_clients
    const scope = buildRequestScope(req);
    if (scope?.clients) {
      const c = scope.clients;
      if (c.mode === 'none') clauses.push('1=0');
      else if (c.mode === 'allow' && c.ids.length) {
        clauses.push(`fk_client_id IN (${c.ids.map(() => '?').join(',')})`);
        params.push(...c.ids);
      }
    }
    if (clientId != null) { clauses.push('fk_client_id = ?'); params.push(clientId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT * FROM tbl_client_purchase_order_details ${where} ORDER BY inv_po_id DESC LIMIT 500`,
      params);
    logger.info('Found ' + rows.length + ' purchase orders');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post('/purchase-orders', validate(Joi.object({
  clientId: Joi.number().integer().positive().required(),
  poNumber: Joi.string().max(100).required(),
  description: Joi.string().max(500).allow('', null).optional(),
  startDate: Joi.date().iso().raw().required(),
  endDate: Joi.date().iso().raw().required(),
  totalAmount: Joi.number().min(0).required(),
})), async (req, res, next) => {
  try {
    const b = req.body || {};
    logger.info('Create purchase order · clientId=' + b.clientId + ' poNumber=' + b.poNumber);
    // RBAC: caller must have scope over the target client.
    const guard = assertEntityInScope(req, { client_id: b.clientId });
    if (!guard.ok) return modernError(res, 403, 'client outside your scope');
    const [ins] = await pool.query(
      `INSERT INTO tbl_client_purchase_order_details
         (fk_client_id, inv_client_po_num, inv_po_desc, inv_po_start_date, inv_po_end_date, inv_po_total_amnt, inv_po_date)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [b.clientId, b.poNumber, b.description || null, b.startDate, b.endDate, b.totalAmount]);
    res.status(201);
    logger.info('Purchase order created · id=' + ins.insertId + ' clientId=' + b.clientId);
    modernOk(res, { poId: ins.insertId });
  } catch (e) { next(e); }
});

// ─── Easyfixer payout ledger ───────────────────────────────────────
router.get('/easyfixer/:id/payout', async (req, res, next) => {
  try {
    logger.info('Get easyfixer payout balance · id=' + req.params.id);
    const [[balance]] = await pool.query(
      'SELECT efr_id, efr_cityId, current_balance FROM tbl_easyfixer WHERE efr_id = ? AND NOT (tbl_easyfixer.efr_status <=> 3)',
      [req.params.id]
    );
    if (!balance) return modernError(res, 404, 'easyfixer not found');
    const guard = assertEntityInScope(req, { city_id: balance.efr_cityId });
    if (!guard.ok) return modernError(res, 404, 'easyfixer not found');
    modernOk(res, balance);
  } catch (e) { next(e); }
});

// ─── Payout approval chain ──────────────────────────────────────────
// Three-step legacy workflow on tbl_service_payout:
//   ops creates payout      → is_approved_by_fin = 0  (pending)
//   ops approves            → is_approved_by_fin = 1  (intermediate)
//   finance approves        → is_approved_by_fin = 2  (final, money out)
//   finance rejects         → is_approved_by_fin = 3
//
// VERIFIED 2026-05-12 against EasyFixerAction.java:555 + EasyfixerDaoImpl:
//   tbl_service_payout columns (raw SQL evidence):
//     payout_id (PK), efr_id, efr_balance,
//     ops_amount, ops_approved_amount, ops_approved_by,
//     pm_req_amount, pm_req_date, pm_req_by,
//     fin_approved_amount, fin_payout_ref, fin_payout_doc,
//     fin_rejected_by, fin_reject_date,
//     is_approved_by_fin (NOTE: short name; not "is_approved_by_finance")
//
// Legacy uses TWO stored procedures that perform the actual updates
// PLUS audit logging:
//   sp_ef_approve_payout_by_ops(payoutId, efrId, opsAprvAmnt, userId, status)
//   sp_ef_approve_payout_by_finance(payoutId, efrId, finAprvAmnt, userId,
//                                   payoutRef, payoutDoc, status)
// Reusing the SPs keeps state-machine and audit-log behaviour identical
// to legacy (battle-tested) and avoids re-implementing internal cascade
// logic that's not visible in the Java code.
//
// `roleByName` gating ensures only Ops + Finance group members can act —
// /payout-chain is inside the admin scope so all routes already require
// auth + admin group via routes/admin/index.js.

router.get('/payouts', async (req, res, next) => {
  try {
    const { efrId, status } = req.query;
    logger.info('List payouts · efrId=' + (efrId ?? 'all') + ' status=' + (status ?? 'all'));
    const clauses = [], params = [];
    // RBAC: filter by easyfixer's city
    const scope = buildRequestScope(req);
    if (scope?.cities) {
      const ci = scope.cities;
      if (ci.mode === 'none') clauses.push('1=0');
      else if (ci.mode === 'allow' && ci.ids.length) {
        clauses.push(`e.efr_cityId IN (${ci.ids.map(() => '?').join(',')})`);
        params.push(...ci.ids);
      }
    }
    if (efrId != null)  { clauses.push('sp.efr_id = ?'); params.push(efrId); }
    if (status != null) { clauses.push('sp.is_approved_by_fin = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT sp.payout_id, sp.efr_id, sp.efr_balance,
              sp.ops_amount, sp.ops_approved_amount,
              sp.pm_req_amount, sp.pm_req_date, sp.pm_req_by,
              sp.fin_approved_amount, sp.fin_payout_ref, sp.fin_payout_doc,
              sp.fin_rejected_by, sp.fin_reject_date,
              sp.is_approved_by_fin,
              e.efr_name, e.efr_no
         FROM tbl_service_payout sp
         LEFT JOIN tbl_easyfixer e ON e.efr_id = sp.efr_id
         ${where}
        ORDER BY sp.payout_id DESC
        LIMIT 500`,
      params
    );
    logger.info('Found ' + rows.length + ' payouts');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

// ─── /admin/finance/payouts/eligible — easyfixers ready for payout ──
// Mirrors legacy `getServicemenPayoutList` (EasyfixerAction.java:457).
// Uses the existing stored proc `sp_ef_get_easyfixer_list_for_payout2`
// which joins tbl_easyfixer with the latest tbl_service_payout row.
//
// VERIFIED tbl_service_payout columns (EasyfixerDaoImpl.java:780):
//   payout_id, efr_id, efr_balance,
//   pm_req_amount, pm_req_date, pm_req_by,
//   ops_amount, ops_approved_amount, ops_approved_date, ops_approved_by,
//   fin_approved_amount, fin_apfoved_date (LEGACY TYPO — "apfoved", preserve),
//   fin_approved_by, fin_payout_ref, fin_payout_doc,
//   fin_rejected_by, fin_reject_date, is_approved_by_fin
//
// `cityList` is a CSV of city_ids; the SP filters by it. Empty = all.
router.get('/payouts/eligible', async (req, res, next) => {
  try {
    const cityList = String(req.query.cityList || '').trim();
    const payoutId = Number(req.query.payoutId || 0);
    logger.info('List payout-eligible easyfixers · cityList=' + (cityList || 'all') + ' payoutId=' + payoutId);
    const [rows] = await pool.query(
      'CALL sp_ef_get_easyfixer_list_for_payout2(?, ?)',
      [cityList, payoutId]
    );
    // mysql2 returns SP results as [resultSets[], okPacket]; the first
    // entry of resultSets is our row array.
    const data = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : [];
    logger.info('Found ' + data.length + ' payout-eligible easyfixers');
    modernOk(res, data);
  } catch (e) { next(e); }
});

// ─── POST /admin/finance/payouts — create new pending payout ────────
// Mirrors legacy `saveServicePayout` (EasyfixerAction.java:484). Inserts
// a new tbl_service_payout row with status 0 (pending), capturing the
// PM's requested amount and the easyfixer's current balance.
router.post('/payouts', validate(Joi.object({
  efrId: Joi.number().integer().positive().required(),
  efrBalance: Joi.number().min(0).required(),
  opsAmount: Joi.number().min(0).required(),
  pmRequestAmount: Joi.number().min(0).required(),
})), async (req, res, next) => {
  try {
    logger.info('Create payout · efrId=' + req.body.efrId + ' pmRequestAmount=' + req.body.pmRequestAmount);
    const efrGuard = await assertEfrInScope(req, req.body.efrId);
    if (!efrGuard.ok) return modernError(res, 403, 'easyfixer outside your scope');
    const [ins] = await pool.query(
      `INSERT INTO tbl_service_payout
         (efr_balance, ops_amount, pm_req_amount, pm_req_date, pm_req_by, is_approved_by_fin, efr_id)
       VALUES (?, ?, ?, NOW(), ?, 0, ?)`,
      [req.body.efrBalance, req.body.opsAmount, req.body.pmRequestAmount,
       req.user.user_id, req.body.efrId]
    );
    res.status(201);
    logger.info('Payout created · id=' + ins.insertId + ' efrId=' + req.body.efrId + ' status=0');
    modernOk(res, { payoutId: ins.insertId, status: 0 }, 'payout created');
  } catch (e) { next(e); }
});

// ─── POST /admin/finance/payouts/bulk-ops-approve ───────────────────
// Mirrors legacy `saveAllServicePayout` — iterate a list, approve each
// via the same SP `/payouts/:id/ops-approve` uses. Wrapped in Promise.all
// so a slow row doesn't block the others, but errors are reported per-row.
router.post('/payouts/bulk-ops-approve', validate(Joi.object({
  items: Joi.array().items(Joi.object({
    payoutId: Joi.number().integer().positive().required(),
    efrId: Joi.number().integer().positive().required(),
    opsApprovedAmount: Joi.number().min(0).required(),
  })).min(1).required(),
})), async (req, res, next) => {
  try {
    logger.info('Bulk ops-approve payouts · items=' + req.body.items.length);
    const results = await Promise.all(req.body.items.map(async (it) => {
      try {
        const guard = await assertEfrInScope(req, it.efrId);
        if (!guard.ok) return { payoutId: it.payoutId, ok: false, error: 'payout not found' };
        await pool.query(
          'CALL sp_ef_approve_payout_by_ops(?, ?, ?, ?, ?)',
          [it.payoutId, it.efrId, it.opsApprovedAmount, req.user.user_id, 1]
        );
        return { payoutId: it.payoutId, ok: true };
      } catch (err) {
        return { payoutId: it.payoutId, ok: false, error: err.message };
      }
    }));
    const okCount = results.filter((r) => r.ok).length;
    logger.info('Bulk ops-approve done · approved=' + okCount + ' failed=' + (results.length - okCount));
    modernOk(res, { results, approvedCount: okCount, failedCount: results.length - okCount });
  } catch (e) { next(e); }
});

// Ops approval — moves to status 1
router.post('/payouts/:id/ops-approve', validate(Joi.object({
  efrId: Joi.number().integer().positive().required(),
  opsApprovedAmount: Joi.number().min(0).required(),
})), async (req, res, next) => {
  try {
    logger.info('Ops-approve payout · id=' + req.params.id + ' efrId=' + req.body.efrId + ' amount=' + req.body.opsApprovedAmount);
    const efrGuard = await assertEfrInScope(req, req.body.efrId);
    if (!efrGuard.ok) return modernError(res, 404, 'payout not found');
    await pool.query(
      'CALL sp_ef_approve_payout_by_ops(?, ?, ?, ?, ?)',
      [Number(req.params.id), req.body.efrId, req.body.opsApprovedAmount, req.user.user_id, 1]
    );
    logger.info('Payout ops-approved · id=' + req.params.id + ' status=1');
    modernOk(res, { approvedBy: 'ops', status: 1 });
  } catch (e) { next(e); }
});

// Finance approval — moves to status 2 (final)
router.post('/payouts/:id/fin-approve', validate(Joi.object({
  efrId: Joi.number().integer().positive().required(),
  finApprovedAmount: Joi.number().min(0).required(),
  payoutRef: Joi.string().max(100).allow('', null).optional(),
  payoutDoc: Joi.string().max(255).allow('', null).optional(),
})), async (req, res, next) => {
  try {
    logger.info('Finance-approve payout · id=' + req.params.id + ' efrId=' + req.body.efrId + ' amount=' + req.body.finApprovedAmount);
    const efrGuard = await assertEfrInScope(req, req.body.efrId);
    if (!efrGuard.ok) return modernError(res, 404, 'payout not found');
    await pool.query(
      'CALL sp_ef_approve_payout_by_finance(?, ?, ?, ?, ?, ?, ?)',
      [
        Number(req.params.id),
        req.body.efrId,
        req.body.finApprovedAmount,
        req.user.user_id,
        req.body.payoutRef || '',
        req.body.payoutDoc || '',
        2,
      ]
    );
    logger.info('Payout finance-approved · id=' + req.params.id + ' status=2');
    modernOk(res, { approvedBy: 'finance', status: 2 });
  } catch (e) { next(e); }
});

// Finance rejection — moves to status 3.
// Legacy did this via raw UPDATE in updateServicePayout(), not an SP,
// because rejection only flips 3 columns (no cascade). Mirrored here.
router.post('/payouts/:id/fin-reject', validate(Joi.object({
  efrId: Joi.number().integer().positive().required(),
})), async (req, res, next) => {
  try {
    logger.info('Finance-reject payout · id=' + req.params.id + ' efrId=' + req.body.efrId);
    const efrGuard = await assertEfrInScope(req, req.body.efrId);
    if (!efrGuard.ok) return modernError(res, 404, 'payout not found');
    const [r] = await pool.query(
      `UPDATE tbl_service_payout
          SET is_approved_by_fin = 3,
              fin_rejected_by = ?,
              fin_reject_date = NOW()
        WHERE payout_id = ? AND efr_id = ?`,
      [req.user.user_id, Number(req.params.id), req.body.efrId]
    );
    if (r.affectedRows === 0) return modernError(res, 404, 'payout not found');
    logger.info('Payout finance-rejected · id=' + req.params.id + ' status=3');
    modernOk(res, { rejected: true, status: 3 });
  } catch (e) { next(e); }
});

// ─── NDM (Node District Manager) recharge workflow ──────────────────
// NDM = Node District Manager (role_id 12 or 13). Field cash collected
// from technicians/sites is recorded by the NDM as a "recharge" against
// the easyfixer's balance, then approved by Finance.
//
// VERIFIED tbl_ndm_recharge columns (FinanceDaoImpl.java:204-244):
//   recharge_id (PK), efr_id, ndm_id, recharge_amount, recharge_date,
//   approval_date, recharge_type, comments, approved_by_finance (0/1),
//   document_path, payment_mode, reference_id
//
// SP `sp_ef_finance_efr_recharge(efrId, ndmId, flag)` is reused for
// listing. Flag values:
//   1 = filter by efrId, 2 = filter by ndmId, 4 = pending-approval list

router.get('/ndm-recharges', async (req, res, next) => {
  try {
    const efrId = Number(req.query.efrId || 0);
    const ndmId = Number(req.query.ndmId || 0);
    const flag = Number(req.query.flag || 4); // default to "pending approval"
    logger.info('List NDM recharges · efrId=' + efrId + ' ndmId=' + ndmId + ' flag=' + flag);
    const [rows] = await pool.query(
      'CALL sp_ef_finance_efr_recharge(?, ?, ?)',
      [efrId, ndmId, flag]
    );
    const data = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : [];
    logger.info('Found ' + data.length + ' NDM recharges (pre-scope filter)');
    // RBAC: post-filter the SP result by easyfixer city scope. SP doesn't
    // accept a scope param so we filter in-memory; volume is bounded
    // (pending-approval rows ≤ low hundreds).
    const scope = buildRequestScope(req);
    if (scope?.cities && scope.cities.mode !== 'all') {
      if (scope.cities.mode === 'none') return modernOk(res, []);
      const allowed = new Set(scope.cities.ids);
      const efrIds = [...new Set(data.map((r) => r.efr_id).filter(Boolean))];
      if (efrIds.length === 0) return modernOk(res, []);
      const placeholders = efrIds.map(() => '?').join(',');
      const [efrCityRows] = await pool.query(
        `SELECT efr_id, efr_cityId FROM tbl_easyfixer WHERE efr_id IN (${placeholders}) AND NOT (tbl_easyfixer.efr_status <=> 3)`,
        efrIds
      );
      const cityByEfr = new Map(efrCityRows.map((r) => [r.efr_id, r.efr_cityId]));
      const filtered = data.filter((r) => allowed.has(cityByEfr.get(r.efr_id)));
      return modernOk(res, filtered);
    }
    modernOk(res, data);
  } catch (e) { next(e); }
});

router.post('/ndm-recharges', validate(Joi.object({
  efrId: Joi.number().integer().positive().required(),
  rechargeAmount: Joi.number().positive().required(),
  rechargeType: Joi.number().integer().optional(),
  comments: Joi.string().max(500).allow('', null).optional(),
  documentPath: Joi.string().max(255).allow('', null).optional(),
  paymentMode: Joi.string().max(50).allow('', null).optional(),
  referenceId: Joi.string().max(100).allow('', null).optional(),
})), async (req, res, next) => {
  try {
    logger.info('Log NDM recharge · efrId=' + req.body.efrId + ' amount=' + req.body.rechargeAmount);
    const efrGuard = await assertEfrInScope(req, req.body.efrId);
    if (!efrGuard.ok) return modernError(res, 403, 'easyfixer outside your scope');
    const [ins] = await pool.query(
      `INSERT INTO tbl_ndm_recharge
         (efr_id, ndm_id, recharge_amount, recharge_date, recharge_type,
          comments, approved_by_finance, document_path, payment_mode, reference_id)
       VALUES (?, ?, ?, NOW(), ?, ?, 0, ?, ?, ?)`,
      [req.body.efrId, req.user.user_id, req.body.rechargeAmount,
       req.body.rechargeType || 1, req.body.comments || null,
       req.body.documentPath || null, req.body.paymentMode || null,
       req.body.referenceId || null]
    );
    res.status(201);
    logger.info('NDM recharge logged · id=' + ins.insertId + ' efrId=' + req.body.efrId);
    modernOk(res, { rechargeId: ins.insertId }, 'NDM recharge logged');
  } catch (e) { next(e); }
});

router.post('/ndm-recharges/:id/approve', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    logger.info('Approve NDM recharge · id=' + id);
    const [[r]] = await pool.query(
      'SELECT efr_id, recharge_amount, approved_by_finance FROM tbl_ndm_recharge WHERE recharge_id = ?',
      [id]
    );
    if (!r) return modernError(res, 404, 'recharge not found');
    if (r.approved_by_finance === 1) { logger.warn('NDM recharge already approved · id=' + id); return modernError(res, 409, 'already approved'); }
    const efrGuard = await assertEfrInScope(req, r.efr_id);
    if (!efrGuard.ok) return modernError(res, 404, 'recharge not found');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Stamp approval + the legacy date column
      await conn.query(
        `UPDATE tbl_ndm_recharge SET approved_by_finance = 1, approval_date = NOW()
          WHERE recharge_id = ?`,
        [id]
      );
      // Cascade the recharge into the easyfixer's balance. If the
      // easyfixer row is missing, refuse the approval — silently
      // crediting a non-existent balance is a compliance bug (legacy
      // used a SP that raised on no-match; we replicate that here).
      const [bumpResult] = await conn.query(
        `UPDATE tbl_easyfixer
            SET current_balance = COALESCE(current_balance, 0) + ?,
                balance_updated = NOW()
          WHERE efr_id = ?`,
        [r.recharge_amount, r.efr_id]
      );
      if (bumpResult.affectedRows === 0) {
        await conn.rollback();
        logger.warn('NDM recharge approval refused — easyfixer not found · id=' + id + ' efrId=' + r.efr_id);
        return modernError(res, 409, `easyfixer ${r.efr_id} not found — approval refused to avoid orphan credit`);
      }
      await conn.commit();
      logger.info('NDM recharge approved · id=' + id + ' efrId=' + r.efr_id + ' credited=' + r.recharge_amount);
      modernOk(res, { approved: true, balanceCredited: r.recharge_amount });
    } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
  } catch (e) { next(e); }
});

router.post('/ndm-recharges/:id/reject', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    logger.info('Reject NDM recharge · id=' + id);
    const [[r]] = await pool.query(
      'SELECT efr_id FROM tbl_ndm_recharge WHERE recharge_id = ? AND approved_by_finance = 0',
      [id]
    );
    if (!r) return modernError(res, 404, 'recharge not found or already approved');
    const efrGuard = await assertEfrInScope(req, r.efr_id);
    if (!efrGuard.ok) return modernError(res, 404, 'recharge not found');
    // Legacy `updateFinanceRejected` simply DELETES the row. Preserving
    // that behaviour — there's no audit table to soft-delete to.
    await pool.query('DELETE FROM tbl_ndm_recharge WHERE recharge_id = ?', [id]);
    logger.info('NDM recharge rejected (deleted) · id=' + id);
    modernOk(res, { rejected: true });
  } catch (e) { next(e); }
});

router.post('/easyfixer/:id/recharge', validate(Joi.object({
  amount: Joi.number().positive().required(),
  reference: Joi.string().max(100).optional(),
})), async (req, res, next) => {
  try {
    const efrId = Number(req.params.id);
    logger.info('Admin recharge easyfixer · efrId=' + efrId + ' amount=' + req.body.amount);
    const efrGuard = await assertEfrInScope(req, efrId);
    if (!efrGuard.ok) return modernError(res, 404, 'easyfixer not found');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [bump] = await conn.query(
        `UPDATE tbl_easyfixer SET current_balance = COALESCE(current_balance, 0) + ?, balance_updated = NOW() WHERE efr_id = ?`,
        [req.body.amount, efrId]);
      if (bump.affectedRows === 0) {
        await conn.rollback();
        return modernError(res, 404, 'easyfixer not found');
      }
      const [[bal]] = await conn.query(
        'SELECT current_balance FROM tbl_easyfixer WHERE efr_id = ? AND NOT (tbl_easyfixer.efr_status <=> 3)',
        [efrId]);
      // Audit ledger row for the manual admin credit (transaction_type=1 = credit).
      // TODO confirm legacy 'source' convention for manual admin credits against existing tbl_easyfixer_transaction rows
      await conn.query(
        `INSERT INTO tbl_easyfixer_transaction
           (easyfixer_id, source, description, transaction_type, transaction_date, amount, balance, created_date, created_by)
         VALUES (?, ?, ?, 1, NOW(), ?, ?, NOW(), ?)`,
        [efrId, 'ADMIN_RECHARGE', req.body.reference || null, req.body.amount, bal.current_balance, req.user.user_id]);
      await conn.commit();
      logger.info('Admin recharge applied · efrId=' + efrId + ' amount=' + req.body.amount + ' newBalance=' + bal.current_balance);
      modernOk(res, { applied: req.body.amount });
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  } catch (e) { next(e); }
});

module.exports = router;
