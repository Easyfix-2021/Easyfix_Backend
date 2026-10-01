/*
 * The formal invoice artifact — ONE definition for every tier (2026-09-30).
 *
 * Extracted from routes/admin/finance.js when the client portal needed the
 * same PDF: tbl_client_invoice.file_path_pdf points at legacy files under
 * core.easyfix.in/easydoc/client_invoice/, and the legacy generator stopped
 * in Feb 2018 (no month folder after Feb_2018; the newest stored paths 404).
 * So the portal's PDF link was dead for EVERY invoice, while the admin CRM
 * already rendered this one. Callers own scope; this owns data + rendering.
 */
const { pool } = require('../db');
const logger = require('../logger');
const { renderInvoicePdf } = require('../utils/pdf-invoice');

// Shared helper: load the invoice + client + flat line items used by
// both /excel and /pdf. Keeps the two endpoints in lock-step.
//
// customer_name (2026-08-03): invoice lines are JOB rows, so the name
// shown is the per-job name captured on the booking form
// (tbl_job.job_customer_name), falling back to the customer master only
// when the job-row copy is absent. NULLIF(TRIM(...), '') is required —
// a plain COALESCE would render a BLANK name for a '' job_customer_name,
// which the validators still permit (job.validator.js allows '').
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
                COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name) AS customer_name,
                cu.customer_mob_no, ci.city_name
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
              COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name) AS customer_name,
              cu.customer_mob_no, ci.city_name
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
  const materialsByJob = new Map();
  if (jobIds.length > 0) {
    /*
     * One query for every job on the invoice — see services/job-line-total.js.
     * It also carries the soft-delete policy: this query used to have no
     * job_service_status filter, so invoices billed for services ops had
     * REMOVED. Every other reader in the backend already excluded them.
     *
     * `materials` (Ops-approved quotation_details lines, sub-project E) is now
     * carried through too — see the header-total comment in /invoices/generate
     * below for why billing folds these in the same way the client estimate
     * already does.
     */
    const { estimateLinesForJobs } = require('./job-line-total');
    const byJob = await estimateLinesForJobs(jobIds);
    for (const [jobId, { lines: jobLines, materials: jobMaterials }] of byJob) {
      servicesByJob.set(jobId, jobLines);
      materialsByJob.set(jobId, jobMaterials);
    }
  }

  const lines = [];
  for (const j of jobs) {
    const svcs = servicesByJob.get(j.job_id) || [];
    const mats = materialsByJob.get(j.job_id) || [];
    if (svcs.length === 0 && mats.length === 0) {
      lines.push({
        job_id: j.job_id, job_ref: j.job_reference_id, client_ref: j.client_ref_id,
        customer: j.customer_name, mobile: j.customer_mob_no, city: j.city_name,
        completed_on: j.checkout_date_time,
        service: '—', quantity: 0, unit_charge: 0, material: 0, line_total: 0,
      });
    } else {
      for (const s of svcs) {
        // Values come from the shared helper; nothing is recomputed here.
        const qty = Number(s.quantity || 1);
        const charge = Number(s.total_charge || 0);
        const mat = Number(s.material_charge || 0);
        lines.push({
          job_id: j.job_id, job_ref: j.job_reference_id, client_ref: j.client_ref_id,
          customer: j.customer_name, mobile: j.customer_mob_no, city: j.city_name,
          completed_on: j.checkout_date_time,
          service: s.service_name || '—', quantity: qty,
          unit_charge: charge, material: mat, line_total: s.line_total,
        });
      }
      // One printed line per Ops-approved material (never the technician's
      // unit_price — approvedMaterialLinesForJobs never selects it).
      for (const m of mats) {
        lines.push({
          job_id: j.job_id, job_ref: j.job_reference_id, client_ref: j.client_ref_id,
          customer: j.customer_name, mobile: j.customer_mob_no, city: j.city_name,
          completed_on: j.checkout_date_time,
          service: m.name || 'Material', quantity: Number(m.unit || 1),
          unit_charge: 0, material: m.approved_charge, line_total: m.approved_charge,
        });
      }
    }
  }

  logger.info('Invoice artifact built · invoiceId=' + invoiceId + ' jobs=' + jobs.length + ' lines=' + lines.length);
  return { inv, client: client || { client_name: '—' }, lines };
}

function sendInvoicePdf(res, { inv, client, lines }) {
  // Trimmed, then made header-safe: legacy rows carry ' ' (→ "invoice- .pdf",
  // seen on QA id 1371), and a `"` or `/` in a number would break the header.
  const name = String(inv.invoice_number || '').trim().replace(/[^\w.-]+/g, '_') || String(inv.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${name}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  renderInvoicePdf({ invoice: inv, client, lines, stream: res });
}

module.exports = { loadInvoiceArtifactData, sendInvoicePdf };
