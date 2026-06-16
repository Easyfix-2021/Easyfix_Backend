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
const { modernOk, modernError } = require('../../utils/response');
const kyc = require('../../services/mobile-kyc.service');

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
    modernOk(res, await kyc.digilockerInitialize(req.tech.efr_id));
  } catch (e) { handleErr(res, next, e); }
});

// GET /digilocker/aadhaar/:clientId
//   → 202 { pending:true } while consent is still missing, OR
//   → 200 { aadhaarNumber, name, dob, gender, address, fatherName, photo }
router.get(
  '/digilocker/aadhaar/:clientId',
  validate(Joi.object({ clientId: Joi.string().trim().min(1).max(128).required() }), 'params'),
  async (req, res, next) => {
    try {
      const out = await kyc.digilockerDownloadAadhaar(req.tech.efr_id, req.params.clientId);
      if (out && out.pending) return res.status(202).json({ success: true, data: out });
      modernOk(res, out);
    } catch (e) { handleErr(res, next, e); }
  },
);

// ─── 2. PAN OCR ─────────────────────────────────────────────────────

// POST /pan-ocr (multipart field `file`) → { panNumber, name, fatherName, dob }
router.post('/pan-ocr', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return modernError(res, 400, 'PAN image is required (multipart field "file")');
    }
    modernOk(res, await kyc.panOcr(req.tech.efr_id, req.file));
  } catch (e) { handleErr(res, next, e); }
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
      modernOk(res, await kyc.aadhaarGenerateOtp(req.tech.efr_id, req.body.aadhaarNumber));
    } catch (e) { handleErr(res, next, e); }
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
      modernOk(res, await kyc.aadhaarSubmitOtp(req.tech.efr_id, req.body.clientId, req.body.otp));
    } catch (e) { handleErr(res, next, e); }
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
      modernOk(res, await kyc.bankVerify(req.tech.efr_id, req.body.accountNumber, req.body.ifsc));
    } catch (e) { handleErr(res, next, e); }
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
      modernOk(res, await kyc.upiVerify(req.tech.efr_id, req.body.upiId));
    } catch (e) { handleErr(res, next, e); }
  },
);

module.exports = router;
