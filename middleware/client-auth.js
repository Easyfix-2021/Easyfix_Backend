const jwt = require('jsonwebtoken');
const { findSpocById } = require('../services/client-auth.service');
const { modernError } = require('../utils/response');

async function requireSpocAuth(req, res, next) {
  // Accept both the new cookie name (`client_auth_token`, aligned with the
  // frontend localStorage key) and the legacy `spocToken` name during a
  // rolling deploy. Either source is acceptable.
  const token = req.cookies?.client_auth_token
    || req.cookies?.spocToken
    || (req.headers.authorization?.startsWith('Bearer ') && req.headers.authorization.slice(7));
  if (!token) return modernError(res, 401, 'authentication required');

  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); }
  catch (e) { return modernError(res, 401, e.name === 'TokenExpiredError' ? 'token expired' : 'invalid token'); }

  if (!String(payload.sub).startsWith('spoc:')) {
    return modernError(res, 403, 'not a client SPOC token');
  }
  const spocId = Number(String(payload.sub).slice(5));
  const spoc = await findSpocById(spocId);
  if (!spoc) return modernError(res, 401, 'SPOC not found or inactive');
  // Client-level gate: an active SPOC whose CLIENT has been deactivated is
  // blocked too (distinct 403 so the app can show "client inactive").
  if (Number(spoc.client_status) !== 1) {
    return modernError(res, 403, 'This client account is inactive. Please contact your EasyFix SPOC.');
  }

  req.spoc = spoc;
  // Client (user_type_id = 3) identity carried in the token claims, for
  // role-based authorization on routes. Older tokens (pre-enrichment) lack
  // these claims — they resolve to null, so this is non-breaking.
  req.clientUser = {
    userId: payload.userId ?? null,
    userRole: payload.userRole ?? null,
    userType: payload.userType ?? null,
  };
  next();
}

// OpenAPI introspection tag — autogen attaches the client SPOC Bearer
// scheme to any route guarded by this middleware.
requireSpocAuth._openapi = { security: 'bearerClient' };

module.exports = requireSpocAuth;
