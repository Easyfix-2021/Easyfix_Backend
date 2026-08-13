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
    logger.info('SPOC login-OTP result · delivered=' + (r.found ? 'yes' : 'no') + (r.clientInactive ? ' (client inactive)' : ''));
    modernOk(res, {
      delivered: r.found,
      expiresAt: r.expiresAt || null,
      message: r.clientInactive ? 'This client account is inactive. Please contact your EasyFix SPOC.' : undefined,
    });
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
      if (r.reason === 'CLIENT_INACTIVE') {
        return modernError(res, 403, 'This client account is inactive. Please contact your EasyFix SPOC.');
      }
      return modernError(res, 401, r.reason);
    }
    logger.info('SPOC verify-OTP ok · spocId=' + r.spoc.id + ' clientId=' + r.spoc.client_id);
    // Cookie name matches the frontend localStorage key (`client_auth_token`)
    // so future refresh/CSRF flows can read either source consistently.
    res.cookie('client_auth_token', r.token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400 * 1000 });
    modernOk(res, { token: r.token, spoc: { id: r.spoc.id, name: r.spoc.contact_name, client_id: r.spoc.client_id } });
  } catch (e) { logger.error('SPOC verify-OTP failed · ' + e.message); next(e); }
});

// Public (pre-login) support — a user who can't sign in (not registered /
// inactive) can still reach us from the login screen. Sends to the IT helpdesk;
// NO auth required, so it stays above requireSpocAuth.
router.post('/auth/support', validate(Joi.object({
  email: Joi.string().allow('', null).max(150),
  subject: Joi.string().allow('', null).max(200),
  message: Joi.string().min(3).max(1000).required(),
})), async (req, res, next) => {
  try {
    const message = String(req.body.message).trim();
    const from = String(req.body.email || '').trim();
    const subject = String(req.body.subject || '').trim() || 'Client App — Support Request (login)';
    const text = `From: ${from || 'unknown (login screen)'}\n\n${message}`;
    await require('../../services/email.service').send({
      to: ['ithelpdesk@easyfix.in'], cc: ['prem.rai@easyfix.in'], subject, text, category: 'client-support-public',
    });
    logger.info('Public client support email · from=' + (from || '-'));
    modernOk(res, { sent: true });
  } catch (e) { next(e); }
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
    // The live table uses the c_prop_* naming (c_prop_name / c_prop_mandatory);
    // the ?? chains keep older/renamed deploys working. Only ACTIVE (status=1),
    // non-config rows are returned — `is_config` rows (e.g.
    // auto_process_unconfirmed_order) are backend switches, not booking fields.
    const items = rows
      .filter((r) => truthy(r.status ?? 1) && !truthy(r.is_config))
      .map((r) => {
        const raw = String(r.c_prop_name ?? r.property_name ?? r.name ?? r.key ?? r.field_name ?? '').trim();
        return {
          name: raw.toLowerCase(),
          label: r.property_label ?? r.label ?? r.display_name ?? raw,
          mandatory: truthy(r.c_prop_mandatory ?? r.is_mandatory ?? r.mandatory ?? r.required ?? r.is_required),
        };
      })
      .filter((p) => p.name);
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

// Action reasons for the app/client user (action_taken_reason, user_type 4),
// selected by action_type — e.g. escalation = 23. Powers the Escalate sheet's
// reason picker. Returns [{ id, label }].
router.get('/lookup/reasons', async (req, res, next) => {
  try {
    const actionType = Number(req.query.actionType);
    if (!actionType) return modernOk(res, { items: [] });
    const [rows] = await pool.query(
      `SELECT id, action_desc AS label
         FROM action_taken_reason
        WHERE action_type = ? AND user_type = 4 AND status = 1 AND is_new = 1
        ORDER BY action_desc ASC`,
      [actionType]);
    logger.info('Lookup reasons · actionType=' + actionType + ' · count=' + rows.length);
    modernOk(res, { items: rows });
  } catch (e) { next(e); }
});

router.get('/dashboard', async (req, res, next) => {
  try {
    // The three "Today's jobs" tiles, each scoped to TODAY by its own date column
    // (scope=today). Default (no scope) = lifetime totals.
    //   New         = ANY ticket created today          (ticket_created_date_time)
    //   In Progress = status 0/1/2/20, appointment today (requested_date_time)
    //   Completed   = status 3/5, checked out today      (checkout_date_time)
    const todayOnly = String(req.query.scope || '') === 'today';
    const on = (col) => (todayOnly ? `AND DATE(${col}) = CURDATE()` : '');

    // Visibility for the "Today's jobs" counts — same reporting hierarchy as
    // Orders (tbl_client_contacts.manager_id, attributed via reporting_contact_id):
    //   • Top SPOC (no manager)  → the WHOLE client's counts.
    //   • Everyone else          → their subtree (themselves + team's bookings).
    //   • ?spoc=<id> (a member)  → just that one SPOC's counts (team drill-down).
    const hier = await resolveClientHierarchy(req);
    const scopeIds = hierarchyFilter(hier, req);   // undefined = whole client
    const params = [req.spoc.client_id];
    let mine = '';
    if (Array.isArray(scopeIds)) {
      mine = `AND reporting_contact_id IN (${scopeIds.map(() => '?').join(',')})`;
      params.push(...scopeIds);
    }

    logger.info('Fetch client dashboard stats · clientId=' + req.spoc.client_id + (todayOnly ? ' · scope=today' : '') + (Array.isArray(scopeIds) ? ' · scope=' + scopeIds.length + 'spoc' : ' · all'));
    const [[stats]] = await pool.query(`
      SELECT
        SUM(CASE WHEN ticket_created_date_time IS NOT NULL ${on('ticket_created_date_time')} THEN 1 ELSE 0 END) AS newTickets,
        SUM(CASE WHEN job_status IN (0,1,2,20) ${on('requested_date_time')} THEN 1 ELSE 0 END) AS inProgress,
        SUM(CASE WHEN job_status IN (3,5)    ${on('checkout_date_time')}             THEN 1 ELSE 0 END) AS completed
       FROM tbl_job WHERE fk_client_id = ? ${mine}`, params);
    modernOk(res, stats);
  } catch (e) { next(e); }
});

// Per-service × city-tier TAT + SDA completion rates.
//   TAT (Turn-Around Time): job age (24h days, ticket-created → completion/close)
//        must be ≤ the pre-defined TAT for that category × tier. Denominator = all jobs.
//   SDA (Same-Day Attendance): technician checked in on/before the appointment date.
//        Denominator = only jobs where SDA applies (right status + both dates present).
// Query params:  ?days=<N>   window on ticket_created_date_time (default: all-time)
router.get('/services/sda-tat', async (req, res, next) => {
  try {
    const days = Number(req.query.days) > 0 ? Number(req.query.days) : null;
    const params = [req.spoc.client_id];
    let windowClause = '';
    if (days) { windowClause = 'AND J.ticket_created_date_time >= DATE_SUB(CURDATE(), INTERVAL ? DAY)'; params.push(days); }
    logger.info('Fetch client service SDA/TAT (tiered) · clientId=' + req.spoc.client_id + (days ? ' · days=' + days : ''));
    const [rows] = await pool.query(`
      SELECT
        d.service_name,
        d.tier,
        COUNT(*)                                                          AS total_jobs,
        SUM(d.in_tat)                                                     AS jobs_in_tat,
        ROUND(100.0 * SUM(d.in_tat) / COUNT(*), 2)                        AS tat_completion_pct,
        SUM(d.sda_applicable)                                             AS sda_applicable_jobs,
        SUM(d.sda_met)                                                    AS jobs_sda_met,
        ROUND(100.0 * SUM(d.sda_met) / NULLIF(SUM(d.sda_applicable),0), 2) AS sda_completion_pct
      FROM (
        SELECT
          COALESCE(TSC.service_catg_name, 'Uncategorised') AS service_name,
          city.tier             AS tier,
          /* In TAT? job age (24h days) <= pre-defined TAT for category × tier */
          CASE WHEN
            (CASE
                WHEN J.job_status IN (9,1,0,2,20,10,15,21) THEN TIMESTAMPDIFF(HOUR, J.ticket_created_date_time, NOW()) DIV 24
                WHEN J.job_status IN (3,5) THEN TIMESTAMPDIFF(HOUR, J.ticket_created_date_time, J.checkout_date_time) DIV 24
                WHEN J.job_status = 6 THEN TIMESTAMPDIFF(HOUR, J.ticket_created_date_time, J.cancel_date_time) DIV 24
                WHEN J.job_status = 7 THEN TIMESTAMPDIFF(HOUR, J.ticket_created_date_time, J.enquiry_date_time) DIV 24
                ELSE 0 END)
            <=
            (CASE
                WHEN J.fk_service_catg_id IS NULL OR city.tier IS NULL THEN 3
                WHEN J.fk_service_catg_id = 15 THEN CASE city.tier WHEN 3 THEN 7 WHEN 2 THEN 5 ELSE 3 END
                WHEN J.fk_service_catg_id IN (1,5,12,21) THEN CASE city.tier WHEN 3 THEN 5 ELSE 3 END
                ELSE 3 END)
          THEN 1 ELSE 0 END AS in_tat,
          /* SDA applies: right status + both dates present */
          CASE WHEN J.job_status IN (2,20,10,21,15,3,5)
                    AND J.checkin_date_time IS NOT NULL
                    AND J.original_appointment_date_time IS NOT NULL
               THEN 1 ELSE 0 END AS sda_applicable,
          /* SDA met: check-in date on/before appointment date */
          CASE WHEN J.job_status IN (2,20,10,21,15,3,5)
                    AND J.checkin_date_time IS NOT NULL
                    AND J.original_appointment_date_time IS NOT NULL
                    AND DATE(J.checkin_date_time) <= DATE(J.original_appointment_date_time)
               THEN 1 ELSE 0 END AS sda_met
        FROM tbl_job J
        LEFT JOIN tbl_address     A    ON A.customer_id = J.fk_customer_id AND A.address_id = J.fk_address_id
        LEFT JOIN tbl_city        city ON city.city_id  = A.city_id
        LEFT JOIN tbl_service_catg TSC ON TSC.service_catg_id = J.fk_service_catg_id
        WHERE J.fk_client_id = ? ${windowClause}
      ) d
      GROUP BY d.service_name, d.tier
      ORDER BY (d.service_name = 'Uncategorised'), d.service_name, d.tier`, params);
    const items = rows.map((r) => ({
      service: r.service_name,
      tier: r.tier,
      total: Number(r.total_jobs),
      jobsInTat: Number(r.jobs_in_tat),
      tatPct: r.tat_completion_pct != null ? Number(r.tat_completion_pct) : null,
      sdaApplicable: Number(r.sda_applicable_jobs),
      jobsSdaMet: Number(r.jobs_sda_met),
      sdaPct: r.sda_completion_pct != null ? Number(r.sda_completion_pct) : null,
    }));
    modernOk(res, { items });
  } catch (e) { next(e); }
});

// Reporting-manager visibility — mirrors the legacy client dashboard exactly:
//   • MANAGER = another active user reports to them (tbl_user.reporting_manager = them).
//   • Manager      → their team's jobs: job_client_owner IN (self + direct reports).
//   • Non-manager  → only their own jobs: job_client_owner = self.
// Keyed off the SPOC's linked Client (user_type_id=3) user, carried in the token
// as req.clientUser.userId (added at login). ownerIds === null means we couldn't
// resolve the user (older token) → no scoping, show all the client's jobs.
async function resolveManagerScope(req) {
  const myUserId = req.clientUser?.userId ?? null;
  if (!myUserId) return { isManager: false, ownerIds: null };
  const [reports] = await pool.query(
    `SELECT user_id FROM tbl_user
      WHERE reporting_manager = ? AND user_status = 1 AND user_id <> reporting_manager`,
    [myUserId]);
  const reportIds = reports.map((r) => Number(r.user_id));
  const isManager = reportIds.length > 0;
  const ownerIds = isManager ? [Number(myUserId), ...reportIds] : [Number(myUserId)];
  return { isManager, ownerIds };
}

/**
 * Client-app reporting hierarchy — walks the SPOC-to-SPOC tree
 * (tbl_client_contacts.manager_id) for the logged-in SPOC. Bookings are
 * attributed to a SPOC via tbl_job.reporting_contact_id.
 *   subtreeIds — this SPOC's contact id + every active contact at/under them
 *   isTop      — this SPOC has no manager above them → sees the WHOLE client
 *                (incl. old / CRM jobs with no booking SPOC)
 *   isManager  — this SPOC has at least one report (subtree bigger than self)
 * MySQL 8 recursive CTE; cte_max_recursion_depth (1000) bounds cyclic data.
 */
async function resolveClientHierarchy(req) {
  const myId = Number(req.spoc.id);
  const clientId = req.spoc.client_id;
  try {
    const [[me]] = await pool.query(
      'SELECT manager_id FROM tbl_client_contacts WHERE id = ? LIMIT 1', [myId]);
    const isTop = !me || me.manager_id == null || Number(me.manager_id) === 0;
    const [rows] = await pool.query(
      `WITH RECURSIVE team AS (
          SELECT id FROM tbl_client_contacts WHERE id = ? AND client_id = ?
          UNION ALL
          SELECT c.id FROM tbl_client_contacts c
            JOIN team t ON c.manager_id = t.id
           WHERE c.client_id = ? AND c.status = 1
       )
       SELECT DISTINCT id FROM team`,
      [myId, clientId, clientId]);
    const subtreeIds = rows.map((r) => Number(r.id));
    if (!subtreeIds.length) subtreeIds.push(myId); // always include self
    return { isTop, isManager: subtreeIds.length > 1, subtreeIds };
  } catch (e) {
    // Cyclic manager_id, recursion-depth limit, or an un-migrated column would
    // otherwise 500 the Orders screen. Fall back to the pre-hierarchy behaviour
    // (client-scoped = see everything) so orders never disappear on a data glitch.
    logger.warn('resolveClientHierarchy failed (' + e.message + ') — falling back to client-wide');
    return { isTop: true, isManager: false, subtreeIds: [myId] };
  }
}

/**
 * Resolve the reporting-contact filter for a list/dashboard request given the
 * caller's hierarchy + an optional `?spoc=<contactId>` team filter.
 *   • ?spoc in my subtree → just that one SPOC
 *   • else if I'm top      → undefined (no filter → whole client)
 *   • else                 → my whole subtree
 */
function hierarchyFilter(hier, req) {
  const spocFilter = Number(req.query.spoc) || null;
  if (spocFilter && hier.subtreeIds.includes(spocFilter)) return [spocFilter];
  if (hier.isTop) return undefined;
  return hier.subtreeIds;
}

router.get('/jobs', async (req, res, next) => {
  try {
    logger.info('List client jobs · status=' + (req.query.status ?? 'all') + ' q=' + (req.query.q || '-') + ' limit=' + (Math.min(Number(req.query.limit) || 50, 500)) + ' offset=' + (Number(req.query.offset) || 0));
    // Reporting-hierarchy scope (tbl_client_contacts.manager_id, attributed via
    // tbl_job.reporting_contact_id): a top SPOC sees the whole client; everyone
    // else sees jobs booked by themselves + their team. `?spoc=<id>` narrows a
    // manager to one team member.
    const hier = await resolveClientHierarchy(req);
    const reportingContactIds = hierarchyFilter(hier, req);
    const { rows, total } = await jobService.list({
      clientId: req.spoc.client_id,
      reportingContactIds,
      status: req.query.status != null ? Number(req.query.status) : undefined,
      q: req.query.q,
      // Server-side date range (so the app can reach any historical date
      // instead of only the recent window it can hold client-side).
      dateType: req.query.dateType,          // 'ticket' → ticket_created_date_time
      startDate: req.query.startDate,
      endDate: req.query.endDate,
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

// Human-readable stage stored on an escalation row (job_stage), matching the
// vocabulary the legacy Client Dashboard already writes to this table.
const STAGE_LABEL = {
  0: 'Unconfirmed', 1: 'Scheduled', 2: 'Pending To Start', 3: 'Completed',
  5: 'Completed', 6: 'Cancelled', 7: 'Enquiry', 9: 'Booked',
  10: 'Under Audit', 15: 'Awaiting Approval', 20: 'Pending To Start', 21: 'On Hold',
};

/**
 * Cancel an order (client-initiated).
 * Routes through jobService.setStatus so it takes the same path ops uses —
 * job_status → 6 plus cancel_date_time / cancel_reason_id / cancel_comment.
 */
router.post('/jobs/:id/cancel', validate(Joi.object({
  comment: Joi.string().min(3).max(500).required(),
  reasonId: Joi.number().integer().allow(null).optional(),
})), async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) {
      logger.warn('Client cancel — job not found / not owned · id=' + req.params.id);
      return modernError(res, 404, 'job not found');
    }
    if (job.job_status === 6) return modernError(res, 409, 'job is already cancelled');
    if ([3, 5].includes(job.job_status)) return modernError(res, 409, 'cannot cancel a completed job');

    // Legacy stamps cancel_by with the SPOC's linked USER (clientContact.getUser()).
    const [[link]] = await pool.query('SELECT user_id FROM tbl_client_contacts WHERE id = ?', [req.spoc.id]);
    logger.info('Client cancel job · id=' + job.job_id + ' · spoc=' + req.spoc.id + ' · user=' + (link?.user_id ?? '-'));
    await jobService.setStatus(job.job_id, {
      status: 6,
      reasonId: req.body.reasonId ?? null,
      comment: req.body.comment,
    }, { user_id: link?.user_id ?? null });
    modernOk(res, { cancelled: true, job_id: job.job_id });
  } catch (e) { next(e); }
});

// ─── Job image upload (Book-a-service attachments) ───────────────────
// Reuses the shared job-image service (same storage as the ops route: S3 with
// a local-disk fallback + a tbl_job_image row). Scoped to the SPOC's client so
// a client can only attach to its own jobs.
const multerClientImg = require('multer');
const jobImageService = require('../../services/job-image.service');
const clientImageUpload = multerClientImg({
  storage: multerClientImg.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

router.post('/jobs/:id/images', clientImageUpload.single('file'), async (req, res, next) => {
  const jobId = Number(req.params.id);
  try {
    const job = await jobService.getById(jobId);
    if (!job || job.fk_client_id !== req.spoc.client_id) return modernError(res, 404, 'job not found');
    const result = await jobImageService.uploadJobImage({ jobId, file: req.file, category: 'Booking' });
    modernOk(res, result, 'image uploaded');
  } catch (e) {
    if (e?.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'file exceeds 10MB');
    if (e?.status === 400) return modernError(res, 400, e.message);
    next(e);
  }
});

// One canonical, stable URL for every job image regardless of storage backend
// (S3 or legacy server disk). Resolves + 302-redirects (S3 presigned) or streams
// (local file) so both CRMs' images render identically, and the app caches by
// this stable URL. Declared BEFORE /jobs/:id so "images" isn't captured as :id.
router.get('/jobs/images/:imageId/file', async (req, res, next) => {
  try {
    const imageId = Number(req.params.imageId);
    if (!Number.isInteger(imageId) || imageId <= 0) return modernError(res, 400, 'invalid imageId');
    const [[row]] = await pool.query(
      'SELECT image_id, job_id, image FROM tbl_job_image WHERE image_id = ? LIMIT 1', [imageId]);
    if (!row || !row.image) return modernError(res, 404, 'image not found');
    // RBAC: the image's job must belong to the SPOC's client.
    const job = await jobService.getById(row.job_id);
    if (!job || job.fk_client_id !== req.spoc.client_id) return modernError(res, 404, 'image not found');
    await jobImageService.serveResolvedImage(res, row.image);
  } catch (e) { next(e); }
});

/**
 * Escalate an order — writes to tbl_job_escalation_info, the same table the
 * legacy Client Dashboard writes, so ops sees app + dashboard escalations in
 * one place. `escalated_from` marks the source as the mobile app.
 */
router.post('/jobs/:id/escalate', validate(Joi.object({
  reasonId: Joi.number().integer().required(),
  comment: Joi.string().allow('').max(500).optional(),
})), async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) {
      logger.warn('Client escalate — job not found / not owned · id=' + req.params.id);
      return modernError(res, 404, 'job not found');
    }
    logger.info('Client escalate job · id=' + job.job_id + ' · reason=' + req.body.reasonId + ' · spoc=' + req.spoc.id);
    const escalatedBy = req.spoc.contact_name || null;

    // 1) the escalation record itself (job_stage here is the human-readable label)
    const [r] = await pool.query(
      `INSERT INTO tbl_job_escalation_info
         (job_id, easyfixer_id, escalation_time, job_stage, escalated_by,
          escalated_by_name, escalated_comments, escalated_from, escalation_reason)
       VALUES (?, ?, NOW(), ?, 0, ?, ?, 'Client App', ?)`,
      [
        job.job_id,
        job.fk_easyfixter_id || null,   // note: column name has the legacy "easyfixter" typo
        STAGE_LABEL[job.job_status] || String(job.job_status ?? ''),
        escalatedBy,
        req.body.comment || null,
        req.body.reasonId,
      ]);

    // 2) the matching job-timeline comment the legacy dashboard also writes
    //    (comment_on = 19 marks it as an escalation; job_stage here is the raw status int).
    await pool.query(
      `INSERT INTO tbl_job_comment
         (job_id, enum_reason_id, comments, comment_on, created_on, job_stage, job_escalated_by)
       VALUES (?, ?, ?, 19, NOW(), ?, ?)`,
      [job.job_id, req.body.reasonId, req.body.comment || null, job.job_status ?? null, escalatedBy]);

    modernOk(res, { escalated: true, escalation_info_id: r.insertId, job_id: job.job_id });
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
    // Stamp the logged-in SPOC onto the job so ops/reports know who booked it.
    // These always come from the authenticated SPOC — never trust the client
    // body for identity — so they override anything the app might send.
    const created = await jobService.create({
      ...req.body,
      fk_client_id: req.spoc.client_id,
      reporting_contact_id: req.spoc.id,
      client_spoc: req.spoc.contact_no || null,
      client_spoc_name: req.spoc.contact_name || null,
      client_spoc_email: req.spoc.contact_email || null,
    }, { user_id: null });
    logger.info('Job created · id=' + created.job_id + ' · spoc=' + req.spoc.id);

    // In-app "Booking confirmed" notification for the client inbox. Matched by
    // the client's jobs in GET /notices, so it surfaces for whoever booked and
    // the client's other SPOCs. Fire-and-forget — a logging hiccup must never
    // fail the booking itself.
    setImmediate(async () => {
      try {
        const inbox = require('../../services/notification-inbox.service');
        await inbox.create({
          userId: req.clientUser?.userId || created.job_client_owner || 0,
          jobId: created.job_id,
          title: 'Booking confirmed',
          desc: `Your service request has been booked. Job #${created.job_id}.`,
        });
      } catch (err) {
        logger.warn({ jobId: created.job_id, err: err.message }, 'booking notification insert failed');
      }
    });

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
      `SELECT cc.id, cc.contact_name, cc.contact_email, cc.contact_no,
              cc.contact_alt_no, cc.contact_desgn, cc.linkedIn_profile,
              cc.client_id, cl.client_name
       FROM tbl_client_contacts cc
       LEFT JOIN tbl_client cl ON cl.client_id = cc.client_id
       WHERE cc.id = ?`,
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

    // Mirror the name onto the SPOC's linked internal user (tbl_user) so both
    // records stay in sync. SPOCs link by tbl_client_contacts.user_id when set,
    // otherwise by matching email on an active Client (user_type_id = 3) user.
    if (contact_name != null && String(contact_name).trim() !== '') {
      const [[cc]] = await pool.query(
        'SELECT user_id, contact_email FROM tbl_client_contacts WHERE id = ?', [req.spoc.id]);
      const uid = cc && Number(cc.user_id) > 0 ? Number(cc.user_id) : null;
      const email = cc && cc.contact_email ? String(cc.contact_email).trim() : null;
      if (uid) {
        await pool.query('UPDATE tbl_user SET user_name = ? WHERE user_id = ?', [contact_name, uid]);
      } else if (email) {
        await pool.query(
          `UPDATE tbl_user SET user_name = ?
            WHERE LOWER(official_email) = LOWER(?) AND user_type_id = 3 AND user_status = 1`,
          [contact_name, email]);
      }
      logger.info('SPOC name mirrored to tbl_user · spocId=' + req.spoc.id + ' · via=' + (uid ? 'user_id' : email ? 'email' : 'none'));
    }
    logger.info('SPOC profile updated · spocId=' + req.spoc.id);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

// ─── Change mobile number (OTP-verified) ─────────────────────────────
// The SPOC's number lives in BOTH tbl_client_contacts (contact_no, the
// login/contact record) and tbl_user (mobile_no). We OTP the NEW number,
// reject it if it is already registered to anyone, then update both tables.
function cn_normalizePhone(v) { return String(v || '').replace(/\D/g, ''); }
function cn_isJunkMobile(m) {
  if (!/^[6-9]\d{9}$/.test(m)) return true;            // 10 digits, starts 6-9
  if (/^(\d)\1{9}$/.test(m)) return true;              // all same digit (e.g. 9999999999)
  if ('01234567890'.includes(m) || '09876543210'.includes(m)) return true; // sequential
  if (/^(\d\d)\1{4}$/.test(m)) return true;            // repeated pair (e.g. 1212121212)
  return false;
}
async function cn_alreadyRegistered(phone, exceptContactId) {
  const [[cc]] = await pool.query(
    'SELECT id FROM tbl_client_contacts WHERE contact_no = ? AND id <> ? LIMIT 1',
    [phone, exceptContactId]);
  if (cc) return true;
  const [[u]] = await pool.query(
    'SELECT user_id FROM tbl_user WHERE mobile_no = ? LIMIT 1', [phone]);
  return !!u;
}

router.post('/profile/change-phone/send-otp', async (req, res, next) => {
  try {
    const phone = cn_normalizePhone(req.body && req.body.new_phone);
    if (cn_isJunkMobile(phone)) return modernError(res, 400, 'Enter a valid 10-digit mobile number.');
    if (await cn_alreadyRegistered(phone, req.spoc.id)) {
      return modernError(res, 409, 'This number is already registered. Please use a different one.');
    }
    const { resolveLoginOtp, otpExpiryDate } = require('../../utils/otp');
    const now = new Date();
    const otp = resolveLoginOtp(phone);
    const expires = otpExpiryDate(now);
    const [[existing]] = await pool.query(
      `SELECT id FROM otp_details WHERE user_mobile_no = ? AND otp_type = 'Change Number' LIMIT 1`, [phone]);
    if (existing) {
      await pool.query(
        `UPDATE otp_details SET otp = ?, generated_on = ?, valid_up_to = ?, is_expired = 0 WHERE id = ?`,
        [otp, now, expires, existing.id]);
    } else {
      await pool.query(
        `INSERT INTO otp_details (otp, otp_type, user_email, user_mobile_no, generated_on, valid_up_to, is_expired, count)
         VALUES (?, 'Change Number', NULL, ?, ?, ?, 0, 0)`,
        [otp, phone, now, expires]);
    }
    try {
      const { deliverOtp } = require('../../services/otp-delivery.service');
      await deliverOtp({ identifier: phone, email: null, mobile: phone, name: req.spoc.contact_name, otp, contextLabel: 'spoc-change-phone' });
    } catch (e) { logger.warn('change-phone OTP deliver failed: ' + e.message); }
    logger.info('Change-phone OTP issued · spocId=' + req.spoc.id);
    return modernOk(res, { sent: true });
  } catch (e) { next(e); }
});

router.post('/profile/change-phone/verify-otp', async (req, res, next) => {
  try {
    const phone = cn_normalizePhone(req.body && req.body.new_phone);
    const otp = Number(req.body && req.body.otp);
    if (cn_isJunkMobile(phone)) return modernError(res, 400, 'Enter a valid 10-digit mobile number.');
    const [[row]] = await pool.query(
      `SELECT id, otp, valid_up_to, is_expired FROM otp_details
        WHERE user_mobile_no = ? AND otp_type = 'Change Number' ORDER BY id DESC LIMIT 1`, [phone]);
    if (!row) return modernError(res, 400, 'No OTP was requested for this number.');
    if (row.is_expired || new Date(row.valid_up_to) < new Date()) {
      await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);
      return modernError(res, 400, 'OTP has expired. Please request a new one.');
    }
    if (Number(row.otp) !== otp) return modernError(res, 400, 'Incorrect OTP.');
    // Re-check right before writing (guards a race between two requests).
    if (await cn_alreadyRegistered(phone, req.spoc.id)) {
      return modernError(res, 409, 'This number is already registered. Please use a different one.');
    }
    const oldPhone = req.spoc.contact_no;
    await pool.query('UPDATE tbl_client_contacts SET contact_no = ? WHERE id = ?', [phone, req.spoc.id]);
    if (oldPhone) {
      await pool.query('UPDATE tbl_user SET mobile_no = ? WHERE mobile_no = ?', [phone, oldPhone]);
    }
    await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);
    logger.info('SPOC phone changed · spocId=' + req.spoc.id + ' (updated tbl_client_contacts + tbl_user)');
    return modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

/**
 * My Rate Card — the client's active priced services.
 * Mirrors the legacy dashboard's rate-card source (tbl_client_service joined to
 * tbl_client_rate_card), but returns the full line (category + service type +
 * charge + rate-card name) rather than just the rate-card id/name pair.
 */
router.get('/ratecard', async (req, res, next) => {
  try {
    logger.info('Fetch client rate card · clientId=' + req.spoc.client_id);
    const [rows] = await pool.query(
      `SELECT CS.client_service_id,
              CS.total_amount,
              CS.charge_type,
              SC.service_catg_name  AS service_category_name,
              ST.service_type_name,
              CRC.crc_ratecard_name AS rate_card_name
         FROM tbl_client_service CS
         LEFT JOIN tbl_service_type     ST  ON ST.service_type_id  = CS.service_type_id
         LEFT JOIN tbl_service_catg     SC  ON SC.service_catg_id  = CS.service_catg_id
         LEFT JOIN tbl_client_rate_card CRC ON CRC.crc_id = CS.rate_card_id AND CRC.status = 1
        WHERE CS.client_id = ? AND CS.service_status = 1
        ORDER BY SC.service_catg_name ASC, ST.service_type_name ASC
        LIMIT 1000`, [req.spoc.client_id]);
    logger.info('Returning ' + rows.length + ' rate card lines');
    modernOk(res, { items: rows });
  } catch (e) { next(e); }
});

router.get('/contacts/managers',async (req, res, next) => {
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

// My Team — every contact belonging to the SPOC's client. Sourced from
// tbl_client_contacts by client_id (both active + inactive so the mobile
// app can show the status badge). Shape matches the client app's TeamMember.
/**
 * Distinct cities the client actually has orders in — for the Orders "Cities"
 * filter. Server-side DISTINCT over ALL the client's jobs, so the list is
 * complete (not limited to the recent window the app can hold client-side) and
 * client-scoped (not the ~11k tbl_city master the legacy dumped).
 */
router.get('/cities', async (req, res, next) => {
  try {
    logger.info('List client cities · clientId=' + req.spoc.client_id);
    const [rows] = await pool.query(
      `SELECT DISTINCT ci.city_name AS name
         FROM tbl_job j
         LEFT JOIN tbl_address a ON a.address_id = j.fk_address_id
         LEFT JOIN tbl_city    ci ON ci.city_id  = a.city_id
        WHERE j.fk_client_id = ? AND ci.city_name IS NOT NULL AND ci.city_name <> ''
        ORDER BY ci.city_name`,
      [req.spoc.client_id]);
    logger.info('Returning ' + rows.length + ' cities');
    modernOk(res, { items: rows.map((r) => r.name) });
  } catch (e) { next(e); }
});

router.get('/team', async (req, res, next) => {
  try {
    logger.info('List client team · clientId=' + req.spoc.client_id);
    const [rows] = await pool.query(
      `SELECT id, contact_name, contact_email, contact_no,
              contact_desgn, manager_id, status, approval_by_client
         FROM tbl_client_contacts
        WHERE client_id = ?
        ORDER BY contact_name`,
      [req.spoc.client_id]);
    const items = rows.map((r) => ({
      id: r.id,
      name: r.contact_name,
      email: r.contact_email,
      mobile: r.contact_no,
      designation: r.contact_desgn,
      managerId: r.manager_id,
      status: r.status,
      approvalByClient: r.approval_by_client,
    }));
    // isManager drives the Orders "Client Team" filter: only reporting managers
    // (someone reports to them in the manager_id tree) get the team filter.
    const { isManager } = await resolveClientHierarchy(req);
    logger.info('Returning ' + items.length + ' team members · isManager=' + isManager);
    modernOk(res, { items, isManager });
  } catch (e) { next(e); }
});

// Per-SPOC booking breakdown for the Orders "Client Team" filter and the
// per-SPOC Today's-jobs view. Lists everyone in the caller's reporting subtree
// (themselves + all reports, recursively) with how many jobs each has booked
// (tbl_job.reporting_contact_id). `?scope=today` counts only today's tickets.
router.get('/team/bookings', async (req, res, next) => {
  try {
    const hier = await resolveClientHierarchy(req);
    const todayOnly = String(req.query.scope || '') === 'today';
    const dateClause = todayOnly ? 'AND DATE(j.ticket_created_date_time) = CURDATE()' : '';
    const placeholders = hier.subtreeIds.map(() => '?').join(',');
    logger.info('Team bookings · clientId=' + req.spoc.client_id + ' · subtree=' + hier.subtreeIds.length + (todayOnly ? ' · today' : ''));
    // ONE grouped scan of tbl_job (not 56 correlated COUNT subqueries — with no
    // index on reporting_contact_id those each full-scan ~1.4M rows and blow the
    // request timeout). LEFT JOIN so zero-booking SPOCs still appear.
    const [rows] = await pool.query(
      `SELECT c.id, c.contact_name, c.contact_desgn, COALESCE(b.cnt, 0) AS bookings
         FROM tbl_client_contacts c
         LEFT JOIN (
           SELECT j.reporting_contact_id AS rc, COUNT(*) AS cnt
             FROM tbl_job j
            WHERE j.reporting_contact_id IN (${placeholders}) ${dateClause}
            GROUP BY j.reporting_contact_id
         ) b ON b.rc = c.id
        WHERE c.id IN (${placeholders})
        ORDER BY (c.id = ?) DESC, bookings DESC, c.contact_name`,
      [...hier.subtreeIds, ...hier.subtreeIds, req.spoc.id]);
    const members = rows.map((r) => ({
      id: r.id,
      name: r.contact_name,
      designation: r.contact_desgn,
      bookings: Number(r.bookings),
      isMe: Number(r.id) === Number(req.spoc.id),
    }));
    modernOk(res, { isManager: hier.isManager, isTop: hier.isTop, me: req.spoc.id, members });
  } catch (e) { next(e); }
});

// ─── Support contacts ────────────────────────────────────────────────
// The EasyFix SPOCs assigned to the logged-in client, from tbl_vertical_mapping:
//   user_type 1 = PRIMARY SPOC, user_type 2 = SECONDARY SPOC.
// Powers Profile → Contact Support: the mail is addressed to the primary SPOC
// with the secondary SPOC cc'd, so the client reaches the people who own them.
router.get('/support-contacts', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT vm.user_type, u.official_email AS email, u.user_name AS name, u.mobile_no AS mobile
         FROM tbl_vertical_mapping vm
         JOIN tbl_user u ON u.user_id = vm.user_id AND u.user_status = 1
        WHERE vm.client_id = ? AND vm.user_type IN (1, 2)
          AND u.official_email IS NOT NULL AND u.official_email <> ''
        ORDER BY vm.user_type, u.user_id`,
      [req.spoc.client_id]);
    const pick = (t) => rows.filter((r) => Number(r.user_type) === t).map((r) => ({ email: r.email, name: r.name, mobile: r.mobile || null }));
    const primary = pick(1);
    const secondary = pick(2);
    logger.info('Support contacts · clientId=' + req.spoc.client_id + ' · primary=' + primary.length + ' secondary=' + secondary.length);
    modernOk(res, {
      primary,
      secondary,
      to: primary.map((p) => p.email),        // primary SPOC(s)
      cc: secondary.map((s) => s.email),      // secondary SPOC(s)
    });
  } catch (e) { next(e); }
});

// Contact Support — sends the support email SERVER-SIDE so the app never opens
// the phone's mail app. Recipients are resolved server-side (To = primary
// SPOC(s), Cc = secondary SPOC(s) + prem.rai@easyfix.in) — never trusted from
// the client body. The app just sends { subject?, message }.
router.post('/support', async (req, res, next) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (message.length < 3) return modernError(res, 400, 'Please add a message (min 3 characters).');
    const [rows] = await pool.query(
      `SELECT vm.user_type, u.official_email AS email
         FROM tbl_vertical_mapping vm
         JOIN tbl_user u ON u.user_id = vm.user_id AND u.user_status = 1
        WHERE vm.client_id = ? AND vm.user_type IN (1, 2)
          AND u.official_email IS NOT NULL AND u.official_email <> ''
        ORDER BY vm.user_type, u.user_id`,
      [req.spoc.client_id]);
    const primary = rows.filter((r) => Number(r.user_type) === 1).map((r) => r.email);
    const secondary = rows.filter((r) => Number(r.user_type) === 2).map((r) => r.email);
    const to = primary.length ? primary : ['ithelpdesk@easyfix.in'];
    const cc = Array.from(new Set([...secondary, 'prem.rai@easyfix.in'])).filter(Boolean);
    const [[cl]] = await pool.query('SELECT client_name FROM tbl_client WHERE client_id = ?', [req.spoc.client_id]);
    const clientName = cl?.client_name || '';
    const subject = String(req.body?.subject || '').trim() || `Client App Support Request${clientName ? ' – ' + clientName : ''}`;
    const from = req.spoc.contact_email || req.spoc.contact_no || '';
    const text = `From: ${req.spoc.contact_name || ''} <${from}>${clientName ? ' · ' + clientName : ''}\n\n${message}`;
    await require('../../services/email.service').send({ to, cc, subject, text, category: 'client-support' });
    logger.info('Client support email sent · clientId=' + req.spoc.client_id + ' · to=' + to.join(','));
    modernOk(res, { sent: true, to, cc, subject });
  } catch (e) { next(e); }
});

// Delete (deactivate) my account — soft delete: sets the SPOC inactive so they
// can no longer log in (findSpoc/findSpocById require status = 1). Data is kept.
router.delete('/profile', async (req, res, next) => {
  try {
    await pool.query('UPDATE tbl_client_contacts SET status = 0 WHERE id = ?', [req.spoc.id]);
    logger.info('Client account deactivated (delete) · spocId=' + req.spoc.id);
    modernOk(res, { deleted: true });
  } catch (e) { next(e); }
});

// ─── Notifications ───────────────────────────────────────────────────
// Dashboard notifications for the logged-in Client user, from the same
// dashboard_notification_log the legacy dashboard reads (job assigned /
// completed / cancelled, booking confirmed, …). Keyed by the SPOC's linked
// Client user (req.clientUser.userId). Mirrors the legacy query exactly:
//   WHERE user_id = ? GROUP BY job_id ORDER BY createdAt DESC.
router.get('/notices', async (req, res, next) => {
  try {
    // Dashboard notifications for the logged-in CLIENT — matched by the client's
    // jobs (dashboard_notification_log.job_id → tbl_job.fk_client_id), not by an
    // individual user_id (those rows are keyed to whichever internal/SPOC user
    // the event fired for, so a user-id filter misses the client's own events).
    const [rows] = await pool.query(
      `SELECT n.id, n.n_title, n.n_desc, n.status, n.job_id, n.createdAt
         FROM dashboard_notification_log n
         JOIN tbl_job j ON j.job_id = n.job_id
        WHERE j.fk_client_id = ?
        GROUP BY n.job_id
        ORDER BY n.createdAt DESC
        LIMIT 100`,
      [req.spoc.client_id]);
    const items = rows.map((r) => ({
      notice_id: r.id,
      title: r.n_title || 'Notification',
      message: r.n_desc || null,
      is_read: String(r.status).toLowerCase() === 'read',
      created_at: r.createdAt,
      job_id: r.job_id || null,
    }));
    logger.info('Notices · clientId=' + req.spoc.client_id + ' · count=' + items.length);
    modernOk(res, { items });
  } catch (e) { next(e); }
});

// Mark notifications read — a single id, or all of the client's notifications.
// Scoped to the client's jobs (same matching as GET /notices).
router.patch('/notices/read', async (req, res, next) => {
  try {
    const id = Number(req.body && req.body.notice_id) || null;
    const [r] = id
      ? await pool.query(
          `UPDATE dashboard_notification_log n JOIN tbl_job j ON j.job_id = n.job_id
              SET n.status = 'read' WHERE n.id = ? AND j.fk_client_id = ?`,
          [id, req.spoc.client_id])
      : await pool.query(
          `UPDATE dashboard_notification_log n JOIN tbl_job j ON j.job_id = n.job_id
              SET n.status = 'read' WHERE j.fk_client_id = ? AND n.status <> 'read'`,
          [req.spoc.client_id]);
    modernOk(res, { updated: r.affectedRows || 0 });
  } catch (e) { next(e); }
});

// ─── Notice board ────────────────────────────────────────────────────
// Published announcements targeted at the 'client' surface (managed from the
// CRM Notice Board). Pinned first, then newest. Read state keyed to the SPOC.
router.get('/notice-board', async (req, res, next) => {
  try {
    const notice = require('../../services/notice.service');
    const items = await notice.listActiveForSurface({
      surface: 'client', readerType: 'client', readerId: req.spoc.id, limit: 20,
    });
    logger.info('Notice board · clientId=' + req.spoc.client_id + ' · count=' + items.length);
    modernOk(res, { items });
  } catch (e) { next(e); }
});

router.patch('/notice-board/:noticeId/read', async (req, res, next) => {
  try {
    const notice = require('../../services/notice.service');
    await notice.markRead({ noticeId: Number(req.params.noticeId), surface: 'client', readerType: 'client', readerId: req.spoc.id });
    modernOk(res, { ok: true });
  } catch (e) { next(e); }
});

// ─── Device id ───────────────────────────────────────────────────────
// On login the client app reports a stable per-install device id; store it on
// the SPOC's tbl_client_contacts row so we know which device is signed in.
router.post('/device-token', async (req, res, next) => {
  try {
    const deviceId = req.body && (req.body.device_id || req.body.token);
    if (!deviceId) return modernError(res, 400, 'device_id is required');
    await pool.query(
      'UPDATE tbl_client_contacts SET device_id = ? WHERE id = ?',
      [String(deviceId), req.spoc.id]);
    logger.info('Device id recorded · spocId=' + req.spoc.id);
    modernOk(res, { ok: true });
  } catch (e) { next(e); }
});

// Customer lookup by mobile — powers the New Order auto-fill (name/email
// prefill when the caller is an existing customer). Returns the most recent
// matching customer, or { customer: null } when unknown.
/*
 * Customer lookup by mobile.
 *
 * The number travels in the BODY, not the path (2026-08-12). A request URL is
 * written to the access log on every request and to the error log on every
 * failure, and it also reaches every upstream proxy/CDN access log we do not
 * control — so a phone number in the path was logged at request rate in places
 * we cannot redact. (A query string is no better: it is part of req.originalUrl
 * too.) Our own logs additionally mask mobile-shaped values via
 * utils/log-format#redactUrl, but that only covers logs we own.
 */
async function lookupCustomerByMobile(rawMobile, res, next) {
  try {
    const mobile = String(rawMobile || '').replace(/\D/g, '');
    if (!/^\d{10}$/.test(mobile)) return modernOk(res, { customer: null });
    const [[customer]] = await pool.query(
      `SELECT customer_id, customer_name, customer_mob_no, customer_email
         FROM tbl_customer
        WHERE customer_mob_no = ?
        ORDER BY customer_id DESC LIMIT 1`,
      [mobile]);
    logger.info('Customer lookup by mobile · found=' + (customer ? 'yes' : 'no'));
    return modernOk(res, { customer: customer || null });
  } catch (e) { return next(e); }
}

// Canonical.
router.post('/customers/lookup', (req, res, next) => (
  lookupCustomerByMobile(req.body?.mobile, res, next)
));

/*
 * DEPRECATED alias — remove once Easyfix_client_UI and Easyfix_Client_App have
 * shipped the POST call (both are updated to use it; this only covers the
 * window where an older client build is still live, since the backend and the
 * two frontends cannot deploy atomically). Behaviour is identical.
 */
router.get('/customers/mobile/:mobile', (req, res, next) => {
  logger.warn('DEPRECATED GET /customers/mobile/:mobile — migrate to POST /customers/lookup');
  return lookupCustomerByMobile(req.params.mobile, res, next);
});

// Saved addresses for a customer, so Book-a-service can offer their previous
// locations. Distinct addresses from this customer's jobs at THIS client that
// reached a real service stage (status 2/3/5/10/15/20/21) — skips new/pending/
// cancelled/enquiry so we only surface addresses that were actually serviced.
// Deduped, newest-first; never other clients' work.
router.get('/customers/:customerId/addresses', async (req, res, next) => {
  try {
    const cid = Number(req.params.customerId);
    if (!cid) return modernOk(res, { items: [] });
    const [rows] = await pool.query(
      `SELECT a.address_id, a.address, a.building, a.landmark, a.locality,
              a.pin_code, a.gps_location, a.city_id, ci.city_name,
              MAX(recent.job_id) AS last_job
         FROM (
                SELECT fk_address_id, job_id
                  FROM tbl_job
                 WHERE fk_customer_id = ? AND fk_client_id = ?
                   AND job_status IN (3,5,2,20,10,15,21)
                 ORDER BY job_id DESC
              ) recent
         JOIN tbl_address a  ON a.address_id = recent.fk_address_id
         LEFT JOIN tbl_city ci ON ci.city_id = a.city_id
        GROUP BY a.address_id, a.address, a.building, a.landmark, a.locality,
                 a.pin_code, a.gps_location, a.city_id, ci.city_name
        ORDER BY last_job DESC`,
      [cid, req.spoc.client_id]);
    logger.info('Customer saved addresses (serviced jobs) · customerId=' + cid + ' · count=' + rows.length);
    modernOk(res, { items: rows });
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
