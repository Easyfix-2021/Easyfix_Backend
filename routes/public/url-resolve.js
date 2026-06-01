/*
 * /api/public/book/:code — JSON resolver for the in-house URL shortener.
 *
 * Why this exists ALONGSIDE the root `GET /book/:code` redirect
 * (routes/public/url-shortener.js):
 *   The customer-facing short URL is hosted on the Next.js FRONTEND
 *   origin (e.g. https://qa.crm.easyfix.in/book/<code>), not the
 *   backend. The frontend has no idea what a short code maps to — that
 *   lives in tbl_url_shortener on the backend. So the frontend's
 *   `(public)/book/[code]` server component calls THIS endpoint to
 *   resolve the code, then issues its own redirect. This endpoint rides
 *   the existing `/api/*` → backend proxy (next.config.mjs rewrite), so
 *   no new host wiring or CORS is needed.
 *
 *   The root `GET /book/:code` redirect is kept for DIRECT backend-host
 *   access (e.g. if SHORT_URL_BASE is ever pointed at the backend
 *   origin), but customers traversing the frontend host hit THIS JSON
 *   resolver instead.
 *
 * Auth: none — same rationale as the rest of /api/public. The short
 * code is the unguessable secret (62^8 keyspace). The resolved long URL
 * is itself a signed-JWT magic link, so the destination still enforces
 * token auth.
 *
 * Response (modern envelope { success, data }):
 *   { found: boolean, expired: boolean, longUrl: string | null }
 *   - found=false        → code never existed (or failed the regex)
 *   - found=true,expired → link past its TTL; longUrl withheld (null)
 *   - found=true,!expired → longUrl present; click recorded fire-and-forget
 */

const router = require('express').Router();

const { pool } = require('../../db');
const urlShortener = require('../../services/url-shortener.service');
const { modernOk } = require('../../utils/response');

// Same strict allowlist the redirect route uses — short-circuits any
// funky path content to a clean "not found" rather than a DB lookup.
const CODE_REGEX = /^[A-Za-z0-9]{4,16}$/;

router.get('/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code || '');
    if (!CODE_REGEX.test(code)) {
      return modernOk(res, { found: false, expired: false, longUrl: null });
    }

    const resolved = await urlShortener.resolveCode(code, pool);
    if (!resolved) {
      return modernOk(res, { found: false, expired: false, longUrl: null });
    }

    // Only count a click when we're actually going to hand back a live
    // URL — an expired-link view is not a successful redirect.
    if (!resolved.expired) {
      urlShortener.recordClick(code, pool);
    }

    return modernOk(res, {
      found: true,
      expired: resolved.expired,
      longUrl: resolved.expired ? null : resolved.longUrl,
    });
  } catch (e) { next(e); }
});

module.exports = router;
