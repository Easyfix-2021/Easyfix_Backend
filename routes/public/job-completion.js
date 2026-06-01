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
  receiverMob, receiverId, receiverName, jobStatus, jobEfrId,
}) {
  try {
    await pool.query(
      `INSERT INTO tbl_job_caller_info
         (job_id, unique_id, caller, caller_id, caller_name,
          reciever, reciever_id, reciever_name,
          job_status, job_efr_id, call_type, inserted_by, is_updated)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'OUT', NULL, 0)`,
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
// in the CRM). Reason is constrained by Joi to CANCEL_REASONS.
router.post(
  '/:token/cancel-request',
  peekToken,
  tokenRateLimit,
  validate(cancelRequestBody, 'body'),
  async (req, res, next) => {
    try {
      const jobId = await verify(req);
      const [ins] = await pool.query(
        `INSERT INTO tbl_job_customer_request
           (job_id, request_type, reason, remarks)
         VALUES (?, 'cancel', ?, ?)`,
        [jobId, req.body.reason, req.body.remarks || null],
      );
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
      const preferred = toMysqlDatetime(req.body.preferred_datetime);
      const [ins] = await pool.query(
        `INSERT INTO tbl_job_customer_request
           (job_id, request_type, reason, remarks, preferred_datetime)
         VALUES (?, 'reschedule', ?, ?, ?)`,
        [jobId, req.body.reason, req.body.remarks || null, preferred],
      );
      logger.info({ jobId, request_id: ins.insertId }, 'magic-link: customer reschedule request logged');
      return modernOk(res, { request_id: ins.insertId });
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

      const result = await kaleyra.clickToCall({ from: customerMob, to: spoc.mobile });
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
      });
      logger.info({ jobId }, 'magic-link: SPOC bridge call placed');
      return modernOk(res, { delivered: true });
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

      const result = await kaleyra.clickToCall({ from: customerMob, to: supportPhone });
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
