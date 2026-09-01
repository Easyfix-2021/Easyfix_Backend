/*
 * HRMS "My Profile" — profile photo. SELF-SERVICE ONLY.
 *
 * ── THE SECURITY BOUNDARY ───────────────────────────────────────────────
 * Every function here takes `userId` and that value comes from
 * `req.user.user_id` in routes/profile-photo.js and NOWHERE ELSE. There is no
 * :userId in any path, no id accepted in any body, and no id read from the
 * query string — the same rule routes/profile.js states at length, for the same
 * reason: this surface is reachable by EVERY authenticated CRM user, not just
 * the admin group, so one id parameter would turn "replace my photo" into
 * "replace anyone's photo".
 *
 * ── STORAGE: S3, VIA THE EXISTING HELPER ────────────────────────────────
 * Nothing new is stood up here. utils/s3-storage.js already owns the client,
 * the presigner and the bucket config for job images, notice images, deep-skill
 * images, client documents and call recordings; this feature is another caller
 * of `putAtKey` / `getPresignedUrl` / `deleteObject`, which exist for exactly
 * this. The only thing this module adds is the key SHAPE, which is
 * feature-specific:
 *
 *     ProfilePhotos/u<userId>_<epochMs>_<rand8>
 *
 * ⚠ NO FILE EXTENSION ON THE KEY. That is the repo-wide convention (see the
 * header of utils/s3-storage.js, ops 2026-05-15): the real MIME type rides on
 * the object's Content-Type at PutObject time and the original filename is
 * stashed in object metadata. Appending '.jpg' to a stored key 404s.
 *
 * ── THE KEY IS RANDOM PER UPLOAD, NOT STABLE PER USER ───────────────────
 * A stable `ProfilePhotos/u42` key would let a replace overwrite in place and
 * need no delete at all — but then every already-minted presigned URL, and
 * every browser cache entry, keeps serving the OLD image for its whole TTL, and
 * there is no moment at which the previous bytes are actually gone. A fresh key
 * per upload makes the replace atomic from the reader's side and makes deleting
 * the previous object an explicit, testable step.
 *
 * ── WHY THE MIME COMES FROM THE BYTES ───────────────────────────────────
 * `req.file.mimetype` is copied verbatim from the multipart part's own
 * Content-Type header, i.e. it is a claim made by the uploader. On a route
 * every authenticated user can reach, that claim is an assertion by a potential
 * attacker, not a fact — an HTML or SVG payload announced as `image/png` would
 * be stored, served back under `Content-Type: image/png`, and the declared type
 * would be the only thing that ever said it was an image. `sniffImageMime`
 * reads the file's own magic bytes instead and the sniffed value is what gets
 * written to S3, so the stored Content-Type can never disagree with the bytes.
 * The neighbouring routes (notices, /shared/upload) validate the DECLARED
 * mimetype; that is weaker, and is not copied here.
 */

const crypto = require('node:crypto');

const { pool } = require('../db');
const logger = require('../logger');
const s3 = require('../utils/s3-storage');

