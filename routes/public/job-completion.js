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
const kaleyra = require('../../services/kaleyra.service');
const voice = require('../../services/voice.service');
const {
  submitBody,
  imageIdParam,
  cancelRequestBody,
  rescheduleRequestBody,
} = require('../../validators/job-magic-link.validator');
const { modernOk, modernError } = require('../../utils/response');
const s3Storage = require('../../utils/s3-storage');
const validate = require('../../middleware/validate');
const { rateLimit } = require('../../middleware/rate-limit');
const { getProperty } = require('../../services/properties.service');
const logger = require('../../logger');

// Global map-clickability toggle (easyfix_properties). Absent/'true' →
// clickable; 'false' → the customer's map is rendered non-interactive.
function mapClickableFlag() {
  const raw = getProperty('ui.map.clickable');
  if (raw == null || String(raw).trim() === '') return true;
  return String(raw).trim().toLowerCase() !== 'false';
}

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

// Dedicated stricter limiter for the bridge-call routes (spoc-call /
// support-call). Outbound voice calls are expensive + abusable, so they get
// their own tighter bucket (5 / 10 min) keyed the same way. Distinct bucket
// prefix ('call:') so call attempts don't share the general 30/10min budget.
const callRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  key: (req) => (req.verifiedJobId ? `call:${req.verifiedJobId}` : `call-ip:${req.ip}`),
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

// Generic, provider-agnostic message returned to the PUBLIC client whenever a
// bridge call fails for a real (non-suppressed) reason. The true diagnostic
// (Kaleyra status, provider error, mis-normalised number) is logged
// server-side only — never leaked to an unauthenticated magic-link client.
const CALL_FAILED_PUBLIC_MSG = 'Could not place the call. Please try again.';

// Per-job daily bridge-call cap. A leaked magic-link token is rate-limited per
// the callRateLimit bucket (5 / 10 min) but that resets; this is a harder
// ceiling on how many spoc+support bridge calls a single job can originate in
// a rolling 24h window — cheap defence against a leaked token being used to
// spam-dial. Counted from the tbl_job_caller_info rows Task 2 persists.
const MAX_BRIDGE_CALLS_PER_JOB_PER_DAY = 10;

// Returns true when the job is already at/over the daily bridge-call cap.
// Counts CUSTOMER-initiated rows only (caller_id IS NULL — the signal Task 2
// uses to mark a customer-originated bridge) inserted in the last 24h, so an
// operator's own CRM click-to-calls don't burn the customer's public budget.
// Best-effort: a count failure logs + returns false (fail-open) so a transient
// DB hiccup never blocks a legitimate customer call.
async function dailyBridgeCapReached(jobId) {
  try {
    const [[{ cnt }]] = await pool.query(
      `SELECT COUNT(*) AS cnt
         FROM tbl_job_caller_info
        WHERE job_id = ?
          AND caller_id IS NULL
          AND inserted_time >= (NOW() - INTERVAL 1 DAY)`,
      [jobId],
    );
    return Number(cnt) >= MAX_BRIDGE_CALLS_PER_JOB_PER_DAY;
  } catch (e) {
    logger.warn({ jobId, err: e && e.message }, 'magic-link: daily bridge-cap count failed — allowing call (fail-open)');
    return false;
  }
}

// Best-effort persist of a customer-initiated bridge call to
// tbl_job_caller_info — mirrors the admin click-to-call INSERT in
// routes/admin/calls.js (~line 333), preserving the legacy `reciever*` column
// typo. The CUSTOMER → SPOC/Support identity is encoded by caller_id = NULL
// (no staff user placed it) + inserted_by = NULL (customer-initiated). NEVER
// throws — a failed audit write must not fail the call response.
async function persistBridgeCall({
  jobId, callId, customerMob, customerName,
  receiverMob, receiverId, receiverName, jobStatus, jobEfrId, provider,
}) {
  try {
    await pool.query(
      `INSERT INTO tbl_job_caller_info
         (job_id, unique_id, caller, caller_id, caller_name,
          reciever, reciever_id, reciever_name,
          job_status, job_efr_id, call_type, inserted_by, is_updated, provider)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'OUT', NULL, 0, ?)`,
      [
        jobId,
        callId || null,
        kaleyra.normaliseIndianPhone(customerMob),
        customerName || 'Customer',
        kaleyra.normaliseIndianPhone(receiverMob),
        receiverId ?? null,
        receiverName,
        jobStatus ?? null,
        jobEfrId ?? null,
        provider || 'kaleyra',
      ],
    );
  } catch (e) {
    logger.warn({ jobId, err: e && e.message }, 'magic-link: tbl_job_caller_info persist failed (call already placed — non-fatal)');
  }
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
// Video MIMEs the customer can share through the Product Photos/Videos picker.
// Same denylist principles as images — strict allowlist, magic-number sniffing
// deferred to v2. mp4/quicktime/3gpp are the dominant Android/iOS WhatsApp /
// share-sheet outputs; webm rounds out Chrome on desktop.
const ALLOWED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/3gpp',
  'video/webm',
]);

