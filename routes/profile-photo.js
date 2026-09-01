const router = require('express').Router();
const multer = require('multer');

const requireAuth = require('../middleware/auth');
const { modernOk, modernError } = require('../utils/response');
const logger = require('../logger');
const { pool } = require('../db');
const photos = require('../services/profile-photo.service');

/*
 * /api/profile/photo — the CRM user's own profile photo.
 *
 * ── WHY THIS IS A SEPARATE FILE FROM routes/profile.js ──────────────────
 * It mounts on the SAME '/profile' path (routes/index.js mounts both routers
 * there; Express walks them in order and the paths do not overlap). It lives
 * apart purely so the multipart surface — multer, the magic-byte rejection, the
 * S3 key lifecycle — does not sit in the middle of the JSON self-service
 * router. If the two ever need to merge, the routes move verbatim; nothing here
 * depends on being its own file.
 *
 * ── THE SECURITY BOUNDARY, RESTATED BECAUSE IT IS RESTATED IN CODE ──────
 * Every handler acts on `req.profileUserId`, which is set below from
 * `req.user.user_id` and from nothing else. No :userId in any path, no id in
 * any body, no id in any query string. This surface is reachable by EVERY
 * authenticated CRM user — unlike /api/admin/*, which is role-gated — so a
 * single id parameter anywhere here would turn "replace my photo" into
 * "replace anyone's photo".
 *
 * The guard below is a deliberate duplicate of the one at the top of
 * routes/profile.js. Sharing it would mean exporting it from that file, which
 * is under concurrent edit; eight lines duplicated with this note is the
 * cheaper risk, and the note is the pointer for whoever consolidates them.
 */

router.use(requireAuth);

/*
 * CRM principals only. requireAuth also resolves TECHNICIAN bearers (subject
 * `efr:<id>`), whose `user_id` is the STRING 'efr:12' — they live in
 * tbl_easyfixer and have no tbl_user row at all. Left unguarded, Number() would
 * coerce that to NaN (and a bare `?` param to NULL), quietly reading or writing
 * a row that belongs to nobody. Technicians have their own profile surface
 * under /api/mobile.
 */
router.use((req, res, next) => {
  const id = Number(req.user && req.user.user_id);
  if (req.user?.__principal === 'mobile' || !Number.isInteger(id) || id <= 0) {
    return modernError(res, 403, 'this profile surface is for CRM users only');
  }
  // The ONLY id any handler below is allowed to use.
  req.profileUserId = id;
  return next();
});

/*
 * ── THE SIZE CAP LIVES HERE, AND ONLY HERE ──────────────────────────────
 * `limits.fileSize` makes Multer abort the stream the moment the cap is
 * crossed, so an oversized upload never finishes buffering. That is the whole
 * point of enforcing it at this layer: a `if (buffer.length > MAX)` check in
 * the handler can only run after the process has already allocated every byte,
 * which is precisely the resource the cap exists to protect on a route every
 * authenticated user can reach.
 *
 * `files: 1` and the single field name mean an extra or misnamed part is a
 * LIMIT_UNEXPECTED_FILE rejection rather than a silently ignored payload.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: photos.MAX_PHOTO_BYTES, files: 1 },
}).single('photo');

/*
 * Multer's rejections (oversize, too many parts, unexpected field) are bad
 * REQUESTS, so they answer 400 here rather than falling through to the 500
 * handler. Multer surfaces them by calling next(err) from inside its own
 * middleware, which a try/catch in the handler below can never see — hence the
 * wrapper. Same shape as aadhaarUploadOr400 in routes/mobile/kyc.js.
 */
function photoUploadOr400(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    logger.warn('Profile photo upload rejected · ' + (err.code || err.name || 'Error')
      + ' · ' + (err.message || 'no message'));
    return modernError(
      res,
      400,
      err.code === 'LIMIT_FILE_SIZE'
        ? `The photo must be ${photos.MAX_PHOTO_BYTES / (1024 * 1024)} MB or smaller`
        : err.message,
      err.code ? { code: err.code } : undefined,
    );
  });
}

/* Services throw { status, code, message }. Surface the status plus the machine
 * code the frontend branches on (NO_PROFILE_PHOTO drives the initials
 * placeholder); anything without a status is a real bug and goes to the central
 * handler as a 500. Mirrors fail() in routes/profile.js. */
function fail(res, next, e, what) {
  if (e && e.status) {
    logger.warn(what + ' failed · ' + e.message);
    return modernError(res, e.status, e.message, e.code ? { code: e.code } : undefined);
  }
  return next(e);
}

// ─── SET / REPLACE ───────────────────────────────────────────────────
// multipart/form-data, field name `photo`. The declared Content-Type of that
// part is NOT trusted — the service identifies the image from its magic bytes.
router.post('/photo', photoUploadOr400, async (req, res, next) => {
  try {
    const data = await photos.setPhoto(req.profileUserId, req.file, pool);
    modernOk(res, data, 'photo updated');
  } catch (e) { fail(res, next, e, 'Set profile photo'); }
});

// ─── READ ────────────────────────────────────────────────────────────
// Returns a short-TTL presigned URL, not bytes — see the service header.
// 404 with code NO_PROFILE_PHOTO when none is set; that is a normal state.
router.get('/photo', async (req, res, next) => {
  try {
    const data = await photos.getPhoto(req.profileUserId, pool);
    modernOk(res, data);
  } catch (e) { fail(res, next, e, 'Load profile photo'); }
});

// ─── REMOVE ──────────────────────────────────────────────────────────
router.delete('/photo', async (req, res, next) => {
  try {
    const data = await photos.removePhoto(req.profileUserId, pool);
    modernOk(res, data, 'photo removed');
  } catch (e) { fail(res, next, e, 'Remove profile photo'); }
});

module.exports = router;
