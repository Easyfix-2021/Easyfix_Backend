const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const requireSpocAuth = require('../../middleware/client-auth');
const { pool } = require('../../db');
const clientAuth = require('../../services/client-auth.service');
const jobService = require('../../services/job.service');
const clientRequest = require('../../services/client-request.service');
const { modernOk, modernError } = require('../../utils/response');
const { sendXlsx } = require('../../utils/xlsx-export');
const { STATUS_LABELS } = require('../../services/integration.service');
const emailService = require('../../services/email.service');
const logger = require('../../logger');
const { istIsPast, currentIstMonth, monthBounds, todayIst } = require('../../utils/ist-calendar');
const { requireGrant } = require('../../services/client-access.service');
const perfService = require('../../services/client-performance.service');
const tatService = require('../../services/tat.service');
const { getTargets, judgeAgainst } = require('../../services/client-target.service');
const holidayService = require('../../services/holiday.service');
const noticeService = require('../../services/notice.service');
const clientService = require('../../services/client.service');
const clientXlsx = require('../../services/client-xlsx.service');

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
      /*
       * Reason codes are for the LOG. Users get a sentence.
       *
       * This route used to `return modernError(res, 401, r.reason)`, which put
       * the bare code on screen — a mistyped OTP read "OTP_MISMATCH", and an
       * unregistered identifier read "USER_NOT_FOUND". Same map shape as
       * routes/auth.js#verify-otp, which has translated the CRM login's codes
       * since it shipped; this one was simply never given the same treatment.
       *
       * USER_NOT_FOUND is now mostly unreachable from the web + mobile clients
       * (both stop at login-otp's `delivered:false`), but it still fires for a
       * SPOC deactivated BETWEEN the two steps, and for any direct API caller.
       */
      const REASON_MESSAGES = {
        CLIENT_INACTIVE: [403, 'This client account is inactive. Please contact your EasyFix SPOC.'],
        USER_NOT_FOUND:  [401, "This email or mobile isn't registered. Check with your EasyFix contact."],
        NO_OTP_ISSUED:   [400, 'No active code — please request a new one.'],
        OTP_EXPIRED:     [401, 'That code has expired — please request a new one.'],
        OTP_MISMATCH:    [401, 'Incorrect code. Please check and try again.'],
      };
      const [status, message] = REASON_MESSAGES[r.reason] || [401, 'We could not sign you in. Please try again.'];
      return modernError(res, status, message);
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

/*
 * ─── SIGNUP — A REQUEST FOR ACCESS, NOT SELF-SERVICE ───────────────────────
 *
 * The landing page has always POSTed here and the route did not exist, so
 * "Signup Now" 404'd and the form reported "Signup failed. Please contact your
 * account manager." — which reads as a policy decision rather than a bug, and
 * so was invisible.
 *
 * ⚠ IT DELIBERATELY DOES NOT CREATE ANYTHING. A portal SPOC is a row in
 * tbl_client_contacts belonging to a specific client, and the client id is
 * typed by whoever fills this form — an unauthenticated stranger. Provisioning
 * on that input would let anyone attach themselves to any client and then
 * receive that client's login OTPs. Access is granted by ops, so this routes
 * the request to them, exactly as /auth/support does for a login problem.
 *
 * For the same reason the response never reveals whether the client id exists:
 * it always reports "sent", so the form cannot be used to enumerate clients.
 * The email itself says whether the id matched, because ops need that.
 *
 * Placed ABOVE requireSpocAuth — someone without an account cannot be
 * authenticated by definition.
 */
router.post('/auth/signup', validate(Joi.object({
  clientId: Joi.string().trim().min(1).max(120).required(),
  email:    Joi.string().trim().max(150).pattern(/.+@.+\..+/).required()
    .messages({ 'string.pattern.base': 'valid email required' }),
})), async (req, res, next) => {
  try {
    const clientId = String(req.body.clientId).trim();
    const email = String(req.body.email).trim();

    /* Resolve for the EMAIL's benefit only — never for the response. Accepts a
     * numeric id or a name, because the field says "Client ID" and people type
     * their company. */
    const asNum = Number(clientId);
    const [[match]] = await pool.query(
      Number.isInteger(asNum) && asNum > 0
        ? 'SELECT client_id, client_name FROM tbl_client WHERE client_id = ? LIMIT 1'
        : 'SELECT client_id, client_name FROM tbl_client WHERE client_name = ? LIMIT 1',
      [Number.isInteger(asNum) && asNum > 0 ? asNum : clientId],
    );

    const known = match
      ? `Matched client ${match.client_id} — ${match.client_name}.`
      : 'No client matched that value; it was typed by the requester and is unverified.';
    const text = `A client-portal access request came in from the public login page.

`
      + `Client ID entered : ${clientId}
`
      + `Email             : ${email}

`
      + `${known}

`
      + `No account has been created. To grant access, add them as a contact on
`
      + `the client (Manage Clients -> Contacts) — they can then sign in by OTP.`;

    await require('../../services/email.service').send({
      to: ['ithelpdesk@easyfix.in'],
      cc: ['prem.rai@easyfix.in'],
      subject: `Client Portal — access request${match ? ' – ' + match.client_name : ''}`,
      text,
      category: 'client-signup-request',
    });
    logger.info('Client portal signup request · clientId=' + clientId + ' · matched=' + (match ? match.client_id : 'no'));
    modernOk(res, { sent: true });
  } catch (e) { next(e); }
});

// ─── Protected ──────────────────────────────────────────────────────
router.use(requireSpocAuth);

// `access` is ADDITIVE — existing callers read res.data.spoc and are
// untouched. Returning it here saves the portal a second round trip at boot,
// which matters because nothing above the nav can render until it lands.
router.get('/me', (req, res) => modernOk(res, { spoc: req.spoc, access: req.access }));

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

/*
 * GET /api/client/access
 *
 * The caller's own effective grants. The client portal asks for this once at
 * boot and hides every surface it does not hold, so the nav never offers a tab
 * that would 403. The server still guards each gated route independently —
 * hiding a tab is a courtesy, not a control.
 */
router.get('/access', (req, res) => modernOk(res, req.access));

/*
 * GET /api/client/action-queue
 *
 * Work that is blocked ON THE CLIENT — not the client's view of EasyFix's
 * queue. Every item here is something no EasyFix action can clear.
 *
 * ONE ITEM TYPE, DELIBERATELY. A job is "awaiting your approval" when it has
 * at least one approval-pending billing line (tbl_job_services.job_service_status = 1)
 * and the client has neither approved nor rejected it (both timestamps null).
 * That is the exact condition PATCH /jobs/:id/estimate/approve clears, so the
 * queue and the action that empties it cannot drift apart.
 *
 * Site access, PO-pending and QC sign-off are real queue types on paper, but no
 * column in tbl_job records them today. They are intentionally absent rather
 * than approximated — a queue that invents items is worse than a short one.
 * Adding them later is additive: give the row a different `type`.
 *
 * Query: ?limit=<1..100> (default 25)
 */
router.get('/action-queue', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const hier = await resolveClientHierarchy(req);
    // A SPOC whose role (or override) grants all-stores visibility sees the
    // whole client's queue; everyone else stays inside their booking subtree.
    const scopeIds = hierarchyFilter(hier, req);   // undefined = whole client

    const params = [req.spoc.client_id];
    let mine = '';
    if (Array.isArray(scopeIds)) {
      mine = `AND J.reporting_contact_id IN (${scopeIds.map(() => '?').join(',')})`;
      params.push(...scopeIds);
    }
    params.push(limit);

    logger.info('Fetch client action queue · clientId=' + req.spoc.client_id + ' · limit=' + limit);
    const [rows] = await pool.query(`
      SELECT J.job_id, J.job_reference_id, J.client_ref_id, J.job_status,
             J.ticket_created_date_time,
             TIMESTAMPDIFF(HOUR, J.ticket_created_date_time, NOW()) DIV 24 AS age_days,
             COALESCE(city.city_name, 'Unknown') AS city_name,
             COALESCE(TSC.service_catg_name, 'Uncategorised') AS category,
             ROUND(SUM(js.total_charge * COALESCE(js.quantity, 1) + COALESCE(js.material_charge, 0)), 2) AS estimate_value
        FROM tbl_job J
        JOIN tbl_job_services js ON js.job_id = J.job_id AND js.job_service_status = 1
        LEFT JOIN tbl_address      A    ON A.customer_id = J.fk_customer_id AND A.address_id = J.fk_address_id
        LEFT JOIN tbl_city         city ON city.city_id  = A.city_id
        LEFT JOIN tbl_service_catg TSC  ON TSC.service_catg_id = J.fk_service_catg_id
       WHERE J.fk_client_id = ?
         ${mine}
         AND J.approved_on_date_time IS NULL
         AND J.approval_reject_date_time IS NULL
         /*
          * ⚠ STATUS 15 ONLY. This was NOT IN (3,5,6), which admitted any
          * non-terminal job that happened to carry an approval-pending billing
          * line. Measured on QA that meant 6,832 ENQUIRIES (status 7) against
          * 54 real approvals — a queue titled "Jobs waiting on you" that was
          * 99% work the client could not act on, because no estimate had been
          * sent for it.
          *
          * 15 is "estimate sent, not yet decided", which is the only state
          * PATCH /jobs/:id/estimate/approve can clear. Queue membership and the
          * action that empties it now describe the same set.
          *
          * Other queue types (site access, PO-pending, QC sign-off) remain
          * absent rather than approximated; adding one later is additive — give
          * the row a different type, which is why the label below is DERIVED
          * rather than hardcoded. (No backticks in this comment: it lives
          * inside a JS template literal, where one would end the string.)
          */
         AND J.job_status = 15
       GROUP BY J.job_id
       ORDER BY age_days DESC, J.job_id ASC
       LIMIT ?`, params);

    const items = rows.map((r) => ({
      /*
       * ⚠ ONLY STATUS 15 IS AN APPROVAL.
       *
       * Membership of this queue is "has an approval-pending billing line and
       * no approve/reject stamp", which is the exact condition the approve
       * endpoint clears — but that admits jobs in any non-terminal status. On
       * QA it is dominated by ENQUIRIES: 6,832 rows at status 7 against 54 at
       * status 15. Every one of them was rendering as "Estimate approval — …"
       * behind an Approve button, for work the client cannot approve because
       * no estimate has been sent.
       *
       * The WHERE above now admits only 15, so this is true for every row
       * today. It is still DERIVED rather than hardcoded on purpose: if that
       * filter is ever loosened, the labels stay honest by construction
       * instead of every row silently reading "Estimate approval" again —
       * which is exactly the bug this replaced.
       */
      type: Number(r.job_status) === 15 ? 'approval' : 'open',
      approvable: Number(r.job_status) === 15,
      jobStatus: Number(r.job_status),
      jobId: Number(r.job_id),
      reference: r.job_reference_id || r.client_ref_id || null,
      city: r.city_name,
      category: r.category,
      ageDays: Number(r.age_days || 0),
      estimateValue: r.estimate_value == null ? null : Number(r.estimate_value),
      // The action that clears this row, so the FE does not hard-code a mapping
      // from type to endpoint.
      action: Number(r.job_status) === 15
        ? { label: 'Approve', method: 'PATCH', path: `/api/client/jobs/${r.job_id}/estimate/approve` }
        // GET, not PATCH: there is nothing to clear. The card opens the job
        // drawer either way, but a row that offers to approve something the
        // server would reject is a button that lies.
        : { label: 'View', method: 'GET', path: `/api/client/jobs/${r.job_id}` },
    }));

    logger.info('Action queue: ' + items.length + ' item(s) awaiting the client');
    modernOk(res, { items, total: items.length, types: ['approval'] });
  } catch (e) { next(e); }
});

/*
 * GET /api/client/performance
 *
 * The client's performance book. Composed from TWO sources, deliberately:
 *
 *   TAT / SLA / approval → services/tat.service.js via forClientWindow().
 *     That engine is the ONE place TAT is computed. This route does not
 *     re-derive a single hour of it. The retired category × city-tier day
 *     count that used to live in client-performance.service.js is gone.
 *
 *   volume / age / FTFR  → services/client-performance.service.js.
 *     Everything the TAT engine cannot answer, because it only loads
 *     COMPLETED jobs and only scores segment targets.
 *
 * WHY THE PAGE SHOWS TWO SCORES. The engine splits ownership: segments 1, 2
 * and 4 are EasyFix's clocks, segment 3 (estimate sent → client decided) is
 * the CLIENT's. Folding them into one number would let a client's own slow
 * approvals show up as an EasyFix SLA miss. So EF Score and Client Score are
 * reported side by side and never averaged together.
 *
 * GATED. requireGrant('performance') 403s a SPOC whose role and overrides do
 * not include it, naming the flag an administrator would set.
 *
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: the current IST month)
 *        ?dim=city|category|technician|jobType (default: city)
 *        ?months=<1..24>                       (volume series, default 6)
 */
const CLIENT_ROLLUP_DIMS = {
  city: 'City',
  category: 'Category',
  technician: 'Technician',
  jobType: 'Local / Travel',
};

router.get('/performance', requireGrant('performance'), async (req, res, next) => {
  try {
    // The default window is the CURRENT IST MONTH, resolved with the shared
    // IST helpers rather than `new Date().toISOString()`. A UTC date is the
    // previous day between 00:00 and 05:30 IST, which would silently shift a
    // month-to-date figure on the first of every month for anyone opening the
    // page before breakfast.
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))
      ? req.query.from
      : monthBounds(currentIstMonth()).start;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? req.query.to : todayIst();
    const dim = Object.prototype.hasOwnProperty.call(CLIENT_ROLLUP_DIMS, String(req.query.dim))
      ? String(req.query.dim) : 'city';

    const hier = await resolveClientHierarchy(req);
    const reportingContactIds = hierarchyFilter(hier, req);   // undefined = whole client
    /*
     * ?city= — added 2026-08-26 so the client dashboard's Performance health
     * card obeys the same city chip its three neighbours do. Before this the
     * card had to print "not narrowed by the city filter" beside itself,
     * because /performance had no city dimension at all and would have ignored
     * the chip silently.
     *
     * Matched on NAME, not id, because that is what GET /cities offers the
     * picker — it is DISTINCT over the client's own jobs, so an unknown value
     * selects nothing rather than reaching another tenant, and it is
     * parameterised regardless.
     */
    const city = String(req.query.city || '').trim();
    const scope = { clientId: req.spoc.client_id, from, to, reportingContactIds, city };

    logger.info('Fetch client performance · clientId=' + req.spoc.client_id + ' · ' + from + '..' + to + ' · dim=' + dim + (city ? ' · city=' + city : ''));

    const targets = await getTargets(req.spoc.client_id);
    // Independent reads — run them together. The TAT engine is the heavy one
    // (it scores every completed job in the window in JS), so serialising the
    // three cheap SQL aggregates behind it would be pure added latency.
    const [book, closure, ftf, series] = await Promise.all([
      tatService.forClientWindow(scope),
      perfService.closureStats(scope),
      perfService.firstTimeFix(scope),
      perfService.volume(scope, req.query.months),
    ]);

    const sum = book.summary;

    modernOk(res, {
      window: { from, to, label: book.windowLabel },
      targets,

      /*
       * The engine's own output, passed through rather than reshaped. The
       * segment list carries its own labels and owners, so the UI never has
       * to hard-code "Seg 3 is the client's" — if the spec adds a segment the
       * page grows a row without a frontend change.
       */
      tat: {
        jobsAnalysed: sum.jobsAnalysed,
        truncated: book.truncated,
        rowCap: book.rowCap,
        efScorePct: sum.efScorePct,
        efMet: sum.efMet,
        efTotal: sum.efTotal,
        efStatus: judgeAgainst('sla_pct', sum.efScorePct, targets.sla_pct),
        clientScorePct: sum.clientScorePct,
        clientMet: sum.clientMet,
        clientEvaluated: sum.clientEvaluated,
        segments: sum.segments,
        labels: sum.labels,
        avgBookingLeadHours: sum.avgBookingLeadHours,
        avgPunctualityHours: sum.avgPunctualityHours,
        arrivedOnTimePct: sum.arrivedOnTimePct,
        // Caveats travel WITH the numbers. A page that shows a score without
        // saying "stop-clock is not implemented" is quietly overstating it.
        assumptions: book.assumptions,
      },

      breakdown: {
        dimension: dim,
        label: CLIENT_ROLLUP_DIMS[dim],
        rows: sum.rollups[dim] || [],
      },
      dimensions: Object.entries(CLIENT_ROLLUP_DIMS).map(([key, label]) => ({ key, label })),

      closure: {
        ...closure,
        avgAgeStatus: judgeAgainst('avg_age_days', closure.avgAgeDays, targets.avg_age_days),
      },
      firstTimeFix: {
        ...ftf,
        ftfrStatus: judgeAgainst('ftfr_pct', ftf.ftfrPct, targets.ftfr_pct),
        revisitStatus: judgeAgainst('revisit_pct', ftf.revisitPct, targets.revisit_pct),
      },
      volume: series,
    });
  } catch (e) {
    if (e && e.status === 404) return modernError(res, 404, e.message);
    next(e);
  }
});

/*
 * ⚠ DEPRECATED — GET /api/client/services/sda-tat
 * ═══════════════════════════════════════════════════════════════════════════
 * This route carries the RETIRED category × city-tier day-count definition of
 * TAT. It is not the platform's TAT any more: services/tat.service.js
 * (spec v1.0, four segments, hour targets, locality-based) is.
 *
 * NO LIVE CONSUMER REMAINS IN THIS ORGANISATION'S CODE. Easyfix_Client_App
 * declared a ServiceTierTable component against it, but that component was
 * never rendered — it was dead code, and as of 2026-08-21 it has been replaced
 * by CategoryPerformanceTable, which reads
 * GET /api/client/performance?dim=category from the TAT engine instead.
 *
 * WHY THE SHAPES COULD NOT SIMPLY BE SWAPPED:
 *   • the engine deliberately has NO tier dimension — 86 of 680 tbl_city rows
 *     have no tier, and inspection showed they are states and villages, not
 *     cities. Coverage-based LOCAL / TRAVEL replaced it.
 *   • the engine has no SDA metric at all; punctuality (Seg 1) is the nearest
 *     equivalent and is measured differently.
 * So the app got a new table rather than the same table with new numbers.
 *
 * WHY IT IS STILL MOUNTED. Older app builds already in the field, and any
 * external caller nobody has inventoried, may still hit it. Removing a
 * client-facing endpoint is a separate, deliberate decision from retiring the
 * definition behind it.
 *
 * TO RETIRE IT: confirm no traffic in the access logs for a full release
 * cycle, then delete this route and its inline thresholds. Until then this is
 * the LAST copy of the old definition in the tree — do not add another.
 *
 * Per-service × city-tier TAT + SDA completion rates.
 */
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
 *   • ?spoc I may see        → just that one SPOC
 *   • else allStores or top  → undefined (no filter → whole client)
 *   • else                   → my whole subtree
 *
 * ⚠ allStores BELONGS HERE, NOT AT THE CALL SITES.
 *
 * It is the role's documented "sees the whole client vs only its own booking
 * subtree" switch (client-access.service.js), so it is a property of THE
 * SCOPE. But four routes wrote `allStores ? undefined : hierarchyFilter(...)`
 * and every other caller wrote the bare call — so a Senior Leader's Home
 * counted the whole client while /jobs, /export/jobs and /orders/counts
 * counted only their booking subtree. "Total open · 6" opened a list of 2.
 *
 * Folding it in is what makes that unrepeatable: a new caller cannot forget a
 * prefix that no longer exists.
 *
 * The ?spoc containment check widens with it. That check exists to stop a
 * Store SPOC reading a peer's book by guessing a contact id — someone who may
 * already see the whole client is not spying by naming one of its SPOCs. And
 * fk_client_id is in every WHERE regardless, so a foreign id selects nothing
 * rather than reaching another tenant.
 */
