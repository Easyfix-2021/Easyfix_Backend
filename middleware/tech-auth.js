const jwt = require('jsonwebtoken');
const { findById } = require('../services/tech-auth.service');
const { modernError } = require('../utils/response');

async function requireTechAuth(req, res, next) {
  const token = req.cookies?.techToken ||
    (req.headers.authorization?.startsWith('Bearer ') && req.headers.authorization.slice(7));
  if (!token) return modernError(res, 401, 'authentication required');
  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); }
  catch (e) { return modernError(res, 401, e.name === 'TokenExpiredError' ? 'token expired' : 'invalid token'); }
  if (!String(payload.sub).startsWith('efr:')) return modernError(res, 403, 'not a technician token');
  // NOTE: findById no longer filters on efr_status — a DEACTIVATED technician
  // keeps a working token so they can reach /mobile/registration/status, see
  // that they're deactivated and contact support. Work stays blocked at the
  // assignment layer (candidate-ranking + job.service both require
  // efr_status = 1), so authenticating them grants no ability to take jobs.
  const tech = await findById(Number(String(payload.sub).slice(4)));
  if (!tech) return modernError(res, 401, 'technician not found');
  req.tech = tech;
  next();
}

// OpenAPI introspection tag — autogen attaches the technician Bearer
// scheme to any route guarded by this middleware.
requireTechAuth._openapi = { security: 'bearerTech' };

module.exports = requireTechAuth;
