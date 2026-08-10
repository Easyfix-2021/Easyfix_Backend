const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const requireSpocAuth = require('../../middleware/client-auth');
const { pool } = require('../../db');
const clientAuth = require('../../services/client-auth.service');
const jobService = require('../../services/job.service');
const holidayService = require('../../services/holiday.service');
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
      // Same friendly mapping as send-otp so the message stays
      // consistent if status changed between the two calls.
      if (r.reason === 'CONTACT_INACTIVE') {
        return modernError(res, 403,
          'Your contact has been deactivated by your client. Please contact the client to reactivate it.');
      }
      if (r.reason === 'CLIENT_INACTIVE') {
        return modernError(res, 403,
          'Your client account is inactive. Please contact EasyFix support to reactivate it.');
      }
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

/*
 * GET /api/client/me — current SPOC + their client brand.
 *
 * Enriches the bare `req.spoc` payload (id, client_id, contact_name,
 * email, client_name) with the resolved client logo URL so the sidebar
 * can render the SPOC's own company brand at the top instead of the
 * generic EasyFix logo. logo_id is read from tbl_client and passed
 * through resolveClientDocumentUrl which handles S3 / absolute URLs /
 * FILE_BASE_URL relative paths transparently.
 *
 * Why here (not in findSpocById): the auth middleware runs on every
 * authenticated request — resolving an S3 presigned URL on every call
 * would be wasteful. `/me` fires once per app boot, which is where the
 * extra round-trip belongs.
 */
router.get('/me', async (req, res, next) => {
  try {
    let client_logo_url = null;
    try {
      const [[client]] = await pool.query(
        'SELECT logo_id FROM tbl_client WHERE client_id = ? LIMIT 1',
        [req.spoc.client_id]
      );
      if (client?.logo_id) {
        const { resolveClientDocumentUrl } = require('../../utils/s3-storage');
        client_logo_url = await resolveClientDocumentUrl(client.logo_id);
      }
    } catch { /* logo is best-effort — never block /me */ }
    modernOk(res, { spoc: { ...req.spoc, client_logo_url } });
  } catch (e) { next(e); }
});

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

/*
 * ─── Notices (Notice Board → Client surface) ──────────────────────
 *
 * The CRM admin "Notice Board" composes notices in tbl_notice with a
 * CSV `target_surfaces` column. Any notice that includes 'client' in
 * that CSV becomes visible to SPOCs here. `notice.service` handles
 * the publish/expire window logic and decorates each row with the
 * per-SPOC `is_read` flag (lookup keyed on tbl_notice_read).
 *
 * Endpoints:
 *   GET   /notices                — list active client-surface notices
 *   GET   /notices/unread-count   — { count } for the sidebar bell badge
 *   PATCH /notices/:id/read       — idempotent read-receipt
 *   PATCH /notices/read-all       — bulk mark-all-as-read
 *
 * Read-receipt identity tuple is fixed per surface:
 *   surface     = 'client'
 *   readerType  = 'client'
 *   readerId    = req.spoc.id  (tbl_client_contacts.id)
 *
 * Returning the resolved image URLs (S3-presigned) means the FE can
 * <img src> the value directly without an extra hop. URLs age out
 * after ~5 min but the page is one-shot — refresh re-fetches.
 */

// Lazy-required inside the handler scope; this matches the existing
// pattern used elsewhere in this file for services with heavy
// transitive deps (s3, sms templates). Avoids paying the cost on
// every cold start of a route that doesn't actually use it.
const noticeService = require('../../services/notice.service');

