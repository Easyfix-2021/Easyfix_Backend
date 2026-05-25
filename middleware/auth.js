/*
 * JWT authentication middleware.
 * Applied to /api/admin, /api/client, /api/mobile, /api/shared routes.
 * NEVER applied to /api/integration/* (those use HTTP Basic Auth).
 *
 * Populates req.user with a fresh row from tbl_user.
 */

const { verifyToken } = require('../utils/jwt');
const { findUserById } = require('../services/auth.service');
const { modernError } = require('../utils/response');

/*
 * Token sources, in priority order:
 *   1. `Authorization: Bearer <jwt>` header — the primary, JS-set credential.
 *   2. `?token=<jwt>` query string — secondary, ONLY used for endpoints
 *      that need to be addressable as a plain URL (notably the job-image
 *      file endpoint, which is consumed by `<img src>` / "open in new
 *      tab" actions where the browser attaches no Authorization header).
 *
 * Why we don't fall back to the `token` cookie:
 *   - Browsers auto-attach cookies to any request to the same origin (incl.
 *     a user typing the URL into the address bar) — direct visits would
 *     return authenticated data with no JS involvement.
 *   - Any third-party site could POST to our API with `credentials: include`;
 *     the cookie rides along and the server thinks the real user authored
 *     the request — classic CSRF.
 *
 * Query-string tokens are NOT susceptible to CSRF: a cross-origin attacker
 * doesn't know the victim's token, so they can't construct a URL carrying
 * it. The real downside of query-string tokens is leakage (access logs,
 * Referer headers, browser history). The frontend ONLY appends `?token=`
 * for the image-file URL, which is a read-only, scope-checked endpoint —
 * acceptable trade-off for the convenience of `<img src>` rendering and
 * "open in new tab" affordances.
 */
function extractToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  const q = req.query && typeof req.query.token === 'string' ? req.query.token : null;
  if (q) return q;
  return null;
}

async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return modernError(res, 401, 'authentication required');

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    const reason = err.name === 'TokenExpiredError' ? 'token expired' : 'invalid token';
    return modernError(res, 401, reason);
  }

  const user = await findUserById(payload.sub);
  if (!user) return modernError(res, 401, 'user not found or inactive');

  req.user = user;
  req.tokenPayload = payload;
  return next();
}

// OpenAPI introspection tag — autogen reads this to attach the right
// security scheme to every route the middleware guards. See docs/openapi-autogen.js.
requireAuth._openapi = { security: 'bearerAdmin' };

module.exports = requireAuth;
