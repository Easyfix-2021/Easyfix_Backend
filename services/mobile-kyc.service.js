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
const sophy = require('./sophy.service');
const { matchNames } = require('../utils/name-match');

// ─── Vendor base URLs ───────────────────────────────────────────────
// VENDOR: SurePass DigiLocker
const SUREPASS_BASE = 'https://kyc-api.surepass.io';
// VENDOR: aadhaarkyc.io (PAN OCR, Aadhaar OTP, bank + UPI verification)
const AADHAARKYC_BASE = 'https://kyc-api.aadhaarkyc.io';

// Hard ceiling on every outbound vendor call. KYC vendors can hang; without a
// timeout a slow vendor ties up the Express worker AND the app's poll loop.
// `AbortSignal.timeout` (Node 18+) aborts the fetch and throws a DOMException
// with name 'TimeoutError', which unreachableError() maps to a clean 504.
const VENDOR_TIMEOUT_MS = 15000;

// ─── Auth / config ──────────────────────────────────────────────────
/*
 * The RAW token, with any "Bearer " the operator pasted in stripped off.
 *
 * SUREPASS_VERIFICATION_KEY is meant to hold the bare token — authHeaders()
 * below adds the single `Bearer ` prefix the vendor expects. But the value is
 * copied by hand out of a dashboard or a curl example, and those show it
 * already prefixed, so `Bearer eyJ...` lands in the env sooner or later. That
 * produced `Authorization: Bearer Bearer eyJ...` and a 401 from every vendor
 * call — an auth failure whose cause is invisible in the env var, because the
 * value LOOKS right.
 *
 * Normalising here means both forms work and neither can double up. Trailing
 * whitespace and stray quotes go too: a key pasted into a .env as
 * "eyJ..." (quoted) or with a trailing newline fails the same silent way.
 */
function verificationKey() {
  return String(process.env.SUREPASS_VERIFICATION_KEY || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^Bearer\s+/i, '')
    .trim();
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

// Maps a thrown fetch/transport error to a clean status: a vendor timeout
// (AbortSignal.timeout → DOMException 'TimeoutError') becomes a 504; any other
// transport failure stays a 502 ("vendor unreachable" from the app's POV).
function unreachableError(err) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    const e = new Error('KYC vendor timed out');
    e.status = 504;
    return e;
  }
  const e = new Error('KYC vendor is unreachable');
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
      signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS),
    });
    parsed = await res.json().catch(() => null);
  } catch (err) {
    logger.warn({ efrId, label, err: err.message }, 'mobile-kyc: vendor call threw');
    throw unreachableError(err);
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
  logger.info('KYC DigiLocker initialize');
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
  logger.info('KYC DigiLocker session created · clientId=' + (d.client_id || '-'));
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
  logger.info('KYC DigiLocker download Aadhaar · clientId=' + (clientId || '-'));
  assertConfigured();
  // VENDOR: GET https://kyc-api.surepass.io/api/v1/digilocker/download-aadhaar/{client_id}
  const url = `${SUREPASS_BASE}/api/v1/digilocker/download-aadhaar/${encodeURIComponent(clientId)}`;
  let res;
  let parsed;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: authHeaders(),
      signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS),
    });
    parsed = await res.json().catch(() => null);
  } catch (err) {
    logger.warn({ efrId, clientId, err: err.message }, 'mobile-kyc: digilocker download threw');
    throw unreachableError(err);
  }

  // Consent not yet given → still pending, app should keep polling.
  if (parsed && parsed.message_code === 'aadhaar_consent_missing') {
    logger.info('KYC DigiLocker Aadhaar still pending (consent missing) · clientId=' + (clientId || '-'));
    return { pending: true };
  }

  if (!isOk(parsed)) {
    logger.warn('KYC DigiLocker download non-OK · clientId=' + (clientId || '-') + ' httpStatus=' + res.status);
    logger.warn(
      { efrId, clientId, httpStatus: res.status, messageCode: parsed?.message_code },
      'mobile-kyc: digilocker download non-OK',
    );
    throw vendorError(parsed, 'DigiLocker Aadhaar download failed');
  }

  logger.info('KYC DigiLocker Aadhaar downloaded · clientId=' + (clientId || '-'));
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
  logger.info('KYC PAN OCR · bytes=' + (file && file.buffer ? file.buffer.length : 0));
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
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
      signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS),
    });
    parsed = await res.json().catch(() => null);
  } catch (err) {
    logger.warn({ efrId, err: err.message }, 'mobile-kyc: PAN OCR threw');
    throw unreachableError(err);
  }
  if (!isOk(parsed)) {
    logger.warn(
      { efrId, httpStatus: res.status, messageCode: parsed?.message_code },
      'mobile-kyc: PAN OCR non-OK',
    );
    throw vendorError(parsed, 'PAN OCR failed');
  }

  logger.info('KYC PAN OCR completed');
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
  logger.info('KYC Aadhaar generate OTP');
  assertConfigured();
  // VENDOR: POST https://kyc-api.aadhaarkyc.io/api/v1/aadhaar-v2/generate-otp
  const url = `${AADHAARKYC_BASE}/api/v1/aadhaar-v2/generate-otp`;
  const out = await callVendorJson(efrId, 'aadhaar/generate-otp', url, {
    id_number: aadhaarNumber,
  });
  const d = out.data || {};
  logger.info('KYC Aadhaar OTP requested · clientId=' + (d.client_id || '-') + ' otpSent=' + (d.otp_sent ?? '-'));
  return {
    clientId: d.client_id || null,
    otpSent: d.otp_sent ?? null,
  };
}

