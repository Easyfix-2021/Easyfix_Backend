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
 * State machine via `adv_status` — LEGACY-COMPATIBLE (1..5).
 *
 * The legacy Struts CRM is STILL LIVE and still writes this same table, so
 * these numbers are its numbers. Verified against
 * EasyFix_CRM/src/main/java/com/easyfix/Jobs/dao/impl/AdvanceDaoImpl.java:429
 * (the adv_status -> label ladder) and pages/jobs/getAllAdvanceListByJobId.vm
 * (which renders one row per stage off the same values):
 *
 *   1 = Initiated           - raised by the PM, awaiting Ops
 *   2 = Pending To Finance  - Ops approved, awaiting Finance
 *   3 = Rejected by Ops     (terminal)
 *   4 = Advance Done        - Finance paid (terminal)
 *   5 = Rejected by Finance (terminal)
 *
 * This file previously used an invented 0/1/2/3 ladder on the SAME column,
 * which silently collided with legacy's: a legacy "Initiated" (1) displayed
 * as "Ops Approved", a legacy "Pending To Finance" (2) displayed as "Finance
 * Approved", ops-approve 409'd on every legacy row (it required 0, a value
 * legacy never writes), and finance-approve accepted 1 - a request Ops had
 * never seen. Do not renumber without changing the legacy CRM in the same
 * release.
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
const ADV_STATUS = {
  INITIATED: 1,
  PENDING_TO_FINANCE: 2,
  REJECTED_BY_OPS: 3,
  ADVANCE_DONE: 4,
  REJECTED_BY_FINANCE: 5,
};

/* Legacy's own wording (AdvanceDaoImpl.java:429) — used by the export so the
   spreadsheet reads like the screen. */
const ADV_STATUS_LABEL = {
  [ADV_STATUS.INITIATED]: 'Initiated',
  [ADV_STATUS.PENDING_TO_FINANCE]: 'Pending To Finance',
  [ADV_STATUS.REJECTED_BY_OPS]: 'Rejected by Ops',
  [ADV_STATUS.ADVANCE_DONE]: 'Advance Done',
  [ADV_STATUS.REJECTED_BY_FINANCE]: 'Rejected by Finance',
};

/*
 * Max advance a job may carry = 60% of the job's client-side total, rounded
 * to 1 decimal. Legacy AdvanceDaoImpl.findAdvanceByJobIdAndStatus():
 *   float maxAdvanceAllowed  = jobTotalAmount * 0.60f;
 *   float maxAdvanceAllowedR = Math.round(maxAdvanceAllowed * 10) / 10.0f;
 *
 * Legacy only enforced this in the browser - validateAdvanceRequest() toggled
 * a warning span and nothing stopped the save - so the cap has never actually
 * held. It is enforced here, against a total computed server-side from the
 * same charges the Billing tab renders: taking the total from the request
 * body would make the cap self-defeating.
 *
 * Skipped when the job has no costed charges yet (total 0). Legacy allowed an
 * advance on such a job and the PM workflow depends on that; blocking it here
 * would be a regression, not a fix.
 */
const MAX_ADVANCE_FRACTION = 0.60;

function roundToOneDecimal(v) {
  return Math.round(v * 10) / 10;
}

/* Client-side job total, summed exactly as the Billing & Charges matrix does:
   service lines + the typed job_material rows (Travel/Incentive/Penalty). */
async function jobTotalClientCharge(jobId) {
  const { getCharges } = require('../../services/job-charges.service');
  const { services, materials } = await getCharges(jobId);
  const sum = (rows) => rows.reduce((t, r) => t + (Number(r.client_charge) || 0), 0);
  return sum(services) + sum(materials);
}

