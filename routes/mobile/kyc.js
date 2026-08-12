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
 */

const router = require('express').Router();
const Joi = require('joi');
const multer = require('multer');

const validate = require('../../middleware/validate');
const { verifyIdempotencyUpload } = require('../../middleware/verify-idempotency-upload');
const { modernOk, modernError } = require('../../utils/response');
const kyc = require('../../services/mobile-kyc.service');
const logger = require('../../logger');

// PAN OCR upload — in-memory, images only, 10 MB cap.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\//i.test(file.mimetype) || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are accepted for PAN OCR'));
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

module.exports = router;
