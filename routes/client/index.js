const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const requireSpocAuth = require('../../middleware/client-auth');
const { pool } = require('../../db');
const clientAuth = require('../../services/client-auth.service');
const jobService = require('../../services/job.service');
const { modernOk, modernError } = require('../../utils/response');
const { sendXlsx } = require('../../utils/xlsx-export');
const { STATUS_LABELS } = require('../../services/integration.service');
const emailService = require('../../services/email.service');
const logger = require('../../logger');

// ─── Public: SPOC OTP login ─────────────────────────────────────────
const identifier = Joi.alternatives(Joi.string().email(), Joi.string().pattern(/^[0-9]{10}$/));

router.post('/auth/login-otp', validate(Joi.object({ identifier: identifier.required() })), async (req, res, next) => {
  try {
    logger.info('SPOC login-OTP requested');
    const r = await clientAuth.createLoginOtp(req.body.identifier);
    logger.info('SPOC login-OTP result · delivered=' + (r.found ? 'yes' : 'no'));
    modernOk(res, { delivered: r.found, expiresAt: r.expiresAt || null });
  } catch (e) { logger.error('SPOC login-OTP failed · ' + e.message); next(e); }
});

router.post('/auth/verify-otp', validate(Joi.object({
  identifier: identifier.required(),
  otp: Joi.number().integer().min(1000).max(9999).required(),
})), async (req, res, next) => {
  try {
    logger.info('SPOC verify-OTP attempt');
    const r = await clientAuth.verifyLoginOtp(req.body.identifier, req.body.otp);
    if (!r.ok) {
      logger.warn('SPOC verify-OTP rejected · ' + r.reason);
      return modernError(res, 401, r.reason);
    }
    logger.info('SPOC verify-OTP ok · spocId=' + r.spoc.id + ' clientId=' + r.spoc.client_id);
    // Cookie name matches the frontend localStorage key (`client_auth_token`)
    // so future refresh/CSRF flows can read either source consistently.
    res.cookie('client_auth_token', r.token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400 * 1000 });
    modernOk(res, { token: r.token, spoc: { id: r.spoc.id, name: r.spoc.contact_name, client_id: r.spoc.client_id } });
  } catch (e) { logger.error('SPOC verify-OTP failed · ' + e.message); next(e); }
});

// ─── Protected ──────────────────────────────────────────────────────
router.use(requireSpocAuth);

router.get('/me', (req, res) => modernOk(res, { spoc: req.spoc }));

/*
 * GET /api/client/me/custom-properties
 *
 * Per-tenant extra fields configured in tbl_client_custom_properties.
 * Mirrors the admin /clients/:clientId/custom-properties normalisation
 * (column-name variants, mandatory flag coercion) but scoped to the
 * authenticated SPOC's own client_id. Powers the dynamic "Custom
 * Properties" section of the New Order form.
 *
 * Response: { items: [{ name, label, mandatory }] }
 *  - name      lowercased + trimmed, used as the stable key
 *  - label     display string; falls back to humanized `name` on FE
 *  - mandatory boolean, drives required-field validation
 */
router.get('/me/custom-properties', async (req, res, next) => {
  try {
    logger.info('Fetch client custom-properties · clientId=' + req.spoc.client_id);
    const [rows] = await pool.query(
      'SELECT * FROM tbl_client_custom_properties WHERE client_id = ?',
      [req.spoc.client_id]
    );
    logger.info('Found ' + rows.length + ' custom-property rows');
    const truthy = (v) => {
      if (v == null) return false;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      const s = String(v).trim().toLowerCase();
      return s === '1' || s === 'true' || s === 'yes' || s === 'y';
    };
    const items = rows.map((r) => ({
      name: String(r.property_name ?? r.name ?? r.key ?? r.field_name ?? '').toLowerCase().trim(),
      label: r.property_label ?? r.label ?? r.display_name ?? r.property_name ?? null,
      mandatory: truthy(r.is_mandatory ?? r.mandatory ?? r.required ?? r.is_required ?? r.is_required_field),
    })).filter((p) => p.name);
    logger.info('Returning ' + items.length + ' custom-properties');
    modernOk(res, { items });
  } catch (e) { next(e); }
});