// Photos are small enough to keep at 5MB. Videos need a higher ceiling — phone
// camera defaults can clear 15 MB easily — but capped to bound S3 cost; a
// 30-second 1080p phone clip lands well under 50 MB. Multer's `files` cap stays
// 1 so the endpoint stays one-file-per-request (FE sequences picks).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = Number(process.env.PUBLIC_VIDEO_MAX_BYTES || 50 * 1024 * 1024);
const MAX_PHOTOS_PER_JOB = 5;
const MAX_VIDEOS_PER_JOB = Number(process.env.PUBLIC_VIDEO_MAX_PER_JOB || 2);

const upload = multer({
  storage: multer.memoryStorage(),
  // Use the larger ceiling at the multer level; the handler enforces the
  // per-kind ceiling below so a "5MB image limit" is still respected for image
  // uploads even when multer would have accepted up to MAX_VIDEO_BYTES.
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIMES.has(file.mimetype) || ALLOWED_VIDEO_MIMES.has(file.mimetype)) return cb(null, true);
    const err = new Error('Only JPEG, PNG, WebP, GIF images or MP4/MOV/3GP/WebM videos are allowed');
    err.code = 'INVALID_MEDIA_MIME';
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
      // Late-open auto-reschedule (IST >= 3pm): shift a still-unconfirmed job's
      // appointment to next day BEFORE building the prefill, so the customer
      // sees the new date. Best-effort — must never block the form. Idempotent
      // by construction; writes scheduling_history (NOT a customer request, so
      // no "Reschedule Requested" chip). See autoRescheduleOnOpenIfLate().
      try {
        await magicLinkService.autoRescheduleOnOpenIfLate(jobId, pool);
      } catch (e) {
        logger.warn('auto-reschedule-on-open failed · jobId=' + jobId + ' · ' + (e && e.message));
      }
      logger.info('Fetch magic-link prefill · jobId=' + jobId);
      const payload = await magicLinkService.fetchPrefill(jobId, pool);
      // Global UI toggle so the customer page can render its map read-only.
      payload.mapClickable = mapClickableFlag();
      return modernOk(res, payload);
    } catch (e) {
      logger.warn('Magic-link prefill failed · ' + e.message);
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
      logger.info('Accept magic-link submission · jobId=' + jobId);
      const result = await magicLinkService.acceptSubmission(jobId, req.body, pool);
      logger.info('Magic-link submission accepted · jobId=' + jobId);
      return modernOk(res, result);
    } catch (e) {
      logger.warn('Magic-link submission failed · ' + e.message);
      return mapKnownError(res, next, e);
    }
  },
);

