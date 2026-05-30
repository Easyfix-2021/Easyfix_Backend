/*
 * /api/public/job-completion/* — customer-facing magic-link completion flow.
 *
 * Security model:
 *   (a) NO admin auth at this mount. The parent router (routes/public/index.js)
 *       sits ahead of any global requireAuth, and we deliberately keep it that
 *       way so the customer can complete an unconfirmed order from a plain
 *       browser tab with only the magic link in hand.
 *   (b) Token-only contract. Every endpoint extracts `:token` from the URL and
 *       runs verifyJobToken() to extract the jobId. The jobId is then pinned
 *       to all subsequent SQL — there is no body/query/param path that lets a
 *       caller address a different job than the one the token was minted for.
 *   (c) State-bound expiry. After JWT verification, requireUnconfirmedJob()
 *       checks the live `tbl_job.job_status` against status 9 (Unconfirmed /
 *       Call-Later). The moment ops confirms the order in CRM the link stops
 *       working — independent of the JWT's time-bound exp. Returns 410 GONE
 *       so the FE can render a friendly "link no longer active" page.
 *   (d) Per-token rate limit. 30 requests per 10 minutes keyed on the verified
 *       jobId (with IP fallback for unverifiable tokens). A cheap pre-pass
 *       middleware peeks the JWT *without* the DB state check so the limiter
 *       can derive a per-token key — every route still re-verifies the token
 *       fully via the verify() closure below, so a forged token does not get
 *       past the per-endpoint auth checks just because it slipped past the
 *       limiter.
 *
 * All responses use the modern `{success, data, error}` shape via utils/response.
 */

const router = require('express').Router();
const Joi = require('joi');
const multer = require('multer');

const { pool } = require('../../db');
const { verifyJobToken, requireUnconfirmedJob } = require('../../utils/jwt');
const magicLinkService = require('../../services/job-magic-link.service');
const { submitBody, imageIdParam } = require('../../validators/job-magic-link.validator');
const { modernOk, modernError } = require('../../utils/response');
const s3Storage = require('../../utils/s3-storage');
const validate = require('../../middleware/validate');
const { rateLimit } = require('../../middleware/rate-limit');
const logger = require('../../logger');

// Peek-the-token middleware. Runs verifyJobToken() only (NOT the DB state
// check) so the rate limiter can key its bucket on the verified jobId. If the
// token is malformed/expired, we DO NOT 401 here — we just leave
// req.verifiedJobId = null and let the per-endpoint verify() emit the proper
// 401 with a consistent message. This middleware exists purely for limiter
// key derivation; it is NOT an auth boundary.
function peekToken(req, _res, next) {
  try {
    const { jobId } = verifyJobToken(req.params.token);
    req.verifiedJobId = jobId;
  } catch (_e) {
    req.verifiedJobId = null;
  }
  return next();
}

// Per-token rate limit: 30 req / 10 min, keyed on jobId where possible
// (falls back to IP for unverifiable tokens to prevent the bucket from
// becoming a single shared "anon" pool that any attacker can DoS through).
const tokenRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  key: (req) => (req.verifiedJobId ? `job:${req.verifiedJobId}` : `ip:${req.ip}`),
});

// Full per-endpoint verify. ALL public routes call this immediately on entry —
// it runs both the cryptographic check (verifyJobToken) and the live state
// check (requireUnconfirmedJob). Throws plain `{status, code?, message}` shapes
// (NOT Error instances) which the route catch maps to modernError().
async function verify(req) {
  const { jobId } = verifyJobToken(req.params.token);
  await requireUnconfirmedJob(jobId, pool);
  return jobId;
}

// Centralised error mapper for the thrown plain-object shape used by
// verifyJobToken / requireUnconfirmedJob and the local logic below. Anything
// without a `status` is treated as an unexpected server error and forwarded
// to the global error handler via `next(e)`.
function mapKnownError(res, next, e) {
  if (e && typeof e.status === 'number') {
    return modernError(res, e.status, e.message || 'request failed');
  }
  return next(e);
}

// MIME allowlist for customer-uploaded images. Anything outside this
// set is rejected at multer's fileFilter (before reading the file body)
// AND re-validated on req.file.mimetype inside the handler (defence in
// depth — the filter trusts the browser-claimed mimetype which is
// trivially spoofable; magic-number sniffing is a v2 follow-up).
//
// Why the strict set: this image ends up rendered in CRM via an <img>
// tag for ops review. Letting through .svg → embedded <script>, .html
// pretending to be image/*, or arbitrary blobs is a stored-XSS vector
// from a public-facing surface.
const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIMES.has(file.mimetype)) return cb(null, true);
    // Reject with a multer-shaped error so the route handler's existing
    // catch can map it to a 400 with a stable message.
    const err = new Error('Only JPEG, PNG, WebP, or GIF images are allowed');
    err.code = 'INVALID_IMAGE_MIME';
    return cb(err, false);
  },
});

// All routes are mounted under /api/public/job-completion (the parent
// aggregator adds the /job-completion prefix). Path segments below are
// expressed relative to that base.

