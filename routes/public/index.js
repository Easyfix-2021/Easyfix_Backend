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
router.use('/maps', require('./maps'));
// JSON resolver for the URL shortener. Reached at /api/public/book/:code
// via the frontend's /api/* proxy — the customer-facing /book/<code>
// short link lives on the Next.js origin and resolves through here.
router.use('/book', require('./url-resolve'));

module.exports = router;
