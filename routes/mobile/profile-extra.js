const router = require('express').Router();
const Joi = require('joi');
const multer = require('multer');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const svc = require('../../services/mobile-profile-extra.service');
const withdrawalService = require('../../services/withdrawal.service');
const { pool } = require('../../db');
const logger = require('../../logger');
const {
  verifyIdempotencyUpload,
  deterministicUploadToken,
} = require('../../middleware/verify-idempotency-upload');

// Profile-image multipart upload — memory storage, single image ≤10MB.
// Images-only allowlist mirrors routes/mobile/uploads.js + admin job images.
const profileImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(
      String(file.mimetype || '').toLowerCase(),
    );
    if (!ok) {
      const e = new Error('only png/jpg/jpeg/webp images are allowed');
      e.code = 'LIMIT_UNEXPECTED_FILE';
      return cb(e);
    }
    return cb(null, true);
  },
});

/*
 * /api/mobile/profile-extra/* — Technician-app "profile extras" surface.
 *
 * Covers the legacy Dropwizard `easyfixers/*`, `upi-details`,
 * `training-video/*`, `version`, `logout` endpoints, plus the
 * earnings / icard / ratings reads. Maps them onto the new
 * `/api/mobile/*` contract (see docs/migration-blueprint.md §4.2).
 *
 * AUTH: `requireTechAuth` is applied UPSTREAM in routes/mobile/index.js
 * via `router.use(requireTechAuth)` BEFORE this sub-router is mounted —
 * so `req.tech` (and thus `req.tech.efr_id`) is always populated here.
 * Every handler scopes strictly to `req.tech.efr_id`; no technician id
 * is ever accepted from the body/query/params.
 *
 * Mount (added in routes/mobile/index.js AFTER requireTechAuth):
 *   router.use('/profile-extra', require('./profile-extra'));
 *
 * NOTE: the paths in this file are RELATIVE to that mount, so they read
 * e.g. `/profile/editable`, `/earnings`, `/icard`, `/upi-details`.
 */