// `{ status, code, message }` — the shape routes/profile.js's fail() and this
// feature's route handler both branch on. Deliberately NOT imported from
// profile-self.service.js: that module is under concurrent edit, and a two-line
// helper is not worth coupling this file's require graph to it.
function mkErr(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/*
 * The hard size cap, in bytes. Exported because it is enforced in ONE place —
 * multer's `limits.fileSize` in routes/profile-photo.js, which aborts the
 * stream mid-flight — and merely QUOTED in the error message. A second check
 * after buffering would be the thing the cap exists to avoid: by the time you
 * can measure `buffer.length`, the process has already allocated it.
 *
 * 5 MB rather than the 10 MB the bulk-upload routes use: this is an avatar, and
 * every authenticated user in the CRM can post to it.
 */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/* The only three types this feature stores. GIF is deliberately absent — an
 * animated avatar is not a requirement, and every extra type is another decoder
 * pointed at attacker-supplied bytes downstream. */
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

/*
 * Identify an image by its MAGIC BYTES. Returns the canonical MIME string, or
 * null for anything that is not one of the three allowed types.
 *
 * Hand-rolled rather than pulling in `file-type`: three signatures is a dozen
 * lines, the repo has no such dependency today, and a narrow allowlist is
 * exactly what is wanted — a general sniffer would happily identify the
 * hundred formats this endpoint must still reject.
 *
 *   JPEG  FF D8 FF                        (SOI + the first marker)
 *   PNG   89 50 4E 47 0D 0A 1A 0A         (the full 8-byte signature)
 *   WEBP  'RIFF' ....  'WEBP'             (RIFF container, form type at +8)
 *
 * The PNG signature is checked in FULL. Its trailing CR/LF/EOF bytes are the
 * part that detects a file mangled by a text-mode transfer, so truncating the
 * check to `89 50 4E 47` would accept a corrupt PNG as a valid one.
 */
function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';

  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    return 'image/png';
  }

  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF'
      && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }

  return null;
}

/* `ProfilePhotos/u<userId>_<epochMs>_<rand8>` — same timestamp+random shape as
 * buildNoticeKey / buildClientDocKey in utils/s3-storage.js. The user id is in
 * the key so an orphaned object can be traced back to a person during a bucket
 * audit; it is never parsed back out, and nothing authorises on it. */