// Service categories scoped to the SPOC's client. Reads tbl_client_service
// (joined with tbl_service_catg) so each tenant sees only the categories
// they've actually contracted for. Powers the "New Order" form dropdown
// and keeps parity with the legacy /clients/{id}/service-categories route.
router.get('/lookup/service-categories', async (req, res, next) => {
  try {
    logger.info('Fetch client service-categories · clientId=' + req.spoc.client_id);
    const lookup = require('../../services/lookup.service');
    const services = await lookup.clientServices({ clientId: req.spoc.client_id });
    const seen = new Map();
    for (const s of services) {
      if (s.service_catg_id && !seen.has(s.service_catg_id)) {
        seen.set(s.service_catg_id, { id: s.service_catg_id, name: s.service_catg_name });
      }
    }
    const items = Array.from(seen.values()).sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || '')));
    logger.info('Returning ' + items.length + ' service-categories');
    modernOk(res, { items });
  } catch (e) { next(e); }
});

router.get('/dashboard', async (req, res, next) => {
  try {
    logger.info('Fetch client dashboard stats · clientId=' + req.spoc.client_id);
    const [[stats]] = await pool.query(`
      SELECT
        SUM(CASE WHEN job_status IN (0,7,9) THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN job_status = 1 THEN 1 ELSE 0 END) AS scheduled,
        SUM(CASE WHEN job_status = 2 THEN 1 ELSE 0 END) AS inProgress,
        SUM(CASE WHEN job_status IN (3,5) THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN job_status = 6 THEN 1 ELSE 0 END) AS cancelled,
        COUNT(*) AS total
       FROM tbl_job WHERE fk_client_id = ?`, [req.spoc.client_id]);
    modernOk(res, stats);
  } catch (e) { next(e); }
});

router.get('/jobs', async (req, res, next) => {
  try {
    logger.info('List client jobs · status=' + (req.query.status ?? 'all') + ' q=' + (req.query.q || '-') + ' limit=' + (Math.min(Number(req.query.limit) || 50, 500)) + ' offset=' + (Number(req.query.offset) || 0));
    const { rows, total } = await jobService.list({
      clientId: req.spoc.client_id,
      status: req.query.status != null ? Number(req.query.status) : undefined,
      q: req.query.q,
      limit: Math.min(Number(req.query.limit) || 50, 500),
      offset: Number(req.query.offset) || 0,
    });
    logger.info('Returning ' + rows.length + ' jobs (total=' + total + ')');
    modernOk(res, { items: rows, total });
  } catch (e) { next(e); }
});

// Bulk upload sub-router (POST /jobs/upload + GET /jobs/upload-template).
// Declared BEFORE /jobs/:id so Express matches the literal `upload`
// segment first — `/jobs/:id` would otherwise capture "upload" as the id.
router.use('/jobs', require('./jobs-upload'));

router.get('/jobs/:id', async (req, res, next) => {
  try {
    logger.info('Fetch client job · id=' + req.params.id);
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) {
      logger.warn('Client job not found / not owned · id=' + req.params.id);
      return modernError(res, 404, 'job not found');
    }
    modernOk(res, job);
  } catch (e) { next(e); }
});

// Approve / reject / escalate
router.patch('/jobs/:id/approve', async (req, res, next) => {
  try {
    logger.info('SPOC approve job · id=' + req.params.id);
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) {
      logger.warn('Approve target not found / not owned · id=' + req.params.id);
      return modernError(res, 404, 'job not found');
    }
    await pool.query('UPDATE tbl_job SET approved_by_client_contact = ?, approved_on_date_time = NOW() WHERE job_id = ?',
      [req.spoc.id, job.job_id]);
    logger.info('Job approved by client · id=' + job.job_id);
    modernOk(res, await jobService.getById(job.job_id), 'approved');
  } catch (e) { next(e); }
});

router.patch('/jobs/:id/reject', validate(Joi.object({ reason: Joi.string().min(3).max(500).required() })), async (req, res, next) => {
  try {
    logger.info('SPOC reject job · id=' + req.params.id);
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) {
      logger.warn('Reject target not found / not owned · id=' + req.params.id);
      return modernError(res, 404, 'job not found');
    }
    await pool.query(
      'UPDATE tbl_job SET approval_reject_reason = ?, approval_reject_date_time = NOW() WHERE job_id = ?',
      [req.body.reason, job.job_id]);
    // Fire escalation email to ops + the owner (legacy
    // sendemailClitoClientUrgentRequest replacement). Non-blocking —
    // failure here must not block the API response.
    fireRejectEscalation(job, req.body.reason, req.spoc).catch(() => {});
    logger.info('Job rejected by client · id=' + job.job_id);
    modernOk(res, await jobService.getById(job.job_id), 'rejected');
  } catch (e) { next(e); }
});

