const router = require('express').Router();
const Joi = require('joi');
const logger = require('../../logger');
const validate = require('../../middleware/validate');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const { buildRequestScope, cityScopeSql, assertEntityInScope } = require('../../lib/scope');

// Helper: load an advance + its scope-relevant fields (client/vertical/city).
async function loadAdvanceForScope(advanceId) {
  const [[row]] = await pool.query(
    `SELECT a.advance_id, a.client_id, a.efr_id,
            cl.vertical_id, e.efr_cityId AS city_id
       FROM tbl_efr_advance_payment a
       LEFT JOIN tbl_client    cl ON cl.client_id = a.client_id
       LEFT JOIN tbl_easyfixer e  ON e.efr_id     = a.efr_id
      WHERE a.advance_id = ? AND NOT (e.efr_status <=> 3) LIMIT 1`,
    [advanceId]
  );
  return row || null;
}

async function scopedAdvance(req, res, next) {
  try {
    const row = await loadAdvanceForScope(req.params.id);
    if (!row) {
      logger.warn('Advance scope check · advance not found · id=' + req.params.id);
      return modernError(res, 404, 'advance not found');
    }
    const guard = assertEntityInScope(req, {
      client_id: row.client_id,
      city_id: row.city_id,
      vertical_id: row.vertical_id,
    });
    if (!guard.ok) {
      logger.warn('Advance scope check · advance outside scope · id=' + req.params.id);
      return modernError(res, 404, 'advance not found');
    }
    req.scopedAdvance = row;
    return next();
  } catch (e) { next(e); }
}

/*
 * Advance Payment audit workflow on `tbl_efr_advance_payment`.
 *
 * State machine via `adv_status`:
 *   0 = pending / initiated by PM
 *   1 = ops approved (mid-state)
 *   2 = finance approved (terminal)
 *   3 = rejected (by ops or finance)
 *
 * VERIFIED 2026-05-12 against live INFORMATION_SCHEMA:
 *   tbl_efr_advance_payment columns:
 *     advance_id (PK), client_id, job_id, efr_id,
 *     adv_status,
 *     job_total_amt, advance_amt,
 *     initiated_on, initiated_by, pm_remarks,
 *     ops_action_on, ops_action_by, ops_remarks,
 *     fin_action_on, fin_action_by, fin_remarks,
 *     supporting_document, updated_on, updated_by, transaction_id
 */

