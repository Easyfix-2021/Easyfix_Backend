/*
 * routes/mobile/kyc.js — technician KYC verification sub-router.
 *
 * Mounted at /kyc under /api/mobile (so paths below resolve to
 * /api/mobile/kyc/...). `requireTechAuth` is applied UPSTREAM in
 * routes/mobile/index.js, so `req.tech.efr_id` / `req.tech.efr_email` are
 * already available here — this router does NOT re-apply auth.
 *
 * REQUIRES env `SUREPASS_VERIFICATION_KEY` (one Bearer token shared across the
 * SurePass + aadhaarkyc.io vendors). When it is unset, every endpoint returns a
 * clean 503 "KYC verification is not configured" (the service throws .status=503).
 *
 * Mirrors the legacy Flutter app's direct vendor calls (DigiLocker, PAN OCR,
 * Aadhaar OTP, bank + UPI verification) but moves the secret server-side and
 * normalises every response to clean camelCase (the raw vendor envelope is never
 * leaked to the app). See services/mobile-kyc.service.js for the vendor contracts.
 *
 * STATUS: built to the exact legacy vendor contracts but NOT yet live-tested
 * against the vendors.
 *
 * Outbound HTTP: native `fetch` (repo standard — no axios). Multipart (PAN OCR)
 * uses multer memoryStorage here + the Node 18 global FormData/Blob in the
 * service (the `form-data` npm package is not installed).
 *
 * ONE EXCEPTION to all of the above: POST /aadhaar-ocr is NOT a KYC-vendor call.
 * It sends the front + back Aadhaar photos to Sophy (the LLM gateway) for AI
 * field extraction on its OWN key (`SOPHY_API_KEY_AADHAAR_OCR`), so it is
 * unaffected by SUREPASS_VERIFICATION_KEY and never 503s — with no key it
 * soft-degrades to 200 { available:false }.
 */

const router = require('express').Router();
const Joi = require('joi');
const multer = require('multer');

const validate = require('../../middleware/validate');
const { verifyIdempotencyUpload } = require('../../middleware/verify-idempotency-upload');
const { modernOk, modernError } = require('../../utils/response');
const kyc = require('../../services/mobile-kyc.service');
const logger = require('../../logger');

// KYC OCR uploads (PAN + Aadhaar) — in-memory, images only. This is the OUTER
// bound shared with PAN; the Aadhaar route enforces its own much tighter
// per-image cap in the service, sized to Sophy's 4.5 MB request-body limit.
const KYC_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: KYC_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (/^image\//i.test(file.mimetype) || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are accepted for KYC OCR'));
    }
  },
});

// Maps service-thrown `.status` errors onto the modern envelope; otherwise
// delegates to the global error handler.
function handleErr(res, next, e) {
  if (e && e.status) return modernError(res, e.status, e.message);
  return next(e);
}

// ─── 1. DigiLocker ──────────────────────────────────────────────────

// POST /digilocker/initialize → { clientId, url, token, expirySeconds }
router.post('/digilocker/initialize', async (req, res, next) => {
  try {
    logger.info('Initialize DigiLocker session');
    const out = await kyc.digilockerInitialize(req.tech.efr_id);
    logger.info('DigiLocker session initialized');
    modernOk(res, out);
  } catch (e) { logger.warn('DigiLocker initialize failed · ' + e.message); handleErr(res, next, e); }
});

// GET /digilocker/aadhaar/:clientId
//   → 202 { pending:true } while consent is still missing, OR
//   → 200 { aadhaarNumber, name, dob, gender, address, fatherName, photo }
router.get(
  '/digilocker/aadhaar/:clientId',
  validate(Joi.object({ clientId: Joi.string().trim().min(1).max(128).required() }), 'params'),
  async (req, res, next) => {
    try {
      logger.info('Download DigiLocker Aadhaar · clientId=' + req.params.clientId);
      const out = await kyc.digilockerDownloadAadhaar(req.tech.efr_id, req.params.clientId);
      if (out && out.pending) { logger.info('DigiLocker consent still pending · clientId=' + req.params.clientId); return res.status(202).json({ success: true, data: out }); }
      logger.info('DigiLocker Aadhaar downloaded · clientId=' + req.params.clientId);
      modernOk(res, out);
    } catch (e) { logger.warn('DigiLocker Aadhaar download failed · clientId=' + req.params.clientId + ' · ' + e.message); handleErr(res, next, e); }
  },
);

// ─── 2. PAN OCR ─────────────────────────────────────────────────────

// POST /pan-ocr (multipart field `file`) → { panNumber, name, fatherName, dob }
router.post('/pan-ocr', upload.single('file'), verifyIdempotencyUpload, async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      logger.warn('PAN OCR rejected · missing image file');
      return modernError(res, 400, 'PAN image is required (multipart field "file")');
    }
    logger.info('PAN OCR · imageBytes=' + req.file.size);
    const out = await kyc.panOcr(req.tech.efr_id, req.file);
    logger.info('PAN OCR completed');
    modernOk(res, out);
  } catch (e) { logger.warn('PAN OCR failed · ' + e.message); handleErr(res, next, e); }
});

// ─── 3. Aadhaar OTP ─────────────────────────────────────────────────

// POST /aadhaar/generate-otp { aadhaarNumber } → { clientId, otpSent }
router.post(
  '/aadhaar/generate-otp',
  validate(Joi.object({
    aadhaarNumber: Joi.string().pattern(/^[0-9]{12}$/).required(),
  })),
  async (req, res, next) => {
    try {
      logger.info('Aadhaar OTP requested');
      const out = await kyc.aadhaarGenerateOtp(req.tech.efr_id, req.body.aadhaarNumber);
      logger.info('Aadhaar OTP dispatched');
      modernOk(res, out);
    } catch (e) { logger.warn('Aadhaar OTP request failed · ' + e.message); handleErr(res, next, e); }
  },
);