/*
 * Submit the OTP the user received. On success returns the verified KYC data.
 */
async function aadhaarSubmitOtp(efrId, clientId, otp) {
  logger.info('KYC Aadhaar submit OTP · clientId=' + (clientId || '-'));
  assertConfigured();
  // VENDOR: POST https://kyc-api.aadhaarkyc.io/api/v1/aadhaar-v2/submit-otp
  const url = `${AADHAARKYC_BASE}/api/v1/aadhaar-v2/submit-otp`;
  const out = await callVendorJson(efrId, 'aadhaar/submit-otp', url, {
    client_id: clientId,
    otp,
  });
  const d = out.data || {};
  logger.info('KYC Aadhaar verified · clientId=' + (clientId || '-'));
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
  logger.info('KYC bank verify');
  assertConfigured();
  // VENDOR: POST https://kyc-api.aadhaarkyc.io/api/v1/bank-verification/
  const url = `${AADHAARKYC_BASE}/api/v1/bank-verification/`;
  const out = await callVendorJson(efrId, 'bank/verify', url, {
    id_number: accountNumber,
    ifsc,
    ifsc_details: true,
  });
  const d = out.data || {};
  /*
   * THE VERDICT IS IN THE BODY, NOT THE ENVELOPE.
   *
   * The vendor reports a non-existent / closed account as
   * `data.account_exists: false` INSIDE a `success: true`, `status_code: 200`
   * envelope. callVendorJson's isOk() check above therefore cannot catch it —
   * it only sees a healthy envelope and returns normally. Until 2026-08-24
   * this function returned `verified: true` unconditionally, so a typo'd or
   * closed account was recorded as a verified payout destination and only
   * surfaced days later as a silently failed payout.
   *
   * ponytail: only an EXPLICIT `false` is treated as a negative verdict. If
   * the field is absent we keep the previous behaviour and log, rather than
   * fail closed — the vendor contracts in this file were reverse-engineered
   * from the legacy Flutter app and were never live-tested, so a field rename
   * would otherwise take every bank save down at once. Tighten to
   * `=== true` once the warn below has stayed silent in prod for a while.
   */
  if (d.account_exists === undefined) {
    logger.warn('KYC bank verify · vendor omitted account_exists — treating as verified');
  }
  const verified = d.account_exists !== false;
  logger.info('KYC bank account verify complete · exists=' + (d.account_exists ?? 'absent'));
  return {
    verified,
    accountExists: d.account_exists ?? null,
    // NEVER logged — the holder name is PII (see utils/name-match.js header).
    accountHolderName: d.full_name || d.account_holder_name || null,
    accountNumber: d.account_number || accountNumber,
    remarks: d.remarks || null,
    clientId: d.client_id || null,
  };
}

// ─── 5. UPI verification (aadhaarkyc.io) ────────────────────────────

async function upiVerify(efrId, upiId) {
  logger.info('KYC UPI verify');
  assertConfigured();
  // VENDOR: POST https://kyc-api.aadhaarkyc.io/api/v1/bank-verification/upi-verification
  const url = `${AADHAARKYC_BASE}/api/v1/bank-verification/upi-verification`;
  const out = await callVendorJson(efrId, 'upi/verify', url, {
    upi_id: upiId,
  });
  const d = out.data || {};
  logger.info('KYC UPI verified');
  return {
    verified: true,
    name: d.name || d.full_name || null,
  };
}


