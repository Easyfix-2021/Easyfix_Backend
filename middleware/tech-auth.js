const jwt = require('jsonwebtoken');
const { findById } = require('../services/tech-auth.service');
const { jobShareGuestClaims } = require('../utils/jwt');
const { modernError } = require('../utils/response');
const { asyncMiddleware } = require('../utils/async-middleware');


async function requireTechAuth(req, res, next) {
  const token = req.cookies?.techToken ||
    (req.headers.authorization?.startsWith('Bearer ') && req.headers.authorization.slice(7));
  if (!token) return modernError(res, 401, 'authentication required');
  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); }
  catch (e) { return modernError(res, 401, e.name === 'TokenExpiredError' ? 'token expired' : 'invalid token'); }

  // Shared-job GUEST (services/job-share-guest.service.js): a contact working
  // ONE delegated job from the web link. Resolved to the SHARER's identity —
  // the job never changes hands, exactly as for a technician delegate — and
  // marked on req.shareGuest so requireShareGuestScope confines it to that job.
  // The share is re-read on every request: cancel, revoke or completion ends
  // the session on the guest's next tap.
  const guestClaims = jobShareGuestClaims(payload);
  if (guestClaims) {
    const shareGuest = require('../services/job-share-guest.service');
    const share = await shareGuest.resolveGuest(guestClaims);
    const owner = share && await findById(Number(share.fk_easyfixer_id));
    if (!share || !owner) {
      return res.status(401).json({
        success: false,
        error: 'This job is no longer shared with you.',
        code: 'share_ended',
        details: { code: 'share_ended' },
      });
    }
    req.tech = owner;
    req.shareGuest = {
      shareId: Number(share.share_id),
      jobId: Number(share.job_id),
      status: share.status,
      share,
      contactNumber: shareGuest.recipientNumber(share),
      contactName: share.contact_name || share.delegate_name || null,
    };
    return next();
  }

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

// Wrapped: the DB lookup above is awaited outside any try. Without this,
// a pool/DB fault here EXITS THE PROCESS rather than returning a 500.
// See utils/async-middleware.js (2026-09-08 incident).
module.exports = asyncMiddleware(requireTechAuth);
