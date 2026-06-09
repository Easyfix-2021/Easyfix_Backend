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

// ─── Public: SPOC OTP login ─────────────────────────────────────────
const identifier = Joi.alternatives(Joi.string().email(), Joi.string().pattern(/^[0-9]{10}$/));

router.post('/auth/login-otp', validate(Joi.object({ identifier: identifier.required() })), async (req, res, next) => {
  try {
    const r = await clientAuth.createLoginOtp(req.body.identifier);
    // CONTACT_INACTIVE — this specific SPOC row has status=0. Their
    // client admin (or another SPOC at the same client) needs to
    // reactivate them via Profile → Contacts. Distinct from
    // "no such user" so the SPOC sees the right next step instead of
    // bouncing to sign-up.
    if (r.reason === 'CONTACT_INACTIVE') {
      return modernError(res, 403,
        'Your contact has been deactivated by your client. Please contact the client to reactivate it.');
    }
    // CLIENT_INACTIVE — the parent tbl_client row is inactive. EasyFix
    // ops is the right escalation here.
    if (r.reason === 'CLIENT_INACTIVE') {
      return modernError(res, 403,
        'Your client account is inactive. Please contact EasyFix support to reactivate it.');
    }
    if (!r.found) {
      return modernError(res, 404,
        `No User Found with given loginId: ${req.body.identifier}, please sign up`);
    }
    modernOk(res, { delivered: r.found, expiresAt: r.expiresAt || null });
  } catch (e) { next(e); }
});

router.post('/auth/verify-otp', validate(Joi.object({
  identifier: identifier.required(),
  otp: Joi.number().integer().min(1000).max(9999).required(),
})), async (req, res, next) => {
  try {
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
      return modernError(res, 401, r.reason);
    }
    // Cookie name matches the frontend localStorage key (`client_auth_token`)
    // so future refresh/CSRF flows can read either source consistently.
    res.cookie('client_auth_token', r.token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400 * 1000 });
    modernOk(res, { token: r.token, spoc: { id: r.spoc.id, name: r.spoc.contact_name, client_id: r.spoc.client_id } });
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
    const [rows] = await pool.query(
      'SELECT * FROM tbl_client_custom_properties WHERE client_id = ?',
      [req.spoc.client_id]
    );
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
    const lookup = require('../../services/lookup.service');
    const rows = await lookup.serviceCategories({ includeInactive: false });
    const items = rows.map((r) => ({
      id: r.service_catg_id,
      name: r.service_catg_name,
    }));
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

router.get('/dashboard', async (req, res, next) => {
  try {
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
    const ticketFlag = req.query.ticketFlag || req.query.flag || undefined;
    let ownerIds = req.query.ownerIds || req.query.owner || undefined;

    // ─── Legacy "my team's tickets" scoping ─────────────────────────
    // ClientController.java lines 101-111: when on a My-New-Tickets-
    // style flag and the caller didn't pre-filter ownerIds, scope the
    // query to:
    //   1. the logged-in SPOC themselves (req.spoc.id), AND
    //   2. every contact whose manager_id points at the SPOC
    //      (i.e., their direct reports — manager sees their team's
    //       tickets).
    //
    // This is enforced server-side rather than trusting a `clientSpocId`
    // body field — the legacy frontend always overwrote that field with
    // the logged-in user's id anyway (job-status.service.ts:43-45), so
    // pulling it from req.spoc here is more secure and behaves identically.
    //
    // Skipped for:
    //   - `noResponse`  → legacy doesn't scope call-later tickets
    //   - `otherOrders` → legacy explicitly excludes this from scoping
    //     (ClientController.java:101 — "All Orders" shows whole client)
    const flagLower = String(ticketFlag || '').toLowerCase();
    const skipScope = !ticketFlag || ownerIds || flagLower === 'noresponse' || flagLower === 'otherorders';
    if (!skipScope) {
      const [reports] = await pool.query(
        `SELECT id FROM tbl_client_contacts
          WHERE client_id = ?
            AND manager_id IS NOT NULL AND manager_id NOT IN ('', 'null')
            AND CAST(manager_id AS UNSIGNED) = ?`,
        [req.spoc.client_id, req.spoc.id]
      );
      const ids = reports.map((r) => r.id);
      ids.push(req.spoc.id);
      // Note: tickets aren't owned via tbl_job.job_owner in legacy —
      // they're owned via tbl_job.reporting_contact_id. We don't have a
      // dedicated `reportingContactIds` filter on the service yet, so
      // we pass these IDs as a separate param the service understands.
      // See `reportingContactIds` handling in job.service.js list().
      req._reportingContactIds = ids;
    }

    const { rows, total } = await jobService.list({
      clientId: req.spoc.client_id,
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
      limit: Math.min(Number(req.query.limit) || 50, 500),
      offset: Number(req.query.offset) || 0,
    });
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
              GROUP_CONCAT(DISTINCT sc.service_catg_name ORDER BY sc.service_catg_name SEPARATOR ',') AS service_categories,
              (SELECT ROUND(AVG(r.customer_rating), 1)
                 FROM tbl_easyfixer_rating_by_customer r
                 JOIN tbl_job j2 ON j2.job_id = r.job_id
                WHERE r.easyfixer_id = e.efr_id
                  AND j2.fk_client_id = ?
                  AND r.customer_rating IS NOT NULL
                  AND r.customer_rating > 0
              ) AS avg_rating,
              (SELECT COUNT(*) FROM tbl_job j3
                WHERE j3.fk_easyfixter_id = e.efr_id AND j3.fk_client_id = ?
              ) AS total_jobs
         FROM tbl_client_easyfixer_mapping m
         JOIN tbl_easyfixer e   ON e.efr_id = m.easyfixer_id
         LEFT JOIN tbl_city ci  ON ci.city_id = e.efr_cityId
         LEFT JOIN tbl_service_type st ON st.service_type_id = m.service_type_id
         LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = st.service_catg_id
        WHERE ${where.join(' AND ')}
        GROUP BY e.efr_id
        ORDER BY e.efr_name ASC
        LIMIT ? OFFSET ?`,
      [req.spoc.client_id, req.spoc.client_id, ...params, limit, offset]
    );

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
      const [rows] = await pool.query(
        `SELECT city_id AS id, city_name AS name
           FROM tbl_city
          WHERE city_status = 1
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
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) return modernError(res, 404, 'job not found');
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
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) return modernError(res, 404, 'job not found');
    await pool.query(
      `UPDATE tbl_job
          SET approved_by_client = 1,
              approved_by_client_contact = ?,
              approved_on_date_time = NOW()
        WHERE job_id = ?`,
      [req.spoc.id, job.job_id]);
    modernOk(res, await jobService.getById(job.job_id), 'approved');
  } catch (e) { next(e); }
});

