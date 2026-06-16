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

module.exports = router;
