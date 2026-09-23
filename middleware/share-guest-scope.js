const logger = require('../logger');

/*
 * ─── SHARED-JOB GUEST SCOPE ──────────────────────────────────────────
 *
 * A guest session (req.shareGuest, set by middleware/tech-auth.js) carries the
 * SHARER's identity, so every ownership check downstream would let it act as
 * him on EVERYTHING. This is the fence: mounted directly after requireTechAuth
 * on the one router that uses it (routes/mobile/index.js), it admits a guest
 * only to
 *   · /jobs/<its job> and /jobs/<its job>/…   (not /share…, not offer accept/reject)
 *   · POST /uploads and /uploads/document     (bytes first, then the job route)
 * and refuses the rest — dashboard, attendance, wallet, profile, other jobs —
 * with 403 share_guest_scope. An ALLOWLIST, so a route added next month is
 * closed to guests until someone opens it here.
 *
 * Its own module (not require-tech-lifecycle-capability.js) because several
 * route tests stub that module wholesale; a fence living there would vanish
 * from them. The path shapes match that module's JOB_ID_PATH / SHARE_PATH /
 * OFFER_*_PATH — tests/job-share-guest.test.js pins both to the same cases.
 */
const JOB_ID_PATH = /^\/jobs\/(\d+)(?:\/|$)/;
const SHARE_PATH = /^\/jobs\/\d+\/share(?:\/|$)/;
const OFFER_PATH = /^\/jobs\/[^/]+\/(?:accept|reject)\/?$/;
const UPLOAD_PATH = /^\/uploads(?:\/document)?\/?$/;

function guestPathAllowed(path, method, jobId) {
  if (UPLOAD_PATH.test(path)) return String(method || '').toUpperCase() === 'POST';
  const match = JOB_ID_PATH.exec(path);
  if (!match || Number(match[1]) !== Number(jobId)) return false;
  return !SHARE_PATH.test(path) && !OFFER_PATH.test(path);
}

function requireShareGuestScope(req, res, next) {
  if (!req.shareGuest) return next();
  const path = req.path || req.originalUrl || '';
  if (guestPathAllowed(path, req.method, req.shareGuest.jobId)) return next();
  logger.info(`Share guest refused · shareId=${req.shareGuest.shareId} · ${req.method} ${path}`);
  return res.status(403).json({
    success: false,
    error: 'This link only opens the job that was shared with you.',
    code: 'share_guest_scope',
    details: { code: 'share_guest_scope' },
  });
}

module.exports = { requireShareGuestScope, guestPathAllowed };