// ─── 6. Aadhaar OCR (AI extraction — Sophy, NOT a KYC vendor) ───────
/*
 * Reads the FRONT + BACK Aadhaar photos the technician just uploaded and asks
 * Sophy (the central LLM gateway) to extract the printed fields, then compares
 * the extracted name with the name the technician typed on the same screen.
 *
 * DIFFERENT PROVIDER, DIFFERENT KEY: this is the ONE function in this file that
 * does NOT talk to SurePass/aadhaarkyc.io and does NOT call assertConfigured().
 * It uses its own per-feature Sophy key (`SOPHY_API_KEY_AADHAAR_OCR`) per the
 * gateway's no-global-fallback rule — no key ⇒ the feature is simply disabled.
 *
 * SOFT DEGRADE: every failure path (no key, gateway error, non-JSON reply,
 * model refusal, nothing legible) returns `{available:false, extracted:null,
 * nameMatch:null}` and the ROUTE still answers 200. A failed extraction must
 * NEVER surface as a name match — matched:true requires a real extraction.
 *
 * READ-ONLY: nothing here is persisted. Saving the identity fields stays with
 * the existing identity-details save.
 *
 * PII: the images, the extracted fields and the typed name are all PII. Log
 * byte counts and booleans only — never a value.
 */

/*
 * Payload ceilings, derived from SOPHY'S limit rather than guessed from what an
 * Aadhaar photo happens to weigh.
 *
 * Sophy runs on Vercel, whose serverless functions reject a request body over
 * 4.5 MB. Sophy's own upload route sets MAX_UPLOAD_BYTES = 4 MB with the comment
 * "stays under the 4.5 MB function body cap" — so 4.5 MB is the hard wall for
 * anything we POST to /v1/chat/completions too, images included.
 *
 * base64 inflates by 4/3, and it is plain ASCII inside the JSON body, so the
 * combined base64 IS very nearly the whole request. Budgeting 3.5 MB leaves
 * ~1 MB for the prompt and the JSON envelope.
 *
 * The per-image cap is then set so TWO images at the maximum still fit under the
 * total: 1.25 MiB raw → ~1.67 MiB base64, × 2 = ~3.33 MiB < 3.5 MiB. That
 * matters — with the previous 5 MB / 12 MiB pair the per-image limit was
 * UNREACHABLE for a pair, so two images that each passed the documented 5 MB
 * check still failed later with a different, numberless error.
 *
 * Headroom against the real client: the app compresses every upload to <= 500 KB
 * (see prepareJpegUpload), i.e. ~683 KB of base64 each and ~1.33 MB combined —
 * about 2.6x under the total, and 2.5x under the per-image cap.
 *
 * Going over these does not fail loudly upstream: Sophy would reject the body at
 * its platform layer, chatVision would return null, and the endpoint would answer
 * available:false — indistinguishable from "no key" or "unreadable card". So the
 * bound has to be enforced HERE, where we can still say why.
 */
const AADHAAR_MAX_IMAGE_BYTES = Math.floor(1.25 * 1024 * 1024);
const AADHAAR_MAX_TOTAL_BASE64 = Math.floor(3.5 * 1024 * 1024);
const MB = (bytes) => `${Math.round((bytes / (1024 * 1024)) * 100) / 100} MB`;
const AADHAAR_ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

// This feature's OWN Sophy key. No fallback to another feature's key.
function aadhaarOcrKey() {
  return process.env.SOPHY_API_KEY_AADHAAR_OCR || '';
}

// Logged once per process, not per request.
let aadhaarOcrDisabledLogged = false;

const AADHAAR_OCR_PROMPT = [
  'You are reading photographs of an Indian Aadhaar card.',
  'The FIRST image is the FRONT of the card, the SECOND image is the BACK.',
  'Return STRICT JSON only — no markdown, no fences, no prose — with EXACTLY these keys:',
  '{"name":null,"dob":null,"aadhaarNumber":null,"gender":null,"fatherName":null,"address":null}',
  'Rules:',
  '- Use null for ANY field you cannot read confidently. Never guess, never invent a value.',
  '- "name" is the cardholder name in English/Latin script, exactly as printed.',
  '- "dob" must be normalised to YYYY-MM-DD. If only a year of birth is printed, return null.',
  '- "aadhaarNumber" is the 12 digits with every space removed. If you cannot read all 12, return null.',
  '- "gender" is "M" for male, "F" for female, "O" for anything else.',
  '- "fatherName" only when the card prints S/O, D/O, C/O or "Father"; otherwise null.',
  '- "address" is the address printed on the back, flattened to one line.',
  '- If these images are not an Aadhaar card, return every field as null.',
].join('\n');

function aadhaarImage(file, field) {
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) {
    const e = new Error(`Aadhaar ${field} image is required (multipart field "${field}")`);
    e.status = 400;
    throw e;
  }
  if (file.buffer.length > AADHAAR_MAX_IMAGE_BYTES) {
    const e = new Error(`Aadhaar ${field} image must be ${MB(AADHAAR_MAX_IMAGE_BYTES)} or smaller`);
    e.status = 400;
    throw e;
  }
  const mimeType = AADHAAR_ALLOWED_MIME.has(String(file.mimetype || '').toLowerCase())
    ? file.mimetype.toLowerCase()
    : 'image/jpeg';
  return { mimeType, base64: file.buffer.toString('base64') };
}