// Estimate approve/reject — legacy stored in approve_job_doc workflow.
// Refuse approval on terminal states (cancelled / completed) and on
// estimates already responded to. Mirrors legacy idempotency guards.
router.patch('/jobs/:id/estimate/approve', async (req, res, next) => {
  try {
    logger.info('SPOC approve estimate · id=' + req.params.id);
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) {
      logger.warn('Estimate-approve target not found / not owned · id=' + req.params.id);
      return modernError(res, 404, 'job not found');
    }
    if ([3, 5, 6].includes(job.job_status)) {
      logger.warn('Estimate-approve blocked · id=' + job.job_id + ' status=' + job.job_status);
      return modernError(res, 409, `cannot approve estimate on a ${job.job_status === 6 ? 'cancelled' : 'completed'} job`);
    }
    if (job.approved_on_date_time) {
      logger.warn('Estimate-approve blocked · already approved · id=' + job.job_id);
      return modernError(res, 409, 'estimate already approved');
    }
    if (job.approval_reject_date_time) {
      logger.warn('Estimate-approve blocked · already rejected · id=' + job.job_id);
      return modernError(res, 409, 'estimate already rejected; cannot approve');
    }
    await pool.query(
      'UPDATE tbl_job SET approved_by_client_contact = ?, approved_on_date_time = NOW() WHERE job_id = ?',
      [req.spoc.id, job.job_id]);
    logger.info('Estimate approved · id=' + job.job_id);
    modernOk(res, { approved: true });
  } catch (e) { next(e); }
});

router.patch('/jobs/:id/estimate/reject', validate(Joi.object({ reason: Joi.string().min(3).max(500).required() })), async (req, res, next) => {
  try {
    logger.info('SPOC reject estimate · id=' + req.params.id);
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) {
      logger.warn('Estimate-reject target not found / not owned · id=' + req.params.id);
      return modernError(res, 404, 'job not found');
    }
    if ([3, 5, 6].includes(job.job_status)) {
      logger.warn('Estimate-reject blocked · id=' + job.job_id + ' status=' + job.job_status);
      return modernError(res, 409, `cannot reject estimate on a ${job.job_status === 6 ? 'cancelled' : 'completed'} job`);
    }
    if (job.approved_on_date_time) {
      logger.warn('Estimate-reject blocked · already approved · id=' + job.job_id);
      return modernError(res, 409, 'estimate already approved; cannot reject');
    }
    if (job.approval_reject_date_time) {
      logger.warn('Estimate-reject blocked · already rejected · id=' + job.job_id);
      return modernError(res, 409, 'estimate already rejected');
    }
    await pool.query(
      'UPDATE tbl_job SET approval_reject_reason = ?, approval_reject_date_time = NOW() WHERE job_id = ?',
      [req.body.reason, job.job_id]);
    fireRejectEscalation(job, req.body.reason, req.spoc).catch(() => {});
    logger.info('Estimate rejected · id=' + job.job_id);
    modernOk(res, { rejected: true });
  } catch (e) { next(e); }
});

/**
 * Escalation email on SPOC rejection.
 * Replaces legacy `sendemailClitoClientUrgentRequest` — that legacy
 * variant was a hardcoded Snapdeal one-off blast (now retired). This
 * is the generic, per-rejection notification.
 *
 * Recipients: owner of the job + a fixed ops mailbox (env override).
 */
async function fireRejectEscalation(job, reason, spoc) {
  const ownerEmail = job.owner_email
    || (await pool.query('SELECT official_email FROM tbl_user WHERE user_id = ?', [job.job_owner]))[0]?.[0]?.official_email;
  const opsMailbox = process.env.OPS_ESCALATION_INBOX || 'ops@easyfix.in';
  const to = [opsMailbox];
  if (ownerEmail) to.push(ownerEmail);
  const subject = `[Rejected by client] Job #${job.job_id} ${job.client_ref_id ? `(${job.client_ref_id})` : ''}`;
  const text = `The client SPOC ${spoc.contact_name || spoc.id} has rejected the job/estimate.\n\n`
    + `Job: ${job.job_id}\n`
    + `Client: ${job.client_name || job.fk_client_id}\n`
    + `Customer: ${job.customer_name || ''} (${job.customer_mob_no || ''})\n\n`
    + `Reason given: ${reason}\n\n`
    + `Please follow up.`;
  logger.info('Sending reject-escalation email · jobId=' + job.job_id + ' recipients=' + to.length);
  return emailService.send({ to, subject, text, category: 'client.reject' });
}