router.get('/notices', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const items = await noticeService.listActiveForSurface({
      surface: 'client',
      readerType: 'client',
      readerId: req.spoc.id,
      limit,
    });
    modernOk(res, { items });
  } catch (e) { next(e); }
});

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
 * GET /api/client/lookup/service-categories — ALL active service
 * categories (not just the ones the SPOC's client has contracted).
 *
 * Changed 2026-05-30: previously this returned only categories with a
 * row in tbl_client_service for the SPOC's client_id. That filter
 * collapsed the dropdown to a handful (sometimes 1) of options, even
 * though the legacy
 *   /service-categories/service-category-by-status
 * endpoint returned the entire active-category set. We now match
 * legacy behaviour — full active list, sorted alphabetically.
 */
router.get('/lookup/service-categories', async (req, res, next) => {
  try {
    logger.info('Fetch client service-categories · clientId=' + req.spoc.client_id);
    const lookup = require('../../services/lookup.service');
    const rows = await lookup.serviceCategories({ includeInactive: false });
    const items = rows.map((r) => ({
      id: r.service_catg_id,
      name: r.service_catg_name,
    }));
    logger.info('Returning ' + items.length + ' service-categories');
    modernOk(res, { items });
  } catch (e) { next(e); }
});

/*
 * GET /api/client/customers/mobile/:mobile — lookup existing customer
 * by their 10-digit mobile number. Used by the New Order form to
 * auto-fill the contact-name field as soon as the SPOC finishes
 * typing the mobile.
 *
 * Legacy parity: ACD_APIs `/api/customers/mob/{mobile}`.
 *
 * Returns { customer: null } if no match (frontend distinguishes a
 * 404 from this empty-result-OK shape — keeps the autofill flow
 * non-blocking even for brand-new customers).
 */
router.get('/customers/mobile/:mobile', async (req, res, next) => {
  try {
    const mobile = String(req.params.mobile || '').trim();
    if (!/^\d{10}$/.test(mobile)) {
      return modernOk(res, { customer: null });
    }
    const [[row]] = await pool.query(
      `SELECT customer_id, customer_name, customer_mob_no, customer_email
         FROM tbl_customer
        WHERE customer_mob_no = ?
        ORDER BY customer_id DESC
        LIMIT 1`,
      [mobile]
    );
    modernOk(res, { customer: row || null });
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
    // scope=today: each active bucket is scoped to TODAY by its own date column —
    //   New         = tickets created today   (ticket_created_date_time)
    //   Scheduled   = appointment today        (requested_date_time)
    //   In Progress = scheduled today           (scheduled_date_time)
    //   Completed   = checked out today         (checkout_date_time)
    // open / cancelled / total stay lifetime. Default (no scope) = all lifetime.
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
        SUM(CASE WHEN job_status = 9      ${on('ticket_created_date_time')} THEN 1 ELSE 0 END) AS newTickets,
        SUM(CASE WHEN job_status = 1      ${on('requested_date_time')}      THEN 1 ELSE 0 END) AS scheduled,
        SUM(CASE WHEN job_status = 2      ${on('scheduled_date_time')}      THEN 1 ELSE 0 END) AS inProgress,
        SUM(CASE WHEN job_status IN (3,5) ${on('checkout_date_time')}       THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN job_status IN (0,7,9) THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN job_status = 6        THEN 1 ELSE 0 END) AS cancelled,
        COUNT(*) AS total
       FROM tbl_job WHERE fk_client_id = ? ${mine}`, params);
    modernOk(res, stats);
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
router.get('/dashboard-summary', async (req, res, next) => {
  try {
    // Resolve the SPOC's team scope — themself + everyone who reports
    // to them. Mirrors the legacy ClientController.java lines 101-111
    // "my team's tickets" expansion. Stays in-process (no JOIN) so we
    // can reuse the same id list across all three sub-queries.
    const [reports] = await pool.query(
      `SELECT id FROM tbl_client_contacts
        WHERE client_id = ?
          AND manager_id IS NOT NULL AND manager_id NOT IN ('', 'null')
          AND CAST(manager_id AS UNSIGNED) = ?`,
      [req.spoc.client_id, req.spoc.id]
    );
    const teamIds = reports.map((r) => r.id);
    teamIds.push(req.spoc.id);
    const teamPlaceholders = teamIds.map(() => '?').join(',');

    // Single COUNT … FILTER over the team-scope. One scan, five
    // SUM(CASE) — keeps the round-trips and join cost flat compared
    // to firing five COUNT(*) queries.
    const [[counts]] = await pool.query(
      `SELECT
         SUM(CASE WHEN j.job_status = 9                                 THEN 1 ELSE 0 END) AS newTickets,
         SUM(CASE WHEN j.job_status IN (0, 1, 2, 20)                    THEN 1 ELSE 0 END) AS inProgress,
         SUM(CASE WHEN j.job_status IN (3, 5)                           THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN j.job_status = 6                                 THEN 1 ELSE 0 END) AS cancelled,
         SUM(CASE WHEN r.is_escalated = 1                               THEN 1 ELSE 0 END) AS escalated
       FROM   tbl_job j
       LEFT   JOIN tbl_easyfixer_rating_by_customer r ON r.job_id = j.job_id
       WHERE  j.fk_client_id        = ?
         AND  j.reporting_contact_id IN (${teamPlaceholders})`,
      [req.spoc.client_id, ...teamIds]
    );

    // Donut slices — return labels + colours pre-baked so the FE just
    // maps to SVG. Order is the lifecycle-natural reading order.
    // Colours match the brand palette + the badge colours used on
    // the Order History "Status of Order" column.
    const [breakdownRows] = await pool.query(
      `SELECT j.job_status, COUNT(*) AS n
         FROM tbl_job j
        WHERE j.fk_client_id        = ?
          AND j.reporting_contact_id IN (${teamPlaceholders})
        GROUP BY j.job_status`,
      [req.spoc.client_id, ...teamIds]
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
          AND j.reporting_contact_id IN (${teamPlaceholders})
        ORDER BY j.job_id DESC
        LIMIT 5`,
      [req.spoc.client_id, ...teamIds]
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
          AND j.reporting_contact_id IN (${teamPlaceholders})`,
      [req.spoc.client_id, ...teamIds]
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
          AND j.reporting_contact_id IN (${teamPlaceholders})
          AND j.job_status NOT IN (3,5,6,7)
          AND NOT EXISTS (
            SELECT 1 FROM tbl_estimate_details e2
             WHERE e2.job_id = ed.job_id
               AND (e2.sent_on > ed.sent_on
                    OR (e2.sent_on = ed.sent_on AND e2.id > ed.id))
          )`,
      [req.spoc.client_id, ...teamIds]
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
          AND j.reporting_contact_id IN (${teamPlaceholders})
          AND ci.city_name IS NOT NULL
        GROUP BY ci.city_name
        ORDER BY orders DESC
        LIMIT 6`,
      [req.spoc.client_id, ...teamIds]
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
            AND j.reporting_contact_id IN (${teamPlaceholders})
            AND j.job_status IN (0,1,2,20,9,15,21)
            AND j.requested_date_time IS NOT NULL
            AND j.requested_date_time < NOW()
       ) t`,
      [req.spoc.client_id, ...teamIds]
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
        WHERE j.fk_client_id = ? AND j.reporting_contact_id IN (${teamPlaceholders})`,
      [req.spoc.client_id, ...teamIds]
    );

    // ─── 30-day orders trend ─────────────────────────────────────────
    // Received (created) vs Completed (checked out) per day, last 30 days,
    // team-scoped. Grouped by day in SQL; JS fills the gap days with zero
    // so the chart always has exactly 30 points.
    const [createdRows] = await pool.query(
      `SELECT DATE_FORMAT(j.ticket_created_date_time,'%Y-%m-%d') AS d, COUNT(*) AS n
         FROM tbl_job j
        WHERE j.fk_client_id = ? AND j.reporting_contact_id IN (${teamPlaceholders})
          AND j.ticket_created_date_time >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
        GROUP BY d`,
      [req.spoc.client_id, ...teamIds]
    );
    const [completedRows] = await pool.query(
      `SELECT DATE_FORMAT(j.checkout_date_time,'%Y-%m-%d') AS d, COUNT(*) AS n
         FROM tbl_job j
        WHERE j.fk_client_id = ? AND j.reporting_contact_id IN (${teamPlaceholders})
          AND j.job_status IN (3,5)
          AND j.checkout_date_time >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
        GROUP BY d`,
      [req.spoc.client_id, ...teamIds]
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
        WHERE j.fk_client_id = ? AND j.reporting_contact_id IN (${teamPlaceholders})
        GROUP BY name
        ORDER BY n DESC
        LIMIT 6`,
      [req.spoc.client_id, ...teamIds]
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
        WHERE j.fk_client_id = ? AND j.reporting_contact_id IN (${teamPlaceholders})
        ORDER BY j.job_id DESC
        LIMIT 8`,
      [req.spoc.client_id, ...teamIds]
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
      },
      statusBreakdown,
      categoryBreakdown,
      recentTickets,
      recentEscalations,
      teamSize: teamIds.length, // for the "across N SPOCs" footer
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
    const ticketFlag = req.query.ticketFlag || req.query.flag || undefined;
    let ownerIds = req.query.ownerIds || req.query.owner || undefined;
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
      // Filter-bar additions (2026-05-28) — match the legacy Angular
      // order-history filter card (Ticket Created Date / Bucket / City /
      // Client Team). All optional; absence falls back to the prior
      // unfiltered behaviour for callers that haven't been updated.
      statuses: req.query.statuses || req.query.bucket || undefined,
      cityIds:  req.query.cityIds  || req.query.city   || undefined,
      ownerIds,
      // Server-derived from JWT — frontend cannot override (security).
      // Mirrors legacy clientSpocId scoping to the SPOC's reports.
      reportingContactIds: req._reportingContactIds,
      ticketFlag,
      startDate: req.query.startDate || undefined,
      endDate:   req.query.endDate   || undefined,
      // Default the date-range column to `created_date_time` — that's
      // what the legacy filter labelled "Ticket Created Date". Callers
      // can override via `dateType=requested|scheduled|ticket`.
      dateType:  req.query.dateType  || 'created',
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
      if (arr.length) { where.push(`j.job_owner IN (${arr.map(() => '?').join(',')})`); params.push(...arr); }
    }
    if (req.query.startDate) { where.push('j.created_date_time >= ?'); params.push(req.query.startDate); }
    if (req.query.endDate)   { where.push('j.created_date_time <= ?'); params.push(req.query.endDate); }
    if (req.query.q) {
      where.push('(j.job_reference_id LIKE ? OR j.client_ref_id LIKE ? OR cu.customer_name LIKE ? OR cu.customer_mob_no LIKE ?)');
      const v = `%${req.query.q}%`;
      params.push(v, v, v, v);
    }
    // Apply the same "my team's tickets" scope as GET /jobs so the tab
    // badges count what's actually visible inside each tab. Without
    // this, counts would over-report (whole-client total) while the
    // list shows only the SPOC's own + reports' rows.
    {
      const [reports] = await pool.query(
        `SELECT id FROM tbl_client_contacts
          WHERE client_id = ?
            AND manager_id IS NOT NULL AND manager_id NOT IN ('', 'null')
            AND CAST(manager_id AS UNSIGNED) = ?`,
        [req.spoc.client_id, req.spoc.id]
      );
      const ids = reports.map((r) => r.id);
      ids.push(req.spoc.id);
      where.push(`j.reporting_contact_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
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
    // Lookup SPOC's direct reports once — used only for the
    // completedOrders scope (otherOrders is whole-client per legacy).
    const [reports] = await pool.query(
      `SELECT id FROM tbl_client_contacts
        WHERE client_id = ?
          AND manager_id IS NOT NULL AND manager_id NOT IN ('', 'null')
          AND CAST(manager_id AS UNSIGNED) = ?`,
      [req.spoc.client_id, req.spoc.id]
    );
    const teamIds = reports.map((r) => r.id);
    teamIds.push(req.spoc.id);
    const teamPh = teamIds.map(() => '?').join(',');

    // Shared filter clauses applied to both counts.
    const sharedWhere = ['j.fk_client_id = ?'];
    const sharedParams = [req.spoc.client_id];

    const toIdArr = (v) => String(v).split(',')
      .map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
    if (req.query.cityIds) {
      const arr = toIdArr(req.query.cityIds);
      if (arr.length) { sharedWhere.push(`ad.city_id IN (${arr.map(() => '?').join(',')})`); sharedParams.push(...arr); }
    }
    if (req.query.ownerIds) {
      const arr = toIdArr(req.query.ownerIds);
      if (arr.length) { sharedWhere.push(`j.job_owner IN (${arr.map(() => '?').join(',')})`); sharedParams.push(...arr); }
    }
    if (req.query.startDate) { sharedWhere.push('j.created_date_time >= ?'); sharedParams.push(req.query.startDate); }
    if (req.query.endDate)   { sharedWhere.push('j.created_date_time <= ?'); sharedParams.push(req.query.endDate); }
    if (req.query.q) {
      sharedWhere.push('(j.job_reference_id LIKE ? OR j.client_ref_id LIKE ? OR cu.customer_name LIKE ? OR cu.customer_mob_no LIKE ?)');
      const v = `%${req.query.q}%`;
      sharedParams.push(v, v, v, v);
    }

    const w = sharedWhere.join(' AND ');
    const needsCu = /\bcu\./.test(w);
    const needsAd = /\bad\./.test(w);
    const joins = `
      FROM tbl_job j
      ${needsCu ? 'LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id' : ''}
      ${needsAd ? 'LEFT JOIN tbl_address  ad ON ad.address_id  = j.fk_address_id' : ''}
    `;

    // Two parallel COUNTs — kept separate (rather than SUM(CASE)) because
    // otherOrders is whole-client while completedOrders is team-scoped,
    // so the WHERE shapes diverge.
    const [[[other]], [[completed]]] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS n ${joins} WHERE ${w}`, sharedParams),
      pool.query(
        `SELECT COUNT(*) AS n ${joins}
          WHERE ${w}
            AND j.ready_for_billing = 'Yes'
            AND j.sub_job_id IS NULL
            AND j.reporting_contact_id IN (${teamPh})`,
        [...sharedParams, ...teamIds]
      ),
    ]);

    modernOk(res, {
      otherOrders:     Number(other.n     || 0),
      completedOrders: Number(completed.n || 0),
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
router.get('/appointments/counts', async (req, res, next) => {
  try {
    const [reports] = await pool.query(
      `SELECT id FROM tbl_client_contacts
        WHERE client_id = ?
          AND manager_id IS NOT NULL AND manager_id NOT IN ('', 'null')
          AND CAST(manager_id AS UNSIGNED) = ?`,
      [req.spoc.client_id, req.spoc.id]
    );
    const teamIds = reports.map((r) => r.id);
    teamIds.push(req.spoc.id);
    const teamPh = teamIds.map(() => '?').join(',');

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
      if (arr.length) { where.push(`j.job_owner IN (${arr.map(() => '?').join(',')})`); params.push(...arr); }
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
    // in the text, so their teamIds must be bound first, then the
    // shared WHERE params.
    const [[row]] = await pool.query(
      `SELECT
         SUM(CASE WHEN j.job_status = 0 AND j.fk_easyfixter_id IS NULL
                   AND j.reporting_contact_id IN (${teamPh})
                  THEN 1 ELSE 0 END) AS txUnallocated,
         SUM(CASE WHEN j.job_status = 0 AND j.fk_easyfixter_id IS NOT NULL
                   AND j.reporting_contact_id IN (${teamPh})
                  THEN 1 ELSE 0 END) AS txAllocated,
         SUM(CASE WHEN j.job_status = 1
                   AND j.reporting_contact_id IN (${teamPh})
                  THEN 1 ELSE 0 END) AS ongoingOrders
       ${joins}
       WHERE ${w}`,
      [...teamIds, ...teamIds, ...teamIds, ...params]
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
router.get('/under-audit/counts', async (req, res, next) => {
  try {
    const [reports] = await pool.query(
      `SELECT id FROM tbl_client_contacts
        WHERE client_id = ?
          AND manager_id IS NOT NULL AND manager_id NOT IN ('', 'null')
          AND CAST(manager_id AS UNSIGNED) = ?`,
      [req.spoc.client_id, req.spoc.id]
    );
    const teamIds = reports.map((r) => r.id);
    teamIds.push(req.spoc.id);
    const teamPh = teamIds.map(() => '?').join(',');

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
      if (arr.length) { where.push(`j.job_owner IN (${arr.map(() => '?').join(',')})`); params.push(...arr); }
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
                   AND j.reporting_contact_id IN (${teamPh})
                  THEN 1 ELSE 0 END) AS revisit,
         SUM(CASE WHEN j.job_status = 10
                   AND j.reporting_contact_id IN (${teamPh})
                  THEN 1 ELSE 0 END) AS completedOnApp
       ${joins}
       WHERE ${w}`,
      [...teamIds, ...teamIds, ...params]
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
router.get('/client-delay/counts', async (req, res, next) => {
  try {
    // SPOC's team ids (self + direct reports)
    const [reports] = await pool.query(
      `SELECT id FROM tbl_client_contacts
        WHERE client_id = ?
          AND manager_id IS NOT NULL AND manager_id NOT IN ('', 'null')
          AND CAST(manager_id AS UNSIGNED) = ?`,
      [req.spoc.client_id, req.spoc.id]
    );
    const teamIds = reports.map((r) => r.id);
    teamIds.push(req.spoc.id);
    const teamPh = teamIds.map(() => '?').join(',');

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
      if (arr.length) { where.push(`j.job_owner IN (${arr.map(() => '?').join(',')})`); params.push(...arr); }
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
         SUM(CASE WHEN j.job_status = 15 AND j.reporting_contact_id IN (${teamPh})
                  THEN 1 ELSE 0 END) AS approveEstimate,
         SUM(CASE WHEN j.job_status = 21 AND j.reporting_contact_id IN (${teamPh})
                  THEN 1 ELSE 0 END) AS fulfilmentOnHold,
         SUM(CASE WHEN j.job_status = 9
                   AND j.approved_by_client = 0
                   AND (j.call_later IS NULL OR j.call_later != 1)
                   AND ccs.manager_id IS NOT NULL
                   AND ccs.manager_id NOT IN ('', 'null')
                   AND ccs.approval_by_client = 1
                   AND j.reporting_contact_id IN (${teamPh})
                  THEN 1 ELSE 0 END) AS unauthorized
       ${joins}
       WHERE ${w}`,
      // teamIds first — placeholders in SELECT CASE come before WHERE.
      [...teamIds, ...teamIds, ...teamIds, ...params]
    );
    modernOk(res, {
      approveEstimate:  Number(row.approveEstimate  || 0),
      fulfilmentOnHold: Number(row.fulfilmentOnHold || 0),
      unauthorized:     Number(row.unauthorized     || 0),
    });
  } catch (e) { next(e); }
});

/*
 * GET /api/client/ratecard — rate-card lines for the SPOC's client.
 *
 * Legacy parity: Angular RateCardComponent + RatecardServiceService
 * (which buggy-called /clients/{id} instead of a rate-card endpoint —
 * we expose a proper one here so the SPOC can actually see their card).
 *
 * Each row in tbl_client_service can have multiple service_type_ids
 * (stored as CSV). Legacy displayed ONE row per service-type, so we
 * expand the CSV here and emit one row per (service, service-type).
 *
 * Columns returned (matches legacy MyRatingCols headers):
 *   service_category_name | service_type_name | rate_card_name | total_amount
 *
 * Soft-deleted rows (service_status = 0) are excluded — same rule as
 * the admin listForClient query.
 */
router.get('/ratecard', async (req, res, next) => {
  try {
    // One row per client_service (each carries a single service_type_id —
    // verified against the live schema). All four joins are LEFT so any
    // missing dimension still surfaces the row with NULL — keeps the FE
    // contract stable even on partial setup.
    const [rows] = await pool.query(
      `SELECT cs.client_service_id,
              cs.total_amount,
              cs.charge_type,
              sc.service_catg_name  AS service_category_name,
              st.service_type_name,
              crc.crc_ratecard_name AS rate_card_name
         FROM tbl_client_service cs
         LEFT JOIN tbl_service_catg     sc  ON sc.service_catg_id  = cs.service_catg_id
         LEFT JOIN tbl_service_type     st  ON st.service_type_id  = cs.service_type_id
         LEFT JOIN tbl_client_rate_card crc ON crc.crc_id          = cs.rate_card_id
        WHERE cs.client_id = ?
          AND (cs.service_status IS NULL OR cs.service_status <> 0)
        ORDER BY sc.service_catg_name, st.service_type_name, cs.client_service_id`,
      [req.spoc.client_id]
    );
    modernOk(res, { items: rows });
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

// ─── Filter lookups ──────────────────────────────────────────────────
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
    const [rows] = await pool.query(
      `SELECT DISTINCT ci.city_id AS id, ci.city_name AS name
         FROM tbl_job j
         LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id
         LEFT JOIN tbl_city    ci ON ci.city_id    = ad.city_id
        WHERE j.fk_client_id = ? AND ci.city_id IS NOT NULL
        ORDER BY ci.city_name ASC`,
      [req.spoc.client_id]
    );
    modernOk(res, { items: rows });
  } catch (e) { next(e); }
});

// Client team members eligible to own jobs — used by the "Client Team"
// multi-select. Reuses tbl_client_contacts (the same table our SPOC
// auth lives in) so the IDs returned here are job_owner-compatible.
router.get('/team/members', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, contact_name AS name, contact_email AS email
         FROM tbl_client_contacts
        WHERE client_id = ? AND status = 1
        ORDER BY contact_name ASC`,
      [req.spoc.client_id]
    );
    modernOk(res, { items: rows });
  } catch (e) { next(e); }
});

/*
 * GET /api/client/team — full SPOC team for the My Team page.
 *
 * Migrated from legacy ACD_APIs
 *   GET /api/clients/{clientId}/contacts/managers?status=<bool>
 * (TechniciansServiceService.getTechnicianData on the Angular dashboard).
 *
 * Returns every contact for the SPOC's client with the fields the page
 * renders. The manager_id column in MySQL is `varchar(255)` and can
 * legitimately be:
 *    "1639" — numeric id of the manager contact
 *    "null" — the literal four-letter string (legacy data quirk)
 *    ""     — empty string
 *    NULL   — actual SQL null
 * All four cases are normalised to JS `null` so the frontend can build
 * the hierarchy with a single `manager_id == null → root` check.
 *
 * Query params:
 *   status   — "true" (active only, default), "false" (inactive only),
 *              "all" (everyone). Mirrors the legacy contract.
 */
router.get('/team', async (req, res, next) => {
  try {
    const statusParam = String(req.query.status || 'true').toLowerCase();
    const clauses = ['client_id = ?'];
    const params = [req.spoc.client_id];
    if (statusParam === 'true')       { clauses.push('status = 1'); }
    else if (statusParam === 'false') { clauses.push('(status = 0 OR status IS NULL)'); }
    // 'all' → no status clause

    const [rows] = await pool.query(
      `SELECT id,
              contact_name  AS name,
              contact_email AS email,
              contact_no    AS mobile,
              contact_desgn AS designation,
              manager_id,
              status,
              approval_by_client
         FROM tbl_client_contacts
        WHERE ${clauses.join(' AND ')}
        ORDER BY contact_name ASC`,
      params
    );

    // Normalise manager_id ("null"/""/NULL → null; numeric strings → Number).
    const items = rows.map((r) => {
      const raw = r.manager_id;
      let mid = null;
      if (raw != null && raw !== '' && String(raw).toLowerCase() !== 'null') {
        const n = Number(raw);
        if (!Number.isNaN(n)) mid = n;
      }
      return {
        id: r.id,
        name: r.name,
        email: r.email,
        mobile: r.mobile,
        designation: r.designation,
        managerId: mid,
        status: r.status,                      // 1 / 0 / null
        approvalByClient: r.approval_by_client,// 0 / 1 / 2 / null
      };
    });

    modernOk(res, { items });
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

// Approve / reject / escalate
//
// Sets `approved_by_client = 1` alongside the contact + timestamp. The
// flag is what the legacy "unauthorized" filter (My-New-Tickets page)
// checks — without it, an authorized ticket would still appear on the
// Un-Authorized tab after approval. See JobFilterServiceImpl.java:192.
router.patch('/jobs/:id/approve', async (req, res, next) => {
  try {
    logger.info('SPOC approve job · id=' + req.params.id);
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) {
      logger.warn('Approve target not found / not owned · id=' + req.params.id);
      return modernError(res, 404, 'job not found');
    }
    await pool.query(
      `UPDATE tbl_job
          SET approved_by_client = 1,
              approved_by_client_contact = ?,
              approved_on_date_time = NOW()
        WHERE job_id = ?`,
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

// Upload a booking image / video for a job (SPOC). Reuses the SAME storage
// (s3Storage → local writeBuffer fallback) + tbl_job_image insert as
// POST /admin/jobs/:id/images — image_category 'booking', stage 0. The admin
// surface is image-only; SPOC bookings additionally allow short videos.
const jobImgMulter = require('multer');
const { writeBuffer: writeJobMedia } = require('../../utils/file-storage');
const s3JobStorage = require('../../utils/s3-storage');
const jobMediaUpload = jobImgMulter({ storage: jobImgMulter.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

router.post('/jobs/:id/images', jobMediaUpload.single('file'), async (req, res, next) => {
  const jobId = Number(req.params.id);
  try {
    const job = await jobService.getById(jobId);
    if (!job || job.fk_client_id !== req.spoc.client_id) return modernError(res, 404, 'job not found');
    if (!req.file) return modernError(res, 400, 'missing "file" upload');

    const [[{ existing }]] = await pool.query(
      'SELECT COUNT(*) AS existing FROM tbl_job_image WHERE job_id = ?', [jobId]);
    const seq = Number(existing || 0) + 1;

    let imageValue;
    if (s3JobStorage.isEnabled && s3JobStorage.isEnabled()) {
      try {
        imageValue = await s3JobStorage.putJobImage({
          jobId, seq, buffer: req.file.buffer,
          contentType: req.file.mimetype, originalName: req.file.originalname,
          category: 'Booking',
        });
      } catch {
        imageValue = writeJobMedia('job_files', req.file.buffer, req.file.originalname, req.file.mimetype).filename;
      }
    } else {
      imageValue = writeJobMedia('job_files', req.file.buffer, req.file.originalname, req.file.mimetype).filename;
    }

    const [ins] = await pool.query(
      `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, status, created_by, created_date)
       VALUES (?, ?, 'booking', 0, 1, ?, NOW())`,
      [jobId, imageValue, req.spoc.id]);

    modernOk(res, { image_id: ins.insertId, job_id: jobId, image: imageValue }, 'image uploaded');
  } catch (e) {
    if (e?.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'file exceeds 25MB');
    next(e);
  }
});

// Cancel an order (SPOC). Reuses jobService.setStatus → status 6 (CANCELLED),
// which already stamps cancel_date_time / cancel_reason_id / cancel_comment /
// cancel_by. Guarded against terminal states so completed/cancelled/enquiry
// orders can't be flipped.
router.post('/jobs/:id/cancel',
  validate(Joi.object({
    reasonId: Joi.number().integer().positive().optional(),
    comment: Joi.string().max(2000).allow('', null).optional(),
  })),
  async (req, res, next) => {
    try {
      const jobId = Number(req.params.id);
      const job = await jobService.getById(jobId);
      if (!job || job.fk_client_id !== req.spoc.client_id) return modernError(res, 404, 'job not found');
      if ([3, 5, 6, 7].includes(Number(job.job_status))) {
        return modernError(res, 400, 'This order can no longer be cancelled.');
      }
      await jobService.setStatus(
        jobId,
        { status: 6, reasonId: req.body.reasonId || null, comment: req.body.comment || null },
        { user_id: req.spoc.id },
      );
      modernOk(res, await jobService.getById(jobId), 'cancelled');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
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

/*
 * GET /api/client/lookup/reasons?actionType=N
 *
 * Reason dropdown source — backs the SPOC-side escalate / cancel /
 * estimate-reject popups on the Job Detail page.
 *
 * Legacy ACD config (Angular `app.config.ts`):
 *   actionType: 1   → Cancel reasons        (jobRejectedByClient)
 *   actionType: 23  → Escalate reasons      (jobEscalatedByClient)
 *   estimateActionType: ?  → Estimate reject
 *
 * userType is fixed to 3 (EasyFix vocabulary) since the SPOC-side legacy
 * code hardcoded that value; passing a `userType` query is allowed for
 * future flexibility but defaults to 3 for back-compat.
 */
/*
 * POST /api/client/jobs/:id/escalate
 * body: { reasonId: number, comment: string }
 *
 * SPOC-driven escalation — replicates the legacy
 *   PATCH /api/jobs/job/{id}/reject?flag=escalated
 * but writes to the canonical escalation table
 * (`tbl_easyfixer_rating_by_customer`) instead of overloading the
 * job-reject flow. One row per job; subsequent escalations bump
 * `no_of_escalations` and re-open the row by clearing `resolved_time`.
 *
 * Notification: ops mailbox + owner are emailed via the existing
 * fireRejectEscalation helper so admins see the row immediately on the
 * Escalated Jobs dashboard.
 */
// Small status→label map used by the escalation history insert. Kept
// local + lowercase-safe to avoid pulling the FE STATUS_LABELS over.
const STATUS_LABELS_SAFE = {
  0: 'Unconfirmed', 1: 'Scheduled', 2: 'In-Progress', 3: 'Completed',
  5: 'Completed', 6: 'Cancelled', 7: 'Enquiry', 9: 'Call Later',
  10: 'Revisit', 15: 'Awaiting Approval', 21: 'On Hold',
};

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

/*
 * GET /api/client/profile — SPOC's own profile.
 *
 * Returns every field the redesigned profile UI surfaces. manager_id is
 * varchar in the DB and can carry "null" / "" literals (legacy data) —
 * we normalise those to JS null so the frontend can treat it uniformly.
 */
router.get('/profile', async (req, res, next) => {
  try {
    logger.info('Fetch SPOC profile · spocId=' + req.spoc.id);
    const [[row]] = await pool.query(
      `SELECT cc.id, cc.contact_name, cc.contact_email, cc.contact_no,
              cc.contact_alt_no, cc.contact_desgn, cc.linkedIn_profile,
              cc.manager_id, cc.email_cc, cc.payment_mode, cc.approval_by_client,
              cc.client_id, cl.client_name
         FROM tbl_client_contacts cc
         LEFT JOIN tbl_client cl ON cl.client_id = cc.client_id
        WHERE cc.id = ?`,
      [req.spoc.id]);
    if (!row) return modernError(res, 404, 'profile not found');
    const raw = row.manager_id;
    let managerId = null;
    if (raw != null && raw !== '' && String(raw).toLowerCase() !== 'null') {
      const n = Number(raw);
      if (!Number.isNaN(n)) managerId = n;
    }
    // Fetch parent client identity + logo so the profile hero card can
    // show the client brand on the right side. logo_id stores the file
    // path under FILE_BASE_URL (legacy convention); resolve it to a
    // browser-loadable URL using the shared client-doc resolver so S3,
    // local, and Nginx layouts all work transparently.
    const [[client]] = await pool.query(
      `SELECT client_id, client_name, logo_id
         FROM tbl_client
        WHERE client_id = ?`,
      [req.spoc.client_id]);
    let client_logo_url = null;
    if (client?.logo_id) {
      try {
        const { resolveClientDocumentUrl } = require('../../utils/s3-storage');
        client_logo_url = await resolveClientDocumentUrl(client.logo_id);
      } catch { /* fall through; FE will show name fallback */ }
    }
    modernOk(res, {
      id: row.id,
      contact_name: row.contact_name,
      contact_email: row.contact_email,
      contact_no: row.contact_no,
      contact_alt_no: row.contact_alt_no,
      contact_desgn: row.contact_desgn,
      linkedIn_profile: row.linkedIn_profile,
      manager_id: managerId,
      email_cc: row.email_cc,
      payment_mode: row.payment_mode,
      approval_by_client: row.approval_by_client,
      // Client brand block — name always sent, logo URL only when set.
      client_id: client?.client_id ?? req.spoc.client_id,
      client_name: client?.client_name ?? null,
      client_logo_url,
    });
  } catch (e) { next(e); }
});

/*
 * PUT /api/client/profile — partial update.
 *
 * Editable: contact_name, contact_alt_no, contact_desgn, linkedIn_profile,
 *           manager_id, email_cc, payment_mode, approval_by_client.
 * Read-only: contact_email, contact_no (separate change-request flow).
 *
 * COALESCE preserves existing values when a field is omitted — letting
 * the FE send partial payloads (e.g. just the approval toggle).
 */
router.put('/profile', async (req, res, next) => {
  try {
    logger.info('Update SPOC profile · spocId=' + req.spoc.id);
    const {
      contact_name, contact_alt_no, contact_desgn, linkedIn_profile,
      manager_id, email_cc, payment_mode, approval_by_client,
    } = req.body || {};
    // Alt-phone junk-pattern guard. Same rule the FE applies on Save
    // and the same rule services/job.service.js#assertValidMobile
    // applies to customer mobiles. Centralised here so a direct API
    // hit (curl, bulk import) can't slip placeholders into
    // tbl_client_contacts.contact_alt_no.
    if (contact_alt_no) {
      const v = String(contact_alt_no).trim();
      const failReason = (() => {
        if (!/^[6-9]\d{9}$/.test(v)) return 'must be a 10-digit Indian mobile starting 6–9';
        if (/^(\d)\1{9}$/.test(v))    return 'cannot be the same digit repeated';
        const asc  = v.split('').every((d, i, a) => i === 0 || (Number(d) - Number(a[i - 1]) + 10) % 10 === 1);
        const desc = v.split('').every((d, i, a) => i === 0 || (Number(a[i - 1]) - Number(d) + 10) % 10 === 1);
        if (asc || desc)              return 'sequential digits aren’t a real mobile';
        if (/^(\d)(\d)\1\2\1\2\1\2\1\2$/.test(v)) return 'looks like a placeholder';
        return null;
      })();
      if (failReason) {
        return modernError(res, 400, `contact_alt_no ${failReason}`);
      }
    }
    // LinkedIn URL guard — same shape as the FE check
    // (src/app/(authed)/profile/page.tsx#isValidLinkedInUrl). Accepts
    // canonical linkedin.com paths only; rejects random text and
    // non-linkedin URLs.
    if (linkedIn_profile && String(linkedIn_profile).trim()) {
      const u = String(linkedIn_profile).trim();
      const ok = /^(https?:\/\/)?(www\.|in\.|[a-z]{2}\.)?linkedin\.com\/(in|pub|company|profile)\/[A-Za-z0-9._%-]+\/?(\?.*)?$/i.test(u);
      if (!ok) {
        return modernError(res, 400, 'linkedIn_profile must be a full LinkedIn URL (e.g. https://linkedin.com/in/handle)');
      }
    }
    // manager_id is varchar in the DB; the FE sends a numeric id (or null
    // to clear). Stringify so MySQL stores it as expected.
    const mgrIdStr = manager_id == null ? null : String(manager_id);
    await pool.query(
      `UPDATE tbl_client_contacts
          SET contact_name       = COALESCE(?, contact_name),
              contact_alt_no     = COALESCE(?, contact_alt_no),
              contact_desgn      = COALESCE(?, contact_desgn),
              linkedIn_profile   = COALESCE(?, linkedIn_profile),
              manager_id         = COALESCE(?, manager_id),
              email_cc           = COALESCE(?, email_cc),
              payment_mode       = COALESCE(?, payment_mode),
              approval_by_client = COALESCE(?, approval_by_client)
        WHERE id = ?`,
      [contact_name, contact_alt_no, contact_desgn, linkedIn_profile,
       mgrIdStr, email_cc, payment_mode, approval_by_client,
       req.spoc.id]);

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

/*
 * ─── Change phone / change email (OTP-protected) ───────────────────
 *
 * The PUT /profile route above intentionally treats contact_no /
 * contact_email as read-only — they're the SPOC's login identifiers,
 * so changing them requires proving ownership of the NEW number/email.
 *
 * Flow (mirrors login OTP, but the OTP goes to the *new* value, not
 * the existing one on file):
 *
 *   1. Client POSTs { new_phone | new_email } to /send-otp
 *      → uniqueness check across tbl_client_contacts AND tbl_user
 *        (across ALL contacts/users — not just active — because we
 *        don't want a future reactivation to silently collide).
 *      → 4-digit OTP written to otp_details with otp_type='Change Phone'
 *        or 'Change Email' and user_email/user_mobile_no set to the
 *        *new* target. otp_type segregates these from 'Login Otp' rows
 *        so a stale login OTP can't satisfy a change-email verify.
 *      → otp-delivery.service sends to the new target.
 *
 *   2. Client POSTs { new_phone | new_email, otp } to /verify-otp
 *      → matches the otp_details row by (otp_type, user_email or
 *        user_mobile_no = new target), validates expiry, then UPDATEs
 *        tbl_client_contacts for req.spoc.id.
 *
 * Why we re-check uniqueness on verify too: between send-otp and
 * verify-otp another SPOC could grab the same number — the second
 * check closes that small TOCTOU window. The first check still lives
 * on send-otp so we never spam an OTP to a duplicate target.
 *
 * No "old number" verification — product asked for the simpler UX
 * where proving control of the *new* number is sufficient. If the
 * SPOC's account is compromised, the attacker would need to also
 * receive OTPs on a number they control, which they do trivially
 * either way (they're already authed). The real constraint is that
 * the new identifier must be unique.
 */

// Junk-free, 10-digit Indian mobile (same rule as createUser / PUT profile).
// We DO NOT block obviously fake numbers here — user said "no validation"
// for the change flow. We only enforce 10-digit shape so the otp_details
// row and downstream WhatsApp/SMS providers have a sane input.
function looksLikePhone(v) {
  return /^[0-9]{10}$/.test(String(v || '').trim());
}
function looksLikeEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
}

/*
 * Uniqueness probe — true if any *other* row in tbl_client_contacts or
 * tbl_user already has this phone / email. We exclude the calling
 * SPOC's own row from tbl_client_contacts because they may be
 * re-submitting their own current value (no-op) and we shouldn't
 * 409 on that. The match is exact (no LOWER on phones, lowercased on
 * emails) since both tables store these as plain VARCHAR.
 */
async function isPhoneInUse(phone, excludeContactId) {
  const v = String(phone || '').trim();
  const [[ctcRow]] = await pool.query(
    `SELECT id FROM tbl_client_contacts WHERE contact_no = ? AND id <> ? LIMIT 1`,
    [v, excludeContactId]);
  if (ctcRow) return true;
  const [[usrRow]] = await pool.query(
    `SELECT user_id FROM tbl_user WHERE mobile_no = ? LIMIT 1`,
    [v]);
  return !!usrRow;
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

// Issue an OTP for a change-phone / change-email request.
// Returns { delivered, expiresAt } on success or { error } shape that
// the route maps to 4xx. Idempotent: re-calling refreshes the OTP for
// the same (otp_type, target) tuple.
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

// Verify a change-phone / change-email OTP and apply the column update.
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
// Saved addresses for a customer, so Book-a-service can offer their previous
// locations. Only the addresses used in this customer's LAST 3 jobs with THIS
// client (deduped) — recent + relevant, never other clients' work.
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
                 ORDER BY job_id DESC
                 LIMIT 3
              ) recent
         JOIN tbl_address a  ON a.address_id = recent.fk_address_id
         LEFT JOIN tbl_city ci ON ci.city_id = a.city_id
        GROUP BY a.address_id, a.address, a.building, a.landmark, a.locality,
                 a.pin_code, a.gps_location, a.city_id, ci.city_name
        ORDER BY last_job DESC`,
      [cid, req.spoc.client_id]);
    logger.info('Customer saved addresses (last 3 jobs) · customerId=' + cid + ' · count=' + rows.length);
    modernOk(res, { items: rows });
  } catch (e) { next(e); }
});

// ─── /client/export/jobs — Excel download ────────────────────────────
// Streams matching jobs as a real .xlsx file (replaces the previous JSON
// preview). Column set mirrors what the SPOC sees in the dashboard table.
// Status code is converted to legacy label so the spreadsheet reads
// naturally to non-technical recipients.
/*
 * GET /api/client/export/jobs — OrderHistory.xlsx download.
 *
 * Migrated from legacy ACD_APIs `POST /api/jobs/exportToExcel/{clientId}`
 * (JobController.java line 389). The legacy contract was POST with a
 * JobFilterDto body; the new contract is GET with query params so the
 * download can be triggered by a plain <a href> or fetch without a
 * preflight. Same filter shape as the list endpoint — pass whatever
 * the user has applied on the dashboard and the spreadsheet mirrors
 * exactly what they see.
 *
 * Column shape matches the legacy 30-column OrderHistory.xlsx layout.
 * Columns the new schema can't fill (Mode of Payment, Total Charge,
 * Pending Reason action_desc, Bucket Status) are exported as blank so
 * ops scripts that index by column position still line up.
 */
router.get('/export/jobs', async (req, res, next) => {
  try {
    logger.info('Export client jobs to xlsx · status=' + (req.query.status ?? 'all') + ' from=' + (req.query.startDate || '-') + ' to=' + (req.query.endDate || '-'));
    const rows = await jobService.listForExport({
      clientId: req.spoc.client_id,
      status: req.query.status != null ? Number(req.query.status) : undefined,
      statuses: req.query.statuses || req.query.bucket || undefined,
      cityIds:  req.query.cityIds  || req.query.city   || undefined,
      ownerIds: req.query.ownerIds || req.query.owner  || undefined,
      ticketFlag: req.query.ticketFlag || req.query.flag || undefined,
      startDate: req.query.startDate || undefined,
      endDate:   req.query.endDate   || undefined,
      dateType:  req.query.dateType  || 'created',
      q: req.query.q,
      limit: 5000, // hard cap; SPOC exports rarely exceed a few hundred
    });

    // Empty-result short-circuit. Instead of streaming an .xlsx that
    // only has a header row (confusing for the SPOC, looks like a
    // "successful but empty" download), bail with a structured JSON
    // 404. The FE's downloadBlob helper detects the JSON content-type
    // and surfaces the message in the export-gate popup.
    //
    // 404 over 204 because:
    //   - 204 carries no body, so the FE can't show a meaningful reason
    //   - 404 with `{success:false, error}` reuses our standard error
    //     envelope and slots into the existing ApiError catch path
    if (!rows || rows.length === 0) {
      return modernError(res, 404,
        'No data matches the selected filters. Adjust the date range or filters and try again.');
    }

    logger.info('Exporting ' + rows.length + ' jobs to xlsx');
    // Legacy stored job_status as a raw int; the spreadsheet showed the
    // human label. Convert here using the shared STATUS_LABELS map.
    const data = rows.map((r) => ({
      ...r,
      job_status_label: STATUS_LABELS[r.job_status] || 'Unknown',
    }));
    const ts = new Date().toISOString().slice(0, 10);
    await sendXlsx(res, {
      filename: `OrderHistory_${ts}.xlsx`,
      sheetName: 'OrderHistory',
      // Column order mirrors the legacy 30-column layout
      // (JobServiceImpl.java#getManageJobDownloadListReportNew).
      columns: [
        { key: 'job_id',                          header: 'Job Id',                       width: 10 },
        { key: 'client_ref_id',                   header: 'Client Reference Id',          width: 18 },
        { key: 'job_desc',                        header: 'Job Description',              width: 40 },
        { key: 'customer_name',                   header: 'Customer Name',                width: 22 },
        { key: 'customer_mob_no',                 header: 'Customer No.',                 width: 14 },
        { key: 'full_address',                    header: 'Complete Address',             width: 40 },
        { key: 'pin_code',                        header: 'Pincode',                      width: 10 },
        { key: 'city_name',                       header: 'City',                         width: 14 },
        { key: 'state_name',                      header: 'State',                        width: 14 },
        { key: 'aging_days',                      header: 'Aging',                        width: 8  },
        { key: 'job_status_label',                header: 'Job Status',                   width: 16 },
        { key: 'bucket_status',                   header: 'Bucket Status',                width: 16 },
        { key: 'pending_due_to',                  header: 'Pending Due to',               width: 16 },
        { key: 'pending_reason',                  header: 'Pending Reason',               width: 20 },
        { key: 'pending_remarks',                 header: 'Pending Remarks',              width: 30 },
        { key: 'cancel_date_time',                header: 'Cancel Date',                  width: 18 },
        { key: 'cancel_enquiry_reason',           header: 'Cancel/Enquiry Reason',        width: 22 },
        { key: 'cancel_enquiry_comment',          header: 'Cancel/Enquiry Comment',       width: 30 },
        { key: 'dashboard_booking_date',          header: 'Dashboard Booking Date',       width: 18 },
        { key: 'crm_booking_date',                header: 'CRM Booking Date',             width: 18 },
        { key: 'original_appointment_date_time',  header: 'Original Appointment Date',    width: 18 },
        { key: 'appointment_date',                header: 'Appointment Date',             width: 18 },
        { key: 'app_checkout_date_time',          header: 'App Checkout Date',            width: 18 },
        { key: 'client_comment',                  header: 'Client Comment',               width: 30 },
        { key: 'tx_name',                         header: 'Tx Name',                      width: 22 },
        { key: 'sda',                             header: 'SDA (Same Day Attempt)',       width: 12 },
        { key: 'customer_rating',                 header: 'Rating',                       width: 8  },
        { key: 'customer_review',                 header: 'Customer Review',              width: 30 },
        { key: 'total_charge',                    header: 'Total Charge',                 width: 12 },
        { key: 'mode_of_payment',                 header: 'Mode of payment',              width: 14 },
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

/* ─── Contacts (SPOCs of the current client) ──────────────────────────
 * SPOC-scoped mirror of /admin/clients/:clientId/contacts*. Lets a
 * client SPOC manage their own team's contact directory directly from
 * the Profile → Contacts tab. Re-uses the admin service layer for the
 * heavy lifting (insert + dedupe + XLSX parser); this block only
 * scopes everything to req.spoc.client_id so a SPOC at client A can
 * never see or mutate client B's contacts.
 *
 * Endpoints:
 *   GET    /api/client/contacts                 — list directory
 *   POST   /api/client/contacts                 — add new contact
 *   PUT    /api/client/contacts/:id             — edit contact
 *   DELETE /api/client/contacts/:id             — remove contact
 *   GET    /api/client/contacts/template        — XLSX template download
 *   POST   /api/client/contacts/bulk-upload     — multipart XLSX import
 */
const multer = require('multer');
const clientService = require('../../services/client.service');
const clientXlsx = require('../../services/client-xlsx.service');
const clientValidator = require('../../validators/client.validator');
const contactUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

// Helper — assert the contact id belongs to the SPOC's client. Returns
// the contact row on success, fires modernError on miss. Centralised
// because every per-id route needs the same scope check.
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

router.post(
  '/contacts',
  validate(clientValidator.createContactBody),
  async (req, res, next) => {
    try {
      // Designation is required on SPOC-side creates (the admin validator
      // keeps it optional to tolerate legacy rows). Guard at the route
      // layer instead of forking the shared Joi schema.
      if (!req.body.contactDesgn || !String(req.body.contactDesgn).trim()) {
        return modernError(res, 400, 'contactDesgn is required');
      }
      const id = await clientService.createContact(req.spoc.client_id, req.body);
      res.status(201);
      modernOk(res, { id });
    } catch (e) {
      if (e.status) {
        return modernError(res, e.status, e.message, e.conflict ? { conflict: e.conflict } : undefined);
      }
      next(e);
    }
  }
);

router.put(
  '/contacts/:id',
  validate(clientValidator.updateContactBody),
  async (req, res, next) => {
    try {
      if (!(await loadOwnedContact(req, res))) return;
      // If designation is being explicitly changed (key present), it
      // must be non-empty. A PUT that omits the key entirely is allowed
      // — only the fields actually sent get updated.
      const desgnKeys = ['contactDesgn', 'contact_desgn'];
      const hasDesgnKey = desgnKeys.some((k) => Object.prototype.hasOwnProperty.call(req.body, k));
      if (hasDesgnKey) {
        const v = req.body.contactDesgn ?? req.body.contact_desgn;
        if (!v || !String(v).trim()) {
          return modernError(res, 400, 'designation cannot be empty');
        }
      }
      // Self-deactivation guard — a SPOC trying to set their OWN row
      // to status=0 would immediately invalidate their next request
      // (findSpocById requires cc.status = 1). Reject with a clear
      // message instead of letting them silently break their session.
      const statusVal = req.body.status ?? req.body.contact_status;
      const isDeactivating = statusVal !== undefined && Number(statusVal) === 0;
      if (isDeactivating && Number(req.params.id) === Number(req.spoc.id)) {
        return modernError(res, 400,
          'You cannot deactivate your own contact — ask another SPOC at your client to do it.');
      }
      const affected = await clientService.updateContact(req.params.id, req.body);
      // Surface affectedRows so the FE can tell a real update apart
      // from a silent no-op (column mismatch, value unchanged, etc.).
      modernOk(res, { updated: affected > 0, affected });
    } catch (e) {
      if (e.status) {
        return modernError(res, e.status, e.message, e.conflict ? { conflict: e.conflict } : undefined);
      }
      next(e);
    }
  }
);

router.delete('/contacts/:id', async (req, res, next) => {
  try {
    if (!(await loadOwnedContact(req, res))) return;
    const affected = await clientService.deleteContact(req.params.id);
    if (!affected) return modernError(res, 404, 'contact not found');
    modernOk(res, { deleted: true });
  } catch (e) { next(e); }
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

module.exports = router;
