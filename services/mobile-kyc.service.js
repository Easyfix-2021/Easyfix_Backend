/*
 * mobile-kyc.service.js — third-party KYC verification proxy (server-side).
 *
 * Fronts the SurePass / aadhaarkyc.io vendor APIs so the technician mobile app
 * never holds the verification key or talks to the vendors directly. Mirrors the
 * legacy Flutter app's direct vendor calls (DigiLocker init/download, PAN OCR,
 * Aadhaar OTP generate/submit, bank verify, UPI verify) but moves the secret
 * server-side and normalises every payload to clean camelCase.
 *
 * REQUIRES env `SUREPASS_VERIFICATION_KEY` — one Bearer token shared across ALL
 * vendors (SurePass + aadhaarkyc.io). When it is UNSET every call throws a clean
 * 503 ("KYC verification is not configured") rather than 500.
 *
 * Outbound HTTP uses the repo-standard native `fetch` (Node 18+ global) — the
 * codebase has NO axios/got dependency (every other service uses fetch too).
 * Multipart (PAN OCR) uses the Node 18 global `FormData` + `Blob` — the
 * `form-data` npm package is NOT installed.
 *
 * STATUS: built to the EXACT legacy Flutter vendor contracts but NOT yet
 * live-tested against the vendors. Field shapes below are taken from the
 * legacy source; if a vendor renames a field, normalise here, not in the router.
 *
 * Service-function convention (matches the rest of /services): each fn takes
 * `(efrId, ...)` first; throws `Error` with `.status` set for 4xx/5xx so the
 * router can map it onto the modern envelope. `efrId` is currently used only
 * for log correlation (the vendors are stateless per-call), but it keeps the
 * signature uniform and ready for per-tech audit logging.
 */

const logger = require('../logger');

// ─── Vendor base URLs ───────────────────────────────────────────────
// VENDOR: SurePass DigiLocker
const SUREPASS_BASE = 'https://kyc-api.surepass.io';
// VENDOR: aadhaarkyc.io (PAN OCR, Aadhaar OTP, bank + UPI verification)
const AADHAARKYC_BASE = 'https://kyc-api.aadhaarkyc.io';

// ─── Auth / config ──────────────────────────────────────────────────
function verificationKey() {
  return process.env.SUREPASS_VERIFICATION_KEY || '';
}