// ─── POST /:token/images — multipart upload (photos OR videos) ──────
// Path kept as `/images` for FE backward compatibility — the endpoint now
// accepts BOTH photos (→ tbl_job_image, cap 5) AND videos (→ tbl_job_media,
// cap MAX_VIDEOS_PER_JOB). Branches on the file's mimetype after multer
// validates membership in the combined allowlist. Response includes a `kind`
// discriminator so the FE renders the correct tile.
router.post(
  '/:token/images',
  peekToken,
  tokenRateLimit,
  upload.single('file'),
  async (req, res, next) => {
    try {
      const jobId = await verify(req);
      logger.info('Magic-link media upload · jobId=' + jobId + ' · mime=' + (req.file && req.file.mimetype));

      if (!req.file) {
        return modernError(res, 400, 'missing file upload');
      }

      const mime = req.file.mimetype;
      const isImage = ALLOWED_IMAGE_MIMES.has(mime);
      const isVideo = ALLOWED_VIDEO_MIMES.has(mime);
      // Defence-in-depth re-check after multer's fileFilter — magic-number
      // sniffing is still v2; this at least catches a bypass / refactor that
      // would have let an octet-stream slip through.
      if (!isImage && !isVideo) {
        return modernError(res, 400, 'Only JPEG, PNG, WebP, GIF images or MP4/MOV/3GP/WebM videos are allowed');
      }

      // Per-kind size ceiling. multer already caps total at MAX_VIDEO_BYTES;
      // images get a tighter limit here so a 25MB "image/jpeg" can't slip in.
      const sizeLimit = isImage ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
      if (req.file.size > sizeLimit) {
        const mb = Math.round(sizeLimit / (1024 * 1024));
        return modernError(res, 400, `${isImage ? 'image' : 'video'} exceeds ${mb}MB`);
      }

      if (isImage) {
        // Photo path — unchanged behaviour. Cap of MAX_PHOTOS_PER_JOB. Two
        // concurrent uploads at exactly capacity-minus-one can both pass this
        // check and produce a 6th row; accepted as a micro-race because the
        // FE sequences picks one at a time and the seq is human-readable.
        const [[{ existing }]] = await pool.query(
          'SELECT COUNT(*) AS existing FROM tbl_job_image WHERE job_id = ?',
          [jobId],
        );
        if (Number(existing) >= MAX_PHOTOS_PER_JOB) {
          return modernError(res, 400, `maximum ${MAX_PHOTOS_PER_JOB} images per job`);
        }
        const seq = Number(existing) + 1;

        let imageKey;
        try {
          imageKey = await s3Storage.putJobImage({
            jobId, seq,
            buffer: req.file.buffer,
            contentType: mime,
            originalName: req.file.originalname,
            category: 'Booking',
          });
        } catch (e) {
          logger.warn({ err: e.message, jobId }, 'public S3 image upload failed');
          return modernError(res, 502, 'image upload to storage failed');
        }

        const [ins] = await pool.query(
          `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, created_date)
           VALUES (?, ?, 'booking', 0, NOW())`,
          [jobId, imageKey],
        );
        logger.info('Job image uploaded · jobId=' + jobId + ' · image_id=' + ins.insertId + ' · seq=' + seq);
        // Short-TTL presigned GET so the FE renders the thumbnail / lightbox
        // immediately (best-effort — null just falls back to a placeholder).
        const imageUrl = await s3Storage.getPresignedUrl(imageKey).catch(() => null);
        return modernOk(res, { kind: 'image', image_id: ins.insertId, key: imageKey, url: imageUrl, seq });
      }

      // Video path — writes to tbl_job_media (separate table because
      // tbl_job_image is image-only by convention). The video file redirect
      // endpoint at /admin/jobs/videos/:mediaId/file serves these to the CRM.
      const [[{ vcount }]] = await pool.query(
        'SELECT COUNT(*) AS vcount FROM tbl_job_media WHERE job_id = ?',
        [jobId],
      );
      if (Number(vcount) >= MAX_VIDEOS_PER_JOB) {
        return modernError(res, 400, `maximum ${MAX_VIDEOS_PER_JOB} videos per job`);
      }
      const vseq = Number(vcount) + 1;

      let videoKey;
      try {
        videoKey = await s3Storage.putJobImage({
          jobId, seq: vseq,
          buffer: req.file.buffer,
          contentType: mime,
          originalName: req.file.originalname,
          category: 'BookingVideo',
        });
      } catch (e) {
        logger.warn({ err: e.message, jobId }, 'public S3 video upload failed');
        return modernError(res, 502, 'video upload to storage failed');
      }

      const [vins] = await pool.query(
        `INSERT INTO tbl_job_media (job_id, s3_key, content_type, source)
         VALUES (?, ?, ?, 'customer_public_form')`,
        [jobId, videoKey, mime],
      );
      logger.info('Job video uploaded · jobId=' + jobId + ' · media_id=' + vins.insertId + ' · seq=' + vseq);
      const videoUrl = await s3Storage.getPresignedUrl(videoKey).catch(() => null);
      return modernOk(res, { kind: 'video', media_id: vins.insertId, key: videoKey, url: videoUrl, seq: vseq });
    } catch (e) {
      if (e?.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(MAX_VIDEO_BYTES / (1024 * 1024));
        return modernError(res, 400, `file exceeds ${mb}MB`);
      }
      if (e?.code === 'INVALID_MEDIA_MIME') {
        return modernError(res, 400, 'Only JPEG, PNG, WebP, GIF images or MP4/MOV/3GP/WebM videos are allowed');
      }
      return mapKnownError(res, next, e);
    }
  },
);