// ─── GET /admin/advances — list with easyfixer + client join ────────
router.get('/', async (req, res, next) => {
  try {
    const { status, efrId, jobId } = req.query;
    logger.info('Listing advance payments · status=' + (status ?? 'all') + ' efrId=' + (efrId ?? 'any') + ' jobId=' + (jobId ?? 'any'));
    const clauses = [];
    const params = [];
    // RBAC: scope by client (manage_clients) + city (manage_cities via
    // joined efr.efr_cityId) + vertical (joined cl.vertical_id).
    const scope = buildRequestScope(req);
    if (scope) {
      const c = scope.clients, ci = scope.cities, v = scope.verticals;
      if (c.mode === 'none' || ci.mode === 'none' || v.mode === 'none') clauses.push('1=0');
      if (c.mode === 'allow' && c.ids.length) {
        clauses.push(`a.client_id IN (${c.ids.map(() => '?').join(',')})`); params.push(...c.ids);
      }
      if (ci.mode === 'allow' && ci.ids.length) {
        clauses.push(cityScopeSql('e.efr_cityId', 'e.efr_id', ci.ids)); params.push(...ci.ids);
      }
      if (v.mode === 'allow' && v.ids.length) {
        clauses.push(`c.vertical_id IN (${v.ids.map(() => '?').join(',')})`); params.push(...v.ids);
      }
    }
    if (status != null && status !== '') {
      clauses.push('a.adv_status = ?');
      params.push(Number(status));
    }
    if (efrId != null && efrId !== '') {
      clauses.push('a.efr_id = ?');
      params.push(Number(efrId));
    }
    // Billing & Charges tab reads a single job's advances via ?jobId=<id>.
    if (jobId != null && jobId !== '') {
      clauses.push('a.job_id = ?');
      params.push(Number(jobId));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    params.push(limit, offset);

    const [rows] = await pool.query(
      `SELECT a.advance_id, a.client_id, a.job_id, a.efr_id,
              a.adv_status, a.job_total_amt, a.advance_amt,
              a.initiated_on, a.initiated_by, a.pm_remarks,
              a.ops_action_on, a.ops_action_by, a.ops_remarks,
              a.fin_action_on, a.fin_action_by, a.fin_remarks,
              a.supporting_document, a.updated_on, a.updated_by, a.transaction_id,
              e.efr_name, e.efr_no,
              c.client_name
         FROM tbl_efr_advance_payment a
         LEFT JOIN tbl_easyfixer e ON e.efr_id    = a.efr_id
         LEFT JOIN tbl_client    c ON c.client_id = a.client_id
         ${where}
        ORDER BY a.advance_id DESC
        LIMIT ? OFFSET ?`,
      params
    );
    logger.info('Found ' + rows.length + ' advance payments');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

// ─── GET /admin/advances/:id — detail ───────────────────────────────
router.get('/:id', scopedAdvance, async (req, res, next) => {
  try {
    logger.info('Fetching advance detail · id=' + req.params.id);
    const [[row]] = await pool.query(
      `SELECT a.*, e.efr_name, e.efr_no, c.client_name
         FROM tbl_efr_advance_payment a
         LEFT JOIN tbl_easyfixer e ON e.efr_id    = a.efr_id
         LEFT JOIN tbl_client    c ON c.client_id = a.client_id
        WHERE a.advance_id = ?`,
      [Number(req.params.id)]
    );
    if (!row) return modernError(res, 404, 'advance not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});

// ─── POST /admin/advances — PM initiates an advance ─────────────────
router.post('/', validate(Joi.object({
  jobId: Joi.number().integer().positive().required(),
  efrId: Joi.number().integer().positive().required(),
  clientId: Joi.number().integer().positive().optional(),
  advanceAmt: Joi.number().positive().required(),
  jobTotalAmt: Joi.number().min(0).required(),
  pmRemarks: Joi.string().max(1000).allow('', null).optional(),
  supportingDocument: Joi.string().max(255).allow('', null).optional(),
})), async (req, res, next) => {
  try {
    const b = req.body;
    logger.info('Initiating advance · jobId=' + b.jobId + ' efrId=' + b.efrId + ' advanceAmt=' + b.advanceAmt);
    let clientId = b.clientId;
    if (clientId == null) {
      const [[job]] = await pool.query(
        'SELECT fk_client_id FROM tbl_job WHERE job_id = ?',
        [b.jobId]
      );
      if (job && job.fk_client_id != null) clientId = job.fk_client_id;
    }
    // RBAC: caller's scope must cover the client + the efr's city.
    const [[efr]] = await pool.query(
      'SELECT efr_cityId FROM tbl_easyfixer WHERE efr_id = ? AND NOT (efr_status <=> 3)',
      [b.efrId]
    );
    const guard = assertEntityInScope(req, {
      client_id: clientId,
      city_id: efr?.efr_cityId,
    });
    if (!guard.ok) {
      logger.warn('Advance initiate blocked · client or easyfixer outside scope · efrId=' + b.efrId);
      return modernError(res, 403, 'client or easyfixer outside your scope');
    }
    const [ins] = await pool.query(
      `INSERT INTO tbl_efr_advance_payment
         (client_id, job_id, efr_id, adv_status,
          job_total_amt, advance_amt,
          initiated_on, initiated_by, pm_remarks,
          supporting_document, updated_on, updated_by)
       VALUES (?, ?, ?, 0, ?, ?, NOW(), ?, ?, ?, NOW(), ?)`,
      [
        clientId || null,
        b.jobId,
        b.efrId,
        b.jobTotalAmt,
        b.advanceAmt,
        req.user.user_id,
        b.pmRemarks || null,
        b.supportingDocument || null,
        req.user.user_id,
      ]
    );
    logger.info('Advance created · id=' + ins.insertId + ' status=0');
    res.status(201);
    modernOk(res, { advanceId: ins.insertId, status: 0 }, 'advance initiated');
  } catch (e) { next(e); }
});

// ─── POST /admin/advances/:id/ops-approve — moves to status 1 ───────
router.post('/:id/ops-approve', validate(Joi.object({
  remarks: Joi.string().max(1000).allow('', null).optional(),
})), scopedAdvance, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    logger.info('Ops-approving advance · id=' + id);
    const [[row]] = await pool.query(
      'SELECT adv_status FROM tbl_efr_advance_payment WHERE advance_id = ?',
      [id]
    );
    if (!row) return modernError(res, 404, 'advance not found');
    if (Number(row.adv_status) !== 0) {
      logger.warn('Ops-approve rejected · advance not pending · id=' + id + ' status=' + row.adv_status);
      return modernError(res, 409, `advance is not pending (current status ${row.adv_status})`);
    }
    const [r] = await pool.query(
      `UPDATE tbl_efr_advance_payment
          SET adv_status = 1,
              ops_action_on = NOW(),
              ops_action_by = ?,
              ops_remarks = ?,
              updated_on = NOW(),
              updated_by = ?
        WHERE advance_id = ? AND adv_status = 0`,
      [req.user.user_id, req.body.remarks || null, req.user.user_id, id]
    );
    if (r.affectedRows === 0) {
      logger.warn('Ops-approve lost race · advance no longer pending · id=' + id);
      return modernError(res, 409, 'advance is not pending (state changed concurrently)');
    }
    logger.info('Advance updated · id=' + id + ' status=1 (ops approved)');
    modernOk(res, { approvedBy: 'ops', status: 1 });
  } catch (e) { next(e); }
});

// ─── POST /admin/advances/:id/fin-approve — moves to status 2 ───────
router.post('/:id/fin-approve', validate(Joi.object({
  remarks: Joi.string().max(1000).allow('', null).optional(),
  transactionId: Joi.string().max(100).allow('', null).optional(),
})), scopedAdvance, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    logger.info('Finance-approving advance · id=' + id);
    const [[row]] = await pool.query(
      'SELECT adv_status FROM tbl_efr_advance_payment WHERE advance_id = ?',
      [id]
    );
    if (!row) return modernError(res, 404, 'advance not found');
    if (Number(row.adv_status) !== 1) {
      logger.warn('Finance-approve rejected · advance not ops-approved · id=' + id + ' status=' + row.adv_status);
      return modernError(res, 409, `advance is not in ops-approved state (current status ${row.adv_status})`);
    }
    const [r] = await pool.query(
      `UPDATE tbl_efr_advance_payment
          SET adv_status = 2,
              fin_action_on = NOW(),
              fin_action_by = ?,
              fin_remarks = ?,
              transaction_id = ?,
              updated_on = NOW(),
              updated_by = ?
        WHERE advance_id = ? AND adv_status = 1`,
      [
        req.user.user_id,
        req.body.remarks || null,
        req.body.transactionId || null,
        req.user.user_id,
        id,
      ]
    );
    if (r.affectedRows === 0) {
      logger.warn('Finance-approve lost race · advance no longer ops-approved · id=' + id);
      return modernError(res, 409, 'advance is not in ops-approved state (state changed concurrently)');
    }
    logger.info('Advance updated · id=' + id + ' status=2 (finance approved)');
    modernOk(res, { approvedBy: 'finance', status: 2 });
  } catch (e) { next(e); }
});

// ─── POST /admin/advances/:id/reject — moves to status 3 ────────────
// Stamps ops_* fields when rejecting from pending state, fin_* fields
// when rejecting from ops-approved state. Already-terminal advances
// (status 2 or 3) cannot be rejected.
router.post('/:id/reject', validate(Joi.object({
  remarks: Joi.string().max(1000).allow('', null).optional(),
})), scopedAdvance, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    logger.info('Rejecting advance · id=' + id);
    const [[row]] = await pool.query(
      'SELECT adv_status FROM tbl_efr_advance_payment WHERE advance_id = ?',
      [id]
    );
    if (!row) return modernError(res, 404, 'advance not found');
    const current = Number(row.adv_status);
    if (current !== 0 && current !== 1) {
      logger.warn('Reject blocked · advance is terminal · id=' + id + ' status=' + current);
      return modernError(res, 409, `advance cannot be rejected from current status ${current}`);
    }
    const sql = current === 0
      ? `UPDATE tbl_efr_advance_payment
            SET adv_status = 3,
                ops_action_on = NOW(),
                ops_action_by = ?,
                ops_remarks = ?,
                updated_on = NOW(),
                updated_by = ?
          WHERE advance_id = ? AND adv_status = 0`
      : `UPDATE tbl_efr_advance_payment
            SET adv_status = 3,
                fin_action_on = NOW(),
                fin_action_by = ?,
                fin_remarks = ?,
                updated_on = NOW(),
                updated_by = ?
          WHERE advance_id = ? AND adv_status = 1`;
    const [r] = await pool.query(sql, [
      req.user.user_id,
      req.body.remarks || null,
      req.user.user_id,
      id,
    ]);
    if (r.affectedRows === 0) {
      logger.warn('Reject lost race · advance state changed concurrently · id=' + id);
      return modernError(res, 409, 'advance cannot be rejected (state changed concurrently)');
    }
    logger.info('Advance updated · id=' + id + ' status=3 (rejected by ' + (current === 0 ? 'ops' : 'finance') + ')');
    modernOk(res, { rejected: true, rejectedBy: current === 0 ? 'ops' : 'finance', status: 3 });
  } catch (e) { next(e); }
});

module.exports = router;