// Create job as SPOC (reuses internal service; fk_client_id locked to SPOC's client)
router.post('/jobs', async (req, res, next) => {
  try {
    logger.info('SPOC create job · clientId=' + req.spoc.client_id + ' type=' + (req.body?.job_type || '-'));
    const created = await jobService.create({ ...req.body, fk_client_id: req.spoc.client_id }, { user_id: null });
    logger.info('Job created · id=' + created.job_id);
    res.status(201);
    modernOk(res, created, 'job created');
  } catch (e) {
    if (e.status) {
      logger.warn('SPOC create job rejected · ' + e.message);
      return modernError(res, e.status, e.message);
    }
    next(e);
  }
});

router.get('/profile', async (req, res, next) => {
  try {
    logger.info('Fetch SPOC profile · spocId=' + req.spoc.id);
    const [[profile]] = await pool.query(
      'SELECT id, contact_name, contact_email, contact_no, contact_alt_no, contact_desgn, linkedIn_profile FROM tbl_client_contacts WHERE id = ?',
      [req.spoc.id]);
    modernOk(res, profile);
  } catch (e) { next(e); }
});

router.put('/profile', async (req, res, next) => {
  try {
    logger.info('Update SPOC profile · spocId=' + req.spoc.id);
    const { contact_name, contact_alt_no, contact_desgn, linkedIn_profile } = req.body || {};
    await pool.query(
      `UPDATE tbl_client_contacts
          SET contact_name = COALESCE(?, contact_name),
              contact_alt_no = COALESCE(?, contact_alt_no),
              contact_desgn = COALESCE(?, contact_desgn),
              linkedIn_profile = COALESCE(?, linkedIn_profile)
        WHERE id = ?`,
      [contact_name, contact_alt_no, contact_desgn, linkedIn_profile, req.spoc.id]);
    logger.info('SPOC profile updated · spocId=' + req.spoc.id);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

router.get('/contacts/managers', async (req, res, next) => {
  try {
    logger.info('List client contact-managers · clientId=' + req.spoc.client_id);
    const [rows] = await pool.query(
      `SELECT id, contact_name, contact_email, contact_no
         FROM tbl_client_contacts WHERE client_id = ? AND status = 1 ORDER BY contact_name`,
      [req.spoc.client_id]);
    logger.info('Returning ' + rows.length + ' contact-managers');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

// ─── /client/export/jobs — Excel download ────────────────────────────
// Streams matching jobs as a real .xlsx file (replaces the previous JSON
// preview). Column set mirrors what the SPOC sees in the dashboard table.
// Status code is converted to legacy label so the spreadsheet reads
// naturally to non-technical recipients.
router.get('/export/jobs', async (req, res, next) => {
  try {
    logger.info('Export client jobs to xlsx · status=' + (req.query.status ?? 'all') + ' from=' + (req.query.startDate || '-') + ' to=' + (req.query.endDate || '-'));
    const { rows } = await jobService.list({
      clientId: req.spoc.client_id,
      status: req.query.status != null ? Number(req.query.status) : undefined,
      q: req.query.q,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      limit: 5000, // hard cap; SPOC exports rarely exceed a few hundred
    });
    logger.info('Exporting ' + rows.length + ' jobs to xlsx');
    const data = rows.map((r) => ({
      ...r,
      status_label: STATUS_LABELS[r.job_status] || 'Unknown',
    }));
    const ts = new Date().toISOString().slice(0, 10);
    sendXlsx(res, {
      filename: `easyfix-jobs-${ts}.xlsx`,
      sheetName: 'Jobs',
      columns: [
        { key: 'job_id',              header: 'Job ID',          width: 10 },
        { key: 'job_reference_id',    header: 'Reference',       width: 16 },
        { key: 'client_ref_id',       header: 'Client Ref',      width: 16 },
        { key: 'status_label',        header: 'Status',          width: 14 },
        { key: 'job_type',            header: 'Type',            width: 14 },
        { key: 'job_desc',            header: 'Description',     width: 40 },
        { key: 'customer_name',       header: 'Customer',        width: 22 },
        { key: 'customer_mob_no',     header: 'Mobile',          width: 14 },
        { key: 'city_name',           header: 'City',            width: 14 },
        { key: 'easyfixer_name',      header: 'Easyfixer',       width: 22 },
        { key: 'owner_name',          header: 'Owner',           width: 18 },
        { key: 'created_date_time',   header: 'Created',         width: 18 },
        { key: 'requested_date_time', header: 'Requested',       width: 18 },
        { key: 'scheduled_date_time', header: 'Scheduled',       width: 18 },
        { key: 'checkin_date_time',   header: 'Checked In',      width: 18 },
        { key: 'checkout_date_time',  header: 'Checked Out',     width: 18 },
      ],
      rows: data,
    });
  } catch (e) { next(e); }
});

// ─── /client/jobs/:id/estimate-preview ───────────────────────────────
// Mirrors the legacy `requestApproval` action (JobAction.java:1706):
// returns the per-service breakdown + grand total so the SPOC can
// preview the estimate before hitting /estimate/approve.
//
// VERIFIED 2026-05-12 against EasyFix_CRM JobDaoImpl.java:2560:
//   tbl_job_services columns (full list):
//     job_service_id (PK), job_id, service_id, service_type_id,
//     service_category_id, quantity, total_charge, easyfix_charge,
//     easyfixer_charge, client_charge, job_charge_type,
//     service_charge_description, material_charge, job_service_status
//   Service name comes from a 2-hop join:
//     tbl_job_services.service_id → tbl_client_service.client_service_id
//     tbl_client_service.rate_card_id → tbl_client_rate_card.crc_id
//                                       → crc_ratecard_name
//   Approval-pending filter is `job_service_status = 1` (legacy: the
//   `serviceStatus` arg to `getJobServiceList`).
//
// IMPORTANT: legacy column is `material_charge`, NOT
// `service_material_charge` (the latter is the Java POJO field name).
router.get('/jobs/:id/estimate-preview', async (req, res, next) => {
  try {
    const jobId = Number(req.params.id);
    logger.info('Build estimate-preview · jobId=' + jobId);
    const job = await jobService.getById(jobId);
    if (!job || job.fk_client_id !== req.spoc.client_id) {
      logger.warn('Estimate-preview target not found / not owned · id=' + req.params.id);
      return modernError(res, 404, 'job not found');
    }

    const [services] = await pool.query(
      `SELECT js.job_service_id, js.job_id, js.service_id,
              js.quantity, js.total_charge, js.material_charge,
              js.easyfix_charge, js.easyfixer_charge, js.client_charge,
              js.job_charge_type, js.service_charge_description,
              js.job_service_status,
              CR.crc_ratecard_name AS service_name
         FROM tbl_job_services js
         LEFT JOIN tbl_client_service   CS ON CS.client_service_id = js.service_id
         LEFT JOIN tbl_client_rate_card CR ON CR.crc_id = CS.rate_card_id
        WHERE js.job_id = ? AND js.job_service_status = 1
        ORDER BY js.job_service_id ASC`,
      [jobId]
    );
    logger.info('Found ' + services.length + ' approval-pending services');

    // Legacy formula: per-row total = (total_charge × quantity) + material_charge
    const lines = services.map((s) => {
      const totalCharge = Number(s.total_charge || 0);
      const qty = Number(s.quantity || 1);
      const material = Number(s.material_charge || 0);
      return { ...s, line_total: totalCharge * qty + material };
    });
    const grandTotal = lines.reduce((sum, l) => sum + l.line_total, 0);

    modernOk(res, {
      job_id: jobId,
      services: lines,
      totals: {
        services_subtotal: lines.reduce((s, l) => s + Number(l.total_charge || 0) * Number(l.quantity || 1), 0),
        material_subtotal: lines.reduce((s, l) => s + Number(l.material_charge || 0), 0),
        grand_total: grandTotal,
      },
      already_approved: job.approved_on_date_time != null,
      already_rejected: job.approval_reject_date_time != null,
    });
  } catch (e) { next(e); }
});

module.exports = router;