// ─── GET /:token — prefill payload for the magic-link form ──────────
router.get(
  '/:token',
  peekToken,
  tokenRateLimit,
  async (req, res, next) => {
    try {
      const jobId = await verify(req);
      const payload = await magicLinkService.fetchPrefill(jobId, pool);
      return modernOk(res, payload);
    } catch (e) {
      return mapKnownError(res, next, e);
    }
  },
);

// ─── POST /:token/submit — accept the completed form ────────────────
router.post(
  '/:token/submit',
  peekToken,
  tokenRateLimit,
  validate(submitBody, 'body'),
  async (req, res, next) => {
    try {
      const jobId = await verify(req);
      const result = await magicLinkService.acceptSubmission(jobId, req.body, pool);
      return modernOk(res, result);
    } catch (e) {
      return mapKnownError(res, next, e);
    }
  },
);

// ─── POST /:token/images — multipart upload, max 5 images per job ───
router.post(
  '/:token/images',
  peekToken,
  tokenRateLimit,
  upload.single('file'),
  async (req, res, next) => {
    try {
      const jobId = await verify(req);

      if (!req.file) {
        return modernError(res, 400, 'missing file upload');
      }

      // Defence-in-depth re-check after multer's fileFilter — the
      // filter trusts the browser-claimed mimetype, and while we can't
      // beat a spoofed mimetype without magic-number sniffing (v2),
      // we at least catch the case where the filter was bypassed by
      // future refactor or an `application/octet-stream`-style upload
      // that an attacker tries to slip through.
      if (!ALLOWED_IMAGE_MIMES.has(req.file.mimetype)) {
        return modernError(res, 400, 'Only JPEG, PNG, WebP, or GIF images are allowed');
      }

      // Hard cap at 5 customer-supplied images per job. Two concurrent
      // uploads at exactly capacity-minus-one can both pass this check
      // and produce 6 rows — we accept that micro-race because (a) the
      // customer-facing form sequences uploads one at a time, and (b)
      // the S3 key seq is a human-readable hint, not a uniqueness key.
      const [[{ existing }]] = await pool.query(
        'SELECT COUNT(*) AS existing FROM tbl_job_image WHERE job_id = ?',
        [jobId],
      );
      if (Number(existing) >= 5) {
        return modernError(res, 400, 'maximum 5 images per job');
      }
      const seq = Number(existing) + 1;

      let imageValue;
      try {
        imageValue = await s3Storage.putJobImage({
          jobId,
          seq,
          buffer: req.file.buffer,
          contentType: req.file.mimetype,
          originalName: req.file.originalname,
          category: 'Booking',
        });
      } catch (e) {
        logger.warn({ err: e.message, jobId }, 'public S3 upload failed');
        return modernError(res, 502, 'image upload to storage failed');
      }

      const [ins] = await pool.query(
        `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, created_date)
         VALUES (?, ?, 'booking', 0, NOW())`,
        [jobId, imageValue],
      );

      return modernOk(res, {
        image_id: ins.insertId,
        image: imageValue,
        seq,
      });
    } catch (e) {
      if (e?.code === 'LIMIT_FILE_SIZE') {
        return modernError(res, 400, 'file exceeds 5MB');
      }
      if (e?.code === 'INVALID_IMAGE_MIME') {
        return modernError(res, 400, 'Only JPEG, PNG, WebP, or GIF images are allowed');
      }
      return mapKnownError(res, next, e);
    }
  },
);

// ─── DELETE /:token/images/:imageId — remove a customer-uploaded image
router.delete(
  '/:token/images/:imageId',
  peekToken,
  tokenRateLimit,
  validate(imageIdParam, 'params'),
  async (req, res, next) => {
    try {
      const jobId = await verify(req);
      const imageId = Number(req.params.imageId);

      const [[row]] = await pool.query(
        'SELECT image_id, job_id, image FROM tbl_job_image WHERE image_id = ? LIMIT 1',
        [imageId],
      );
      // Pin to this token's jobId — a leaked token must not be usable to
      // delete images on a job it wasn't minted for. Same 404 on absent and
      // wrong-job so the public surface doesn't disclose which images exist
      // outside the token's scope.
      if (!row || Number(row.job_id) !== jobId) {
        return modernError(res, 404, 'image not found');
      }

      if (row.image) {
        try {
          await s3Storage.deleteObject(row.image);
        } catch (e) {
          // S3 delete failure is non-fatal — we still drop the DB row so
          // the customer's "remove" action takes effect from the UI's
          // perspective. The orphaned S3 object can be reaped by a later
          // sweeper; leaving the row would falsely retain the image.
          logger.warn(
            { err: e.message, imageId: row.image_id },
            'public S3 delete failed (continuing with DB delete)',
          );
        }
      }

      await pool.query('DELETE FROM tbl_job_image WHERE image_id = ?', [imageId]);

      return modernOk(res, { image_id: row.image_id, deleted: true });
    } catch (e) {
      return mapKnownError(res, next, e);
    }
  },
);

module.exports = router;