function buildPhotoKey(userId) {
  return `ProfilePhotos/u${Number(userId)}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/* The caller's current key, or null. One statement, on the primary key. */
async function readKey(userId, runner) {
  const [[row]] = await runner.query(
    'SELECT profile_image_key FROM tbl_user_personal_details WHERE user_id = ? LIMIT 1',
    [Number(userId)],
  );
  return (row && row.profile_image_key) || null;
}

/*
 * POST /api/profile/photo — set or replace the caller's own photo.
 *
 * ── ORDER OF OPERATIONS, AND WHY IT IS THIS ORDER ───────────────────────
 *   1. sniff the bytes            reject before anything is stored
 *   2. read the CURRENT key       remembered before it is overwritten
 *   3. PUT the new object
 *   4. UPDATE the column
 *   5. DELETE the old object      best-effort, and only now
 *
 * Step 5 comes LAST on purpose. Delete-then-upload loses the user's photo
 * outright if the upload fails, and delete-then-update leaves the column
 * pointing at bytes that are already gone — a 404 on every render. Deleting
 * only after the column no longer references the old key means the worst case
 * is a leaked object, never a broken profile.
 *
 * Conversely, skipping step 5 is not an option: without it every re-upload
 * strands the previous object in the bucket forever, and a user who re-crops
 * their avatar a dozen times pays for a dozen images.
 *
 * A failure in step 4 (after a successful step 3) orphans the NEW object. That
 * is left alone deliberately — it needs a DB error to happen at all, and the
 * cleanup branch would itself be untested code on a path nothing exercises.
 */
async function setPhoto(userId, file, runner = pool) {
  const buffer = file && file.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw mkErr(400, 'NO_FILE', 'Attach an image in the "photo" field');
  }

  // The bytes decide, not the uploader. See the header note.
  const mime = sniffImageMime(buffer);
  if (!mime) {
    logger.warn('Profile photo rejected · content is not JPEG/PNG/WEBP · userId=' + Number(userId));
    throw mkErr(400, 'UNSUPPORTED_IMAGE',
      'That file is not a JPEG, PNG or WEBP image. Upload a photo in one of those formats.');
  }

  if (!s3.isEnabled()) {
    throw mkErr(503, 'STORAGE_UNAVAILABLE', 'Photo storage is not configured on this environment');
  }

  const previousKey = await readKey(userId, runner);
  const key = buildPhotoKey(userId);

  await s3.putAtKey({
    key,
    buffer,
    // The SNIFFED type, never req.file.mimetype — the object's Content-Type is
    // what every reader trusts, so it must describe the bytes actually stored.
    contentType: mime,
    originalName: file.originalname,
  });

  const now = new Date();
  await runner.query(
    `INSERT INTO tbl_user_personal_details (user_id, profile_image_key, created_on, updated_on)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE profile_image_key = VALUES(profile_image_key),
                             updated_on        = VALUES(updated_on)`,
    [Number(userId), key, now, now],
  );

  if (previousKey && previousKey !== key) {
    // Best-effort: deleteObject already swallows missing-object and permission
    // errors and reports them in its return value. The column is correct either
    // way, so a failure here is a storage-cleanup problem, not a request error.
    const outcome = await s3.deleteObject(previousKey);
    if (!outcome.deleted) {
      logger.warn('Previous profile photo not removed · key=' + previousKey
        + ' reason=' + (outcome.reason || 'unknown'));
    }
  }

  logger.info('Profile photo set · userId=' + Number(userId) + ' mime=' + mime
    + ' bytes=' + buffer.length + ' replaced=' + (previousKey ? 'yes' : 'no'));

  const url = await s3.getPresignedUrl(key);
  return { key, url, content_type: mime };
}

/*
 * GET /api/profile/photo — the caller's own photo.
 *
 * Returns a SHORT-TTL PRESIGNED URL, not the image bytes. That is the pattern
 * every other S3-backed image in this codebase uses (notice images, deep-skill
 * thumbnails, job supportings, client documents), and it is the one that works
 * with a plain `<img src>`: a bytes-through-the-API route would be behind the
 * Bearer token, which an `<img>` tag cannot send, forcing the frontend into a
 * fetch-blob-objectURL dance for no gain.
 *
 * NO PHOTO IS A 404, not an empty 200 and not a 500. The route surfaces the
 * code so the frontend can render its initials placeholder without treating a
 * normal state as an error.
 */
async function getPhoto(userId, runner = pool) {
  const key = await readKey(userId, runner);
  if (!key) throw mkErr(404, 'NO_PROFILE_PHOTO', 'You have no profile photo on file');
  if (!s3.isEnabled()) {
    throw mkErr(503, 'STORAGE_UNAVAILABLE', 'Photo storage is not configured on this environment');
  }
  return { key, url: await s3.getPresignedUrl(key) };
}

/*
 * DELETE /api/profile/photo — remove the caller's own photo.
 *
 * The COLUMN is cleared first, then the object. Same reasoning as the replace
 * path in reverse: once the column is NULL nothing can render a dangling key,
 * and a failed S3 delete leaves an orphan rather than a profile pointing at
 * bytes that no longer exist.
 *
 * The column is set to NULL, never to ''. NULL is the single representation of
 * "no photo" this feature has (see the migration note), so no reader ever has
 * to treat the two alike.
 */
async function removePhoto(userId, runner = pool) {
  const key = await readKey(userId, runner);
  if (!key) throw mkErr(404, 'NO_PROFILE_PHOTO', 'You have no profile photo on file');

  await runner.query(
    `UPDATE tbl_user_personal_details
        SET profile_image_key = NULL, updated_on = ?
      WHERE user_id = ?`,
    [new Date(), Number(userId)],
  );

  const outcome = await s3.deleteObject(key);
  if (!outcome.deleted) {
    logger.warn('Profile photo object not removed · key=' + key
      + ' reason=' + (outcome.reason || 'unknown'));
  }

  logger.info('Profile photo removed · userId=' + Number(userId));
  return { removed: true };
}

module.exports = {
  setPhoto,
  getPhoto,
  removePhoto,
  MAX_PHOTO_BYTES,
  ALLOWED_MIME,
  // Exported for the route's multer config and for the magic-byte tests.
  sniffImageMime,
};
