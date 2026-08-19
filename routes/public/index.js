/*
 * /api/public/* — aggregator for token-authed customer-facing endpoints.
 *
 * Mount semantics:
 *   - NO global auth middleware is applied at this level. The router is
 *     deliberately exposed unauthenticated so the customer's magic-link
 *     page (no Bearer token, no SPOC login) can call it directly from
 *     the browser.
 *   - Each sub-router does its OWN per-endpoint token verification
 *     against the URL `:token` segment via utils/jwt.verifyJobToken().
 *     The token carries the jobId; routes pin all SQL to that jobId so
 *     a stolen token can only reach the one job it was minted for.
 *   - Per-token rate limiting is applied inside the sub-routers
 *     (keyed by the verified jobId) — not here — because the rate
 *     limiter needs to peek inside the JWT to derive its key.
 *
 * Because this mount lives ahead of `requireAuth`, ANY new sub-router
 * added here MUST self-verify its own auth. Do not add a "trusted"
 * sub-router that relies on a parent guard.
 */

const router = require('express').Router();

router.use('/job-completion', require('./job-completion'));
/*
 * Technician "share job" surface. UNAUTHENTICATED — a public link a technician
 * shares; whoever opens it sees NON-CONFIDENTIAL job details and can navigate /
 * place a masked call to the customer. Self-verifies its own `job_share` token
 * (separate type from job-completion). See routes/public/shared-job.js.
 */
router.use('/shared-job', require('./shared-job'));
// Easyfixer-facing profile-update magic-link surface. Token lives in the
// query string (?token=…) rather than the URL path because the FE keeps the
// path stable (/profile-update/<jwt>) and proxies the JWT through to the BE
// as a query param — keeps URL shapes consistent with the customer
// job-completion flow's prefill+save POSTs.
router.use('/easyfixer-profile-update', require('./easyfixer-profile-update'));
router.use('/maps', require('./maps'));
// JSON resolver for the URL shortener. Reached at /api/public/book/:code
// via the frontend's /api/* proxy — the customer-facing /book/<code>
// short link lives on the Next.js origin and resolves through here.
router.use('/book', require('./url-resolve'));
/*
 * Public deep-skill image resolver (2026-06-11). UNAUTHENTICATED — exposes
 * presigned URLs to deep-skill thumbnails so legacy Java CRM / Client
 * Dashboard / Mobile app (none of which carry modern EasyFix JWTs) can
 * render the same skill images the new CRM does. Non-sensitive data;
 * see routes/public/deep-skills.js for the security rationale.
 */
router.use('/deep-skills', require('./deep-skills'));
/*
 * Technician email-verification landing (2026-06-16). UNAUTHENTICATED — this
 * is the link the technician's mail client opens directly in a browser. The
 * :token path segment is the sole authority (single-use, 24h TTL); it consumes
 * the token and flips is_email_verified on that technician's own row, then
 * renders a self-contained HTML confirmation page (not the JSON envelope).
 * See routes/public/email-verify.js for the security rationale.
 */
router.use('/email-verify', require('./email-verify'));
/*
 * Plivo answer_url callback (2026-06-17). UNAUTHENTICATED — Plivo GETs this the
 * moment the agent leg answers, and we return call-control XML bridging to the
 * customer. Authorisation is the signed `t` JWT (carries the destination +
 * tbl_job_caller_info id), not a Bearer/Basic credential. Full path becomes
 * /api/public/plivo/answer. See routes/public/plivo-answer.js.
 */
router.use('/plivo', require('./plivo-answer'));
/*
 * Technician-app force-update policy (2026-07-15). The ONLY sub-router here that
 * verifies no token — by necessity: it gates the app's LOGIN screen, so an
 * outdated client has no session to present. Safe because it returns version
 * policy only (no user data / PII / job scope). Fails OPEN — see the route.
 * Full path: /api/public/app-version?platform=android
 */
router.use('/app-version', require('./app-version'));
/*
 * Pre-login technician pincode resolver. UNAUTHENTICATED by necessity: R.03
 * resolves Home Pincode before OTP verification. Safe because it returns only
 * city/state catalogue labels, never writes/geocodes, and self-rate-limits.
 */
router.use('/pincodes', require('./pincodes'));
/*
 * Marketing-site QR booking (2026-08-07). UNAUTHENTICATED BY DESIGN and the
 * only sub-router here that both WRITES and verifies no token — a customer
 * scanning a QR on product packaging has no prior identity to mint one
 * against, and the `?code=` on the link is a CLIENT reference printed on
 * retail packaging, never a credential. Self-limits instead: per-IP rate
 * limits (generous on the /context and /serviceability reads, strict on the
 * write, which also caps both the Google Geocoding spend an unknown pincode
 * can trigger and the customer photos one IP can push into S3) plus a honeypot
 * field that returns a success-shaped 200 and creates nothing. Least
 * privilege: it can ONLY ever produce status-9 (Unconfirmed) jobs — no
 * updates, no status transitions, no way to address an existing job; the two
 * GETs are advisory catalogue reads exposing no job/customer/client id — so a
 * status-9 row stays inert until a human confirms it in the CRM. NEVER fails
 * on client resolution (2026-08-07): an absent/unknown `code` falls back to
 * client 1 (RETAIL) and ops re-maps from the CRM — there is no env override,
 * the rule is just "client 1 unless the reference code matches". See
 * routes/public/website-booking.js.
 */
router.use('/website-booking', require('./website-booking'));
/*
 * Festival theme for the login page (2026-08-18). Token-less by necessity —
 * it is read while the LOGIN screen paints, before any session exists. Safe
 * because it returns only chrome: a name, a date window and overlay geometry,
 * plus an ornament URL presigned ONLY for keys under the `Branding/` prefix.
 * No user, job, client or PII. Full path: /api/public/branding/active
 */
router.use('/branding', require('./branding'));

module.exports = router;