function cleanText(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t && t.length <= max ? t : null;
}

// A real calendar date in YYYY-MM-DD, and not in the future.
function cleanDob(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null;
  const t = v.trim();
  const d = new Date(`${t}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t) return null;
  return d.getTime() > Date.now() ? null : t;
}

function cleanAadhaar(v) {
  const digits = String(v == null ? '' : v).replace(/\D/g, '');
  return digits.length === 12 ? digits : null;
}

/*
 * The prompt asks for 'M' / 'F' / 'O' and nothing else, so the vocabulary is
 * CLOSED: anything outside it is a field the model could not read, NOT an
 * "other". Coercing it to 'O' invented a gender the card never printed AND kept
 * an otherwise-illegible extraction alive, because validateExtraction needs only
 * ONE non-null field. A card that genuinely prints a third gender still reads as
 * 'O' through the spellings below. Matching is exact, never by prefix — 'MADE
 * IN INDIA' is not male.
 */
function cleanGender(v) {
  const g = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toUpperCase();
  if (g === 'M' || g === 'MALE') return 'M';
  if (g === 'F' || g === 'FEMALE') return 'F';
  if (/^(O|OTHER|T|TG|TRANSGENDER|THIRD GENDER)$/.test(g)) return 'O';
  return null;
}

/*
 * Never trust the model's shape: coerce every field and drop whatever fails.
 * Returns null when the reply is not an object, or when NOTHING legible came
 * back — "parsed but empty" is not an extraction, so it degrades to
 * available:false rather than an all-null "successful" read.
 */
function validateExtraction(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const extracted = {
    name: cleanText(parsed.name, 120),
    dob: cleanDob(parsed.dob),
    aadhaarNumber: cleanAadhaar(parsed.aadhaarNumber),
    gender: cleanGender(parsed.gender),
    fatherName: cleanText(parsed.fatherName, 120),
    address: cleanText(parsed.address, 400),
  };
  return Object.values(extracted).some((v) => v !== null) ? extracted : null;
}

const AADHAAR_UNAVAILABLE = { available: false, extracted: null, nameMatch: null };

async function aadhaarOcr(efrId, frontFile, backFile, typedName) {
  const front = aadhaarImage(frontFile, 'front');
  const back = aadhaarImage(backFile, 'back');
  const expected = typeof typedName === 'string' ? typedName.trim() : '';

  const apiKey = aadhaarOcrKey();
  if (!sophy.enabled(apiKey)) {
    if (!aadhaarOcrDisabledLogged) {
      aadhaarOcrDisabledLogged = true;
      logger.warn('KYC Aadhaar OCR is disabled · SOPHY_API_KEY_AADHAAR_OCR is not set');
    }
    return { ...AADHAAR_UNAVAILABLE };
  }

  if (front.base64.length + back.base64.length > AADHAAR_MAX_TOTAL_BASE64) {
    const e = new Error(
      `Aadhaar images are too large to process together — each must be `
      + `${MB(AADHAAR_MAX_IMAGE_BYTES)} or smaller. Please retake them.`,
    );
    e.status = 400;
    throw e;
  }

  logger.info(
    'KYC Aadhaar OCR · frontBytes=' + frontFile.buffer.length
    + ' · backBytes=' + backFile.buffer.length,
  );
  const reply = await sophy.chatVision({
    system: AADHAAR_OCR_PROMPT,
    user: 'Extract the fields from these two Aadhaar images.',
    images: [front, back],
    maxTokens: 700,
    apiKey,
  });
  const extracted = validateExtraction(sophy.parseJsonLoose(reply));
  if (!extracted) {
    logger.warn({ efrId, available: false }, 'mobile-kyc: Aadhaar OCR produced no usable extraction');
    return { ...AADHAAR_UNAVAILABLE };
  }

  // A verdict needs BOTH sides. No typed name ⇒ no verdict; a name the model
  // could not READ is an ABSENT comparison too, not a failed one — reporting
  // {matched:false, found:null} is indistinguishable on the wire from a genuine
  // mismatch, and the app renders it as one.
  const nameMatch = expected && extracted.name ? matchNames(expected, extracted.name) : null;
  logger.info(
    'KYC Aadhaar OCR completed · available=true · matched='
    + (nameMatch ? nameMatch.matched : 'n/a'),
  );
  return { available: true, extracted, nameMatch };
}

module.exports = {
  digilockerInitialize,
  digilockerDownloadAadhaar,
  panOcr,
  aadhaarGenerateOtp,
  aadhaarSubmitOtp,
  bankVerify,
  upiVerify,
  aadhaarOcr,
};