router.patch('/jobs/:id/reject', validate(Joi.object({ reason: Joi.string().min(3).max(500).required() })), async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) return modernError(res, 404, 'job not found');
    await pool.query(
      'UPDATE tbl_job SET approval_reject_reason = ?, approval_reject_date_time = NOW() WHERE job_id = ?',
      [req.body.reason, job.job_id]);
    // Fire escalation email to ops + the owner (legacy
    // sendemailClitoClientUrgentRequest replacement). Non-blocking —
    // failure here must not block the API response.
    fireRejectEscalation(job, req.body.reason, req.spoc).catch(() => {});
    modernOk(res, await jobService.getById(job.job_id), 'rejected');
  } catch (e) { next(e); }
});

// Estimate approve/reject — legacy stored in approve_job_doc workflow.
// Refuse approval on terminal states (cancelled / completed) and on
// estimates already responded to. Mirrors legacy idempotency guards.
router.patch('/jobs/:id/estimate/approve', async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) return modernError(res, 404, 'job not found');
    if ([3, 5, 6].includes(job.job_status)) {
      return modernError(res, 409, `cannot approve estimate on a ${job.job_status === 6 ? 'cancelled' : 'completed'} job`);
    }
    if (job.approved_on_date_time) return modernError(res, 409, 'estimate already approved');
    if (job.approval_reject_date_time) return modernError(res, 409, 'estimate already rejected; cannot approve');
    await pool.query(
      'UPDATE tbl_job SET approved_by_client_contact = ?, approved_on_date_time = NOW() WHERE job_id = ?',
      [req.spoc.id, job.job_id]);
    modernOk(res, { approved: true });
  } catch (e) { next(e); }
});