// Throws a clean 503 (NOT 500) when the shared Bearer token is missing.
// Every public service fn calls this first.
function assertConfigured() {
  if (!verificationKey()) {
    const e = new Error('KYC verification is not configured');
    e.status = 503;
    throw e;
  }
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${verificationKey()}`,
    ...extra,
  };
}

// ─── Vendor-envelope handling ───────────────────────────────────────
// All vendors share the envelope { data, status_code, message_code, message,
// success }. Treat success===true (or status_code===200) as OK; otherwise throw
// a 502 carrying the vendor's `message`.
function isOk(body) {
  return !!(body && (body.success === true || body.status_code === 200));
}

function vendorError(body, fallback) {
  const e = new Error(
    (body && (body.message || body.message_code)) || fallback || 'KYC vendor request failed',
  );
  e.status = 502;
  return e;
}

/*
 * Core JSON call. `label` is used for log correlation only. On a non-2xx HTTP
 * status or a non-OK vendor envelope it throws `.status=502`. Network/parse
 * failures also surface as 502 (a vendor-side problem from the app's POV).
 */
async function callVendorJson(efrId, label, url, body) {
  let res;
  let parsed;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    parsed = await res.json().catch(() => null);
  } catch (err) {
    logger.warn({ efrId, label, err: err.message }, 'mobile-kyc: vendor call threw');
    const e = new Error('KYC vendor is unreachable');
    e.status = 502;
    throw e;
  }
  if (!isOk(parsed)) {
    logger.warn(
      { efrId, label, httpStatus: res.status, messageCode: parsed?.message_code },
      'mobile-kyc: vendor returned non-OK',
    );
    throw vendorError(parsed, `KYC ${label} failed`);
  }
  return parsed;
}

// ─── 1. DigiLocker (SurePass) ───────────────────────────────────────

/*
 * Initialize a DigiLocker session. Returns the hosted URL + token the app opens
 * in a webview, plus the client_id used to poll for the Aadhaar download.
 */
async function digilockerInitialize(efrId) {
  assertConfigured();
  // VENDOR: POST https://kyc-api.surepass.io/api/v1/digilocker/initialize
  const url = `${SUREPASS_BASE}/api/v1/digilocker/initialize`;
  const body = {
    data: {
      signup_flow: true,
      auth_type: 'app',
      voice_assistant_lang: 'en',
      voice_assistant: false,
      retry_count: 2,
      skip_main_screen: false,
    },
  };
  const out = await callVendorJson(efrId, 'digilocker/initialize', url, body);
  const d = out.data || {};
  return {
    clientId: d.client_id || null,
    url: d.url || null,
    token: d.token || null,
    expirySeconds: d.expiry_seconds ?? null,
  };
}

/*
 * Poll/download the Aadhaar pulled from DigiLocker for a given client_id.
 *
 * If the user hasn't yet completed consent in the DigiLocker webview the vendor
 * returns message_code === 'aadhaar_consent_missing'. In that case we DO NOT
 * retry server-side (the app owns the poll loop) — we return { pending:true }
 * and the router maps it to a 202-style response.
 */
async function digilockerDownloadAadhaar(efrId, clientId) {
  assertConfigured();
  // VENDOR: GET https://kyc-api.surepass.io/api/v1/digilocker/download-aadhaar/{client_id}
  const url = `${SUREPASS_BASE}/api/v1/digilocker/download-aadhaar/${encodeURIComponent(clientId)}`;
  let res;
  let parsed;
  try {
    res = await fetch(url, { method: 'GET', headers: authHeaders() });
    parsed = await res.json().catch(() => null);
  } catch (err) {
    logger.warn({ efrId, clientId, err: err.message }, 'mobile-kyc: digilocker download threw');
    const e = new Error('KYC vendor is unreachable');
    e.status = 502;
    throw e;
  }

  // Consent not yet given → still pending, app should keep polling.
  if (parsed && parsed.message_code === 'aadhaar_consent_missing') {
    return { pending: true };
  }

  if (!isOk(parsed)) {
    logger.warn(
      { efrId, clientId, httpStatus: res.status, messageCode: parsed?.message_code },
      'mobile-kyc: digilocker download non-OK',
    );
    throw vendorError(parsed, 'DigiLocker Aadhaar download failed');
  }

  const d = parsed.data || {};
  return {
    aadhaarNumber: d.aadhaar_number || d.masked_aadhaar || null,
    name: d.name || null,
    dob: d.dob || null,
    gender: d.gender || null,
    address: d.address || null,
    fatherName: d.father_name || null,
    photo: d.photo || null,
  };
}

// ─── 2. PAN OCR (aadhaarkyc.io) ─────────────────────────────────────

/*
 * OCR a PAN card image. `file` is { buffer, mimetype, originalname } from multer
 * memoryStorage. Forwarded to the vendor as multipart/form-data field `file`
 * using the Node 18 global FormData + Blob (no form-data npm dep).
 */
async function panOcr(efrId, file) {
  assertConfigured();
  if (!file || !file.buffer) {
    const e = new Error('PAN image file is required (multipart field "file")');
    e.status = 400;
    throw e;
  }

  // VENDOR: POST https://kyc-api.aadhaarkyc.io/api/v1/ocr/pan  (multipart, field `file`)
  const url = `${AADHAARKYC_BASE}/api/v1/ocr/pan`;
  const form = new FormData();
  const blob = new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' });
  form.append('file', blob, file.originalname || 'pan.jpg');

  let res;
  let parsed;
  try {
    // NOTE: do NOT set Content-Type manually — fetch/FormData sets the
    // multipart boundary itself. Only the Authorization header is forwarded.
    res = await fetch(url, { method: 'POST', headers: authHeaders(), body: form });
    parsed = await res.json().catch(() => null);
  } catch (err) {
    logger.warn({ efrId, err: err.message }, 'mobile-kyc: PAN OCR threw');
    const e = new Error('KYC vendor is unreachable');
    e.status = 502;
    throw e;
  }
  if (!isOk(parsed)) {
    logger.warn(
      { efrId, httpStatus: res.status, messageCode: parsed?.message_code },
      'mobile-kyc: PAN OCR non-OK',
    );
    throw vendorError(parsed, 'PAN OCR failed');
  }

  const fields = (parsed.data && parsed.data.ocr_fields && parsed.data.ocr_fields[0]) || {};
  return {
    panNumber: fields.pan_number?.value || null,
    name: fields.full_name?.value || null,
    fatherName: fields.father_name?.value || null,
    dob: fields.dob?.value || null,
  };
}

// ─── 3. Aadhaar OTP (aadhaarkyc.io) ─────────────────────────────────

/*
 * Generate an OTP against an Aadhaar number. Returns the vendor client_id (used
 * to submit the OTP) plus whether the OTP was actually dispatched.
 */
async function aadhaarGenerateOtp(efrId, aadhaarNumber) {
  assertConfigured();
  // VENDOR: POST https://kyc-api.aadhaarkyc.io/api/v1/aadhaar-v2/generate-otp
  const url = `${AADHAARKYC_BASE}/api/v1/aadhaar-v2/generate-otp`;
  const out = await callVendorJson(efrId, 'aadhaar/generate-otp', url, {
    id_number: aadhaarNumber,
  });
  const d = out.data || {};
  return {
    clientId: d.client_id || null,
    otpSent: d.otp_sent ?? null,
  };
}

/*
 * Submit the OTP the user received. On success returns the verified KYC data.
 */
async function aadhaarSubmitOtp(efrId, clientId, otp) {
  assertConfigured();
  // VENDOR: POST https://kyc-api.aadhaarkyc.io/api/v1/aadhaar-v2/submit-otp
  const url = `${AADHAARKYC_BASE}/api/v1/aadhaar-v2/submit-otp`;
  const out = await callVendorJson(efrId, 'aadhaar/submit-otp', url, {
    client_id: clientId,
    otp,
  });
  const d = out.data || {};
  return {
    verified: true,
    name: d.full_name || null,
    dob: d.dob || null,
    gender: d.gender || null,
    address: d.address || null,
  };
}

// ─── 4. Bank verification (aadhaarkyc.io) ───────────────────────────

async function bankVerify(efrId, accountNumber, ifsc) {
  assertConfigured();
  // VENDOR: POST https://kyc-api.aadhaarkyc.io/api/v1/bank-verification/
  const url = `${AADHAARKYC_BASE}/api/v1/bank-verification/`;
  const out = await callVendorJson(efrId, 'bank/verify', url, {
    id_number: accountNumber,
    ifsc,
    ifsc_details: true,
  });
  const d = out.data || {};
  return {
    verified: true,
    accountHolderName: d.full_name || d.account_holder_name || null,
    accountNumber: d.account_number || accountNumber,
  };
}

// ─── 5. UPI verification (aadhaarkyc.io) ────────────────────────────

async function upiVerify(efrId, upiId) {
  assertConfigured();
  // VENDOR: POST https://kyc-api.aadhaarkyc.io/api/v1/bank-verification/upi-verification
  const url = `${AADHAARKYC_BASE}/api/v1/bank-verification/upi-verification`;
  const out = await callVendorJson(efrId, 'upi/verify', url, {
    upi_id: upiId,
  });
  const d = out.data || {};
  return {
    verified: true,
    name: d.name || d.full_name || null,
  };
}

module.exports = {
  digilockerInitialize,
  digilockerDownloadAadhaar,
  panOcr,
  aadhaarGenerateOtp,
  aadhaarSubmitOtp,
  bankVerify,
  upiVerify,
};