// ─── DELETE /:token/videos/:mediaId — remove a customer-uploaded video ─
router.delete(
  '/:token/videos/:mediaId',
  peekToken,
  tokenRateLimit,
  async (req, res, next) => {
    try {
      const jobId = await verify(req);
      const mediaId = Number(req.params.mediaId);
      logger.info('Delete magic-link video · jobId=' + jobId + ' · mediaId=' + mediaId);
      if (!Number.isInteger(mediaId) || mediaId <= 0) {
        return modernError(res, 400, 'invalid mediaId');
      }

      const [[row]] = await pool.query(
        'SELECT media_id, job_id, s3_key FROM tbl_job_media WHERE media_id = ? LIMIT 1',
        [mediaId],
      );
      // Token-pinned, same 404 on absent or wrong-job to avoid disclosure.
      if (!row || Number(row.job_id) !== jobId) {
        return modernError(res, 404, 'video not found');
      }

      if (row.s3_key) {
        try { await s3Storage.deleteObject(row.s3_key); }
        catch (e) {
          logger.warn({ err: e.message, mediaId: row.media_id }, 'public S3 video delete failed (continuing with DB delete)');
        }
      }
      await pool.query('DELETE FROM tbl_job_media WHERE media_id = ?', [mediaId]);
      logger.info('Job video deleted · media_id=' + row.media_id);
      return modernOk(res, { media_id: row.media_id, deleted: true });
    } catch (e) {
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
      logger.info('Delete magic-link image · jobId=' + jobId + ' · imageId=' + imageId);

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

      logger.info('Job image deleted · image_id=' + row.image_id);
      return modernOk(res, { image_id: row.image_id, deleted: true });
    } catch (e) {
      return mapKnownError(res, next, e);
    }
  },
);