// POST /aadhaar/submit-otp { clientId, otp } → { verified, name, dob, gender, address }
router.post(
  '/aadhaar/submit-otp',
  validate(Joi.object({
    clientId: Joi.string().trim().min(1).max(128).required(),
    otp: Joi.string().pattern(/^[0-9]{4,8}$/).required(),
  })),
  async (req, res, next) => {
    try {
      logger.info('Verify Aadhaar OTP · clientId=' + req.body.clientId);
      const out = await kyc.aadhaarSubmitOtp(req.tech.efr_id, req.body.clientId, req.body.otp);
      logger.info('Aadhaar OTP verified · clientId=' + req.body.clientId);
      modernOk(res, out);
    } catch (e) { logger.warn('Aadhaar OTP verification failed · clientId=' + req.body.clientId + ' · ' + e.message); handleErr(res, next, e); }
  },
);

// ─── 4. Bank verification ───────────────────────────────────────────

// POST /bank/verify { accountNumber, ifsc } → { verified, accountHolderName, accountNumber }
router.post(
  '/bank/verify',
  validate(Joi.object({
    accountNumber: Joi.string().trim().pattern(/^[0-9]{6,20}$/).required(),
    ifsc: Joi.string().trim().pattern(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/).required(),
  })),
  async (req, res, next) => {
    try {
      logger.info('Verify bank account');
      const out = await kyc.bankVerify(req.tech.efr_id, req.body.accountNumber, req.body.ifsc);
      logger.info('Bank account verification completed');
      modernOk(res, out);
    } catch (e) { logger.warn('Bank account verification failed · ' + e.message); handleErr(res, next, e); }
  },
);

// ─── 5. UPI verification ────────────────────────────────────────────

// POST /upi/verify { upiId } → { verified, name }
router.post(
  '/upi/verify',
  validate(Joi.object({
    upiId: Joi.string().trim().pattern(/^[\w.\-]{2,256}@[\w.\-]{2,64}$/).required(),
  })),
  async (req, res, next) => {
    try {
      logger.info('Verify UPI id');
      const out = await kyc.upiVerify(req.tech.efr_id, req.body.upiId);
      logger.info('UPI verification completed');
      modernOk(res, out);
    } catch (e) { logger.warn('UPI verification failed · ' + e.message); handleErr(res, next, e); }
  },
);


// ─── 6. Aadhaar OCR (AI extraction via Sophy) ───────────────────────

// POST /aadhaar-ocr — multipart: `front` (file), `back` (file), `name` (text,
// optional: the "Name as per Aadhaar" the technician typed on the same screen).
//   → 200 { available, extracted, nameMatch }
// `available:false` is a SOFT DEGRADE (no key / gateway error / unreadable
// reply) and still answers 200 with extracted+nameMatch null. 400 is reserved
// for a genuinely bad request: missing file, not an image, oversize.
const aadhaarUpload = upload.fields([
  { name: 'front', maxCount: 1 },
  { name: 'back', maxCount: 1 },
]);

// A pure extraction read that PERSISTS NOTHING, so an Idempotency-Key buys no
// replay protection here — and it cannot be bound honestly. The idempotency
// layer fingerprints method + URL + body + ONE content digest and runs BEFORE
// Multer, so of this route's three payload parts (front, back, typed name) two
// sit outside the fingerprint: a retry under the same key after the technician
// fixes a typo or re-shoots the back image would replay the stale extraction.
// Refuse the header instead of binding it to a third of the request.
function rejectIdempotencyKey(req, res, next) {
  if (!req.headers['idempotency-key']) return next();
  logger.warn('Aadhaar OCR rejected · Idempotency-Key is not supported here');
  return modernError(res, 400, 'Idempotency-Key is not supported on this endpoint', {
    code: 'IDEMPOTENCY_NOT_SUPPORTED',
  });
}

// Multer rejections (oversize, wrong type, unexpected field) are bad REQUESTS,
// so they answer 400 here instead of falling through to the 500 handler.
function aadhaarUploadOr400(req, res, next) {
  aadhaarUpload(req, res, (err) => {
    if (!err) return next();
    // Multer's own rejections are MulterError (a `code` plus a fixed message);
    // a fileFilter rejection is a plain Error carrying only a message. Log both
    // so the line always names the cause. Neither field is PII — both come from
    // fixed strings in this file or in Multer, never from the upload itself.
    logger.warn('Aadhaar OCR upload rejected · ' + (err.code || err.name || 'Error')
      + ' · ' + (err.message || 'no message'));
    return modernError(
      res,
      400,
      err.code === 'LIMIT_FILE_SIZE'
        ? `Each Aadhaar image must be ${KYC_UPLOAD_MAX_BYTES / (1024 * 1024)} MB or smaller`
        : err.message,
    );
  });
}

router.post('/aadhaar-ocr', rejectIdempotencyKey, aadhaarUploadOr400, async (req, res, next) => {
  try {
    const front = req.files && req.files.front && req.files.front[0];
    const back = req.files && req.files.back && req.files.back[0];
    if (!front || !back) {
      logger.warn('Aadhaar OCR rejected · missing image file');
      return modernError(res, 400, 'Both Aadhaar images are required (multipart fields "front" and "back")');
    }
    // NEVER log req.body.name or anything extracted — bytes and booleans only.
    const out = await kyc.aadhaarOcr(req.tech.efr_id, front, back, req.body && req.body.name);
    logger.info('Aadhaar OCR responded · available=' + out.available);
    modernOk(res, out);
  } catch (e) { logger.warn('Aadhaar OCR failed · ' + e.message); handleErr(res, next, e); }
});

module.exports = router;