router.patch('/jobs/:id/estimate/reject', validate(Joi.object({ reason: Joi.string().min(3).max(500).required() })), async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) return modernError(res, 404, 'job not found');
    if ([3, 5, 6].includes(job.job_status)) {
      return modernError(res, 409, `cannot reject estimate on a ${job.job_status === 6 ? 'cancelled' : 'completed'} job`);
    }
    if (job.approved_on_date_time) return modernError(res, 409, 'estimate already approved; cannot reject');
    if (job.approval_reject_date_time) return modernError(res, 409, 'estimate already rejected');
    await pool.query(
      'UPDATE tbl_job SET approval_reject_reason = ?, approval_reject_date_time = NOW() WHERE job_id = ?',
      [req.body.reason, job.job_id]);
    fireRejectEscalation(job, req.body.reason, req.spoc).catch(() => {});
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
router.get('/lookup/reasons', async (req, res, next) => {
  try {
    const actionType = Number(req.query.actionType);
    if (!Number.isInteger(actionType) || actionType <= 0) {
      return modernError(res, 400, 'actionType (positive integer) is required');
    }
    const userType = Number(req.query.userType) || 3;
    const [rows] = await pool.query(
      `SELECT id, action_desc
         FROM action_taken_reason
        WHERE action_type = ? AND user_type = ?
          AND (status IS NULL OR status = 1)
        ORDER BY id ASC`,
      [actionType, userType]
    );
    const items = rows
      .map((r) => ({ id: r.id, label: String(r.action_desc || '').trim() }))
      .filter((x) => x.label);
    modernOk(res, items);
  } catch (e) { next(e); }
});

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
router.post('/jobs/:id/escalate', validate(Joi.object({
  reasonId: Joi.number().integer().positive().required(),
  comment:  Joi.string().min(3).max(2000).required(),
})), async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_client_id !== req.spoc.client_id) {
      return modernError(res, 404, 'job not found');
    }
    const { reasonId, comment } = req.body;

    // Resolve the human-readable reason once so the email is informative.
    const [[reasonRow]] = await pool.query(
      'SELECT action_desc FROM action_taken_reason WHERE id = ? LIMIT 1',
      [reasonId]);
    const reasonLabel = reasonRow?.action_desc || `Reason #${reasonId}`;

    // Upsert escalation row — there's no unique constraint on (job_id),
    // so we manually SELECT then UPDATE/INSERT. SPOC isn't a real
    // tbl_user, so `escalated_by` is NULL and we tag `escalated_from`
    // with the SPOC id for audit (legacy used the SPOC's user_id on the
    // contact record, which most rows don't have).
    const [[existing]] = await pool.query(
      `SELECT table_id, no_of_escalations
         FROM tbl_easyfixer_rating_by_customer
        WHERE job_id = ?
        LIMIT 1`,
      [job.job_id]);
    if (existing) {
      await pool.query(
        `UPDATE tbl_easyfixer_rating_by_customer
            SET is_escalated      = 1,
                escalated_time    = NOW(),
                resolved_time     = NULL,
                escalated_comments = ?,
                no_of_escalations = COALESCE(no_of_escalations, 0) + 1,
                escalated_from    = ?
          WHERE table_id = ?`,
        [`[${reasonLabel}] ${comment}`, `spoc:${req.spoc.id}`, existing.table_id]);
    } else {
      await pool.query(
        `INSERT INTO tbl_easyfixer_rating_by_customer
           (job_id, easyfixer_id, is_escalated, escalated_time,
            escalated_comments, no_of_escalations, escalated_from)
         VALUES (?, ?, 1, NOW(), ?, 1, ?)`,
        [job.job_id, job.fk_easyfixter_id || null,
         `[${reasonLabel}] ${comment}`, `spoc:${req.spoc.id}`]);
    }

    // Per-stage history row — mirrors what admin "Escalated Jobs"
    // page reads via the GROUP_CONCAT(job_stage_history) subquery.
    try {
      await pool.query(
        `INSERT INTO tbl_job_escalation_info
           (job_id, escalation_time, job_stage)
         VALUES (?, NOW(), ?)`,
        [job.job_id, STATUS_LABELS_SAFE[job.job_status] || `Status ${job.job_status}`]);
    } catch {
      // History table is best-effort — don't fail the user's action if
      // the table is missing on this environment.
    }

    // Same email shape as estimate reject, just relabelled. Best-effort.
    fireRejectEscalation(job, `[Escalated by SPOC] ${reasonLabel}: ${comment}`, req.spoc).catch(() => {});

    modernOk(res, { escalated: true }, 'Job Escalate Successfull');
  } catch (e) { next(e); }
});

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
    // Pull the SPOC's full row so we can stamp client_spoc_* / mobile
    // / reporting_contact_id on the new job WITHOUT trusting the
    // frontend to send them. These columns identify "which client
    // contact raised this order" and must come from the verified JWT,
    // not from a posted body that could spoof another SPOC.
    const [[me]] = await pool.query(
      `SELECT id, contact_name, contact_email, contact_no
         FROM tbl_client_contacts WHERE id = ? LIMIT 1`,
      [req.spoc.id]
    );

    const enriched = {
      ...req.body,
      fk_client_id: req.spoc.client_id,
      // Server-trusted SPOC stamping. FE-provided values are ignored
      // — overwriting unconditionally is correct here because these
      // identify the AUTHOR of the booking, not the customer.
      client_spoc:        me?.contact_no    || req.body.client_spoc       || null,
      client_spoc_name:   me?.contact_name  || req.body.client_spoc_name  || null,
      client_spoc_email:  me?.contact_email || req.body.client_spoc_email || null,
      reporting_contact_id: req.spoc.id,
    };

    const created = await jobService.create(enriched, { user_id: null });
    res.status(201);
    modernOk(res, created, 'job created');
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
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
    const [[row]] = await pool.query(
      `SELECT id, contact_name, contact_email, contact_no,
              contact_alt_no, contact_desgn, linkedIn_profile,
              manager_id, email_cc, payment_mode, approval_by_client
         FROM tbl_client_contacts
        WHERE id = ?`,
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

router.post('/profile/change-phone/send-otp', async (req, res, next) => {
  try {
    const newPhone = String(req.body?.new_phone || '').trim();
    if (!looksLikePhone(newPhone)) {
      return modernError(res, 400, 'new_phone must be a 10-digit number');
    }
    // No-op guard — if the SPOC submits their own current number we
    // skip the whole OTP dance instead of looping them through a
    // pointless verify step.
    if (newPhone === String(req.spoc.contact_no || '').trim()) {
      return modernError(res, 400, 'This is already your current number');
    }
    if (await isPhoneInUse(newPhone, req.spoc.id)) {
      return modernError(res, 409, 'This number is already registered with another account');
    }
    const r = await issueChangeOtp({
      otpType: 'Change Phone',
      target: newPhone,
      kind: 'phone',
    });
    modernOk(res, { delivered: r.delivered, expiresAt: r.expiresAt });
  } catch (e) { next(e); }
});

router.post('/profile/change-phone/verify-otp', async (req, res, next) => {
  try {
    const newPhone = String(req.body?.new_phone || '').trim();
    const otp = Number(req.body?.otp);
    if (!looksLikePhone(newPhone)) {
      return modernError(res, 400, 'new_phone must be a 10-digit number');
    }
    if (!Number.isInteger(otp) || otp < 1000 || otp > 9999) {
      return modernError(res, 400, 'otp must be a 4-digit number');
    }
    // Re-check uniqueness right before commit — another SPOC could
    // have claimed this number between send-otp and verify-otp.
    if (await isPhoneInUse(newPhone, req.spoc.id)) {
      return modernError(res, 409, 'This number is already registered with another account');
    }
    const r = await verifyChangeOtp({
      otpType: 'Change Phone',
      target: newPhone,
      otp,
      kind: 'phone',
      spocId: req.spoc.id,
    });
    if (!r.ok) return modernError(res, 401, r.reason);
    modernOk(res, { updated: true, contact_no: newPhone }, 'Number updated');
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
    const [rows] = await pool.query(
      `SELECT id, contact_name, contact_email, contact_no
         FROM tbl_client_contacts WHERE client_id = ? AND status = 1 ORDER BY contact_name`,
      [req.spoc.client_id]);
    modernOk(res, rows);
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
    const job = await jobService.getById(jobId);
    if (!job || job.fk_client_id !== req.spoc.client_id) return modernError(res, 404, 'job not found');

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