function hierarchyFilter(hier, req) {
  const spocFilter = Number(req.query.spoc) || null;
  const allStores = !!(req.access && req.access.allStores);
  if (spocFilter && (allStores || hier.subtreeIds.includes(spocFilter))) return [spocFilter];
  if (allStores || hier.isTop) return undefined;
  return hier.subtreeIds;
}

/*
 * The same scope as a BARE SQL predicate, for handlers that need it inside a
 * SUM(CASE WHEN …) as well as in a WHERE.
 *
 * The `AND …` / empty-string form the WHERE-only callers use cannot go in a
 * CASE — an omitted predicate leaves `CASE WHEN AND …`. So unrestricted is the
 * literal TRUE, and an empty scope is FALSE: a SPOC who may see nothing counts
 * nothing, never everything. Both bind no parameters, so a call site spreads
 * `...scope.params` unconditionally and the placeholder count still matches.
 */
function scopePredicate(scopeIds) {
  if (!Array.isArray(scopeIds)) return { sql: '1=1', params: [] };
  if (!scopeIds.length)         return { sql: '1=0', params: [] };
  return {
    sql: `j.reporting_contact_id IN (${scopeIds.map(() => '?').join(',')})`,
    params: scopeIds,
  };
}

/*
 * CSV → number[]. The empty-segment filter is load-bearing, not tidiness:
 * ''.split(',') is [''], and Number('') is 0, which IS finite — so without it
 * an ABSENT ownerIds parsed as [0], the intersection below emptied, and every
 * request answered zero rows. Caught by tests/client-jobs-shared-filters.test.js.
 */
const csvIds = (v) => String(v == null ? '' : v).split(',')
  .map((x) => x.trim())
  .filter((x) => x !== '')
  .map(Number)
  .filter((n) => Number.isFinite(n));

/*
 * ─── ONE FILTER SET FOR EVERY ROUTE THAT LISTS A CLIENT'S JOBS ──────────────
 *
 * The list (/jobs), the export (/export/jobs) and the tab counts
 * (/orders/counts) each used to build their own, and they had drifted so far
 * apart that Order History rendered "Filters active" over completely
 * unfiltered rows while the badge above it counted a different population
 * again. Sharing the resolver is what makes them agree BY CONSTRUCTION rather
 * than by two people remembering to edit both.
 *
 * ⚠ ownerIds ARE CONTACT IDS AND BELONG IN reportingContactIds.
 *
 * This is the trap that produced the original bug, and it is worth stating in
 * full because the obvious fix is wrong twice over. tbl_job has three owner-ish
 * columns in TWO different id spaces:
 *
 *   job_owner         tbl_user.user_id — the internal EasyFix operator.
 *   job_client_owner  tbl_user.user_id — the EasyFix person who owns the
 *                     account (resolved from tbl_vertical_mapping user_type=1).
 *                     `jobService.list({ ownerId })` filters on THIS one.
 *   reporting_contact_id  tbl_client_contacts.id — the CLIENT SPOC who booked
 *                     the job. Written from req.spoc.id when the portal creates
 *                     one.
 *
 * The portal's "Client Team" picker is fed by GET /team/members, which returns
 * tbl_client_contacts.id. So routing ownerIds to either owner column compares
 * two disjoint id spaces. /orders/counts did exactly that (`j.job_owner IN
 * (...)`) and it could never have matched: the portal creates jobs with actor
 * `{ user_id: null }`, so job_owner is NULL on every portal-booked row.
 *
 * ⚠ AND IT NARROWS THE HIERARCHY, IT DOES NOT REPLACE IT. Both the picked
 * owners and the caller's own scope are lists of the same contact ids, so the
 * filter is an INTERSECTION. Assigning ownerIds straight to
 * reportingContactIds would let a Store SPOC read a peer's book by picking
 * them in a dropdown. An empty intersection is a genuine zero-row answer and
 * jobService.list turns it into `1=0` rather than dropping the clause, so
 * "none of your team" cannot silently widen to "everyone".
 */
/*
 * "Open" as a positive list, DERIVED from the canonical status set rather than
 * typed out again. jobService.list filters with IN, and every place that can
 * express the rule directly uses the negative form — job_status NOT IN
 * (3,5,6,7) — so enumerating it by hand here is precisely how the two drift.
 * A status added to STATUS is open unless it is added to the terminal list.
 */
const TERMINAL_STATUS_CODES = [3, 5, 6, 7];   // completed, completed-alt, cancelled, enquiry
const OPEN_STATUS_CODES = [...jobService.ALL_STATUS_VALUES]
  .filter((code) => !TERMINAL_STATUS_CODES.includes(code))
  .sort((a, b) => a - b);

function clientJobFilters(req, hier) {
  let reportingContactIds = hierarchyFilter(hier, req);
  const pickedOwners = csvIds(req.query.ownerIds);
  if (pickedOwners.length) {
    reportingContactIds = Array.isArray(reportingContactIds)
      // Intersect: never widen past what the hierarchy already allows.
      ? reportingContactIds.filter((id) => pickedOwners.includes(id))
      // Top of the tree — unrestricted, so the pick IS the restriction. Still
      // safe: fk_client_id is always in the WHERE, so a foreign contact's id
      // selects nothing rather than reaching another tenant.
      : pickedOwners;
  }
  return {
    clientId: req.spoc.client_id,
    reportingContactIds,
    // `statuses` (CSV) is what the portal sends; `status` (single) is kept for
    // the mobile app and any caller still on the old shape.
    statuses: req.query.statuses,
    status: req.query.status != null ? Number(req.query.status) : undefined,
    cityId: req.query.cityIds,
    q: req.query.q,
    // Server-side date range (so the app can reach any historical date
    // instead of only the recent window it can hold client-side).
    dateType: req.query.dateType,          // 'ticket' → ticket_created_date_time
    startDate: req.query.startDate,
    endDate: req.query.endDate,
    /*
     * `flag` is the portal's tab selector and carries three values:
     *   completedOrders  Order History "In-Warranty" tab → readyForBilling.
     *   otherOrders      Order History "All Orders" tab  → no extra predicate.
     *   escalatedJobs    /tickets/escalated              → isEscalated.
     *
     * ⚠ isEscalated IS A DOCUMENTED NO-OP in jobService.list — tbl_job has no
     * is_escalated column, the real flag lives on
     * tbl_easyfixer_rating_by_customer, and wiring it needs a join in the LIST
     * projection. It is forwarded anyway so the day that join lands the page
     * starts filtering without another change here. Until then
     * /tickets/escalated lists more than it claims — a pre-existing gap this
     * commit neither introduces nor closes.
     */
    readyForBilling: String(req.query.flag || '') === 'completedOrders',
    isEscalated: String(req.query.flag || '') === 'escalatedJobs' ? true : undefined,
    /*
     * Sort was dropped like the filters were, and it mattered most where a cap
     * bites. /completed asks for the 500 rows of a window and then tells the
     * reader they are "the most recent closures" — but with no sort the route
     * fell back to `ORDER BY j.job_id DESC`, which is most recently CREATED.
     * A job raised in January and closed in August has a low job_id, so the
     * ones being dropped were not the old ones at all.
     *
     * Safe to pass through: jobService.list resolves sortBy against the
     * SORTABLE_COLUMNS whitelist with a hasOwnProperty guard and coerces
     * sortDir to ASC/DESC, so neither value reaches the SQL as text.
     */
    sortBy: req.query.sortBy,
    sortDir: req.query.sortDir,
  };
}

/*
 * ─── THE OWNERSHIP CHECK FOR CLIENT WRITES ─────────────────────────────────
 *
 * The four PATCH /jobs/:id/* endpoints checked TENANCY only — fk_client_id —
 * so any SPOC who guessed a job id could approve or reject a colleague's job,
 * including one they cannot see in any list on the site. Read scope and write
 * scope were two different answers to the same question.
 *
 * They are one answer now: if the job is not in the set you may SEE, you may
 * not act on it. Same resolver as every list.
 *
 * ⚠ A JOB WITH NO reporting_contact_id IS IN NOBODY'S SUBTREE. 9,400 of them
 * exist — 52% of website bookings, 69% of the Reach Fitness API's — because
 * they were not booked by a SPOC at all. They are already invisible to a
 * scoped SPOC in every list (`reporting_contact_id IN (…)` never matches
 * NULL), so refusing the write is the CONSISTENT answer rather than a new
 * restriction, and an allStores or top-of-tree SPOC can still act on them.
 * Zero status-15 jobs are in that state today, so no estimate approval is
 * blocked by this; if that changes, the log line below says exactly why.
 *
 * 404, not 403, matching the tenancy branch: a distinguishable "exists but is
 * not yours" confirms which ids exist. The LOG distinguishes them, because
 * "wrong client" and "wrong subtree" need different fixes.
 *
 * Returns null once it has answered the request — callers `if (!job) return;`.
 */
async function loadJobForWrite(req, res, what) {
  const job = await jobService.getById(Number(req.params.id));
  if (!job || job.fk_client_id !== req.spoc.client_id) {
    logger.warn(what + ' target not found / not owned · id=' + req.params.id);
    modernError(res, 404, 'job not found');
    return null;
  }
  const hier = await resolveClientHierarchy(req);
  const scopeIds = hierarchyFilter(hier, req);
  if (Array.isArray(scopeIds) && !scopeIds.includes(Number(job.reporting_contact_id))) {
    logger.warn(what + ' target outside caller hierarchy · id=' + req.params.id
      + ' · reporting_contact_id=' + job.reporting_contact_id
      + ' · spoc=' + req.spoc.id);
    modernError(res, 404, 'job not found');
    return null;
  }
  return job;
}