// Normalise a Joi-validated preferred_datetime into a MySQL DATETIME string
// ("YYYY-MM-DD HH:mm:ss"). Joi may hand us a Date (ISO branch) or a string
// (the "YYYY-MM-DD HH:mm" pattern branch). Returns null when absent/unparseable.
function toMysqlDatetime(val) {
  if (val == null || val === '') return null;
  const d = val instanceof Date ? val : new Date(String(val).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ─── POST /:token/cancel-request — log a customer cancel request ────
// LOGS A REQUEST for ops. Does NOT change job_status (ops actions it later
// in the CRM). Reason is validated against the live action_taken_reason list.
router.post(
  '/:token/cancel-request',
  peekToken,
  tokenRateLimit,
  validate(cancelRequestBody, 'body'),
  async (req, res, next) => {
    try {
      const jobId = await verify(req);
      // Membership check + id resolution — the Joi schema only guarantees a
      // non-empty string; the reasons are DB-driven (action_taken_reason
      // action_type=39). Resolve the matching row so we get BOTH validation
      // AND its id for tbl_job_comment.enum_reason_id.
      const cancelReasons = await magicLinkService.getCancelReasons(pool);
      const reasonRow = cancelReasons.find((r) => r.action_desc === req.body.reason);
      if (!reasonRow) {
        throw Object.assign(new Error('Please select a valid cancellation reason.'), { status: 400 });
      }
      logger.info('Log customer cancel request · jobId=' + jobId + ' · reason=' + req.body.reason);
      const [ins] = await pool.query(
        `INSERT INTO tbl_job_customer_request
           (job_id, request_type, reason, remarks)
         VALUES (?, 'cancel', ?, ?)`,
        [jobId, req.body.reason, req.body.remarks || null],
      );
      // Mirror into the job comment thread so ops sees the request in the CRM
      // History tab (not only the tbl_job_customer_request queue). Best-effort:
      // the request above is the source of truth, so a comment failure must NOT
      // fail the customer's action. comment_on=1 = job-lifecycle bucket (avoids
      // the job_stage=9 side-effect of 16/17); commented_by=null = customer.
      try {
        // Mirror to the job History (tbl_job_comment). Compose a NON-EMPTY
        // reason-bearing comment text (reason label + optional remark) so
        // addComment's empty-text guard can't silently drop the row (and the
        // reason enum_reason_id) when the customer typed no remark. comment_on=1
        // (lifecycle bucket — avoids the 16/17 job_stage=9 side-effect).
        const remarkText = (req.body.remarks || '').trim();
        const commentText = remarkText
          ? `Cancellation requested: ${req.body.reason} — ${remarkText}`
          : `Cancellation requested: ${req.body.reason}`;
        await require('../../services/job-comment.service').addComment(jobId, {
          comments: commentText,
          comment_on: 1,
          commented_by: null,
          enum_reason_id: reasonRow.id,
        });
      } catch (ce) {
        logger.warn('cancel-request comment mirror failed · jobId=' + jobId + ' · ' + ce.message);
      }
      logger.info({ jobId, request_id: ins.insertId }, 'magic-link: customer cancel request logged');
      return modernOk(res, { request_id: ins.insertId });
    } catch (e) {
      return mapKnownError(res, next, e);
    }
  },
);

// ─── POST /:token/reschedule-request — log a customer reschedule req ─
// Same ops-signal semantics as cancel-request — NO job_status change.
// `preferred_datetime` is optional; stored as DATETIME (NULL when absent).
router.post(
  '/:token/reschedule-request',
  peekToken,
  tokenRateLimit,
  validate(rescheduleRequestBody, 'body'),
  async (req, res, next) => {
    try {
      const jobId = await verify(req);
      // Membership check + id resolution — reasons are DB-driven
      // (action_taken_reason action_type=38).
      const reschedReasons = await magicLinkService.getRescheduleReasons(pool);
      const reasonRow = reschedReasons.find((r) => r.action_desc === req.body.reason);
      if (!reasonRow) {
        throw Object.assign(new Error('Please select a valid reschedule reason.'), { status: 400 });
      }
      logger.info('Log customer reschedule request · jobId=' + jobId + ' · reason=' + req.body.reason);
      // Default the preferred date to the job's CURRENT appointment
      // (tbl_job.requested_date_time) when the customer didn't pick one, instead
      // of storing NULL — so Ops always has a concrete date to act on and the
      // list/detail surfaces never show a bare "Reschedule Requested" with no
      // date. db.js runs dateStrings:true + timezone '+05:30', so the column
      // comes back as a ready 'YYYY-MM-DD HH:MM:SS' IST wall-clock string — a
      // valid DATETIME literal used verbatim (do NOT re-parse through
      // toMysqlDatetime, which is only for normalising the raw request body).
      let preferred = toMysqlDatetime(req.body.preferred_datetime);
      if (!preferred) {
        const [[jobRow]] = await pool.query(
          'SELECT requested_date_time FROM tbl_job WHERE job_id = ? LIMIT 1',
          [jobId],
        );
        preferred = jobRow ? jobRow.requested_date_time : null;
      }
      const [ins] = await pool.query(
        `INSERT INTO tbl_job_customer_request
           (job_id, request_type, reason, remarks, preferred_datetime)
         VALUES (?, 'reschedule', ?, ?, ?)`,
        [jobId, req.body.reason, req.body.remarks || null, preferred],
      );
      // Mirror into the job comment thread for ops visibility (best-effort — the
      // request above is authoritative). comment_on=1 = the job-lifecycle bucket
      // legacy uses for reschedule notes; appointment_on carries the preferred
      // date so the comment row itself shows the requested new time.
      try {
        // Mirror to job History. Compose a NON-EMPTY reason-bearing comment text
        // (reason label + optional remark) so addComment's empty-text guard can't
        // silently drop the row when the customer typed no remark — that used to
        // lose enum_reason_id (the reason) entirely. appointment_on carries the
        // requested new time; enum_reason_id stamps the reason FK; commented_by=null.
        const remarkText = (req.body.remarks || '').trim();
        const commentText = remarkText
          ? `Reschedule requested: ${req.body.reason} — ${remarkText}`
          : `Reschedule requested: ${req.body.reason}`;
        await require('../../services/job-comment.service').addComment(jobId, {
          comments: commentText,
          comment_on: 1,
          commented_by: null,
          appointment_on: preferred || null,
          enum_reason_id: reasonRow.id,
        });
      } catch (ce) {
        logger.warn('reschedule-request comment mirror failed · jobId=' + jobId + ' · ' + ce.message);
      }
      logger.info({ jobId, request_id: ins.insertId }, 'magic-link: customer reschedule request logged');
      return modernOk(res, { request_id: ins.insertId });
    } catch (e) {
      return mapKnownError(res, next, e);
    }
  },
);

// ─── GET /:token/spoc-call/preview — masked from→to the bridge WOULD dial ──
// Powers the "Need Help" confirmation so the customer sees exactly which two
// numbers will be bridged (first-4-then-bullets masking, same convention as
// the CRM operator click-to-call confirm dialog) — in ALL environments. The
// effective legs come from kaleyra.previewCallLegs() (the SAME resolver
// clickToCall uses), so QA test-redirects (KALEYRA_CALL_FROM/TO) and prod real
// numbers are reflected accurately, and a QA env with no valid redirect is
// flagged `suppressed:true`. No call is placed; no raw number leaves the server.
router.get(
  '/:token/spoc-call/preview',
  peekToken,
  tokenRateLimit,
  async (req, res, next) => {
    try {
      const jobId = await verify(req);
      logger.info('Preview SPOC bridge call legs · jobId=' + jobId);
      const [[job]] = await pool.query(
        `SELECT c.customer_mob_no
           FROM tbl_job j
      LEFT JOIN tbl_customer c ON c.customer_id = j.fk_customer_id
          WHERE j.job_id = ? LIMIT 1`,
        [jobId],
      );
      const customerMob = job && job.customer_mob_no;
      if (!customerMob) return modernError(res, 422, 'No customer mobile on file to bridge the call');

      const spoc = await magicLinkService.resolveJobSpoc(jobId, pool);
      if (!spoc.mobile) return modernError(res, 422, 'No SPOC available to call');

      // Hardcoded to Plivo's bridge (call) flow — this is a CUSTOMER-initiated
      // public call, so it must use the server-placed Plivo Call bridge, never
      // the Plivo web/WebRTC SDK (CRM-staff only). Same alwaysApplyEnvOverride:true
      // the actual spoc-call uses → the preview reflects what would be dialled.
      const preview = voice.previewCallLegs({
        provider: 'plivo',
        from: customerMob,
        to: spoc.mobile,
        alwaysApplyEnvOverride: true,
      });
      return modernOk(res, {
        from: preview.from,
        to: preview.to,
        suppressed: !!preview.suppressed,
      });
    } catch (e) {
      return mapKnownError(res, next, e);
    }
  },
);

// ─── POST /:token/spoc-call — bridge a click-to-call to the SPOC ────
// Resolves the customer's own mobile (caller leg) + the client's Primary
// SPOC real mobile (receiver leg) server-side and bridges via Kaleyra. The
// SPOC's real number is NEVER returned to the client. Honours the same
// suppressed/disabled handling as routes/admin/calls.js.
router.post(
  '/:token/spoc-call',
  peekToken,
  callRateLimit,
  async (req, res, next) => {
    try {
      const jobId = await verify(req);
      logger.info('Place SPOC bridge call · jobId=' + jobId);

      // Hard per-job daily ceiling on customer-initiated bridge calls — a
      // leaked token can't spam-dial beyond this even within the rate-limit
      // window. Checked before any provider work.
      if (await dailyBridgeCapReached(jobId)) {
        return modernError(res, 429, 'Call limit reached for this order today. Please try again later.');
      }

      // Customer's own mobile = caller leg. Also pull the snapshot fields the
      // tbl_job_caller_info audit row needs (status + assigned easyfixer +
      // customer name) in the same round-trip.
      const [[job]] = await pool.query(
        `SELECT c.customer_mob_no,
                COALESCE(j.job_customer_name, c.customer_name) AS customer_name,
                j.job_status, j.fk_easyfixter_id
           FROM tbl_job j
      LEFT JOIN tbl_customer c ON c.customer_id = j.fk_customer_id
          WHERE j.job_id = ? LIMIT 1`,
        [jobId],
      );
      const customerMob = job && job.customer_mob_no;
      if (!customerMob) {
        return modernError(res, 422, 'No customer mobile on file to bridge the call');
      }

      // SPOC real mobile = receiver leg (resolved server-side, never shipped).
      const spoc = await magicLinkService.resolveJobSpoc(jobId, pool);
      if (!spoc.mobile) {
        return modernError(res, 422, 'No SPOC available to call');
      }

      // Hardcoded to Plivo's bridge (call) flow: this is a CUSTOMER-initiated
      // public call, so it uses the server-placed Plivo Call bridge (customer
      // leg ⇄ SPOC leg), NOT the Plivo web/WebRTC SDK (which is CRM-staff only).
      // alwaysApplyEnvOverride: the OPERATOR-LESS public bridge resolves the REAL
      // customer + SPOC numbers server-side, so the CALL_FROM/TO test-redirect
      // MUST apply in non-prod (prevents dialling a real customer from QA); in
      // prod those env vars are unset → real numbers as intended.
      const result = await voice.clickToCall({ provider: 'plivo', from: customerMob, to: spoc.mobile, alwaysApplyEnvOverride: true });
      if (!result.delivered && (result.suppressed || result.disabled)) {
        // Calling disabled in this environment — mirror admin/calls: 200 OK
        // with delivered:false + suppressed:true so the FE can show
        // "would have called" feedback instead of an error toast. We STILL
        // persist the audit row so ops can see the customer's intent to call.
        await persistBridgeCall({
          jobId,
          callId: result.callId,
          customerMob,
          customerName: job.customer_name,
          receiverMob: spoc.mobile,
          receiverId: spoc.user_id,
          receiverName: spoc.name,
          jobStatus: job.job_status,
          jobEfrId: job.fk_easyfixter_id,
          provider: result.provider,
        });
        return modernOk(res, { delivered: false, suppressed: true });
      }
      if (!result.delivered) {
        // Log the REAL diagnostic server-side; return a generic message to the
        // public client so no provider/number detail leaks.
        logger.warn(
          { jobId, diagnostic: result.diagnostic, err: result.error, providerError: result.providerError, providerStatus: result.providerStatus },
          'magic-link: SPOC bridge call failed',
        );
        return modernError(res, 502, CALL_FAILED_PUBLIC_MSG);
      }
      // CUSTOMER → SPOC audit row (best-effort; never fails the response).
      await persistBridgeCall({
        jobId,
        callId: result.callId,
        customerMob,
        customerName: job.customer_name,
        receiverMob: spoc.mobile,
        receiverId: spoc.user_id,
        receiverName: spoc.name,
        jobStatus: job.job_status,
        jobEfrId: job.fk_easyfixter_id,
        provider: result.provider,
      });
      logger.info({ jobId }, 'magic-link: SPOC bridge call placed');
      return modernOk(res, { delivered: true });
    } catch (e) {
      return mapKnownError(res, next, e);
    }
  },
);

// ─── GET /:token/support-call/preview — masked from→to for the Support bridge ──
// Parity with /spoc-call/preview, for the (currently dormant) Support click-to-
// call path. If SUPPORT_PHONE is unset, returns support_phone:null so the FE can
// fall back. Uses the SAME kaleyra.previewCallLegs resolver so the displayed
// from→to matches exactly what /support-call would dial in every environment.
router.get(
  '/:token/support-call/preview',
  peekToken,
  tokenRateLimit,
  async (req, res, next) => {
    try {
      const jobId = await verify(req);
      logger.info('Preview Support bridge call legs · jobId=' + jobId);
      const supportPhone = (process.env.SUPPORT_PHONE || '').trim();
      if (!supportPhone) return modernOk(res, { from: null, to: null, suppressed: false, support_phone: null });

      const [[job]] = await pool.query(
        `SELECT c.customer_mob_no
           FROM tbl_job j
      LEFT JOIN tbl_customer c ON c.customer_id = j.fk_customer_id
          WHERE j.job_id = ? LIMIT 1`,
        [jobId],
      );
      const customerMob = job && job.customer_mob_no;
      if (!customerMob) return modernError(res, 422, 'No customer mobile on file to bridge the call');

      const preview = voice.previewCallLegs({
        from: customerMob,
        to: supportPhone,
        alwaysApplyEnvOverride: true,
      });
      return modernOk(res, {
        from: preview.from,
        to: preview.to,
        suppressed: !!preview.suppressed,
        support_phone: true,
      });
    } catch (e) {
      return mapKnownError(res, next, e);
    }
  },
);

// ─── POST /:token/support-call — bridge a click-to-call to Support ──
// Bridges the customer to the SUPPORT_PHONE env number. When SUPPORT_PHONE
// is unset, returns delivered:false + support_phone:null so the FE can fall
// back (e.g. show a help email). Same suppressed handling as spoc-call.
router.post(
  '/:token/support-call',
  peekToken,
  callRateLimit,
  async (req, res, next) => {
    try {
      const jobId = await verify(req);
      logger.info('Place Support bridge call · jobId=' + jobId);

      const supportPhone = (process.env.SUPPORT_PHONE || '').trim();
      if (!supportPhone) {
        // No support number configured — FE falls back gracefully.
        return modernOk(res, { delivered: false, support_phone: null });
      }

      // Hard per-job daily ceiling on customer-initiated bridge calls. Shares
      // the same 24h budget as spoc-call (counts all caller_id IS NULL rows).
      if (await dailyBridgeCapReached(jobId)) {
        return modernError(res, 429, 'Call limit reached for this order today. Please try again later.');
      }

      const [[job]] = await pool.query(
        `SELECT c.customer_mob_no,
                COALESCE(j.job_customer_name, c.customer_name) AS customer_name,
                j.job_status, j.fk_easyfixter_id
           FROM tbl_job j
      LEFT JOIN tbl_customer c ON c.customer_id = j.fk_customer_id
          WHERE j.job_id = ? LIMIT 1`,
        [jobId],
      );
      const customerMob = job && job.customer_mob_no;
      if (!customerMob) {
        return modernError(res, 422, 'No customer mobile on file to bridge the call');
      }

      // Same operator-less rationale as spoc-call — force the
      // KALEYRA_CALL_FROM/TO test-redirect in non-prod so QA never dials
      // the real customer/support line.
      const result = await voice.clickToCall({ from: customerMob, to: supportPhone, alwaysApplyEnvOverride: true });
      // Support audit row: reciever_id NULL (not a staff user) + the literal
      // 'EasyFix Support' name so ops can tell a CUSTOMER → Support call apart
      // from a CUSTOMER → SPOC call. caller_id NULL marks it customer-initiated.
      const persistSupport = (callId) => persistBridgeCall({
        jobId,
        callId,
        customerMob,
        customerName: job.customer_name,
        receiverMob: supportPhone,
        receiverId: null,
        receiverName: 'EasyFix Support',
        jobStatus: job.job_status,
        jobEfrId: job.fk_easyfixter_id,
        provider: result.provider,
      });

      if (!result.delivered && (result.suppressed || result.disabled)) {
        await persistSupport(result.callId);
        return modernOk(res, { delivered: false, suppressed: true });
      }
      if (!result.delivered) {
        // Real diagnostic logged server-side; generic message to the client.
        logger.warn(
          { jobId, diagnostic: result.diagnostic, err: result.error, providerError: result.providerError, providerStatus: result.providerStatus },
          'magic-link: support bridge call failed',
        );
        return modernError(res, 502, CALL_FAILED_PUBLIC_MSG);
      }
      await persistSupport(result.callId);
      logger.info({ jobId }, 'magic-link: support bridge call placed');
      return modernOk(res, { delivered: true });
    } catch (e) {
      return mapKnownError(res, next, e);
    }
  },
);

module.exports = router;