/*
 * Audit Advance list filters — legacy findAllAdvanceList()
 * (EasyFix_CRM AdvanceDaoImpl.java:332). Shared by the list and the export so
 * the spreadsheet can never disagree with the screen it was exported from.
 *
 * Legacy's own filter set, preserved exactly:
 *   status    EAP.adv_status
 *   jobStatus 1 = open (NOT IN 3,5,6,7) · 2 = completed (3,5) · 3 = closed (6,7)
 *   cityId    the TECHNICIAN's city (TCY.city_id via EFR.efr_cityId), not the job's
 *   ndmId     TCY.state_user — the NDM owning that city
 *   pmId      EAP.initiated_by — who raised it
 *   dateFrom/dateTo  matches when ANY of initiated_on / ops_action_on /
 *                    fin_action_on falls in range, so a row surfaces on the
 *                    date it was acted on, not only the date it was raised
 *
 * Legacy string-concatenated every one of these into the SQL. They are bound
 * parameters here.
 */
function buildAdvanceFilters(req) {
  const { status, efrId, jobId, jobStatus, cityId, ndmId, pmId, dateFrom, dateTo } = req.query;
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

  const eq = (value, sql) => {
    if (value == null || value === '') return;
    clauses.push(sql); params.push(Number(value));
  };
  eq(status, 'a.adv_status = ?');
  eq(efrId, 'a.efr_id = ?');
  // Billing & Charges tab reads a single job's advances via ?jobId=<id>.
  eq(jobId, 'a.job_id = ?');
  eq(cityId, 'ci.city_id = ?');
  eq(ndmId, 'ci.state_user = ?');
  eq(pmId, 'a.initiated_by = ?');

  const js = Number(jobStatus);
  if (js === 1) clauses.push('j.job_status NOT IN (3, 5, 6, 7)');
  else if (js === 2) clauses.push('j.job_status IN (3, 5)');
  else if (js === 3) clauses.push('j.job_status IN (6, 7)');

  if (dateFrom && dateTo) {
    clauses.push(`((a.initiated_on  BETWEEN ? AND ?)
                OR (a.ops_action_on BETWEEN ? AND ?)
                OR (a.fin_action_on BETWEEN ? AND ?))`);
    const from = `${dateFrom} 00:00:00`;
    const to = `${dateTo} 23:59:59`;
    params.push(from, to, from, to, from, to);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/* FROM + joins, shared by the row SELECT and the COUNT so a filter can never
   apply to one and not the other. */
const ADVANCE_FROM = `
    FROM tbl_efr_advance_payment a
    LEFT JOIN tbl_easyfixer e ON e.efr_id    = a.efr_id
    LEFT JOIN tbl_client    c ON c.client_id = a.client_id
    LEFT JOIN tbl_city     ci ON ci.city_id  = e.efr_cityId
    LEFT JOIN tbl_job       j ON j.job_id    = a.job_id
    LEFT JOIN tbl_user     ui ON ui.user_id  = a.initiated_by
    LEFT JOIN tbl_user     uo ON uo.user_id  = a.ops_action_by
    LEFT JOIN tbl_user     uf ON uf.user_id  = a.fin_action_by`;

/*
 * One SELECT for the list and the export. Carries legacy's Audit Advance
 * columns: the technician's city and CURRENT BALANCE (finance approves against
 * what the tech already holds) and the job's status, none of which this route
 * used to return.
 */
const ADVANCE_SELECT = `
  SELECT a.advance_id, a.client_id, a.job_id, a.efr_id,
         a.adv_status, a.job_total_amt, a.advance_amt,
         a.initiated_on, a.initiated_by, a.pm_remarks,
         a.ops_action_on, a.ops_action_by, a.ops_remarks,
         a.fin_action_on, a.fin_action_by, a.fin_remarks,
         a.supporting_document, a.updated_on, a.updated_by, a.transaction_id,
         e.efr_name, e.efr_no, e.current_balance,
         c.client_name,
         ci.city_name,
         j.job_status,
         -- Actor names for the per-stage history the job Advance panel
         -- renders (legacy initiatedByUser / approvedByUser / paidByUser).
         ui.user_name AS initiated_by_name,
         uo.user_name AS ops_action_by_name,
         uf.user_name AS fin_action_by_name
    ${ADVANCE_FROM}`;

// ─── GET /admin/advances — list with easyfixer + client join ────────
router.get('/', async (req, res, next) => {
  try {
    logger.info('Listing advance payments · ' + JSON.stringify(req.query));
    const { where, params } = buildAdvanceFilters(req);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;

    const [rows] = await pool.query(
      `${ADVANCE_SELECT}
         ${where}
        ORDER BY a.advance_id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    /*
     * Total for the pager. Legacy's Audit Advance paged at 20 with a row count
     * driving the control (advancedApproved.vm:299); this route returned a bare
     * array capped at 100, so anything past the first 100 was silently missing
     * with nothing on screen to say so.
     *
     * The envelope is { items, total } — both consumers already accepted either
     * shape (`Array.isArray(data) ? data : data.items`), so this is not a
     * breaking change for the job Billing tab.
     */
    const [[counted]] = await pool.query(
      `SELECT COUNT(*) AS total ${ADVANCE_FROM}
         ${where}`,
      params
    );
    const total = Number(counted ? counted.total : 0);
    logger.info('Found ' + rows.length + ' advance payments of ' + total);
    modernOk(res, { items: rows, total, limit, offset });
  } catch (e) { next(e); }
});

// ─── GET /admin/advances/context — form context for one job ─────────
/*
 * Everything the Advance Payment Request form needs BEFORE an advance row
 * exists. Legacy did this inside findAdvanceByJobIdAndStatus(), which
 * returned a default Advance carrying these computed values when the job had
 * none — that is why the legacy form opens fully populated on a job with no
 * advance yet.
 *
 * The three counters are legacy's single query (AdvanceDaoImpl:247):
 *   FOH = the client's jobs at status 21
 *   ESA = the client's jobs at status 15
 *   OOA = this technician's jobs not in (3, 5, 6, 7)
 *
 * Declared BEFORE `GET /:id` on purpose: Express matches in declaration
 * order, so the /:id route would otherwise swallow "context" as an id.
 */
router.get('/context', validate(Joi.object({
  jobId: Joi.number().integer().positive().required(),
  efrId: Joi.number().integer().positive().optional(),
}), 'query'), async (req, res, next) => {
  try {
    const jobId = Number(req.query.jobId);
    logger.info('Advance form context · jobId=' + jobId);
    const [[job]] = await pool.query(
      'SELECT fk_client_id, fk_easyfixter_id FROM tbl_job WHERE job_id = ? LIMIT 1',
      [jobId]
    );
    if (!job) return modernError(res, 404, 'job not found');

    const clientId = job.fk_client_id;
    // The form may be opened before a technician is assigned; the OOA count
    // is then 0 rather than a count over a NULL efr.
    const efrId = req.query.efrId != null ? Number(req.query.efrId) : job.fk_easyfixter_id;

    const guard = assertEntityInScope(req, { client_id: clientId });
    if (!guard.ok) {
      logger.warn('Advance context blocked · job outside scope · jobId=' + jobId);
      return modernError(res, 404, 'job not found');
    }

    const jobTotalAmt = await jobTotalClientCharge(jobId);
    const [[counts]] = await pool.query(
      `SELECT
         COALESCE(COUNT(CASE WHEN job_status = 21 AND fk_client_id = ? THEN 1 END), 0) AS foh_count,
         COALESCE(COUNT(CASE WHEN job_status = 15 AND fk_client_id = ? THEN 1 END), 0) AS esa_count,
         COALESCE(COUNT(CASE WHEN fk_easyfixter_id = ? AND job_status NOT IN (3, 5, 6, 7) THEN job_id END), 0) AS tx_open_count
         FROM tbl_job`,
      [clientId, clientId, efrId || 0]
    );

    modernOk(res, {
      job_id: jobId,
      client_id: clientId,
      efr_id: efrId,
      job_total_amt: jobTotalAmt,
      max_allowed_advance: roundToOneDecimal(jobTotalAmt * MAX_ADVANCE_FRACTION),
      foh_count: Number(counts.foh_count),
      esa_count: Number(counts.esa_count),
      tx_open_count: Number(counts.tx_open_count),
    });
  } catch (e) { next(e); }
});

// ─── GET /admin/advances/export — the legacy "Download Advance" ─────
/*
 * Legacy's Audit Advance screen had a Download button (downloadAdvanceList,
 * struts.xml:2139) streaming the filtered list as a spreadsheet; this CRM
 * shipped the screen without one.
 *
 * Uses buildAdvanceFilters, so the file is exactly the rows on screen — no
 * second query to drift. No LIMIT: an export is meant to be the whole filtered
 * set, which is the entire point of exporting it.
 *
 * Declared BEFORE `GET /:id` so "export" is not parsed as an advance id.
 */
router.get('/export', async (req, res, next) => {
  try {
    logger.info('Exporting advance payments · ' + JSON.stringify(req.query));
    const { where, params } = buildAdvanceFilters(req);
    const [rows] = await pool.query(
      `${ADVANCE_SELECT}
         ${where}
        ORDER BY a.advance_id DESC`,
      params
    );

    const { streamStyledXlsx } = require('../../utils/xlsx-styled-export');
    const num = (v) => (v == null ? null : Number(v));
    const totalAdvance = rows.reduce((t, r) => t + (Number(r.advance_amt) || 0), 0);

    await streamStyledXlsx(res, `advance-list-${new Date().toISOString().slice(0, 10)}.xlsx`, {
      title: 'Audit Advance',
      meta: `${rows.length} Rows`,
      sheetName: 'AuditAdvance',
      kpis: [
        { label: 'Advances', value: rows.length, accent: 'FF6366F1' },
        { label: 'Total Advance', value: totalAdvance, accent: 'FF14B8A6' },
      ],
      // Legacy's Audit Advance column set, in its order.
      columns: [
        { key: 'initiated_on', header: 'Initiated Date', width: 20 },
        { key: 'status', header: 'Status', width: 18 },
        { key: 'job_id', header: 'Job Id', width: 10 },
        { key: 'efr_name', header: 'Tx Name', width: 22 },
        { key: 'current_balance', header: 'Tx Current Balance', width: 18 },
        { key: 'client_name', header: 'Client Name', width: 24 },
        { key: 'city_name', header: 'City Name', width: 16 },
        { key: 'job_total_amt', header: 'Total Order Value', width: 18 },
        { key: 'advance_amt', header: 'Job Advance Amount', width: 18 },
      ],
      rows: rows.map((r) => ({
        initiated_on: r.initiated_on,
        status: ADV_STATUS_LABEL[Number(r.adv_status)] ?? String(r.adv_status),
        job_id: r.job_id,
        efr_name: r.efr_name,
        current_balance: num(r.current_balance),
        client_name: r.client_name,
        city_name: r.city_name,
        job_total_amt: num(r.job_total_amt),
        advance_amt: num(r.advance_amt),
      })),
      totalRow: { initiated_on: 'Total', advance_amt: totalAdvance },
      emptyMessage: 'No Advances Found.',
    });
  } catch (e) { next(e); }
});

// ─── GET /admin/advances/:id — detail ───────────────────────────────
router.get('/:id', scopedAdvance, async (req, res, next) => {
  try {
    logger.info('Fetching advance detail · id=' + req.params.id);
    const [[row]] = await pool.query(
      `SELECT a.*, e.efr_name, e.efr_no, c.client_name,
              ui.user_name AS initiated_by_name,
              uo.user_name AS ops_action_by_name,
              uf.user_name AS fin_action_by_name
         FROM tbl_efr_advance_payment a
         LEFT JOIN tbl_easyfixer e ON e.efr_id    = a.efr_id
         LEFT JOIN tbl_client    c ON c.client_id = a.client_id
         LEFT JOIN tbl_user     ui ON ui.user_id  = a.initiated_by
         LEFT JOIN tbl_user     uo ON uo.user_id  = a.ops_action_by
         LEFT JOIN tbl_user     uf ON uf.user_id  = a.fin_action_by
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
    /*
     * 60% cap (legacy parity, now actually enforced — see MAX_ADVANCE_FRACTION).
     * The total is recomputed here rather than trusted from `jobTotalAmt` in
     * the body, and the computed figure is what gets stored, so the cap and
     * the audit trail agree even if the caller sent something else.
     */
    const jobTotalAmt = await jobTotalClientCharge(b.jobId);
    const maxAllowed = roundToOneDecimal(jobTotalAmt * MAX_ADVANCE_FRACTION);
    if (jobTotalAmt > 0 && Number(b.advanceAmt) > maxAllowed) {
      logger.warn('Advance initiate blocked · exceeds cap · jobId=' + b.jobId
        + ' requested=' + b.advanceAmt + ' max=' + maxAllowed);
      return modernError(res, 422,
        `advance exceeds the maximum allowed for this job (${maxAllowed})`);
    }
    if (jobTotalAmt === 0) {
      logger.info('Advance cap skipped · job has no costed charges yet · jobId=' + b.jobId);
    }

    const now = new Date();
    const [ins] = await pool.query(
      `INSERT INTO tbl_efr_advance_payment
         (client_id, job_id, efr_id, adv_status,
          job_total_amt, advance_amt,
          initiated_on, initiated_by, pm_remarks,
          supporting_document, updated_on, updated_by)
       VALUES (?, ?, ?, ${ADV_STATUS.INITIATED}, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clientId || null,
        b.jobId,
        b.efrId,
        jobTotalAmt,
        b.advanceAmt,
        now,
        req.user.user_id,
        b.pmRemarks || null,
        b.supportingDocument || null,
        now,
        req.user.user_id,
      ]
    );
    logger.info('Advance created · id=' + ins.insertId + ' status=1 (Initiated)');
    res.status(201);
    modernOk(res, { advanceId: ins.insertId, status: ADV_STATUS.INITIATED }, 'advance initiated');
  } catch (e) { next(e); }
});

// ─── POST /admin/advances/:id/ops-approve — 1 Initiated -> 2 Pending To Finance ───
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
    if (Number(row.adv_status) !== ADV_STATUS.INITIATED) {
      logger.warn('Ops-approve rejected · advance not Initiated · id=' + id + ' status=' + row.adv_status);
      return modernError(res, 409, `advance is not awaiting Ops (current status ${row.adv_status})`);
    }
    const now = new Date();
    const [r] = await pool.query(
      `UPDATE tbl_efr_advance_payment
          SET adv_status = ${ADV_STATUS.PENDING_TO_FINANCE},
              ops_action_on = ?,
              ops_action_by = ?,
              ops_remarks = ?,
              updated_on = ?,
              updated_by = ?
        WHERE advance_id = ? AND adv_status = ${ADV_STATUS.INITIATED}`,
      [now, req.user.user_id, req.body.remarks || null, now, req.user.user_id, id]
    );
    if (r.affectedRows === 0) {
      logger.warn('Ops-approve lost race · advance no longer Initiated · id=' + id);
      return modernError(res, 409, 'advance is not awaiting Ops (state changed concurrently)');
    }
    logger.info('Advance updated · id=' + id + ' status=2 (Pending To Finance)');
    modernOk(res, { approvedBy: 'ops', status: ADV_STATUS.PENDING_TO_FINANCE });
  } catch (e) { next(e); }
});

// ─── POST /admin/advances/:id/fin-approve — 2 Pending To Finance -> 4 Advance Done ───
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
    if (Number(row.adv_status) !== ADV_STATUS.PENDING_TO_FINANCE) {
      logger.warn('Finance-approve rejected · advance not Pending To Finance · id=' + id + ' status=' + row.adv_status);
      return modernError(res, 409, `advance is not pending with Finance (current status ${row.adv_status})`);
    }
    const now = new Date();
    const [r] = await pool.query(
      `UPDATE tbl_efr_advance_payment
          SET adv_status = ${ADV_STATUS.ADVANCE_DONE},
              fin_action_on = ?,
              fin_action_by = ?,
              fin_remarks = ?,
              transaction_id = ?,
              updated_on = ?,
              updated_by = ?
        WHERE advance_id = ? AND adv_status = ${ADV_STATUS.PENDING_TO_FINANCE}`,
      [
        now,
        req.user.user_id,
        req.body.remarks || null,
        req.body.transactionId || null,
        now,
        req.user.user_id,
        id,
      ]
    );
    if (r.affectedRows === 0) {
      logger.warn('Finance-approve lost race · advance no longer Pending To Finance · id=' + id);
      return modernError(res, 409, 'advance is not pending with Finance (state changed concurrently)');
    }
    logger.info('Advance updated · id=' + id + ' status=4 (Advance Done)');
    modernOk(res, { approvedBy: 'finance', status: ADV_STATUS.ADVANCE_DONE });
  } catch (e) { next(e); }
});

// ─── POST /admin/advances/:id/reject — 1 -> 3 (Ops) | 2 -> 5 (Finance) ───
// Legacy keeps the two rejections apart, so the row records WHO refused:
// "Rejected by Ops" (3) from Initiated, "Rejected by Finance" (5) from
// Pending To Finance — see AdvanceDaoImpl.java:429. Stamps ops_* on the
// first, fin_* on the second. Terminal rows (3, 4, 5) cannot be rejected.
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
    if (current !== ADV_STATUS.INITIATED && current !== ADV_STATUS.PENDING_TO_FINANCE) {
      logger.warn('Reject blocked · advance is terminal · id=' + id + ' status=' + current);
      return modernError(res, 409, `advance cannot be rejected from current status ${current}`);
    }
    const byOps = current === ADV_STATUS.INITIATED;
    const now = new Date();
    const sql = byOps
      ? `UPDATE tbl_efr_advance_payment
            SET adv_status = ${ADV_STATUS.REJECTED_BY_OPS},
                ops_action_on = ?,
                ops_action_by = ?,
                ops_remarks = ?,
                updated_on = ?,
                updated_by = ?
          WHERE advance_id = ? AND adv_status = ${ADV_STATUS.INITIATED}`
      : `UPDATE tbl_efr_advance_payment
            SET adv_status = ${ADV_STATUS.REJECTED_BY_FINANCE},
                fin_action_on = ?,
                fin_action_by = ?,
                fin_remarks = ?,
                updated_on = ?,
                updated_by = ?
          WHERE advance_id = ? AND adv_status = ${ADV_STATUS.PENDING_TO_FINANCE}`;
    const [r] = await pool.query(sql, [
      now,
      req.user.user_id,
      req.body.remarks || null,
      now,
      req.user.user_id,
      id,
    ]);
    if (r.affectedRows === 0) {
      logger.warn('Reject lost race · advance state changed concurrently · id=' + id);
      return modernError(res, 409, 'advance cannot be rejected (state changed concurrently)');
    }
    const newStatus = byOps ? ADV_STATUS.REJECTED_BY_OPS : ADV_STATUS.REJECTED_BY_FINANCE;
    logger.info('Advance updated · id=' + id + ' status=' + newStatus
      + ' (rejected by ' + (byOps ? 'ops' : 'finance') + ')');
    modernOk(res, { rejected: true, rejectedBy: byOps ? 'ops' : 'finance', status: newStatus });
  } catch (e) { next(e); }
});

module.exports = router;
