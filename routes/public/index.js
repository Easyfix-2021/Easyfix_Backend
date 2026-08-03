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
// Customer feedback page — public, jobId-scoped via the URL param.
// See routes/public/feedback.js for the threat model + future
// magic-link hardening notes.
router.use('/feedback', require('./feedback'));
// Customer/SPOC estimate-approval page — JWT-scoped via the URL token.
// Token-only credential (same JWT_SECRET); see routes/public/estimate.js
// for the threat model and idempotency guards.
router.use('/estimate', require('./estimate'));
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

module.exports = router;