// ─── Date-window query schema (shared by windowed reads) ─────────────
// `from` / `to` are inclusive YYYY-MM-DD bounds. Both optional.
const dateWindow = Joi.object({
  from: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// ─────────────────────────────────────────────────────────────────────
// Profile extras
// ─────────────────────────────────────────────────────────────────────

// DUPLICATE REMOVED: `POST /profile/editable` (getEditableProfile) was
// removed — it duplicates the existing `GET /profile`, which returns the
// full tbl_easyfixer row the app reads its editable fields from.

// Update display name.
router.patch('/profile/name', validate(Joi.object({
  name: Joi.string().trim().min(1).max(255).required(),
})), async (req, res, next) => {
  try {
    logger.info('Update profile name');
    modernOk(res, await svc.updateName(req.tech.efr_id, req.body.name));
  } catch (e) { next(e); }
});

/*
 * Set the profile image — direct multipart byte upload.
 *
 * The RN screen POSTs the image file as multipart/form-data under the
 * `file` field. We upload it to S3 at `EasyfixerProfile/<efrId>_<ts>`
 * (no extension on the key — Content-Type + original-filename carry the
 * real type), persist that key onto tbl_easyfixer.efr_profile_img, and
 * return { url, imageId } (imageId == the stored key). When S3 is
 * disabled (local dev) the service falls back to local disk.
 */
router.post(
  '/profile/image',
  profileImageUpload.single('file'),
  verifyIdempotencyUpload,
  async (req, res, next) => {
  try {
    if (!req.file) {
      logger.warn('Profile image upload rejected · missing "file" field');
      return modernError(res, 400, 'missing "file" upload');
    }
    logger.info(`Profile image upload · type=${req.file.mimetype} bytes=${req.file.size}`);
    return modernOk(res, await svc.setProfileImageFromUpload(
      req.tech.efr_id,
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname,
      { storageToken: deterministicUploadToken(req) },
    ));
  } catch (e) {
    if (e?.code === 'LIMIT_FILE_SIZE') {
      logger.warn('Profile image upload rejected · file exceeds 10MB');
      return modernError(res, 400, 'file exceeds 10MB');
    }
    if (e?.code === 'LIMIT_UNEXPECTED_FILE') {
      logger.warn(`Profile image upload rejected · ${e.message}`);
      return modernError(res, 400, e.message || 'unsupported file');
    }
    return next(e);
  }
  },
);

// Weekly performance chart — MOVED to routes/mobile/performance.js
// (`GET /api/mobile/performance/weekly`), which the RN app actually calls and
// which fixes the tbl_job_transaction JOIN fan-out the old aggregate had. The
// old `/profile/performance/weekly` path was never reached by the app.

// ─────────────────────────────────────────────────────────────────────
// Earnings
// ─────────────────────────────────────────────────────────────────────

router.get('/earnings', validate(dateWindow, 'query'), async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const window = `${from || 'all'} → ${to || 'all'}`;
    // Surface + identity are auto-stamped by the contextual logger (ALS), so the
    // message only needs the request-specific bits (the date window / counts).
    logger.info(`Earnings requested · ${window}`);
    const data = await svc.getEarnings(req.tech.efr_id, { from, to });
    logger.info(`Returning ${data.items.length} earning record(s) · ${window}`);
    modernOk(res, data);
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────
// Withdraw / payout request
// ─────────────────────────────────────────────────────────────────────

/*
 * Record a payout/withdrawal request against the technician's wallet balance.
 *
 * MVP (finance-in-the-loop): this ONLY records the request row in
 * tbl_easyfixer_withdrawal_request (status='requested'). It deliberately does
 * NOT debit tbl_easyfixer.current_balance — the actual payout + wallet debit are
 * a downstream FINANCE/OPS step performed when the payout is settled (see
 * services/withdrawal.service.js). The service throws { status, code, message }
 * for the bank-missing / invalid-amount / already-pending cases, which the
 * central error-handler surfaces to the app verbatim.
 */
router.post('/withdraw', validate(Joi.object({
  amount: Joi.number().positive().required(),
})), async (req, res, next) => {
  try {
    logger.info('Withdrawal requested · amount=' + req.body.amount);
    const result = await withdrawalService.requestWithdrawal(req.tech.efr_id, req.body, pool);
    logger.info('Withdrawal request recorded · requestId=' + result.requestId);
    modernOk(res, result);
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────
// I-Card
// ─────────────────────────────────────────────────────────────────────

router.get('/icard', async (req, res, next) => {
  try {
    logger.info('I-Card requested');
    modernOk(res, await svc.getICard(req.tech.efr_id));
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────
// Ratings
// ─────────────────────────────────────────────────────────────────────

router.get('/ratings', validate(dateWindow, 'query'), async (req, res, next) => {
  try {
    logger.info(`Ratings requested · ${req.query.from || 'all'} → ${req.query.to || 'all'}`);
    modernOk(res, await svc.getRatings(req.tech.efr_id, {
      from: req.query.from,
      to: req.query.to,
    }));
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────
// Training videos — watched %
// ─────────────────────────────────────────────────────────────────────

router.get('/training-videos/percentage', async (req, res, next) => {
  try {
    logger.info('Training video percentages requested');
    modernOk(res, await svc.getTrainingPercentages(req.tech.efr_id));
  } catch (e) { next(e); }
});

router.post('/training-videos/percentage', validate(Joi.object({
  videoId: Joi.number().integer().positive().required(),
  watchedPercentage: Joi.number().integer().min(0).max(100).required(),
})), async (req, res, next) => {
  try {
    logger.info(`Set training video percentage · videoId=${req.body.videoId} watched=${req.body.watchedPercentage}%`);
    modernOk(res, await svc.setTrainingPercentage(
      req.tech.efr_id,
      req.body.videoId,
      req.body.watchedPercentage,
    ));
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────
// App version
// ─────────────────────────────────────────────────────────────────────

router.get('/app-version', (_req, res, next) => {
  try {
    logger.info('App version requested');
    modernOk(res, svc.getAppVersion());
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────
// Logout — device deregister
// ─────────────────────────────────────────────────────────────────────

router.post('/logout', validate(Joi.object({
  deviceId: Joi.string().trim().max(255).optional(),
})), async (req, res, next) => {
  try {
    logger.info(`Logout · deviceId ${req.body.deviceId ? 'provided' : 'absent'}`);
    modernOk(res, await svc.logout(req.tech.efr_id, req.body.deviceId || null));
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────
// UPI details
// ─────────────────────────────────────────────────────────────────────

router.get('/upi-details', async (req, res, next) => {
  try {
    logger.info('UPI details requested');
    modernOk(res, await svc.getUpiDetails(req.tech.efr_id));
  } catch (e) { next(e); }
});

router.post('/upi-details', validate(Joi.object({
  upiId: Joi.string().trim().min(3).max(255).required(),
  isPrimary: Joi.boolean().optional(),
})), async (req, res, next) => {
  try {
    logger.info(`Add UPI detail · isPrimary=${req.body.isPrimary === true}`);
    modernOk(res, await svc.addUpiDetail(
      req.tech.efr_id,
      req.body.upiId,
      req.body.isPrimary === true,
    ));
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────
// KYC — Aadhaar/PAN duplicate-check
// ─────────────────────────────────────────────────────────────────────

/*
 * `number` is a bare Aadhaar (12 digits) or PAN (ABCDE1234F). We validate its
 * shape and exclude the caller's own row so a re-save of an unchanged number
 * isn't a false duplicate.
 *
 * POST, not GET-with-a-path-param (changed 2026-08-12). middleware/http-log.js
 * captures req.originalUrl and prints it for EVERY request, so a path param put
 * the caller's Aadhaar/PAN into the access log on every check — the endpoint is
 * a read, but the identifier is the PII. A request body is not logged.
 *
 * This remains ADVISORY only: it is a pre-submit convenience for the app and is
 * inherently TOCTOU-racy. Enforcement lives in the write path
 * (utils/aadhaar-uniqueness#assertActiveAadhaarAvailable), never here.
 */
router.post('/kyc/aadhaar-pan-exists', validate(Joi.object({
  number: Joi.string().trim().pattern(/^([0-9]{12}|[A-Za-z]{5}[0-9]{4}[A-Za-z])$/).required()
    .messages({ 'string.pattern.base': 'number must be a 12-digit Aadhaar or a valid PAN' }),
})), async (req, res, next) => {
  try {
    logger.info(`KYC duplicate-check · type=${/^[0-9]{12}$/.test(req.body.number) ? 'aadhaar' : 'pan'}`);
    modernOk(res, await svc.aadhaarPanExists(req.body.number, req.tech.efr_id));
  } catch (e) { next(e); }
});

// ─── Serviceable pincodes ──────────────────────────────────────────────────
// The 6-digit pincodes a technician is willing to work in. Scoped strictly to
// req.tech.efr_id. Read returns the CSV as an array; write reuses the
// verification service's replaceServiceablePincodes (same soft-write + flip-to-
// serviceable the CRM/public flows use), so storage format can't drift.
const verificationService = require('../../services/easyfixer-verification.service');

router.get('/serviceable-pincodes', async (req, res, next) => {
  try {
    logger.info('Get serviceable pincodes · efr=' + req.tech.efr_id);
    modernOk(res, await svc.getServiceablePincodes(req.tech.efr_id));
  } catch (e) { next(e); }
});

// PUT the full set (idempotent replace). An empty array clears the set.
// Pincodes are 6-digit strings; replaceServiceablePincodes matches them against
// tbl_pincode by value, so an unknown pincode is dropped (partial-resolution
// warning) rather than stored — the app validates each one before adding it.
router.put('/serviceable-pincodes', validate(Joi.object({
  pincodes: Joi.array().items(Joi.string().trim().pattern(/^[0-9]{6}$/)).max(200).required(),
})), async (req, res, next) => {
  try {
    logger.info('Replace serviceable pincodes · efr=' + req.tech.efr_id + ' · count=' + req.body.pincodes.length);
    // actor=null → the technician is acting on their own behalf; the helper
    // stamps their efr_id as created_by/updated_by.
    await verificationService.replaceServiceablePincodes(
      req.tech.efr_id,
      req.body.pincodes,
      null,
      null,
      { representation: 'value' },
    );
    modernOk(res, await svc.getServiceablePincodes(req.tech.efr_id));
  } catch (e) { next(e); }
});

module.exports = router;