router.get('/jobs', async (req, res, next) => {
  try {
    logger.info('List client jobs · status=' + (req.query.status ?? 'all') + ' q=' + (req.query.q || '-') + ' limit=' + (Math.min(Number(req.query.limit) || 50, 500)) + ' offset=' + (Number(req.query.offset) || 0));
    // Reporting-hierarchy scope (tbl_client_contacts.manager_id, attributed via
    // tbl_job.reporting_contact_id): a top SPOC sees the whole client; everyone
    // else sees jobs booked by themselves + their team. `?spoc=<id>` narrows a
    // manager to one team member.
    const hier = await resolveClientHierarchy(req);
    const { rows, total } = await jobService.list({
      ...clientJobFilters(req, hier),
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
    const job = await loadJobForWrite(req, res, 'Approve');
    if (!job) return;
    await pool.query('UPDATE tbl_job SET approved_by_client_contact = ?, approved_on_date_time = NOW() WHERE job_id = ?',
      [req.spoc.id, job.job_id]);
    logger.info('Job approved by client · id=' + job.job_id);
    modernOk(res, await jobService.getById(job.job_id), 'approved');
  } catch (e) { next(e); }
});

router.patch('/jobs/:id/reject', validate(Joi.object({ reason: Joi.string().min(3).max(500).required() })), async (req, res, next) => {
  try {
    logger.info('SPOC reject job · id=' + req.params.id);
    const job = await loadJobForWrite(req, res, 'Reject');
    if (!job) return;
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
    const job = await loadJobForWrite(req, res, 'Estimate-approve');
    if (!job) return;
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
    const job = await loadJobForWrite(req, res, 'Estimate-reject');
    if (!job) return;
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
    const job = await loadJobForWrite(req, res, 'Client cancel');
    if (!job) return;
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
    const job = await loadJobForWrite(req, res, 'Client image upload');
    if (!job) return;
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
/*
 * POST /api/client/jobs/:id/client-request  { kind: 'cancel' | 'retry', comment? }
 *
 * The two things a client can ask ops to do about a job whose customer could
 * not be reached. NEITHER CHANGES THE JOB — per ops, a client raises a request
 * and ops acts on it, so this only writes a durable remark that surfaces to ops
 * as a chip on My Orders -> Unconfirmed. There is no destructive path here and
 * no status transition; if you are adding one, it belongs in the CRM.
 *
 * Column choices, and the two traps behind them, are documented in
 * services/client-request.service.js. The short version: the request is
 * identified by enum_reason_id (a real FK), never by its text; and commented_by
 * is omitted, because it is a tbl_user FK and a client contact id would resolve
 * to a same-numbered EMPLOYEE rather than to nothing.
 */
router.post('/jobs/:id/client-request', validate(Joi.object({
  kind: Joi.string().valid(...clientRequest.KINDS).required(),
  comment: Joi.string().allow('').max(500).optional(),
})), async (req, res, next) => {
  try {
    const job = await loadJobForWrite(req, res, 'Client request');
    if (!job) return;

    /*
     * OFFERED ONLY ON THE UNREACHABLE BUCKET, per ops. Re-checked HERE and not
     * only in the UI: the portal decides which rows show the buttons, and a
     * button is an affordance, never a guard. Without this a SPOC could raise a
     * cancellation request against any job of theirs by calling the endpoint.
     *
     * Membership is the SAME rule the /unreachable-jobs list uses — an
     * Unreachable outcome (comment_on = 16) on a job that is still open — so a
     * row the client can see is a row they can act on. It is deliberately NOT
     * the stricter three-days-in-three rule the dashboard TILE counts: the tile
     * is a "worth your attention" signal, while this is "may I ask about it",
     * and refusing an action on a job the client is looking at would read as a
     * bug.
     */
    const [[reachable]] = await pool.query(
      `SELECT 1 AS ok
         FROM tbl_job_comment c
        WHERE c.job_id = ? AND c.comment_on = 16
        LIMIT 1`,
      [job.job_id],
    );
    if (!reachable) {
      logger.warn('Client request refused · not an unreachable job · id=' + job.job_id);
      return modernError(res, 409, 'This action is only available on jobs where the customer could not be reached.');
    }

    /*
     * The reason ids come from action_taken_reason. A miss means the seed
     * migration has not run on this host — refuse rather than write an
     * unmarked comment, because a request ops cannot see in its section is
     * worse than one that visibly failed.
     */
    const ids = await clientRequest.reasonIds(pool);
    if (!ids) {
      logger.error('Client request unavailable · action_taken_reason rows missing · run migrations/2026-09-04-seed-client-request-reasons.sql');
      return modernError(res, 503, 'This action is not available yet. Please contact support.');
    }

    const authorName = req.spoc.contact_name || null;
    const commentId = await clientRequest.insertRequest(pool, {
      jobId: job.job_id,
      kind: req.body.kind,
      jobStatus: job.job_status ?? null,
      authorName,
      comment: req.body.comment,
      reasonId: ids[req.body.kind],
    });
    logger.info('Client request logged · job=' + job.job_id + ' · kind=' + req.body.kind
      + ' · spoc=' + req.spoc.id + ' · comment_id=' + commentId);

    modernOk(res, {
      requested: true,
      kind: req.body.kind,
      job_id: job.job_id,
      comment_id: commentId,
      chip: clientRequest.CHIP_LABEL[req.body.kind],
    });
  } catch (e) { next(e); }
});

router.post('/jobs/:id/escalate', validate(Joi.object({
  reasonId: Joi.number().integer().required(),
  comment: Joi.string().allow('').max(500).optional(),
})), async (req, res, next) => {
  try {
    const job = await loadJobForWrite(req, res, 'Client escalate');
    if (!job) return;
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
    // Explicit IST parse — valid_up_to is an IST wall-clock string.
    if (row.is_expired || istIsPast(row.valid_up_to)) {
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
  /*
   * ⚠ THE FILTER OPTIONS MUST MATCH THE ROWS THE FILTER CAN RETURN.
   *
   * This listed every city/SPOC on the CLIENT while the lists it filters are
   * scoped to the caller's booking subtree, so a Store SPOC was offered
   * choices that could only ever return zero rows — and an empty result reads
   * as "this colleague has no jobs", not "you cannot see theirs". That is
   * misinformation, not friction.
   *
   * Unrestricted callers are unaffected: hierarchyFilter returns undefined for
   * allStores and top-of-tree, and the predicate collapses to TRUE.
   */
    const scope = scopePredicate(hierarchyFilter(await resolveClientHierarchy(req), req));
    const [rows] = await pool.query(
      `SELECT DISTINCT ci.city_name AS name
         FROM tbl_job j
         LEFT JOIN tbl_address a ON a.address_id = j.fk_address_id
         LEFT JOIN tbl_city    ci ON ci.city_id  = a.city_id
        WHERE j.fk_client_id = ? AND ${scope.sql}
          AND ci.city_name IS NOT NULL AND ci.city_name <> ''
        ORDER BY ci.city_name`,
      [req.spoc.client_id, ...scope.params]);
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
    /*
     * ⚠ TWO CONSUMERS, TWO NEEDS — WHICH IS WHY items STAYS CLIENT-WIDE.
     *
     * The Client Profile renders this as the company's SPOC DIRECTORY and
     * genuinely wants everyone. The dashboard and Orders render it as the
     * "viewing as" SPOC PICKER, which must only offer SPOCs whose book the
     * caller can actually open — a manager could pick a colleague outside
     * their subtree, hierarchyFilter would ignore the id, and the chip would
     * name a scope the cards had not applied. The page states that rule about
     * itself ("the chip and the cards must never disagree") and then broke it.
     *
     * So: the list keeps every contact, and each row says whether it is in the
     * caller's scope. The picker filters on it; the directory ignores it. That
     * is additive, so an older frontend keeps working unchanged — and a newer
     * frontend against an older backend sees `undefined`, which it treats as
     * in-scope rather than hiding every option.
     */
    const hier = await resolveClientHierarchy(req);
    const scopeIds = hierarchyFilter(hier, req);
    const items = rows.map((r) => ({
      id: r.id,
      name: r.contact_name,
      email: r.contact_email,
      mobile: r.contact_no,
      designation: r.contact_desgn,
      managerId: r.manager_id,
      status: r.status,
      approvalByClient: r.approval_by_client,
      inScope: !Array.isArray(scopeIds) || scopeIds.includes(Number(r.id)),
    }));
    // isManager drives the Orders "Client Team" filter: only reporting managers
    // (someone reports to them in the manager_id tree) get the team filter.
    const { isManager } = hier;
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
// Hard cap on an export. Named (not inlined) because the response REPORTS it:
// a workbook that silently stops at N rows reads as a complete answer, and the
// reader has no way to tell a full export from a truncated one by looking at
// it. Raised 5,000 → 10,000 on 2026-08-26.
const EXPORT_ROW_CAP = 10000;

router.get('/export/jobs', async (req, res, next) => {
  try {
    logger.info('Export client jobs to xlsx · status=' + (req.query.status ?? 'all') + ' from=' + (req.query.startDate || '-') + ' to=' + (req.query.endDate || '-'));
    /*
     * ⚠ THIS ROUTE HAD NO HIERARCHY SCOPE AT ALL until 2026-08-26 — it passed
     * clientId and nothing else, so a Store SPOC who pressed Export received
     * every order on the whole account, including other stores' work that the
     * list view correctly hides from them. Sharing clientJobFilters closes
     * that and picks up the dropped statuses/cityIds/ownerIds/flag in the
     * same move: an export that does not match the list it was exported from
     * is its own kind of wrong answer.
     */
    const hier = await resolveClientHierarchy(req);
    const { rows, total } = await jobService.list({
      ...clientJobFilters(req, hier),
      limit: EXPORT_ROW_CAP,
    });
    /*
     * The truncation notice travels in HEADERS, because the body of this
     * response is an .xlsx binary and there is nowhere in it to put a caveat
     * the reader would see. The browser can read these off the fetch and say
     * so on the page — see downloadBlob() in the portal's lib/api.ts.
     *
     * Access-Control-Expose-Headers is REQUIRED: the portal is served from a
     * different origin to the API, and a cross-origin fetch cannot see any
     * response header that is not named here. Without it these are set,
     * delivered, and invisible — the exact failure this is meant to prevent.
     */
    const truncated = total > rows.length;
    res.setHeader('X-Export-Row-Cap', String(EXPORT_ROW_CAP));
    res.setHeader('X-Export-Total', String(total));
    res.setHeader('X-Export-Truncated', truncated ? '1' : '0');
    res.setHeader('Access-Control-Expose-Headers',
      'X-Export-Row-Cap, X-Export-Total, X-Export-Truncated, Content-Disposition');
    if (truncated) {
      logger.warn('Client export TRUNCATED · ' + rows.length + ' of ' + total + ' rows · clientId=' + req.spoc.client_id);
    }
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


/* ═══════════════════════════════════════════════════════════════════════════
 * CLIENT-DASHBOARD ENDPOINTS
 *
 * Ported from the `ClientDashboard_backend` branch, ADDITIVELY. That branch
 * forked before ~119 commits of work landed here, so merging it wholesale would
 * have replayed its older copies of routes this file has since improved — a
 * trial merge silently reverted `uploadJobImage`, the `/lookup/service-categories`
 * body and an export column before it was caught. Only the routes that exist
 * NOWHERE on this branch were taken; all 41 routes the two branches share were
 * left exactly as they are here.
 *
 * The client portal (Easyfix_client_UI) cannot render without these — its
 * dashboard, invoicing, stores, holidays and notice-badge calls were all 404ing.
 * ═══════════════════════════════════════════════════════════════════════════ */

function looksLikeEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
}

async function isEmailInUse(email, excludeContactId) {
  const v = String(email || '').trim().toLowerCase();
  const [[ctcRow]] = await pool.query(
    `SELECT id FROM tbl_client_contacts WHERE LOWER(contact_email) = ? AND id <> ? LIMIT 1`,
    [v, excludeContactId]);
  if (ctcRow) return true;
  const [[usrRow]] = await pool.query(
    `SELECT user_id FROM tbl_user WHERE LOWER(official_email) = ? LIMIT 1`,
    [v]);
  return !!usrRow;
}

async function issueChangeOtp({ otpType, target, kind }) {
  const { generateOtp, otpExpiryDate } = require('../../utils/otp');
  const otp = generateOtp();
  const now = new Date();
  const expires = otpExpiryDate(now);
  // For change-phone, target lives in user_mobile_no; for change-email
  // it goes in user_email. The other column stays NULL so verify can
  // disambiguate by inspecting only the relevant one.
  const emailCol = kind === 'email' ? target : null;
  const mobileCol = kind === 'phone' ? target : null;
  const [[existing]] = await pool.query(
    `SELECT id FROM otp_details
       WHERE otp_type = ?
         AND ${kind === 'email' ? 'user_email' : 'user_mobile_no'} = ?
       LIMIT 1`,
    [otpType, target]);
  if (existing) {
    await pool.query(
      `UPDATE otp_details
          SET otp = ?, generated_on = ?, valid_up_to = ?, is_expired = 0,
              count = count + 1,
              user_email = ?, user_mobile_no = ?
        WHERE id = ?`,
      [otp, now, expires, emailCol, mobileCol, existing.id]);
  } else {
    await pool.query(
      `INSERT INTO otp_details (otp, otp_type, user_email, user_mobile_no, generated_on, valid_up_to, is_expired, count)
       VALUES (?, ?, ?, ?, ?, ?, 0, 1)`,
      [otp, otpType, emailCol, mobileCol, now, expires]);
  }
  // Dev-only log so QA can grab the code without an SMS/email round-trip.
  if (process.env.NODE_ENV !== 'production') {
    require('../../logger').event('🔁', 'cyan',
      `${otpType} OTP for ${target}: ${otp} (valid 5 min) — dev only`);
  }
  const { deliverOtp } = require('../../services/otp-delivery.service');
  const r = await deliverOtp({
    identifier: target,
    email: kind === 'email' ? target : null,
    mobile: kind === 'phone' ? target : null,
    name: null,
    otp,
    contextLabel: otpType.toLowerCase().replace(/\s+/g, '-'),
  });
  return { delivered: !!r.finalDelivered, expiresAt: expires };
}

async function verifyChangeOtp({ otpType, target, otp, kind, spocId }) {
  const matchCol = kind === 'email' ? 'user_email' : 'user_mobile_no';
  const [[row]] = await pool.query(
    `SELECT id, otp, valid_up_to, is_expired FROM otp_details
      WHERE otp_type = ? AND ${matchCol} = ?
      LIMIT 1`,
    [otpType, target]);
  if (!row) return { ok: false, reason: 'NO_OTP_ISSUED' };
  if (row.is_expired || new Date(row.valid_up_to).getTime() < Date.now()) {
    await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);
    return { ok: false, reason: 'OTP_EXPIRED' };
  }
  if (Number(row.otp) !== Number(otp)) return { ok: false, reason: 'OTP_MISMATCH' };
  await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);
  const updateCol = kind === 'email' ? 'contact_email' : 'contact_no';
  await pool.query(
    `UPDATE tbl_client_contacts SET ${updateCol} = ? WHERE id = ?`,
    [target, spocId]);
  return { ok: true };
}

// Reuses the multer binding this file already requires for client job images
// (`multerClientImg`, above) rather than requiring the module a second time —
// the ported branch called it plain `multer`.
const contactUpload = multerClientImg({
  storage: multerClientImg.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

async function loadOwnedContact(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    modernError(res, 400, 'invalid contact id');
    return null;
  }
  const [[row]] = await pool.query(
    'SELECT id, client_id FROM tbl_client_contacts WHERE id = ? LIMIT 1',
    [id]
  );
  if (!row || row.client_id !== req.spoc.client_id) {
    modernError(res, 404, 'contact not found');
    return null;
  }
  return row;
}

router.get('/notices/unread-count', async (req, res, next) => {
  try {
    // We could push this into the service, but a direct COUNT against
    // the active-window filter is cheaper than fetching + decorating
    // rows just to throw away everything except the unread total.
    // Mirrors the same `is active for the client surface` predicate
    // used inside listActiveForSurface for parity.
    const [[{ unread }]] = await pool.query(
      `SELECT COUNT(*) AS unread
         FROM tbl_notice n
        WHERE FIND_IN_SET('client', n.target_surfaces)
          AND n.status IN ('published', 'scheduled')
          AND (n.publish_at IS NULL OR n.publish_at <= NOW())
          AND (n.expire_at  IS NULL OR n.expire_at  >  NOW())
          AND NOT EXISTS (
            SELECT 1 FROM tbl_notice_read r
             WHERE r.notice_id   = n.notice_id
               AND r.surface     = 'client'
               AND r.reader_type = 'client'
               AND r.reader_id   = ?
          )`,
      [req.spoc.id]
    );
    modernOk(res, { count: Number(unread) || 0 });
  } catch (e) { next(e); }
});

router.patch('/notices/:id/read', async (req, res, next) => {
  try {
    const noticeId = Number(req.params.id);
    if (!Number.isInteger(noticeId) || noticeId <= 0) {
      return modernError(res, 400, 'invalid notice id');
    }
    // Idempotent — INSERT IGNORE inside markRead means duplicate
    // taps are no-ops. We don't bother verifying the notice exists +
    // is visible: a stale read-receipt row pointing at a deleted
    // notice is harmless (and the FK-less schema tolerates it).
    await noticeService.markRead({
      noticeId,
      surface: 'client',
      readerType: 'client',
      readerId: req.spoc.id,
    });
    modernOk(res, { ok: true });
  } catch (e) { next(e); }
});

router.patch('/notices/read-all', async (req, res, next) => {
  try {
    // Bulk mark-all. One INSERT … SELECT covers the current active
    // window in a single round-trip. The `WHERE NOT EXISTS` guard
    // makes this idempotent without relying on the UNIQUE index
    // throwing duplicate-key errors.
    await pool.query(
      `INSERT INTO tbl_notice_read (notice_id, surface, reader_type, reader_id)
       SELECT n.notice_id, 'client', 'client', ?
         FROM tbl_notice n
        WHERE FIND_IN_SET('client', n.target_surfaces)
          AND n.status IN ('published', 'scheduled')
          AND (n.publish_at IS NULL OR n.publish_at <= NOW())
          AND (n.expire_at  IS NULL OR n.expire_at  >  NOW())
          AND NOT EXISTS (
            SELECT 1 FROM tbl_notice_read r
             WHERE r.notice_id   = n.notice_id
               AND r.surface     = 'client'
               AND r.reader_type = 'client'
               AND r.reader_id   = ?
          )`,
      [req.spoc.id, req.spoc.id]
    );
    modernOk(res, { ok: true });
  } catch (e) { next(e); }
});

/*
 * SPOC-scoped Google Maps proxy.
 *
 * Thin wrappers around services/maps.service.* — the same service the
 * admin and magic-link mounts use. SPOC JWT auth is already enforced
 * by requireSpocAuth above, so no extra token gate is needed here.
 *
 *   GET /maps/autocomplete?q=<text>           — Places Autocomplete
 *   GET /maps/reverse-geocode?latlng=lat,lng  — Reverse geocode
 *   GET /maps/geocode?place_id=... | &address=... — Forward / by-id
 *
 * Keeps the GOOGLE_MAPS_API_KEY server-side; the FE never sees it.
 */
router.get('/maps/autocomplete', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 3) return modernOk(res, { suggestions: [] });
    const mapsService = require('../../services/maps.service');
    const out = await mapsService.autocomplete(q);
    modernOk(res, out);
  } catch (e) {
    if (e && e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.get('/maps/reverse-geocode', async (req, res, next) => {
  try {
    const latlng = String(req.query.latlng || '').trim();
    if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(latlng)) {
      return modernError(res, 400, 'latlng must be "lat,lng"');
    }
    const mapsService = require('../../services/maps.service');
    const out = await mapsService.geocode({ latlng });
    modernOk(res, out);
  } catch (e) {
    if (e && e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * Forward geocode — used by the Select Address autocomplete flow:
 * SPOC picks a Place suggestion, FE sends its place_id here, we resolve
 * lat/lng + formatted_address + address_components in one shot.
 */
router.get('/maps/geocode', async (req, res, next) => {
  try {
    const place_id = req.query.place_id ? String(req.query.place_id) : null;
    const address  = req.query.address  ? String(req.query.address)  : null;
    if (!place_id && !address) {
      return modernError(res, 400, 'place_id or address required');
    }
    const mapsService = require('../../services/maps.service');
    const out = await mapsService.geocode({ place_id, address });
    modernOk(res, out);
  } catch (e) {
    if (e && e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * GET /api/client/customers/mobile/:mobile/addresses
 *
 * Saved-address book for a customer. Path:
 *   customer mobile  → tbl_customer.customer_id
 *   → tbl_job.fk_address_id  (rows for this customer at THIS client)
 *   → tbl_address rows (deduped)
 *
 * Scoped to the SPOC's own client (j.fk_client_id = req.spoc.client_id)
 * so a customer who has booked at multiple brands doesn't leak their
 * address from brand A into brand B's portal.
 *
 * Returns the latest 20 distinct addresses. Empty array if the customer
 * has never been booked at this client.
 */
router.get('/customers/mobile/:mobile/addresses', async (req, res, next) => {
  try {
    const mobile = String(req.params.mobile || '').trim();
    if (!/^\d{10}$/.test(mobile)) {
      return modernOk(res, { items: [] });
    }
    const [[cust]] = await pool.query(
      'SELECT customer_id FROM tbl_customer WHERE customer_mob_no = ? ORDER BY customer_id DESC LIMIT 1',
      [mobile]
    );
    if (!cust) return modernOk(res, { items: [] });

    // GROUP BY in MySQL 5.7+ is permissive on the non-aggregated cols
    // we pull; LIMIT 20 keeps the wire payload small for chatty
    // customers with hundreds of historical bookings.
    const [rows] = await pool.query(
      `SELECT a.address_id, a.address, a.building, a.landmark, a.locality,
              a.city_id, a.pin_code, a.gps_location, a.mobile_number,
              c.city_name,
              MAX(j.job_id) AS latest_job_id
         FROM tbl_address a
         JOIN tbl_job     j ON j.fk_address_id = a.address_id
         LEFT JOIN tbl_city c ON c.city_id     = a.city_id
        WHERE j.fk_customer_id = ?
          AND j.fk_client_id   = ?
        GROUP BY a.address_id
        ORDER BY latest_job_id DESC
        LIMIT 20`,
      [cust.customer_id, req.spoc.client_id]
    );
    modernOk(res, { items: rows });
  } catch (e) { next(e); }
});

/*
 * GET /api/client/dashboard-summary
 *
 * Powers the new Summary Dashboard landing page. Returns three
 * payloads in a single round-trip so the FE renders without a
 * cascade of fetches:
 *
 *   counts:           Headline KPI numbers (5 cards).
 *   statusBreakdown:  Slice array for the donut chart, in display order.
 *   recentEscalations: Top 5 most-recent escalated jobs, for the
 *                      "Need attention" list.
 *
 * Scope (always team-wide for now — per design decision):
 *   reporting_contact_id IN (req.spoc.id ∪ direct-reports-of-spoc)
 *
 * Date scope: omitted on v1 — counts are lifetime. A date picker
 * would slot in here as `startDate`/`endDate` query params; the
 * BETWEEN clause would attach to j.ticket_created_date_time. Left
 * out for v1 simplicity.
 *
 * Performance: each sub-payload is a single COUNT/SELECT that hits
 * the (fk_client_id, job_status) compound coverage on tbl_job. With
 * the existing FK_tbl_job_client + idx_tbl_job_status indexes the
 * planner can range-scan; on prod-sized tbl_job (~481k rows) the
 * whole endpoint resolves in well under 200ms.
 */
/*
 * GET /api/client/unreachable-jobs
 *
 * The rows behind the "Customer Unreachable" tile: jobs where the customer
 * could not be reached on THREE DIFFERENT DAYS inside a three-day span.
 *
 * ⚠ OPEN JOBS ONLY — job_status NOT IN (3,5,6,7). A completed or cancelled job
 * carries the same unreachable history forever, and listing it here would put
 * work nobody can act on in front of a client, which is the whole failure this
 * dashboard has been unpicking. The tile's COUNT uses the same predicate, so
 * the number and the list it opens cannot disagree.
 *
 * View only for now: no action buttons. The row carries what a reader needs to
 * decide who to chase — attempts, the days they fell on, and how long the job
 * has been open.
 */
router.get('/unreachable-jobs', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const hier = await resolveClientHierarchy(req);
    const scopeIds = hierarchyFilter(hier, req);   // undefined = whole client
    const scopeSql = Array.isArray(scopeIds)
      ? `AND j.reporting_contact_id IN (${scopeIds.length ? scopeIds.map(() => '?').join(',') : 'NULL'})`
      : '';
    const scopeParams = Array.isArray(scopeIds) ? scopeIds : [];

    logger.info('Fetch unreachable jobs · clientId=' + req.spoc.client_id + ' · limit=' + limit);

    /*
     * Same self-join as the tile's count: any anchor date with >= 3 DISTINCT
     * dates in [anchor, anchor+2]. Kept as a derived set rather than repeated
     * inline so the list and the count select the identical jobs.
     */
    const params = [req.spoc.client_id, ...scopeParams, req.spoc.client_id, ...scopeParams, limit];
    const [rows] = await pool.query(`
      WITH cl AS (
        SELECT DISTINCT c.job_id, DATE(c.created_on) AS d
          FROM tbl_job_comment c
          JOIN tbl_job j ON j.job_id = c.job_id
         WHERE c.comment_on = 16
           AND j.fk_client_id = ?
           ${scopeSql}
           AND j.job_status NOT IN (3,5,6,7)
      ), qualified AS (
        SELECT a.job_id
          FROM cl a
          JOIN cl b ON b.job_id = a.job_id
           AND b.d BETWEEN a.d AND DATE_ADD(a.d, INTERVAL 2 DAY)
         GROUP BY a.job_id, a.d
        HAVING COUNT(DISTINCT b.d) >= 3
      )
      SELECT j.job_id, j.job_reference_id, j.client_ref_id, j.job_status,
             COALESCE(city.city_name, 'Unknown')            AS city_name,
             COALESCE(TSC.service_catg_name, 'Uncategorised') AS category,
             TIMESTAMPDIFF(HOUR, j.ticket_created_date_time, NOW()) DIV 24 AS age_days,
             COUNT(DISTINCT DATE(c.created_on)) AS unreachable_days,
             COUNT(c.comment_id)                AS attempts,
             MAX(c.created_on)                  AS last_attempt
        FROM tbl_job j
        JOIN (SELECT DISTINCT job_id FROM qualified) q ON q.job_id = j.job_id
        JOIN tbl_job_comment c ON c.job_id = j.job_id AND c.comment_on = 16
        LEFT JOIN tbl_address      A    ON A.address_id = j.fk_address_id
        LEFT JOIN tbl_city         city ON city.city_id = A.city_id
        LEFT JOIN tbl_service_catg TSC  ON TSC.service_catg_id = j.fk_service_catg_id
       WHERE j.fk_client_id = ?
         ${scopeSql}
         AND j.job_status NOT IN (3,5,6,7)
       GROUP BY j.job_id
       ORDER BY unreachable_days DESC, last_attempt DESC
       LIMIT ?`, params);

    modernOk(res, {
      items: rows.map((r) => ({
        jobId: r.job_id,
        reference: r.job_reference_id || r.client_ref_id || null,
        jobStatus: Number(r.job_status),
        city: r.city_name,
        category: r.category,
        ageDays: Number(r.age_days) || 0,
        unreachableDays: Number(r.unreachable_days) || 0,
        attempts: Number(r.attempts) || 0,
        lastAttempt: r.last_attempt,
      })),
      total: rows.length,
    });
  } catch (e) { next(e); }
});

router.get('/dashboard-summary', async (req, res, next) => {
  try {
    /*
     * ⚠ THE SAME SCOPE EVERY OTHER SURFACE ON THIS PAGE USES.
     *
     * This resolved its own list — self plus DIRECT reports, non-recursive —
     * and ignored the caller's role entirely, while the action queue beside it
     * used hierarchyFilter: the whole client for a Senior Leader and the full
     * recursive subtree for everyone else. Two panels on one screen counting
     * two different populations, which is how "Jobs Waiting for You" could
     * show an approval that "Pending on you" counted as zero.
     *
     * `undefined` means unrestricted, so the filter collapses to an empty
     * string rather than an impossible IN () — and an empty subtree array
     * still emits the clause, so a SPOC who can see nothing counts nothing
     * rather than everything.
     */
    const hier = await resolveClientHierarchy(req);
    const scopeIds = hierarchyFilter(hier, req);   // undefined = whole client
    const teamFilter = Array.isArray(scopeIds)
      ? `AND j.reporting_contact_id IN (${scopeIds.length ? scopeIds.map(() => '?').join(',') : 'NULL'})`
      : '';
    const teamParams = Array.isArray(scopeIds) ? scopeIds : [];
    /*
     * ⚠ THE "Across N SPOCs" FOOTER MUST DESCRIBE THE POPULATION BELOW IT.
     *
     * This fell back to hier.subtreeIds when the scope was unrestricted, so an
     * allStores SPOC read "Across 2 SPOCs · live" — their own little subtree —
     * over counts covering the entire client. The number was true of something,
     * just not of the page it captions.
     *
     * Unrestricted means every SPOC of the client, so that is what it counts.
     * status = 1 matches the recursive resolver, which walks active contacts
     * only: a deactivated colleague is not somebody this reader is "across".
     */
    let teamSize = Array.isArray(scopeIds) ? scopeIds.length : null;
    if (teamSize === null) {
      const [[everyone]] = await pool.query(
        'SELECT COUNT(*) AS n FROM tbl_client_contacts WHERE client_id = ? AND status = 1',
        [req.spoc.client_id]);
      teamSize = Number(everyone.n) || 0;
    }

    // Single COUNT … FILTER over the team-scope. One scan, five
    // SUM(CASE) — keeps the round-trips and join cost flat compared
    // to firing five COUNT(*) queries.
    const [[counts]] = await pool.query(
      `SELECT
         SUM(CASE WHEN j.job_status = 9                                 THEN 1 ELSE 0 END) AS newTickets,
         SUM(CASE WHEN j.job_status IN (0, 1, 2, 20)                    THEN 1 ELSE 0 END) AS inProgress,
         SUM(CASE WHEN j.job_status IN (3, 5)                           THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN j.job_status = 6                                 THEN 1 ELSE 0 END) AS cancelled,
         SUM(CASE WHEN r.is_escalated = 1                               THEN 1 ELSE 0 END) AS escalated,
         /*
          * The Open-breakdown bar, which splits the open book into "pending
          * with EasyFix" and "pending with you". Both come from THIS query so
          * the two segments share one scan and one scope — the bar has to
          * partition a single number, and two queries is how the halves stop
          * summing to the whole.
          *
          * openTotal is every non-terminal job: not completed (3,5), not
          * cancelled (6), not an enquiry (7). Deliberately WIDER than
          * newTickets + inProgress, which the bar used to be built from and
          * which silently omits 15, 21 and 10 — jobs that are open by any
          * reading, just not in those two buckets.
          *
          * awaitingYou is status 15 — an estimate sent and not yet decided.
          * It is the ONLY state no EasyFix action can clear, which is what
          * "pending with you" means.
          */
         SUM(CASE WHEN j.job_status NOT IN (3, 5, 6, 7)                 THEN 1 ELSE 0 END) AS openTotal,
         SUM(CASE WHEN j.job_status = 15                                THEN 1 ELSE 0 END) AS awaitingYou
       FROM   tbl_job j
       LEFT   JOIN tbl_easyfixer_rating_by_customer r ON r.job_id = j.job_id
       WHERE  j.fk_client_id        = ?
         ${teamFilter}`,
      [req.spoc.client_id, ...teamParams]
    );

    /*
     * ─── REPEATEDLY UNREACHABLE ────────────────────────────────────────────
     *
     * Jobs where the customer could not be reached on THREE DIFFERENT DAYS
     * inside a three-day span. Deliberately not any of the near-misses:
     *
     *   three calls in ONE day        no — that is one bad afternoon
     *   one call across three days    no — that is a single attempt
     *   three days, but months apart  no — the span is what makes it a pattern
     *
     * ⚠ tbl_job.call_later CANNOT ANSWER THIS. It is a bit(1) flag with no
     * count and no dates, so `call_later = 1` says "unreachable at least once,
     * ever" — which is why the old attention bucket built on it was inflating
     * "pending on you" with jobs nobody could act on. The history lives in
     * tbl_job_comment at comment_on = 16, one row per Unreachable outcome
     * (see job-comment.service.js, which stamps the flag AND writes the row).
     *
     * The self-join finds any anchor date with >= 3 DISTINCT dates in
     * [anchor, anchor+2]. DISTINCT is doing the work: it collapses several
     * calls on one day to a single date, which is exactly the "three calls in
     * one day" case that must not qualify.
     *
     * No recency filter, on purpose: the job being OPEN is the recency. A job
     * unreachable three days running last week and still open is still a job
     * the client should chase.
     */
    const [[unreachable]] = await pool.query(
      `SELECT COUNT(*) AS n FROM (
         SELECT a.job_id
           FROM (SELECT DISTINCT c.job_id, DATE(c.created_on) AS d
                   FROM tbl_job_comment c
                   JOIN tbl_job j ON j.job_id = c.job_id
                  WHERE c.comment_on = 16
                    AND j.fk_client_id = ?
                    ${teamFilter}
                    AND j.job_status NOT IN (3,5,6,7)) a
           JOIN (SELECT DISTINCT c.job_id, DATE(c.created_on) AS d
                   FROM tbl_job_comment c
                   JOIN tbl_job j ON j.job_id = c.job_id
                  WHERE c.comment_on = 16
                    AND j.fk_client_id = ?
                    ${teamFilter}
                    AND j.job_status NOT IN (3,5,6,7)) b
             ON b.job_id = a.job_id
            AND b.d BETWEEN a.d AND DATE_ADD(a.d, INTERVAL 2 DAY)
          GROUP BY a.job_id, a.d
         HAVING COUNT(DISTINCT b.d) >= 3
       ) q`,
      [req.spoc.client_id, ...teamParams, req.spoc.client_id, ...teamParams]
    );

    // Donut slices — return labels + colours pre-baked so the FE just
    // maps to SVG. Order is the lifecycle-natural reading order.
    // Colours match the brand palette + the badge colours used on
    // the Order History "Status of Order" column.
    const [breakdownRows] = await pool.query(
      `SELECT j.job_status, COUNT(*) AS n
         FROM tbl_job j
        WHERE j.fk_client_id        = ?
          ${teamFilter}
        GROUP BY j.job_status`,
      [req.spoc.client_id, ...teamParams]
    );
    const STATUS_GROUPS = [
      { label: 'New',         statuses: [9],            color: '#f59e0b' }, // amber
      { label: 'Scheduled',   statuses: [0, 1],         color: '#3b82f6' }, // blue
      { label: 'In Progress', statuses: [2, 20],        color: '#8b5cf6' }, // violet
      { label: 'Completed',   statuses: [3, 5],         color: '#10b981' }, // emerald
      { label: 'Under Audit', statuses: [10],           color: '#06b6d4' }, // cyan
      { label: 'Cancelled',   statuses: [6],            color: '#ef4444' }, // rose
      { label: 'On Hold',     statuses: [15, 21],       color: '#64748b' }, // slate
    ];
    const byStatus = new Map(breakdownRows.map((r) => [Number(r.job_status), Number(r.n)]));
    const statusBreakdown = STATUS_GROUPS.map((g) => ({
      label: g.label,
      count: g.statuses.reduce((sum, s) => sum + (byStatus.get(s) || 0), 0),
      color: g.color,
    })).filter((s) => s.count > 0); // hide empty slices

    // Top 5 most-recent escalations. Joined with the rating row to
    // get the escalation reason, and with the customer for the
    // display name. ORDER BY job_id DESC is a safe proxy for "most
    // recent" without depending on rating_date_time (column legacy-
    // unreliable on some rows).
    const [recentEscalations] = await pool.query(
      `SELECT j.job_id, j.client_ref_id, j.job_status,
              cu.customer_name, cu.customer_mob_no,
              ef.efr_name AS easyfixer_name,
              r.review_comment, r.customer_rating
         FROM tbl_job j
         JOIN tbl_easyfixer_rating_by_customer r ON r.job_id = j.job_id
         LEFT JOIN tbl_customer  cu ON cu.customer_id = j.fk_customer_id
         LEFT JOIN tbl_easyfixer ef ON ef.efr_id      = j.fk_easyfixter_id
        WHERE r.is_escalated         = 1
          AND j.fk_client_id         = ?
          ${teamFilter}
        ORDER BY j.job_id DESC
        LIMIT 5`,
      [req.spoc.client_id, ...teamParams]
    );

    // ─── Home-page KPI boxes ──────────────────────────────────────────
    // New Tickets / Waiting for Allocation / Running Late — all derived
    // from tbl_job over the same team scope (no rating join here, so a
    // job with multiple rating rows can't double-count).
    //   waitingForAllocation : requested time passed, still scheduled/
    //                          unconfirmed (0,1), NO technician assigned.
    //   runningLate          : same, but a technician IS assigned and the
    //                          job still hasn't progressed.
    const [[jobBoxes]] = await pool.query(
      `SELECT
         SUM(CASE WHEN j.job_status = 9 THEN 1 ELSE 0 END) AS newTickets,
         SUM(CASE WHEN j.job_status IN (0,1)
                   AND j.requested_date_time <= NOW()
                   AND j.fk_easyfixter_id IS NULL     THEN 1 ELSE 0 END) AS waitingForAllocation,
         SUM(CASE WHEN j.job_status IN (0,1)
                   AND j.requested_date_time <= NOW()
                   AND j.fk_easyfixter_id IS NOT NULL THEN 1 ELSE 0 END) AS runningLate
         FROM tbl_job j
        WHERE j.fk_client_id        = ?
          ${teamFilter}`,
      [req.spoc.client_id, ...teamParams]
    );

    // Estimate Approved / Rejected — count the LATEST estimate per job
    // (greatest sent_on, id as tie-breaker) whose job is still live
    // (not completed/cancelled/enquiry: 3,5,6,7), team-scoped.
    // tbl_estimate_details.status: 1 = Approved, 2 = Rejected (0 = Sent).
    const [[estBoxes]] = await pool.query(
      `SELECT
         SUM(CASE WHEN ed.status = 1 THEN 1 ELSE 0 END) AS estimateApproved,
         SUM(CASE WHEN ed.status = 2 THEN 1 ELSE 0 END) AS estimateRejected
         FROM tbl_estimate_details ed
         JOIN tbl_job j ON j.job_id = ed.job_id
        WHERE j.fk_client_id        = ?
          ${teamFilter}
          AND j.job_status NOT IN (3,5,6,7)
          AND NOT EXISTS (
            SELECT 1 FROM tbl_estimate_details e2
             WHERE e2.job_id = ed.job_id
               AND (e2.sent_on > ed.sent_on
                    OR (e2.sent_on = ed.sent_on AND e2.id > ed.id))
          )`,
      [req.spoc.client_id, ...teamParams]
    );

    // ─── Performance by City / Store ─────────────────────────────────
    // Per-city orders / completed / on-time% / avg TAT, team-scoped.
    // On-time = a completed job checked out on or before its original
    // committed appointment date. Avg TAT = ticket-created → checkout in
    // 24h-days. Top 6 cities by volume.
    const [cityRows] = await pool.query(
      `SELECT ci.city_name AS city,
              COUNT(*)                                              AS orders,
              SUM(CASE WHEN j.job_status IN (3,5) THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN j.job_status IN (3,5)
                        AND j.checkout_date_time IS NOT NULL
                        AND (j.original_appointment_date_time IS NULL
                             OR DATE(j.checkout_date_time) <= DATE(j.original_appointment_date_time))
                       THEN 1 ELSE 0 END)                           AS on_time,
              AVG(CASE WHEN j.job_status IN (3,5) AND j.checkout_date_time IS NOT NULL
                       THEN TIMESTAMPDIFF(HOUR, j.ticket_created_date_time, j.checkout_date_time)/24.0
                       END)                                         AS avg_tat_days
         FROM tbl_job j
         LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id
         LEFT JOIN tbl_city    ci ON ci.city_id    = ad.city_id
        WHERE j.fk_client_id        = ?
          ${teamFilter}
          AND ci.city_name IS NOT NULL
        GROUP BY ci.city_name
        ORDER BY orders DESC
        LIMIT 6`,
      [req.spoc.client_id, ...teamParams]
    );
    const cityPerformance = cityRows.map((r) => {
      const orders = Number(r.orders) || 0;
      const completed = Number(r.completed) || 0;
      const onTime = Number(r.on_time) || 0;
      return {
        city: r.city,
        orders,
        completed,
        onTimePct: completed ? Math.round((onTime / completed) * 100) : null,
        avgTatDays: r.avg_tat_days != null ? Number(Number(r.avg_tat_days).toFixed(1)) : null,
      };
    });

    // ─── SLA breaches by aging ───────────────────────────────────────
    // Active jobs (not completed/cancelled/enquiry) whose committed
    // appointment (requested_date_time) is already in the past — i.e.
    // overdue — bucketed by how many days late they are.
    //
    // ⚠ The predicate is the NEGATIVE set, matching openTotal above and every
    // other open-job count on this route. It used to enumerate
    // IN (0,1,2,20,9,15,21) — the same seven codes, minus 10 — so a job that
    // was open enough to be counted was not open enough to be aged, and this
    // panel quietly disagreed with the card above it.
    const [[sla]] = await pool.query(
      `SELECT
         SUM(CASE WHEN d BETWEEN 0 AND 1 THEN 1 ELSE 0 END) AS d01,
         SUM(CASE WHEN d BETWEEN 2 AND 3 THEN 1 ELSE 0 END) AS d23,
         SUM(CASE WHEN d BETWEEN 4 AND 7 THEN 1 ELSE 0 END) AS d47,
         SUM(CASE WHEN d > 7            THEN 1 ELSE 0 END) AS d7plus
       FROM (
         SELECT DATEDIFF(NOW(), j.requested_date_time) AS d
           FROM tbl_job j
          WHERE j.fk_client_id        = ?
            ${teamFilter}
            AND j.job_status NOT IN (3,5,6,7)
            AND j.requested_date_time IS NOT NULL
            AND j.requested_date_time < NOW()
       ) t`,
      [req.spoc.client_id, ...teamParams]
    );

    // Invoices due (client-level) — feeds the "Needs attention" card.
    const [[invDue]] = await pool.query(
      `SELECT COUNT(*) AS cnt,
              COALESCE(SUM(total_invoice_amount - COALESCE(total_paid_amount,0)),0) AS amt
         FROM tbl_client_invoice
        WHERE fk_client_id = ? AND is_raised = 1
          AND (total_invoice_amount - COALESCE(total_paid_amount,0)) > 0`,
      [req.spoc.client_id]
    );

    // Actionable order buckets for "Needs attention" — team-scoped.
    //   estimatePending : status 15 — estimate awaiting the client's approval
    //   noResponse      : call_later = 1 — customer not reachable / call not picked
    //   onHold          : status 21 — fulfilment on hold (items/parts/approval pending)
    //   revisit         : completed (3,5) with a revisit created, not yet billed
    const [[attn]] = await pool.query(
      `SELECT
         SUM(CASE WHEN j.job_status = 15 THEN 1 ELSE 0 END) AS estimatePending,
         SUM(CASE WHEN j.call_later = 1  THEN 1 ELSE 0 END) AS noResponse,
         SUM(CASE WHEN j.job_status = 21 THEN 1 ELSE 0 END) AS onHold,
         SUM(CASE WHEN j.job_status IN (3,5) AND j.sub_job_id IS NOT NULL
                   AND j.ready_for_billing = 'No' THEN 1 ELSE 0 END) AS revisit,
         SUM(CASE WHEN j.ready_for_billing = 'Yes' THEN 1 ELSE 0 END) AS qcDone
         FROM tbl_job j
        WHERE j.fk_client_id = ? ${teamFilter}`,
      [req.spoc.client_id, ...teamParams]
    );

    // ─── 30-day orders trend ─────────────────────────────────────────
    // Received (created) vs Completed (checked out) per day, last 30 days,
    // team-scoped. Grouped by day in SQL; JS fills the gap days with zero
    // so the chart always has exactly 30 points.
    const [createdRows] = await pool.query(
      `SELECT DATE_FORMAT(j.ticket_created_date_time,'%Y-%m-%d') AS d, COUNT(*) AS n
         FROM tbl_job j
        WHERE j.fk_client_id = ? ${teamFilter}
          AND j.ticket_created_date_time >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
        GROUP BY d`,
      [req.spoc.client_id, ...teamParams]
    );
    const [completedRows] = await pool.query(
      `SELECT DATE_FORMAT(j.checkout_date_time,'%Y-%m-%d') AS d, COUNT(*) AS n
         FROM tbl_job j
        WHERE j.fk_client_id = ? ${teamFilter}
          AND j.job_status IN (3,5)
          AND j.checkout_date_time >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
        GROUP BY d`,
      [req.spoc.client_id, ...teamParams]
    );
    const createdMap   = new Map(createdRows.map((r) => [r.d, Number(r.n) || 0]));
    const completedMap = new Map(completedRows.map((r) => [r.d, Number(r.n) || 0]));
    const ymd = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const trend = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const dt = new Date(today);
      dt.setDate(today.getDate() - i);
      const key = ymd(dt);
      trend.push({ date: key, created: createdMap.get(key) || 0, completed: completedMap.get(key) || 0 });
    }

    // Category & work-type mix — orders per service category. Replaces the
    // status breakdown on the dashboard (status is already in the KPI cards).
    // Team-scoped, top 6 by volume, colours pre-baked for the donut.
    const CAT_COLORS = ['#2f6bff', '#10b981', '#7c5cff', '#F39C12', '#e11d48', '#06b6d4'];
    const [catRows] = await pool.query(
      `SELECT COALESCE(sc.service_catg_name, 'Other') AS name, COUNT(*) AS n
         FROM tbl_job j
         LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id
        WHERE j.fk_client_id = ? ${teamFilter}
        GROUP BY name
        ORDER BY n DESC
        LIMIT 6`,
      [req.spoc.client_id, ...teamParams]
    );
    const categoryBreakdown = catRows.map((r, i) => ({
      label: r.name,
      count: Number(r.n) || 0,
      color: CAT_COLORS[i % CAT_COLORS.length],
    }));

    // Recent tickets — latest jobs (team-scoped) for the "Recent tickets"
    // table, with real status codes the FE maps to pills.
    const [recentRows] = await pool.query(
      `SELECT j.job_id, j.client_ref_id, j.job_status, j.requested_date_time,
              cu.customer_name, ci.city_name, ef.efr_name AS easyfixer_name
         FROM tbl_job j
         LEFT JOIN tbl_customer  cu ON cu.customer_id = j.fk_customer_id
         LEFT JOIN tbl_address   ad ON ad.address_id  = j.fk_address_id
         LEFT JOIN tbl_city      ci ON ci.city_id     = ad.city_id
         LEFT JOIN tbl_easyfixer ef ON ef.efr_id      = j.fk_easyfixter_id
        WHERE j.fk_client_id = ? ${teamFilter}
        ORDER BY j.job_id DESC
        LIMIT 8`,
      [req.spoc.client_id, ...teamParams]
    );
    const recentTickets = recentRows.map((r) => ({
      jobId:    r.job_id,
      ref:      r.client_ref_id,
      customer: r.customer_name,
      city:     r.city_name,
      tech:     r.easyfixer_name,
      status:   Number(r.job_status),
      when:     r.requested_date_time,
    }));

    return modernOk(res, {
      boxes: {
        newTickets:           Number(jobBoxes.newTickets)           || 0,
        waitingForAllocation: Number(jobBoxes.waitingForAllocation) || 0,
        runningLate:          Number(jobBoxes.runningLate)          || 0,
        estimateApproved:     Number(estBoxes.estimateApproved)     || 0,
        estimateRejected:     Number(estBoxes.estimateRejected)     || 0,
      },
      cityPerformance,
      slaAging: {
        d01:    Number(sla?.d01)    || 0,
        d23:    Number(sla?.d23)    || 0,
        d47:    Number(sla?.d47)    || 0,
        d7plus: Number(sla?.d7plus) || 0,
      },
      attention: {
        invoicesDue:     { count: Number(invDue?.cnt) || 0, amount: Number(invDue?.amt) || 0 },
        estimatePending: Number(attn?.estimatePending) || 0,
        noResponse:      Number(attn?.noResponse) || 0,
        /*
         * Distinct from noResponse, which is the bare call_later flag —
         * "unreachable at least once, ever". This is the PATTERN: three
         * different days inside a three-day span, on a job that is still open.
         */
        repeatedlyUnreachable: Number(unreachable?.n) || 0,
        onHold:          Number(attn?.onHold) || 0,
        revisit:         Number(attn?.revisit) || 0,
        qcDone:          Number(attn?.qcDone) || 0,
      },
      trend,
      counts: {
        newTickets: Number(counts.newTickets) || 0,
        inProgress: Number(counts.inProgress) || 0,
        completed:  Number(counts.completed)  || 0,
        cancelled:  Number(counts.cancelled)  || 0,
        escalated:  Number(counts.escalated)  || 0,
        // The two halves of the Open-breakdown bar. openTotal INCLUDES
        // awaitingYou — the card subtracts, so the segments partition rather
        // than overlap.
        openTotal:   Number(counts.openTotal)   || 0,
        awaitingYou: Number(counts.awaitingYou) || 0,
      },
      statusBreakdown,
      categoryBreakdown,
      recentTickets,
      recentEscalations,
      teamSize,                 // for the "across N SPOCs" footer
    });
  } catch (e) { next(e); }
});

/*
 * GET /api/client/invoices — the client's raised invoices + aging.
 *
 * Client-level (NOT team-scoped) — invoices live in tbl_client_invoice
 * keyed by fk_client_id. Returns:
 *   summary : billed / collected / outstanding totals + count
 *   aging   : the OUTSTANDING amount split by days past the due date
 *             (0–30 / 31–60 / 60+), for the "what's overdue" view
 *   items   : the invoice list, newest first (blank numbers/dates in
 *             legacy rows are normalised to null so the FE shows "—")
 * Powers the /invoices page and the dashboard "invoice due" alert.
 */
router.get('/invoices', async (req, res, next) => {
  try {
    const clientId = req.spoc.client_id;
    logger.info('Fetch client invoices · clientId=' + clientId);

    const [[summary]] = await pool.query(
      `SELECT COALESCE(SUM(total_invoice_amount),0)                                   AS billed,
              COALESCE(SUM(total_paid_amount),0)                                       AS collected,
              COALESCE(SUM(total_invoice_amount - COALESCE(total_paid_amount,0)),0)    AS outstanding,
              COUNT(*)                                                                 AS count
         FROM tbl_client_invoice
        WHERE fk_client_id = ? AND is_raised = 1`,
      [clientId]
    );

    const [[aging]] = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN days <= 30           THEN due ELSE 0 END),0) AS a0_30,
              COALESCE(SUM(CASE WHEN days BETWEEN 31 AND 60 THEN due ELSE 0 END),0) AS a31_60,
              COALESCE(SUM(CASE WHEN days > 60            THEN due ELSE 0 END),0) AS a60plus,
              COUNT(*)                                                            AS unpaid
         FROM (SELECT (total_invoice_amount - COALESCE(total_paid_amount,0)) AS due,
                      DATEDIFF(NOW(), amount_due_date)                        AS days
                 FROM tbl_client_invoice
                WHERE fk_client_id = ? AND is_raised = 1
                  AND (total_invoice_amount - COALESCE(total_paid_amount,0)) > 0) t`,
      [clientId]
    );

    const [rows] = await pool.query(
      `SELECT id, invoice_number, invoice_date, amount_due_date,
              total_invoice_amount, total_paid_amount,
              (total_invoice_amount - COALESCE(total_paid_amount,0)) AS due_amount,
              is_paid, file_path_pdf
         FROM tbl_client_invoice
        WHERE fk_client_id = ? AND is_raised = 1
        ORDER BY (invoice_date IS NULL), invoice_date DESC, id DESC
        LIMIT 300`,
      [clientId]
    );

    const items = rows.map((r) => {
      const total = Number(r.total_invoice_amount) || 0;
      const paid  = Number(r.total_paid_amount) || 0;
      const due   = Number(r.due_amount) || 0;
      const status = (Number(r.is_paid) === 1 || due <= 0) ? 'paid' : (paid > 0 ? 'partial' : 'unpaid');
      return {
        id: r.id,
        invoiceNumber: (String(r.invoice_number || '').trim()) || null,
        invoiceDate: r.invoice_date,
        dueDate: r.amount_due_date,
        total, paid, due, status,
        pdfPath: (r.file_path_pdf && String(r.file_path_pdf).trim()) ? r.file_path_pdf : null,
      };
    });

    return modernOk(res, {
      summary: {
        billed:      Number(summary.billed) || 0,
        collected:   Number(summary.collected) || 0,
        outstanding: Number(summary.outstanding) || 0,
        count:       Number(summary.count) || 0,
      },
      aging: {
        a0_30:   Number(aging.a0_30) || 0,
        a31_60:  Number(aging.a31_60) || 0,
        a60plus: Number(aging.a60plus) || 0,
        unpaid:  Number(aging.unpaid) || 0,
      },
      items,
    });
  } catch (e) { next(e); }
});

/*
 * GET /api/client/stores — the client's store / branch directory (active
 * rows). Powers the store-code picker on the New Order form.
 */
router.get('/stores', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, store_code, store_name, contact_name, contact_no,
              address, city_id, city_name, pin_code
         FROM tbl_client_store
        WHERE fk_client_id = ? AND status = 1
        ORDER BY store_code`,
      [req.spoc.client_id]
    );
    modernOk(res, { items: rows });
  } catch (e) { next(e); }
});

/*
 * GET /api/client/stores/lookup?code=STR-142 — resolve one store by its
 * code for the logged-in client. Returns { store: null } on no match so
 * the New Order flow stays non-blocking.
 */
router.get('/stores/lookup', async (req, res, next) => {
  try {
    const code = String(req.query.code || '').trim();
    if (!code) return modernOk(res, { store: null });
    const [[row]] = await pool.query(
      `SELECT id, store_code, store_name, contact_name, contact_no,
              address, city_id, city_name, pin_code
         FROM tbl_client_store
        WHERE fk_client_id = ? AND status = 1 AND store_code = ?
        LIMIT 1`,
      [req.spoc.client_id, code]
    );
    modernOk(res, { store: row || null });
  } catch (e) { next(e); }
});

/*
 * GET /api/client/holidays — upcoming holidays for the dashboard's
 * holiday calendar. Uses the shared holiday.service (code-maintained
 * Indian holiday list) — same source the admin holidays screen uses.
 * `?days=` window, default 30, capped at 30 by the service.
 */
router.get('/holidays', async (req, res, next) => {
  try {
    const days = Number(req.query.days) > 0 ? Number(req.query.days) : 30;
    const items = await holidayService.getUpcoming({ days });
    modernOk(res, { items });
  } catch (e) { next(e); }
});

// ─── My-New-Tickets tab counts ───────────────────────────────────────
// Single endpoint returning all three tab counts so the Client_UI can
// refresh the badges on a single round-trip after an Authorize action.
// Mirrors the legacy SharedService.getBucketData([9], …) bus on the
// Angular dashboard.
//
// Filters (cityIds, ownerIds, startDate/endDate, q) are respected so
// the counts always agree with the visible table when those filters
// are active. SQL: one SELECT, three COUNT(...) inside CASE — saves
// two round-trips and keeps the WHERE clause identical across counts.
router.get('/tickets/counts', async (req, res, next) => {
  try {
    // Shared filter clauses — NOT including the status=9 pin (legacy
    // noResponse case doesn't pin it, so we apply per-CASE inside the
    // SUM expressions below).
    const where = [];
    const params = [];
    where.push('j.fk_client_id = ?'); params.push(req.spoc.client_id);

    const toIdArr = (v) => String(v).split(',')
      .map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
    if (req.query.cityIds) {
      const arr = toIdArr(req.query.cityIds);
      if (arr.length) { where.push(`ad.city_id IN (${arr.map(() => '?').join(',')})`); params.push(...arr); }
    }
    if (req.query.ownerIds) {
      const arr = toIdArr(req.query.ownerIds);
      // reporting_contact_id, NOT job_owner — see clientJobFilters above:
      // ?ownerIds are tbl_client_contacts ids, job_owner is a tbl_user id and is
      // NULL on every portal-booked job, so the old clause could never match.
      if (arr.length) { where.push(`j.reporting_contact_id IN (${arr.map(() => '?').join(',')})`); params.push(...arr); }
    }
    if (req.query.startDate) { where.push('j.created_date_time >= ?'); params.push(req.query.startDate); }
    if (req.query.endDate)   { where.push('j.created_date_time <= ?'); params.push(req.query.endDate); }
    if (req.query.q) {
      where.push('(j.job_reference_id LIKE ? OR j.client_ref_id LIKE ? OR cu.customer_name LIKE ? OR cu.customer_mob_no LIKE ?)');
      const v = `%${req.query.q}%`;
      params.push(v, v, v, v);
    }
    /*
     * The same scope as GET /jobs, so the tab badges count what is actually
     * visible inside each tab.
     *
     * The comment here used to CLAIM that and the code no longer delivered it:
     * this expanded self plus DIRECT reports with its own query, non-recursive,
     * and ignored the caller's role, while /jobs resolves the full recursive
     * subtree through hierarchyFilter and is unrestricted for allStores. A
     * manager two levels up got a badge smaller than their own list; a Senior
     * Leader got one smaller still.
     */
    {
      const hier = await resolveClientHierarchy(req);
      const scope = scopePredicate(hierarchyFilter(hier, req));
      where.push(scope.sql);
      params.push(...scope.params);
    }

    // Compose join set — only pull in tables WHERE references. The SUM
    // expressions ALWAYS need ccs (for the unauthorized branch) and
    // status pinning for the first two CASEs, so we join unconditionally.
    const w = where.join(' AND ');
    const needsCu = /\bcu\./.test(w);
    const needsAd = /\bad\./.test(w);
    const joins = `
      FROM tbl_job j
      ${needsCu ? 'LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id' : ''}
      ${needsAd ? 'LEFT JOIN tbl_address  ad ON ad.address_id  = j.fk_address_id' : ''}
      LEFT JOIN tbl_client_contacts ccs ON ccs.id = j.reporting_contact_id
    `;

    // Per-bucket CASE expressions mirror jobService.list ticketFlag SQL
    // exactly — keep them in sync if you tweak one.
    const [[row]] = await pool.query(
      `SELECT
         SUM(CASE WHEN j.job_status = 9
                   AND j.approved_by_client = 0
                   AND (j.call_later IS NULL OR j.call_later != 1)
                   AND ccs.manager_id IS NOT NULL
                   AND ccs.manager_id NOT IN ('', 'null')
                   AND ccs.approval_by_client = 1
                  THEN 1 ELSE 0 END) AS unauthorized,
         SUM(CASE WHEN j.job_status = 9
                   AND (j.approved_by_client != 0 OR j.approved_by_client IS NULL)
                   AND (j.call_later IS NULL OR j.call_later != 1)
                  THEN 1 ELSE 0 END) AS authorized,
         SUM(CASE WHEN j.call_later = 1 THEN 1 ELSE 0 END) AS noResponse
       ${joins}
       WHERE ${w}`,
      params
    );
    modernOk(res, {
      unauthorized: Number(row.unauthorized || 0),
      authorized:   Number(row.authorized   || 0),
      noResponse:   Number(row.noResponse   || 0),
    });
  } catch (e) { next(e); }
});

/*
 * GET /api/client/orders/counts — tab counts for the My Order History page.
 *
 * Legacy parity: subscribes to bucketCountState$ on the Angular
 * OrderHistoryComponent (ngOnInit lines 157-163) populating
 * otherOrdersCount + completedForBillingOrdersCount.
 *
 * Returns:
 *   { otherOrders: N, completedOrders: M }
 *
 * Filter contract identical to /jobs so badges stay in sync with the
 * table. completedOrders is auto-scoped to the SPOC's team (matches
 * legacy ClientController.java:101 + /jobs route).
 */
router.get('/orders/counts', async (req, res, next) => {
  try {
    /*
     * The two tab badges on Order History. Both now come from
     * jobService.list({ countOnly: true }) over clientJobFilters — the SAME
     * WHERE the list below them uses — because this handler used to hand-roll
     * its own SQL and the two had drifted into counting different populations
     * on one screen.
     *
     * THREE THINGS CHANGED, and all three are the badge moving TOWARDS the
     * list rather than the other way round:
     *
     * 1. otherOrders had NO hierarchy restriction — it counted the whole
     *    client while the list showed only the caller's subtree, so a Store
     *    SPOC read "All Orders 1,834" above "Showing 1–10 of 212". It is now
     *    scoped like the list. This NARROWS the number, which is the safe
     *    direction: nobody starts seeing a count they could not see before.
     * 2. completedOrders scoped to self + DIRECT reports via its own
     *    non-recursive query, while the list uses the full recursive subtree
     *    from resolveClientHierarchy. It now uses the subtree, so a manager
     *    with indirect reports sees a LARGER number than before — larger, but
     *    equal to the rows they can actually open.
     * 3. ?ownerIds filtered `j.job_owner IN (...)`, which is a tbl_user id
     *    column being compared against tbl_client_contacts ids — and is NULL
     *    on every portal-booked job anyway, so it could never match. It is now
     *    an intersection into reportingContactIds. See clientJobFilters.
     *
     * `flag`/`statuses` are deliberately NOT taken from the query here. The
     * page does not send them to this endpoint, and it should not: a badge
     * that shrank with the Bucket filter would only ever restate the total
     * already printed under the table. The badges answer "how big is the other
     * tab", so each count sets its own readyForBilling and leaves the rest of
     * the filters shared.
     */
    const hier = await resolveClientHierarchy(req);
    const filters = clientJobFilters(req, hier);

    const [all, billable, open] = await Promise.all([
      jobService.list({ ...filters, readyForBilling: false, countOnly: true }),
      jobService.list({ ...filters, readyForBilling: true,  countOnly: true }),
      jobService.list({ ...filters, statuses: OPEN_STATUS_CODES, readyForBilling: false, countOnly: true }),
    ]);

    modernOk(res, {
      otherOrders:     Number(all.total      || 0),
      completedOrders: Number(billable.total || 0),
      /*
       * The nav badge on the "Open jobs" tab. It used to read otherOrders —
       * EVERY order on file — so the tab said "99+" over a page reading "209
       * orders on file · 2 of them open". A badge on a tab named "Open jobs"
       * has exactly one honest meaning.
       */
      openOrders:      Number(open.total     || 0),
    });
  } catch (e) { next(e); }
});

/*
 * GET /api/client/appointments/counts — tab counts for the Committed
 * Appointments page.
 *
 * Legacy parity: UpcomingAppointmentsComponent.ngOnInit subscribes to
 * bucketCountState$ for unAllocatedJobsCount + allocatedJobsCount +
 * ongoingOrders (status [0, 1]).
 *
 * Three tabs scoped to SPOC's team:
 *   txUnallocated  — status=0, fk_easyfixter_id IS NULL
 *   txAllocated    — status=0, fk_easyfixter_id IS NOT NULL
 *   ongoingOrders  — status=1
 */
/*
 * ⚠ PARKED, NOT DEAD — DO NOT DELETE ON A "NO CALLERS" SWEEP.
 *
 * Nothing in the portal calls this today, and a dead-code sweep will keep
 * re-flagging it. Its caller is the "Committed Appointments" page, which was
 * deliberately replaced by a ComingSoon stub whose own comment says the
 * implementation "is preserved in git history; restore it with
 * `git checkout <ref> -- ...`". Restore that page (src/app/(authed)/appointments/page.tsx,
 * around dccf51f) and this endpoint is live again the same minute.
 *
 * It shares the one scope resolver, so when that page comes back its badges
 * will already agree with the list beneath them.
 */
router.get('/appointments/counts', async (req, res, next) => {
  try {
    /*
     * The same scope /jobs uses, resolved once. This expanded self plus DIRECT
     * reports with its own query — non-recursive, and blind to the caller's
     * role — so a badge here could never agree with the list beside it for a
     * manager with indirect reports, or for any allStores SPOC.
     */
    const hier = await resolveClientHierarchy(req);
    const scope = scopePredicate(hierarchyFilter(hier, req));

    const where = ['j.fk_client_id = ?'];
    const params = [req.spoc.client_id];

    const toIdArr = (v) => String(v).split(',')
      .map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
    if (req.query.cityIds) {
      const arr = toIdArr(req.query.cityIds);
      if (arr.length) { where.push(`ad.city_id IN (${arr.map(() => '?').join(',')})`); params.push(...arr); }
    }
    if (req.query.ownerIds) {
      const arr = toIdArr(req.query.ownerIds);
      // reporting_contact_id, NOT job_owner — see clientJobFilters above:
      // ?ownerIds are tbl_client_contacts ids, job_owner is a tbl_user id and is
      // NULL on every portal-booked job, so the old clause could never match.
      if (arr.length) { where.push(`j.reporting_contact_id IN (${arr.map(() => '?').join(',')})`); params.push(...arr); }
    }
    if (req.query.startDate) { where.push('j.created_date_time >= ?'); params.push(req.query.startDate); }
    if (req.query.endDate)   { where.push('j.created_date_time <= ?'); params.push(req.query.endDate); }
    if (req.query.q) {
      where.push('(j.job_reference_id LIKE ? OR j.client_ref_id LIKE ? OR cu.customer_name LIKE ? OR cu.customer_mob_no LIKE ?)');
      const v = `%${req.query.q}%`;
      params.push(v, v, v, v);
    }

    const w = where.join(' AND ');
    const needsCu = /\bcu\./.test(w);
    const needsAd = /\bad\./.test(w);
    const joins = `
      FROM tbl_job j
      ${needsCu ? 'LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id' : ''}
      ${needsAd ? 'LEFT JOIN tbl_address  ad ON ad.address_id  = j.fk_address_id' : ''}
    `;

    // Bind order: SQL placeholders are consumed in textual order.
    // The three SELECT CASE expressions come BEFORE the WHERE clause
    // in the text, so their scope params must be bound first, then the
    // shared WHERE params.
    const [[row]] = await pool.query(
      `SELECT
         SUM(CASE WHEN j.job_status = 0 AND j.fk_easyfixter_id IS NULL
                   AND ${scope.sql}
                  THEN 1 ELSE 0 END) AS txUnallocated,
         SUM(CASE WHEN j.job_status = 0 AND j.fk_easyfixter_id IS NOT NULL
                   AND ${scope.sql}
                  THEN 1 ELSE 0 END) AS txAllocated,
         SUM(CASE WHEN j.job_status = 1
                   AND ${scope.sql}
                  THEN 1 ELSE 0 END) AS ongoingOrders
       ${joins}
       WHERE ${w}`,
      [...scope.params, ...scope.params, ...scope.params, ...params]
    );
    modernOk(res, {
      txUnallocated: Number(row.txUnallocated || 0),
      txAllocated:   Number(row.txAllocated   || 0),
      ongoingOrders: Number(row.ongoingOrders || 0),
    });
  } catch (e) { next(e); }
});

/*
 * GET /api/client/under-audit/counts — tab counts for the Under Audit page.
 *
 * Legacy parity: UnderAuditComponent.ngOnInit subscribes to
 * bucketCountState$ for revisitJobsCount + txCompletedOnAppJobsCount.
 *
 * Two tabs scoped to SPOC's team:
 *   revisit         — status IN (3, 5), sub_job_id NOT NULL,
 *                     ready_for_billing = 'No'    (the "visit done" flag)
 *   completedOnApp  — status = 10
 */
/*
 * ⚠ PARKED, NOT DEAD — DO NOT DELETE ON A "NO CALLERS" SWEEP.
 *
 * Nothing in the portal calls this today, and a dead-code sweep will keep
 * re-flagging it. Its caller is the "Completed & Under Audit" page, which was
 * deliberately replaced by a ComingSoon stub whose own comment says the
 * implementation "is preserved in git history; restore it with
 * `git checkout <ref> -- ...`". Restore that page (src/app/(authed)/tickets/under-audit/page.tsx,
 * around 8150dbf) and this endpoint is live again the same minute.
 *
 * It shares the one scope resolver, so when that page comes back its badges
 * will already agree with the list beneath them.
 */
router.get('/under-audit/counts', async (req, res, next) => {
  try {
    /*
     * The same scope /jobs uses, resolved once. This expanded self plus DIRECT
     * reports with its own query — non-recursive, and blind to the caller's
     * role — so a badge here could never agree with the list beside it for a
     * manager with indirect reports, or for any allStores SPOC.
     */
    const hier = await resolveClientHierarchy(req);
    const scope = scopePredicate(hierarchyFilter(hier, req));

    const where = ['j.fk_client_id = ?'];
    const params = [req.spoc.client_id];

    const toIdArr = (v) => String(v).split(',')
      .map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
    if (req.query.cityIds) {
      const arr = toIdArr(req.query.cityIds);
      if (arr.length) { where.push(`ad.city_id IN (${arr.map(() => '?').join(',')})`); params.push(...arr); }
    }
    if (req.query.ownerIds) {
      const arr = toIdArr(req.query.ownerIds);
      // reporting_contact_id, NOT job_owner — see clientJobFilters above:
      // ?ownerIds are tbl_client_contacts ids, job_owner is a tbl_user id and is
      // NULL on every portal-booked job, so the old clause could never match.
      if (arr.length) { where.push(`j.reporting_contact_id IN (${arr.map(() => '?').join(',')})`); params.push(...arr); }
    }
    if (req.query.startDate) { where.push('j.created_date_time >= ?'); params.push(req.query.startDate); }
    if (req.query.endDate)   { where.push('j.created_date_time <= ?'); params.push(req.query.endDate); }
    if (req.query.q) {
      where.push('(j.job_reference_id LIKE ? OR j.client_ref_id LIKE ? OR cu.customer_name LIKE ? OR cu.customer_mob_no LIKE ?)');
      const v = `%${req.query.q}%`;
      params.push(v, v, v, v);
    }

    const w = where.join(' AND ');
    const needsCu = /\bcu\./.test(w);
    const needsAd = /\bad\./.test(w);
    const joins = `
      FROM tbl_job j
      ${needsCu ? 'LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id' : ''}
      ${needsAd ? 'LEFT JOIN tbl_address  ad ON ad.address_id  = j.fk_address_id' : ''}
    `;

    // Bind order: SELECT CASE placeholders fill before WHERE.
    const [[row]] = await pool.query(
      `SELECT
         SUM(CASE WHEN j.job_status IN (3, 5)
                   AND j.sub_job_id IS NOT NULL
                   AND j.ready_for_billing = 'No'
                   AND ${scope.sql}
                  THEN 1 ELSE 0 END) AS revisit,
         SUM(CASE WHEN j.job_status = 10
                   AND ${scope.sql}
                  THEN 1 ELSE 0 END) AS completedOnApp
       ${joins}
       WHERE ${w}`,
      [...scope.params, ...scope.params, ...params]
    );
    modernOk(res, {
      revisit:        Number(row.revisit        || 0),
      completedOnApp: Number(row.completedOnApp || 0),
    });
  } catch (e) { next(e); }
});

/*
 * GET /api/client/client-delay/counts — tab counts for the Client Delay page.
 *
 * Legacy parity: MyApprovalsComponent.ngOnInit subscribes to
 * bucketCountState$ for estimateJobsCount + fulfillmentJobCount +
 * unAuthorisedJobsCount (status [15, 21, 9]).
 *
 * Filters: same shape as /jobs (date / city / team / search) so the
 * badges reflect what the user will see when they click a tab.
 *
 * Scoping: all three tabs use "my team's tickets" scope.
 */
/*
 * ⚠ PARKED, NOT DEAD — DO NOT DELETE ON A "NO CALLERS" SWEEP.
 *
 * Nothing in the portal calls this today, and a dead-code sweep will keep
 * re-flagging it. Its caller is the "Pending due to Client" page, which was
 * deliberately replaced by a ComingSoon stub whose own comment says the
 * implementation "is preserved in git history; restore it with
 * `git checkout <ref> -- ...`". Restore that page (the buckets commented out in portal b166c9d,
 * around b166c9d) and this endpoint is live again the same minute.
 *
 * It shares the one scope resolver, so when that page comes back its badges
 * will already agree with the list beneath them.
 */
router.get('/client-delay/counts', async (req, res, next) => {
  try {
    /*
     * The same scope /jobs uses, resolved once. This expanded self plus DIRECT
     * reports with its own query — non-recursive, and blind to the caller's
     * role — so a badge here could never agree with the list beside it for a
     * manager with indirect reports, or for any allStores SPOC.
     */
    const hier = await resolveClientHierarchy(req);
    const scope = scopePredicate(hierarchyFilter(hier, req));

    const where = ['j.fk_client_id = ?'];
    const params = [req.spoc.client_id];

    const toIdArr = (v) => String(v).split(',')
      .map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
    if (req.query.cityIds) {
      const arr = toIdArr(req.query.cityIds);
      if (arr.length) { where.push(`ad.city_id IN (${arr.map(() => '?').join(',')})`); params.push(...arr); }
    }
    if (req.query.ownerIds) {
      const arr = toIdArr(req.query.ownerIds);
      // reporting_contact_id, NOT job_owner — see clientJobFilters above:
      // ?ownerIds are tbl_client_contacts ids, job_owner is a tbl_user id and is
      // NULL on every portal-booked job, so the old clause could never match.
      if (arr.length) { where.push(`j.reporting_contact_id IN (${arr.map(() => '?').join(',')})`); params.push(...arr); }
    }
    if (req.query.startDate) { where.push('j.created_date_time >= ?'); params.push(req.query.startDate); }
    if (req.query.endDate)   { where.push('j.created_date_time <= ?'); params.push(req.query.endDate); }
    if (req.query.q) {
      where.push('(j.job_reference_id LIKE ? OR j.client_ref_id LIKE ? OR cu.customer_name LIKE ? OR cu.customer_mob_no LIKE ?)');
      const v = `%${req.query.q}%`;
      params.push(v, v, v, v);
    }
    const w = where.join(' AND ');
    const needsCu = /\bcu\./.test(w);
    const needsAd = /\bad\./.test(w);
    const joins = `
      FROM tbl_job j
      ${needsCu ? 'LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id' : ''}
      ${needsAd ? 'LEFT JOIN tbl_address  ad ON ad.address_id  = j.fk_address_id' : ''}
      LEFT JOIN tbl_client_contacts ccs ON ccs.id = j.reporting_contact_id
    `;

    const [[row]] = await pool.query(
      `SELECT
         SUM(CASE WHEN j.job_status = 15 AND ${scope.sql}
                  THEN 1 ELSE 0 END) AS approveEstimate,
         SUM(CASE WHEN j.job_status = 21 AND ${scope.sql}
                  THEN 1 ELSE 0 END) AS fulfilmentOnHold,
         SUM(CASE WHEN j.job_status = 9
                   AND j.approved_by_client = 0
                   AND (j.call_later IS NULL OR j.call_later != 1)
                   AND ccs.manager_id IS NOT NULL
                   AND ccs.manager_id NOT IN ('', 'null')
                   AND ccs.approval_by_client = 1
                   AND ${scope.sql}
                  THEN 1 ELSE 0 END) AS unauthorized
       ${joins}
       WHERE ${w}`,
      // Scope params first — placeholders in SELECT CASE come before WHERE.
      [...scope.params, ...scope.params, ...scope.params, ...params]
    );
    modernOk(res, {
      approveEstimate:  Number(row.approveEstimate  || 0),
      fulfilmentOnHold: Number(row.fulfilmentOnHold || 0),
      unauthorized:     Number(row.unauthorized     || 0),
    });
  } catch (e) { next(e); }
});

/*
 * GET /api/client/technicians — easyfixers mapped to the SPOC's client.
 *
 * Mapped via tbl_client_easyfixer_mapping (one row per (client, easyfixer,
 * service_type)). A single tech can carry many service types per client,
 * so we DISTINCT on efr_id and GROUP_CONCAT service-type names into a
 * single comma-separated column the FE shows as chips.
 *
 * Per-row payload:
 *   id, name, mobile, email, city, status, skill_rating, tool_rating,
 *   service_types (CSV string), avg_rating (NULL if never rated),
 *   total_jobs (count for this client only).
 *
 * Query params:
 *   status     — "true" (active only — default), "false" (inactive),
 *                "all" (everyone). Matches the legacy ?status= contract.
 *   cityIds    — CSV, narrows by efr city.
 *   q          — substring search across name / mobile / email.
 *   limit/offset — pagination (default 50, capped at 500).
 */
router.get('/technicians', async (req, res, next) => {
  try {
    const statusParam = String(req.query.status || 'true').toLowerCase();
    const where = ['m.client_id = ?', 'm.mapping_status = 1'];
    const params = [req.spoc.client_id];

    if (statusParam === 'true')       { where.push('e.efr_status = 1'); }
    else if (statusParam === 'false') { where.push('(e.efr_status = 0 OR e.efr_status IS NULL)'); }
    // 'all' → no status clause

    if (req.query.cityIds) {
      const arr = String(req.query.cityIds).split(',')
        .map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
      if (arr.length) {
        // scope-guard: user-supplied filter, not RBAC — must stay narrow.
        // The CRM's operator scope admits technicians with no city (see
        // lib/scope.js::cityScopeSql); this is a client picking cities for
        // themselves, and widening it would show them unscoped technicians.
        where.push(`e.efr_cityId IN (${arr.map(() => '?').join(',')})`);
        params.push(...arr);
      }
    }
    if (req.query.q) {
      where.push('(e.efr_name LIKE ? OR e.efr_no LIKE ? OR e.efr_email LIKE ?)');
      const v = `%${req.query.q}%`;
      params.push(v, v, v);
    }

    const limit  = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;

    // Total distinct count for pagination
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(DISTINCT e.efr_id) AS total
         FROM tbl_client_easyfixer_mapping m
         JOIN tbl_easyfixer e ON e.efr_id = m.easyfixer_id
         LEFT JOIN tbl_city ci ON ci.city_id = e.efr_cityId
        WHERE ${where.join(' AND ')}`,
      params
    );

    // List query — GROUP BY collapses duplicate mapping rows per efr.
    //
    // Chips on the FE card now show CATEGORIES (Carpentry, Electrician,
    // …) instead of individual service types — a tech mapped to 8
    // service types under "Carpentry" used to render 8 chips + "+5 more";
    // collapsed to category-level it's just 1–2 chips, far cleaner.
    //
    // service_categories pulled via GROUP_CONCAT(DISTINCT) joining
    // tbl_service_type → tbl_service_catg through service_catg_id.
    // DISTINCT dedupes naturally so "Carpentry" appears once even when
    // a tech has 10 carpentry-bucket service types.
    //
    // service_types is kept for callers that still need the granular
    // list (e.g. potential future detail panel) — same field name as
    // before, no breaking change.
    //
    // avg_rating + total_jobs are correlated subqueries scoped to THIS
    // client only (legacy parity: client should see ratings on its own
    // jobs, not a global average).
    /*
     * Perf rewrite (2026-06-10): the previous single-query version
     * embedded TWO correlated subqueries (avg_rating + total_jobs)
     * directly in the SELECT list. Each subquery scanned the 481k-row
     * tbl_job — fine on a small client (12 techs × milliseconds) but
     * on a tech-heavy client (~2,400+ mapped techs) the planner did
     * scans even after LIMIT 12 was applied, pushing wall-clock time
     * past 80 seconds and timing the route out → HTTP 500 on the FE.
     *
     * The rewrite splits into TWO round-trips:
     *   (1) Page query — pure JOINs, no subqueries → returns 12 techs
     *   (2) Aggregate query — single SELECT with IN-list of those 12
     *       efr_ids → returns {avg_rating, total_jobs} per tech in
     *       one shot.
     * Then we merge in JS and return. Total wall-clock drops from
     * ~90s to ~150ms on the same client.
     */
    const [rows] = await pool.query(
      `SELECT e.efr_id AS id,
              e.efr_name AS name,
              e.efr_no AS mobile,
              e.efr_email AS email,
              e.efr_status AS status,
              e.skill_rating,
              e.tool_rating,
              ci.city_name AS city,
              GROUP_CONCAT(DISTINCT st.service_type_name ORDER BY st.service_type_name SEPARATOR ',') AS service_types,
              GROUP_CONCAT(DISTINCT sc.service_catg_name ORDER BY sc.service_catg_name SEPARATOR ',') AS service_categories
         FROM tbl_client_easyfixer_mapping m
         JOIN tbl_easyfixer e   ON e.efr_id = m.easyfixer_id
         LEFT JOIN tbl_city ci  ON ci.city_id = e.efr_cityId
         LEFT JOIN tbl_service_type st ON st.service_type_id = m.service_type_id
         LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = st.service_catg_id
        WHERE ${where.join(' AND ')}
        GROUP BY e.efr_id
        ORDER BY e.efr_name ASC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Step 2 — aggregate ratings + job counts for ONLY the page's
    // 12 techs. One SELECT, two indexed (efr_id) IN-list scans. The
    // ratings JOIN is scoped to the SPOC's own client so we don't
    // mix in another client's reviews.
    if (rows.length > 0) {
      const efrIds = rows.map((r) => r.id);
      const placeholders = efrIds.map(() => '?').join(',');
      const [aggRows] = await pool.query(
        `SELECT e.efr_id AS id,
                (SELECT ROUND(AVG(r.customer_rating), 1)
                   FROM tbl_easyfixer_rating_by_customer r
                   JOIN tbl_job j2 ON j2.job_id = r.job_id
                  WHERE r.easyfixer_id = e.efr_id
                    AND j2.fk_client_id = ?
                    AND r.customer_rating IS NOT NULL
                    AND r.customer_rating > 0
                ) AS avg_rating,
                (SELECT COUNT(*) FROM tbl_job j3
                  WHERE j3.fk_easyfixter_id = e.efr_id
                    AND j3.fk_client_id = ?
                ) AS total_jobs
           FROM tbl_easyfixer e
          WHERE e.efr_id IN (${placeholders})`,
        [req.spoc.client_id, req.spoc.client_id, ...efrIds]
      );
      // Index by efr_id for O(1) merge below.
      const aggBy = new Map(aggRows.map((a) => [a.id, a]));
      rows.forEach((r) => {
        const a = aggBy.get(r.id);
        r.avg_rating = a?.avg_rating ?? null;
        r.total_jobs = a?.total_jobs ?? 0;
      });
    }

    modernOk(res, { items: rows, total });
  } catch (e) { next(e); }
});

/*
 * GET /api/client/lookup/cities
 *
 * Two modes:
 *   default      — cities the SPOC's client has actually raised jobs in
 *                  (typically a handful; keeps filter dropdowns tight)
 *   ?scope=all   — every active city in tbl_city (~472 rows). Used by
 *                  the New Order form where the SPOC may book in a
 *                  city the client hasn't operated in before.
 */
router.get('/lookup/cities', async (req, res, next) => {
  try {
    const scope = String(req.query.scope || '').toLowerCase();
    if (scope === 'all') {
      // Every city in tbl_city (no status filter) — the client wants the
      // full master list available in the New Order form. Columns are still
      // aliased to { id, name } for the FE dropdown contract.
      const [rows] = await pool.query(
        `SELECT city_id AS id, city_name AS name
           FROM tbl_city
          ORDER BY city_name ASC`
      );
      return modernOk(res, { items: rows });
    }
  /*
   * ⚠ THE FILTER OPTIONS MUST MATCH THE ROWS THE FILTER CAN RETURN.
   *
   * This listed every city/SPOC on the CLIENT while the lists it filters are
   * scoped to the caller's booking subtree, so a Store SPOC was offered
   * choices that could only ever return zero rows — and an empty result reads
   * as "this colleague has no jobs", not "you cannot see theirs". That is
   * misinformation, not friction.
   *
   * Unrestricted callers are unaffected: hierarchyFilter returns undefined for
   * allStores and top-of-tree, and the predicate collapses to TRUE.
   */
  /*
   * ?scope=all above is deliberately NOT scoped and must stay that way: it is
   * the master city list for the New Order form, where the whole point is
   * booking into a city you have no jobs in yet.
   */
    const hierScope = scopePredicate(hierarchyFilter(await resolveClientHierarchy(req), req));
    const [rows] = await pool.query(
      `SELECT DISTINCT ci.city_id AS id, ci.city_name AS name
         FROM tbl_job j
         LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id
         LEFT JOIN tbl_city    ci ON ci.city_id    = ad.city_id
        WHERE j.fk_client_id = ? AND ${hierScope.sql} AND ci.city_id IS NOT NULL
        ORDER BY ci.city_name ASC`,
      [req.spoc.client_id, ...hierScope.params]
    );
    modernOk(res, { items: rows });
  } catch (e) { next(e); }
});

// Client team members eligible to own jobs — used by the "Client Team"
// multi-select.
//
// ⚠ THESE IDS ARE tbl_client_contacts.id. An earlier version of this comment
// claimed they were "job_owner-compatible"; they are not, and that sentence is
// what caused five handlers to filter ?ownerIds on j.job_owner — a tbl_user
// column, NULL on every portal-booked job. The column these ids match is
// tbl_job.reporting_contact_id. See clientJobFilters().
router.get('/team/members', async (req, res, next) => {
  try {
  /*
   * ⚠ THE FILTER OPTIONS MUST MATCH THE ROWS THE FILTER CAN RETURN.
   *
   * This listed every city/SPOC on the CLIENT while the lists it filters are
   * scoped to the caller's booking subtree, so a Store SPOC was offered
   * choices that could only ever return zero rows — and an empty result reads
   * as "this colleague has no jobs", not "you cannot see theirs". That is
   * misinformation, not friction.
   *
   * Unrestricted callers are unaffected: hierarchyFilter returns undefined for
   * allStores and top-of-tree, and the predicate collapses to TRUE.
   */
  /*
   * The column here is tbl_client_contacts.id, not tbl_job.reporting_contact_id,
   * so scopePredicate (which names the job column) does not fit — the same
   * id set, spelled for this table.
   */
    const scopeIds = hierarchyFilter(await resolveClientHierarchy(req), req);
    const scopeClause = Array.isArray(scopeIds)
      ? `AND id IN (${scopeIds.length ? scopeIds.map(() => '?').join(',') : 'NULL'})`
      : '';
    const [rows] = await pool.query(
      `SELECT id, contact_name AS name, contact_email AS email
         FROM tbl_client_contacts
        WHERE client_id = ? AND status = 1
          ${scopeClause}
        ORDER BY contact_name ASC`,
      [req.spoc.client_id, ...(Array.isArray(scopeIds) ? scopeIds : [])]
    );
    modernOk(res, { items: rows });
  } catch (e) { next(e); }
});

/*
 * GET /api/client/jobs/:id/images/:imageId — stream a job image to the
 * browser. Scoped to SPOC's client_id (other clients' images 404 even
 * when the imageId is known).
 *
 * Resolution mirrors the admin route (routes/admin/jobs.js:1831):
 *   1. S3 (if enabled) — 302 to a presigned URL
 *   2. Local file under UPLOAD_JOB_FILES — res.sendFile
 *   3. FILE_BASE_URL absolute — 302 to Nginx-served path
 *   4. 404
 *
 * Powers the Jobsheet button + the gallery thumbnails on the detail page.
 */
router.get('/jobs/:id/images/:imageId', async (req, res, next) => {
  try {
    const jobId   = Number(req.params.id);
    const imageId = Number(req.params.imageId);
    if (!Number.isInteger(jobId) || !Number.isInteger(imageId)) {
      return modernError(res, 400, 'invalid id');
    }

    // Scope: image must belong to a job in this SPOC's client.
    const [[row]] = await pool.query(
      `SELECT i.image_id, i.job_id, i.image
         FROM tbl_job_image i
         JOIN tbl_job j ON j.job_id = i.job_id
        WHERE i.image_id = ? AND i.job_id = ? AND j.fk_client_id = ?
        LIMIT 1`,
      [imageId, jobId, req.spoc.client_id]
    );
    if (!row || !row.image) return modernError(res, 404, 'image not found');

    const stored = String(row.image).trim();
    const path = require('path');
    const fs = require('fs');

    // (1) S3 — presigned URL redirect
    try {
      const s3Storage = require('../../utils/s3-storage');
      if (s3Storage.isEnabled && s3Storage.isEnabled()) {
        const candidates = [stored];
        if (!stored.startsWith('Job_Images/') && !stored.startsWith('JobSupportings/')) {
          candidates.push(`JobSupportings/${path.basename(stored)}`);
          candidates.push(`Job_Images/${path.basename(stored)}`);
        }
        for (const key of candidates) {
          try {
            if (await s3Storage.exists(key)) {
              const url = await s3Storage.getPresignedUrl(key);
              return res.redirect(url);
            }
          } catch { /* fall through to local */ }
        }
      }
    } catch { /* s3 module not available — fall through */ }

    // (2) Local file
    const rootCandidates = [
      process.env.UPLOAD_JOB_FILES,
      process.env.UPLOAD_ROOT_PATH,
      './uploads/upload_jobs',
      './uploads',
    ].filter(Boolean);
    const relForms = [stored, path.basename(stored)];
    for (const root of rootCandidates) {
      const absRoot = path.resolve(root);
      for (const rel of relForms) {
        const candidate = path.resolve(absRoot, rel.replace(/^\/+/, ''));
        if (!candidate.startsWith(absRoot + path.sep) && candidate !== absRoot) continue;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return res.sendFile(candidate);
        }
      }
    }

    // (3) Absolute FILE_BASE_URL — Nginx fallback
    const fileBase = process.env.FILE_BASE_URL || '';
    if (/^https?:\/\//i.test(fileBase)) {
      const url = stored.includes('/')
        ? `${fileBase.replace(/\/+$/, '')}/${stored.replace(/^\/+/, '')}`
        : `${fileBase.replace(/\/+$/, '')}/upload_jobs/${stored}`;
      return res.redirect(url);
    }

    return modernError(res, 404, 'image file not found on disk');
  } catch (e) { next(e); }
});

router.post('/profile/change-email/send-otp', async (req, res, next) => {
  try {
    const newEmail = String(req.body?.new_email || '').trim().toLowerCase();
    if (!looksLikeEmail(newEmail)) {
      return modernError(res, 400, 'new_email must be a valid email address');
    }
    if (newEmail === String(req.spoc.contact_email || '').trim().toLowerCase()) {
      return modernError(res, 400, 'This is already your current email');
    }
    if (await isEmailInUse(newEmail, req.spoc.id)) {
      return modernError(res, 409, 'This email is already registered with another account');
    }
    const r = await issueChangeOtp({
      otpType: 'Change Email',
      target: newEmail,
      kind: 'email',
    });
    modernOk(res, { delivered: r.delivered, expiresAt: r.expiresAt });
  } catch (e) { next(e); }
});

router.post('/profile/change-email/verify-otp', async (req, res, next) => {
  try {
    const newEmail = String(req.body?.new_email || '').trim().toLowerCase();
    const otp = Number(req.body?.otp);
    if (!looksLikeEmail(newEmail)) {
      return modernError(res, 400, 'new_email must be a valid email address');
    }
    if (!Number.isInteger(otp) || otp < 1000 || otp > 9999) {
      return modernError(res, 400, 'otp must be a 4-digit number');
    }
    if (await isEmailInUse(newEmail, req.spoc.id)) {
      return modernError(res, 409, 'This email is already registered with another account');
    }
    const r = await verifyChangeOtp({
      otpType: 'Change Email',
      target: newEmail,
      otp,
      kind: 'email',
      spocId: req.spoc.id,
    });
    if (!r.ok) return modernError(res, 401, r.reason);
    modernOk(res, { updated: true, contact_email: newEmail }, 'Email updated');
  } catch (e) { next(e); }
});

router.get('/contacts', async (req, res, next) => {
  try {
    const rows = await clientService.listContacts(req.spoc.client_id);
    // Project only the columns the FE table actually needs — keeps
    // the wire payload small and hides legacy internal columns
    // (manager_id, created_by, etc.) that the SPOC shouldn't see.
    const items = rows.map((r) => ({
      id: r.id,
      contact_name:  r.contact_name,
      contact_email: r.contact_email,
      contact_no:    r.contact_no,
      contact_alt_no: r.contact_alt_no,
      contact_desgn: r.contact_desgn,
      status:        r.status,
    }));
    modernOk(res, { items });
  } catch (e) { next(e); }
});

router.delete('/contacts/:id', async (req, res, next) => {
  try {
    if (!(await loadOwnedContact(req, res))) return;
    const affected = await clientService.deleteContact(req.params.id);
    if (!affected) return modernError(res, 404, 'contact not found');
    modernOk(res, { deleted: true });
  } catch (e) { next(e); }
});

/*
 * ─── CREATE / UPDATE A SINGLE CONTACT ──────────────────────────────────────
 *
 * The Profile → Contacts editor has always POSTed and PUT here; the routes did
 * not exist, so Add, Edit and the Activate/Deactivate toggle all 404'd. Only
 * bulk-upload could create a contact and only DELETE could change one.
 *
 * ⚠ THE RULES MIRROR THE SPREADSHEET'S, DELIBERATELY. One contact typed into a
 * form and one row of an uploaded sheet are the same object, and a sheet that
 * rejects a 9-digit phone while the form accepts it produces two populations in
 * one table. These are client-xlsx.service.js's checks, in Joi:
 *   name required · email /.+@.+\..+/ · phone exactly 10 digits after stripping
 *   non-digits · alt phone same if present · designation <= 100.
 *
 * The email regex is the sheet's, not Joi's stricter .email(), for the same
 * reason — a row that uploads must not fail when it is edited.
 *
 * Dedupe, the 409 and the column allowlist all live in clientService, which
 * bulk-upload already uses. Nothing here re-implements them.
 */
const TEN_DIGITS = /^\d{10}$/;
const LOOSE_EMAIL = /.+@.+\..+/;
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

const contactFields = {
  contactName:  Joi.string().trim().min(1).max(150),
  contactEmail: Joi.string().trim().max(150).pattern(LOOSE_EMAIL)
    .messages({ 'string.pattern.base': 'valid email required' }),
  contactNo:    Joi.string().trim().max(20),
  contactAltNo: Joi.string().trim().max(20).allow('', null),
  contactDesgn: Joi.string().trim().max(100).allow('', null),
};

/* Phone arrives formatted from some browsers ("+91 98765 43210"); strip first,
 * then require ten digits — exactly what the sheet parser does. */
function normalisePhones(body, res) {
  const out = { ...body };
  const no = digits(out.contactNo);
  if (out.contactNo !== undefined) {
    if (!TEN_DIGITS.test(no)) { modernError(res, 400, 'phone must be 10 digits'); return null; }
    out.contactNo = no;
  }
  if (out.contactAltNo) {
    const alt = digits(out.contactAltNo);
    if (!TEN_DIGITS.test(alt)) { modernError(res, 400, 'alt phone must be 10 digits'); return null; }
    out.contactAltNo = alt;
  } else if ('contactAltNo' in out) {
    out.contactAltNo = null;
  }
  return out;
}

router.post('/contacts', validate(Joi.object({
  contactName:  contactFields.contactName.required(),
  contactEmail: contactFields.contactEmail.required(),
  contactNo:    contactFields.contactNo.required(),
  contactAltNo: contactFields.contactAltNo,
  contactDesgn: contactFields.contactDesgn,
})), async (req, res, next) => {
  try {
    const body = normalisePhones(req.body, res);
    if (!body) return;
    const id = await clientService.createContact(req.spoc.client_id, body);
    logger.info('SPOC created contact · id=' + id + ' clientId=' + req.spoc.client_id);
    modernOk(res, { id, created: true }, 'contact created');
  } catch (e) {
    // 409 carries the conflicting row so the editor can name it.
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * PUT is BOTH the editor's save and the Activate/Deactivate toggle — the toggle
 * sends only { status }. So every field is optional and at least one is
 * required; `status` is on clientService's CONTACT_UPDATE_ALLOWED already.
 *
 * loadOwnedContact is the tenancy guard the DELETE beside this uses: a contact
 * belonging to another client 404s rather than 403s, so an id cannot be probed.
 */
router.put('/contacts/:id', validate(Joi.object({
  contactName:  contactFields.contactName,
  contactEmail: contactFields.contactEmail,
  contactNo:    contactFields.contactNo,
  contactAltNo: contactFields.contactAltNo,
  contactDesgn: contactFields.contactDesgn,
  status:       Joi.number().valid(0, 1),
}).min(1)), async (req, res, next) => {
  try {
    if (!(await loadOwnedContact(req, res))) return;
    const body = normalisePhones(req.body, res);
    if (!body) return;
    const affected = await clientService.updateContact(req.params.id, body);
    logger.info('SPOC updated contact · id=' + req.params.id + ' affected=' + affected);
    modernOk(res, { updated: affected > 0, affected }, 'contact updated');
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.get('/contacts/template', async (req, res, next) => {
  try {
    const buf = await clientXlsx.buildSpocTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts-template.xlsx"');
    res.send(buf);
  } catch (e) { next(e); }
});

router.post('/contacts/bulk-upload', contactUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return modernError(res, 400, 'missing "file" upload');
    const { rows } = await clientXlsx.parseSpocUpload(req.file.buffer);
    const summary = { total: rows.length, created: 0, skipped: 0, invalid: 0 };
    const results = [];
    for (const r of rows) {
      if (r.status === 'invalid') {
        summary.invalid++;
        results.push({ rowNumber: r.rowNumber, status: 'invalid', errors: r.errors });
        continue;
      }
      // SPOC-side rule: designation mandatory. The shared XLSX parser
      // leaves it optional (admin parity), so re-validate per row here.
      if (!r.payload?.contactDesgn || !String(r.payload.contactDesgn).trim()) {
        summary.invalid++;
        results.push({
          rowNumber: r.rowNumber,
          status: 'invalid',
          errors: ['designation is required'],
        });
        continue;
      }
      try {
        const id = await clientService.createContact(req.spoc.client_id, r.payload);
        summary.created++;
        results.push({ rowNumber: r.rowNumber, status: 'created', contactId: id });
      } catch (e) {
        if (e.status === 409) {
          summary.skipped++;
          results.push({ rowNumber: r.rowNumber, status: 'skipped', reason: e.message });
        } else {
          summary.invalid++;
          results.push({ rowNumber: r.rowNumber, status: 'failed', errors: [e.message] });
        }
      }
    }
    modernOk(res, { summary, results });
  } catch (e) {
    if (e.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'file exceeds 10MB');
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});


/* ═══ Client Profile — the SPOC's OWN company ═══════════════════════════════
 *
 * Everything under /api/client/company is scoped to req.spoc.client_id and
 * NEVER takes a client id from the caller. That is the whole security model
 * here: a SPOC cannot address another tenant's row because there is no
 * parameter through which to name one.
 *
 * ─── WHY MOST OF THE MASTER IS READ-ONLY ────────────────────────────────────
 * tbl_client carries two very different kinds of field:
 *   • The client's OWN facts — registered address, contact email, the name
 *     they want on an invoice, their KYC documents. Theirs to correct, and
 *     making them raise a ticket to fix a typo in their own address is the
 *     kind of friction this portal exists to remove.
 *   • EasyFix's COMMERCIAL CONFIG — collected_by (which party collects on a
 *     job), booking_cut_off (dispatch lead time), client_type, reference_code
 *     (which resolves their public booking link), max_orders, travel_distance,
 *     monthly_revenue, and the invoice cycle. These are negotiated terms and
 *     operational settings. A tenant editing them would be changing how
 *     EasyFix dispatches and bills, from the outside.
 * So COMPANY_WRITABLE is an ALLOWLIST, not a denylist: a column added to
 * tbl_client tomorrow is read-only here by default, which is the safe way for
 * that mistake to go.
 *
 * ─── WHY allStores GATES THE WRITES ─────────────────────────────────────────
 * The access model's surfaces (home / open / completed / performance /
 * actions / invoicing) are all about ORDERS; none of them means "may speak for
 * the company". `allStores` is the closest existing signal — it is what
 * separates Senior Leader and Finance from a Store or Regional SPOC, i.e. the
 * people who represent the whole client from the people who represent one
 * site. Reusing it avoids widening SURFACES (which is the CRM's Client Role
 * Access vocabulary and would need a role-config sweep to land).
 * ponytail: allStores as the company-write gate; add a real 'profile' surface
 * to SURFACES in client-access.service.js if this needs its own toggle.
 */

const clientDocsSvc = require('../../services/client-documents.service');
const clientS3 = require('../../utils/s3-storage');

const companyDocUpload = multerClientImg({
  storage: multerClientImg.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

const COMPANY_DOC_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf',
]);
const COMPANY_DOC_TYPES = ['pan', 'tan', 'gstin', 'aadhaar', 'other'];

// paid_by / collected_by share one legacy code space.
const PARTY_LABELS = { 0: 'Any (Operator Picks)', 1: 'Easyfixer', 2: 'EasyFix', 3: 'Client' };
const party = (code) => (code == null || code === ''
  ? null
  : { code: Number(code), label: PARTY_LABELS[Number(code)] ?? `Code ${code}` });

/*
 * camelCase key → tbl_client column. Everything the portal may write, and
 * nothing else. Values are passed to clientService.updateClient(), which
 * applies its OWN whitelist + column probe on top — so this list can only
 * ever be narrower than the admin surface, never wider.
 */
const COMPANY_WRITABLE = {
  clientEmail: 'clientEmail',
  clientAddress: 'clientAddress',
  building: 'building',
  landmark: 'landmark',
  pincode: 'pincode',
  billingName: 'billingName',
};

const companyUpdateBody = Joi.object({
  clientEmail:   Joi.string().email().max(255).optional().allow('', null),
  clientAddress: Joi.string().max(500).optional().allow('', null),
  building:      Joi.string().max(200).optional().allow('', null),
  landmark:      Joi.string().max(200).optional().allow('', null),
  pincode:       Joi.string().pattern(/^[0-9]{6}$/).optional().allow('', null)
    .messages({ 'string.pattern.base': 'Pincode must be 6 digits' }),
  billingName:   Joi.string().max(255).optional().allow('', null),
}).min(1);

/** 403 unless this SPOC speaks for the whole client. See the header note. */
function requireCompanyWrite(req, res) {
  if (req.access && req.access.allStores) return true;
  modernError(res, 403,
    'Only a Senior Leader or Finance contact can change your company profile. Ask them, or your EasyFix SPOC.');
  return false;
}

/*
 * GET /api/client/company — the company profile.
 *
 * SELECT * then project in JS, deliberately: tbl_client is a legacy table whose
 * column set differs between environments (display_name / tech_app_name arrive
 * with migrations/2026-08-25-client-profile-names.sql; coupon_code and
 * monthly_revenue are absent on older ones). A named SELECT would 1054 on the
 * environments that are behind; projecting a row that came back whole cannot.
 *
 * `editable` ships WITH the payload so the UI never has to re-derive who may
 * write what — one definition, and a UI that cannot drift out of step with the
 * gate the PUT actually applies.
 */
router.get('/company', async (req, res, next) => {
  try {
    const clientId = req.spoc.client_id;
    logger.info('Fetch client company profile · clientId=' + clientId);

    const [[row]] = await pool.query(
      `SELECT cl.*, ci.city_name
         FROM tbl_client cl
         LEFT JOIN tbl_city ci ON ci.city_id = cl.client_city_id
        WHERE cl.client_id = ?`,
      [clientId],
    );
    if (!row) return modernError(res, 404, 'client not found');

    const canWrite = !!(req.access && req.access.allStores);
    const str = (v) => (v == null || v === '' ? null : String(v));

    modernOk(res, {
      clientId: row.client_id,
      clientName: str(row.client_name),
      /*
       * The three presentation names. Each falls back to client_name so an
       * unconfigured client reads consistently everywhere rather than showing
       * blanks — the fallback is the CONTRACT, not a UI nicety.
       */
      displayName: str(row.display_name) ?? str(row.client_name),
      billingName: str(row.billing_name) ?? str(row.client_name),
      techAppName: str(row.tech_app_name) ?? str(row.client_name),
      clientType: str(row.client_type),
      referenceCode: str(row.reference_code),
      email: str(row.client_email),
      address: str(row.client_address),
      building: str(row.building),
      landmark: str(row.landmark),
      city: row.client_city_id ? { id: row.client_city_id, name: str(row.city_name) } : null,
      pincode: str(row.client_pincode),
      status: Number(row.client_status),

      /* Commercial config — READ-ONLY, and labelled as EasyFix's to change. */
      terms: {
        // HOURS of lead time, not a clock time. job.service.js consumes it as
        // hours; rendering it as "4:00 PM" anywhere would be a different number.
        bookingCutOffHours: row.booking_cut_off == null ? null : Number(row.booking_cut_off),
        collectedBy: party(row.collected_by),
        paidBy: party(row.paid_by),
        travelDistanceKm: row.travel_distance == null ? null : Number(row.travel_distance),
        maxOrders: row.max_orders == null ? null : Number(row.max_orders),
        /*
         * The legacy "Invoice Details" block. `cycle` is a CSV of days of the
         * month with 40 meaning "last day" — a STRING, despite the legacy Java
         * model also declaring an unrelated int billingCycle.
         */
        invoicing: {
          raised: Number(row.billing_raised) === 1,
          cycle: str(row.billing_cycle),
          startDate: row.billing_start_date || null,
        },
      },

      /* KYC identifiers, on their legacy column names. */
      kyc: {
        cin: str(row.tan_number),          // legacy: "CIN NO" is stored in tan_number
        pan: str(row.client_pan_number),
        mouContact: str(row.client_aadhaar), // legacy: "MOU Contact" in client_aadhaar
      },

      createdAt: row.insert_date || null,
      updatedAt: row.update_date || null,

      /* Who may write what, resolved server-side. */
      canEdit: canWrite,
      editable: canWrite ? Object.keys(COMPANY_WRITABLE) : [],
    });
  } catch (e) { next(e); }
});

/*
 * PUT /api/client/company — correct your own company's details.
 *
 * Delegates to clientService.updateClient(), the same writer the CRM uses, so
 * the column probe and the '' → NULL date coercion apply identically. Unknown
 * keys are rejected by Joi BEFORE they reach it: `stripUnknown` is deliberately
 * NOT used, because silently dropping `collectedBy` would tell the caller their
 * write succeeded.
 */
router.put('/company', validate(companyUpdateBody), async (req, res, next) => {
  try {
    if (!requireCompanyWrite(req, res)) return;
    const clientId = req.spoc.client_id;

    const payload = {};
    for (const [key, mapped] of Object.entries(COMPANY_WRITABLE)) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) payload[mapped] = req.body[key];
    }
    if (Object.keys(payload).length === 0) return modernError(res, 400, 'nothing to update');

    logger.info('Update client company profile · clientId=' + clientId
      + ' · spocId=' + req.spoc.id + ' · fields=' + Object.keys(payload).join(','));
    const affected = await clientService.updateClient(clientId, payload, req.clientUser?.userId ?? null);
    if (!affected) return modernError(res, 404, 'client not found');
    modernOk(res, { updated: true });
  } catch (e) {
    if (e.status) {
      logger.warn('Company profile update rejected · ' + e.message);
      return modernError(res, e.status, e.message);
    }
    next(e);
  }
});

/*
 * GET /api/client/company/documents — the client's own KYC / brand files.
 *
 * Same tbl_client_document rows the CRM's checklist manages, scoped to this
 * SPOC's client. Presigned URLs come back ready for <img>/<a href>, so the
 * portal never needs a bearer on the file request itself.
 *
 * A missing table is not an error here: this portal predates client documents
 * on some environments, and an empty checklist that says so beats a 503 that
 * takes the whole profile page down.
 */
router.get('/company/documents', async (req, res, next) => {
  try {
    logger.info('List client company documents · clientId=' + req.spoc.client_id);
    if (!(await clientDocsSvc.hasTable())) {
      return modernOk(res, { items: [], provisioned: false, canEdit: !!(req.access && req.access.allStores) });
    }
    const rows = await clientDocsSvc.listForClient(req.spoc.client_id);
    modernOk(res, {
      items: rows,
      provisioned: true,
      canEdit: !!(req.access && req.access.allStores),
    });
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * POST /api/client/company/documents — upload one KYC / brand file.
 *   multipart: file (required), docType (pan|tan|gstin|aadhaar|other), docLabel
 */
router.post('/company/documents', companyDocUpload.single('file'), async (req, res, next) => {
  try {
    if (!requireCompanyWrite(req, res)) return;
    if (!req.file) return modernError(res, 400, 'missing "file" upload');
    if (!COMPANY_DOC_MIME.has(req.file.mimetype)) {
      return modernError(res, 400, `mimetype "${req.file.mimetype}" is not allowed; use PNG/JPEG/WEBP/GIF/PDF`);
    }
    const docType = String(req.body.docType || 'other').toLowerCase();
    if (!COMPANY_DOC_TYPES.includes(docType)) {
      return modernError(res, 400, 'docType must be pan|tan|gstin|aadhaar|other');
    }
    if (!clientS3.isEnabled()) {
      return modernError(res, 503, 'File storage is not configured on this environment');
    }
    // Same single call the CRM route uses — the compensating delete lives in
    // the service so neither upload path can be fixed without the other.
    const { documentId, s3Key } = await clientDocsSvc.storeAndRecord(req.spoc.client_id, {
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
      originalName: req.file.originalname,
      docType,
      docLabel: req.body.docLabel || null,
      // The tbl_user id carried in the SPOC's token, NOT req.spoc.id — that is
      // a tbl_client_contacts PK and uploaded_by is a tbl_user FK. Older tokens
      // have no claim, and null is the honest answer for those.
      uploadedBy: req.clientUser?.userId ?? null,
    });
    const url = await clientS3.resolveClientDocumentUrl(s3Key).catch(() => null);
    logger.info('Client company document uploaded · id=' + documentId + ' · clientId=' + req.spoc.client_id);
    res.status(201);
    modernOk(res, { documentId, s3Key, url });
  } catch (e) {
    if (e?.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'file exceeds 10MB');
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * DELETE /api/client/company/documents/:id
 *
 * ⚠ OWNERSHIP IS CHECKED HERE, NOT IN THE SERVICE. softDelete() takes a bare
 * document id and applies no client filter — it is safe in the CRM only
 * because that route runs guardRowByClientId() first. Without the same check
 * a SPOC could delete ANOTHER TENANT'S documents by counting upwards. The
 * mismatch returns the same 404 as a missing row so the endpoint cannot be
 * used to probe which ids exist.
 */
router.delete('/company/documents/:id', async (req, res, next) => {
  try {
    if (!requireCompanyWrite(req, res)) return;
    const docId = Number(req.params.id);
    if (!Number.isInteger(docId) || docId <= 0) return modernError(res, 404, 'document not found');

    const ownerClientId = await clientService.getDocumentClientId(docId);
    if (ownerClientId == null || Number(ownerClientId) !== Number(req.spoc.client_id)) {
      logger.warn('Company document delete refused · docId=' + docId
        + ' · spocClientId=' + req.spoc.client_id + ' · ownerClientId=' + ownerClientId);
      return modernError(res, 404, 'document not found');
    }
    const affected = await clientDocsSvc.softDelete(docId);
    if (!affected) return modernError(res, 404, 'document not found');
    logger.info('Client company document deleted · id=' + docId + ' · clientId=' + req.spoc.client_id);
    modernOk(res, { deleted: true });
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});


/* ═══ Home — the date-range block ═══════════════════════════════════════════
 *
 * GET /api/client/dashboard-range?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Powers the three cards under Today's Pulse: performance health, work by
 * city, and cancellations. Today's Pulse itself does NOT read this — open
 * orders are a live figure and a date range means nothing to them, which is
 * why the range control sits below the pulse and not above it.
 *
 * ─── THE COHORT IS "RAISED IN THIS WINDOW" ──────────────────────────────────
 * Every number here counts the same set of jobs: those whose
 * ticket_created_date_time falls in the range. Completed, still in progress,
 * now overdue, escalated, cancelled — all of that cohort. So the card reads as
 * "of the work raised in this window, here is where it stands", and every
 * figure moves together when the range changes.
 *
 * The alternative — each metric on its own most natural date (completed by
 * checkout, escalated by escalation date) — was considered and rejected: the
 * percentages stop reconciling, because the denominators are different sets of
 * jobs. A share of cancellations is only meaningful against a total that
 * contains the same rows.
 *
 * ─── WHY NOT REUSE /performance ─────────────────────────────────────────────
 * It is range-aware and rolls up by city and category already, but it is gated
 * on the `performance` grant while Home is ungated — a Store SPOC would get a
 * 403 and three empty cards. It also runs the full TAT engine, scoring every
 * completed job in the window in JS, which is far too heavy for a card that
 * re-reads on every range change. These are four plain SQL aggregates.
 *
 * Team scope mirrors /dashboard-summary exactly (self + everyone reporting to
 * you) so the numbers on this page reconcile with each other.
 */
const dashboardRangeQuery = Joi.object({
  from: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  to:   Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  // Optional scope narrowing. Both are OPT-IN: absent means "everything you
  // can already see", never a widened view.
  city: Joi.string().max(120).optional().allow(''),
  spoc: Joi.number().integer().positive().optional(),
}).messages({ 'string.pattern.base': 'Dates must be yyyy-mm-dd' });

router.get('/dashboard-range', validate(dashboardRangeQuery, 'query'), async (req, res, next) => {
  try {
    const clientId = req.spoc.client_id;
    const { from, to } = req.query;
    logger.info('Client dashboard range · clientId=' + clientId + ' · ' + from + '..' + to);

    /*
     * THE SAME SCOPE THE REST OF THE PAGE USES — the third and last bespoke
     * one on this screen. It expanded self plus DIRECT reports, non-recursive,
     * and ignored the caller's role, so a Senior Leader's range cards covered
     * a narrower book than the pulse cards directly above them.
     *
     * hierarchyFilter owns both halves of that: the recursive subtree, and the
     * ?spoc containment check that stops a Store SPOC reading a peer's book by
     * guessing a contact id (an id it will not allow is IGNORED, not rejected,
     * so the page degrades to the caller's own scope rather than erroring and
     * cannot be used to probe which ids exist).
     *
     * `undefined` = unrestricted, which has to become an ABSENT clause rather
     * than IN () — and an empty array still emits `IN (NULL)`, so a SPOC who
     * may see nothing counts nothing instead of everything.
     */
    const hier = await resolveClientHierarchy(req);
    const scopeIds = hierarchyFilter(hier, req);
    const teamClause = Array.isArray(scopeIds)
      ? `AND j.reporting_contact_id IN (${scopeIds.length ? scopeIds.map(() => '?').join(',') : 'NULL'})`
      : '';
    const teamIds = Array.isArray(scopeIds) ? scopeIds : [];
    const wantSpoc = Number(req.query.spoc) || null;

    /*
     * ?city=<name> filters on the job's ADDRESS city. The city list the UI
     * offers comes from GET /cities, which is itself DISTINCT over this
     * client's jobs — so a value that matches nothing is a stale tab, not an
     * injection surface, and it is parameterised regardless.
     *
     * The join has to be added to all four queries, not just the city one, or
     * the percentages would compare a city-scoped numerator against a
     * client-wide denominator.
     */
    const city = String(req.query.city || '').trim();
    const cityJoin = city
      ? `LEFT JOIN tbl_address ad2 ON ad2.address_id = j.fk_address_id
         LEFT JOIN tbl_city    ci2 ON ci2.city_id    = ad2.city_id`
      : '';
    const cityWhere = city ? 'AND ci2.city_name = ?' : '';
    const cityParam = city ? [city] : [];

    /*
     * `to` is INCLUSIVE: a job raised at 18:40 on the end date belongs to the
     * window. `< to + 1 day` rather than `DATE(...) <=` so the index on
     * ticket_created_date_time stays usable.
     */
    const COHORT = `j.fk_client_id = ?
          ${teamClause}
          AND j.ticket_created_date_time >= ?
          AND j.ticket_created_date_time <  DATE_ADD(?, INTERVAL 1 DAY)
          ${cityWhere}`;
    const params = [clientId, ...teamIds, from, to, ...cityParam];

    const totals = pool.query(
      `SELECT COUNT(*)                                                        AS total,
              SUM(CASE WHEN j.job_status IN (3,5)      THEN 1 ELSE 0 END)     AS completed,
              SUM(CASE WHEN j.job_status IN (0,1,2,20) THEN 1 ELSE 0 END)     AS inProgress,
              SUM(CASE WHEN j.job_status = 6           THEN 1 ELSE 0 END)     AS cancelled,
              -- Overdue = still open AND its appointment has passed.
              SUM(CASE WHEN j.job_status IN (0,1,2,20)
                        AND j.requested_date_time IS NOT NULL
                        AND j.requested_date_time < NOW()  THEN 1 ELSE 0 END) AS runningLate,
              SUM(CASE WHEN r.is_escalated = 1         THEN 1 ELSE 0 END)     AS escalated
         FROM tbl_job j
         LEFT JOIN tbl_easyfixer_rating_by_customer r ON r.job_id = j.job_id
         ${cityJoin}
        WHERE ${COHORT}`,
      params,
    );

    // Every city in the window, not a top-N — the card shows a few and says
    // how many more there are, so truncating here would make that count a lie.
    const cities = pool.query(
      `SELECT ci.city_name AS name,
              COUNT(*)                                                    AS jobs,
              SUM(CASE WHEN j.job_status IN (3,5) THEN 1 ELSE 0 END)      AS completed
         FROM tbl_job j
         LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id
         LEFT JOIN tbl_city    ci ON ci.city_id    = ad.city_id
        WHERE ${COHORT}
          AND ci.city_name IS NOT NULL AND ci.city_name <> ''
        GROUP BY ci.city_name
        ORDER BY jobs DESC, name ASC`,
      params,
    );

    /*
     * Cancellation reasons. cancel_reason_id points at action_taken_reason,
     * the one reason table (the older per-flow tables are dead — see the
     * action_taken_reason note in the CRM). A cancelled job with no reason
     * recorded is kept and labelled rather than dropped: "we do not know" is
     * itself a finding when it is a large share.
     */
    const reasons = pool.query(
      `SELECT COALESCE(NULLIF(TRIM(atr.action_desc), ''), 'Not recorded') AS reason,
              COUNT(*)                                                    AS n
         FROM tbl_job j
         LEFT JOIN action_taken_reason atr ON atr.id = j.cancel_reason_id
         ${cityJoin}
        WHERE ${COHORT}
          AND j.job_status = 6
        GROUP BY reason
        ORDER BY n DESC, reason ASC`,
      params,
    );

    /*
     * There is NO fourth aggregate. A category breakdown of ALL work used to
     * ship inside the Cancellations card and was removed from the design on
     * 2026-08-26 — the card answers "how many cancelled, and why", and a mix of
     * every job in the window sitting under a "N cancelled" title invited
     * exactly the misreading it once caused ("89 carpentry CANCELLATIONS").
     * The query went with it rather than being left to run for a payload
     * nobody reads.
     */
    /*
     * The PREVIOUS comparable window — one COUNT, for the delta pill on the
     * Cancellations card. "Same length, immediately before": a 60-day window is
     * compared with the 60 days before it, a month-to-date with the equally
     * many days before the 1st.
     *
     * The arithmetic stays in SQL. `from`/`to` are bare YYYY-MM-DD and the
     * column is a zone-less IST DATETIME, so doing the shift in JS would mean
     * parsing a calendar date into an instant and back — the exact round trip
     * that moves a boundary by a day for anyone outside IST. DATEDIFF and
     * DATE_SUB compare the same calendar the column is written in.
     *
     * ONE query for all three cards. It mirrors the shape of `totals` rather
     * than counting a single status, because every card below Today's Pulse now
     * shows movement and they must all compare against the SAME window — three
     * separate prior-period queries is three chances for one card to be
     * comparing against a different fortnight than its neighbour.
     *
     * Still not the whole aggregate set: no city or reason breakdown, because
     * no card shows a per-city or per-reason delta.
     */
    const previous = pool.query(
      `SELECT COUNT(*)                                                    AS total,
              SUM(CASE WHEN j.job_status IN (3,5) THEN 1 ELSE 0 END)      AS completed,
              SUM(CASE WHEN j.job_status = 6      THEN 1 ELSE 0 END)      AS cancelled
         FROM tbl_job j
         ${cityJoin}
        WHERE j.fk_client_id = ?
          ${teamClause}
          AND j.ticket_created_date_time >= DATE_SUB(?, INTERVAL (DATEDIFF(?, ?) + 1) DAY)
          AND j.ticket_created_date_time <  ?
          ${cityWhere}`,
      [clientId, ...teamIds, from, to, from, from, ...cityParam],
    );

    const [[[t]], [cityRows], [reasonRows], [[prev]]] =
      await Promise.all([totals, cities, reasons, previous]);

    const n = (v) => Number(v) || 0;
    const total = n(t.total);
    const cancelled = n(t.cancelled);
    const pctOf = (v, d) => (d > 0 ? Number(((100 * v) / d).toFixed(1)) : 0);

    modernOk(res, {
      window: { from, to },
      scope: { city: city || null, spoc: teamIds.length === 1 && wantSpoc ? wantSpoc : null },
      performance: {
        total,
        completed: n(t.completed),
        inProgress: n(t.inProgress),
        runningLate: n(t.runningLate),
        escalated: n(t.escalated),
        cancelled,
      },
      cities: cityRows.map((r) => ({
        name: r.name, jobs: n(r.jobs), completed: n(r.completed),
      })),
      cancellations: {
        cancelled,
        total,
        // Top 3 by volume; pct is of CANCELLED jobs, not of all work — the card
        // reads "of the cancellations, this is why".
        topReasons: reasonRows.slice(0, 3).map((r) => ({
          reason: r.reason, count: n(r.n), pct: pctOf(n(r.n), cancelled),
        })),
        reasonCount: reasonRows.length,
        /*
         * The remainder, so the card can show a real "Other" row rather than a
         * muted "+ N other reasons" footnote. EXACT, not an estimate: `cancelled`
         * counts job_status = 6 and the reasons query groups the same cohort on
         * the same predicate, so the reason counts sum to `cancelled` — a
         * cancelled job with no reason recorded is LABELLED 'Not recorded', never
         * dropped, which is what keeps the two reconcilable.
         */
        otherReasons: {
          count: Math.max(0, cancelled - reasonRows.slice(0, 3).reduce((a, r) => a + n(r.n), 0)),
          reasons: Math.max(0, reasonRows.length - 3),
        },
      },

      /*
       * The same window LENGTH immediately before the selected one — the
       * comparison every card below Today's Pulse renders its movement against.
       *
       * RAW COUNTS, NO DELTAS AND NO DIRECTION. Each card decides what a rise
       * means, because they disagree: more cancellations is worse, a higher
       * completion rate is better, and more work raised is neither — it is
       * volume, and colouring it good or bad would be the dashboard inventing
       * an opinion about the client's own business. A server-computed
       * "improvement" would have to bake one polarity in for all three.
       */
      previous: {
        total: n(prev && prev.total),
        completed: n(prev && prev.completed),
        cancelled: n(prev && prev.cancelled),
      },
    });
  } catch (e) { next(e); }
});

module.exports = router;
