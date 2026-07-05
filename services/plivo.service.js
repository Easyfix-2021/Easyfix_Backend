const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const logger = require('../logger');
const { getProperty } = require('./properties.service');

/*
 * Plivo voice integration (2026-06-17). Alternative click-to-call provider
 * alongside Kaleyra. DISABLED by default — gated on the easyfix_properties key
 * `plivo.calling.enabled`; stays off until real credentials + a Plivo caller-ID
 * number are configured.
 *
 * Unlike Kaleyra's single GET `dial.click2call` bridge, Plivo has no one-shot
 * bridge. We place an OUTBOUND call to the AGENT's phone, FROM a Plivo DID, and
 * hand Plivo an `answer_url` that returns call-control XML dialing the SECOND
 * leg (the customer) once the agent answers:
 *
 *   POST https://api.plivo.com/v1/Account/{AUTH_ID}/Call/   (HTTP Basic auth)
 *     { from: <PLIVO_CALLER_ID>, to: <agent>,
 *       answer_url: <BASE>/api/public/plivo/answer?t=<token>   (GET → XML),
 *       ring_url:   <BASE>/api/webhook/plivo/ring?t=<token>    (POST),
 *       hangup_url: <BASE>/api/webhook/plivo/hangup?t=<token>  (POST) }
 *
 *   answer XML: <Response><Dial callerId="<PLIVO_CALLER_ID>">
 *                 <Number>{customer}</Number></Dial></Response>
 *
 * The `token` is a short-lived signed JWT carrying the destination (customer)
 * number + the tbl_job_caller_info id, so (a) the destination is never in a raw
 * URL, (b) the callbacks self-identify which call row to update without
 * matching on provider ids. Real-time status (ringing / answered / hangup)
 * arrives on those callback URLs → the webhook updates the call row → the FE
 * polls it. Same env-override + masking semantics as kaleyra.service.js.
 */

const BASE = (process.env.PLIVO_BASE_URL || 'https://api.plivo.com/v1').replace(/\/+$/, '');
const TOKEN_TTL_SEC = 15 * 60; // answer/ring/hangup callbacks all fire well within 15 min

function callingEnabled() {
  return String(getProperty('plivo.calling.enabled')).toLowerCase() === 'true';
}

// Whether to record the bridged conversation. OFF by default — flip the
// easyfix_properties key `plivo.recording.enabled` to 'true' ONLY after
// compliance/consent sign-off (recording customer calls). No redeploy needed
// (properties are DB-backed). See buildAnswerXml + GET /admin/calls/:id/recording.
function recordingEnabled() {
  return String(getProperty('plivo.recording.enabled')).toLowerCase() === 'true';
}

// The publicly-reachable BACKEND base URL Plivo will call back on (NOT the CRM
// UI). Must terminate at this Express app, e.g. https://core.easyfix.in.
function callbackBase() {
  return (process.env.PLIVO_CALLBACK_BASE_URL || process.env.PUBLIC_API_BASE_URL || '').replace(/\/+$/, '');
}

function tokenSecret() {
  return process.env.PLIVO_ANSWER_TOKEN_SECRET || process.env.JWT_SECRET;
}

function normaliseIndianPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return null;
}

function maskForDisplay(raw) {
  if (raw == null) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length <= 4) return d;
  return d.slice(0, 4) + '•'.repeat(d.length - 4);
}

/*
 * Same env-override waterfall + guards as kaleyra.service.js::resolveCallLegs,
 * keyed on PLIVO_* vars so the two providers can be tested independently.
 * `caller` = the agent leg Plivo rings first; `receiver` = the customer the
 * answer-XML bridges to.
 */
function resolveCallLegs({ from, to, alwaysApplyEnvOverride = false }) {
  const callerReal = normaliseIndianPhone(from);
  const receiverReal = normaliseIndianPhone(to);
  if (!callerReal) return { ok: false, error: `invalid caller phone "${from}"` };
  if (!receiverReal) return { ok: false, error: `invalid receiver phone "${to}"` };

  let caller = callerReal;
  let receiver = receiverReal;
  const overrides = [];
  const customNumberMode = String(process.env.PLIVO_CALLING_CUSTOM_NUMBER).toLowerCase() === 'true';

  if (!customNumberMode || alwaysApplyEnvOverride) {
    const envFrom = process.env.PLIVO_CALL_FROM;
    if (envFrom && envFrom.trim()) {
      const v = normaliseIndianPhone(envFrom);
      if (v) { caller = v; overrides.push(`from=${callerReal}→${caller} (PLIVO_CALL_FROM)`); }
      else logger.warn(`PLIVO_CALL_FROM='${envFrom}' is not a valid Indian phone — ignored.`);
    }
    const envTo = process.env.PLIVO_CALL_TO;
    if (envTo && envTo.trim()) {
      const v = normaliseIndianPhone(envTo);
      if (v) { receiver = v; overrides.push(`to=${receiverReal}→${receiver} (PLIVO_CALL_TO)`); }
      else logger.warn(`PLIVO_CALL_TO='${envTo}' is not a valid Indian phone — ignored.`);
    }
    if (overrides.length) logger.test(`Plivo dev-override · ${overrides.join(' · ')}`);
  }

  if (alwaysApplyEnvOverride && customNumberMode) {
    const fromStillReal = caller === callerReal;
    const toStillReal = receiver === receiverReal;
    if (fromStillReal || toStillReal) {
      const which = [fromStillReal && 'PLIVO_CALL_FROM', toStillReal && 'PLIVO_CALL_TO'].filter(Boolean).join(' and ');
      logger.test(`Plivo call suppressed (operator-less QA, no valid test redirect) · set ${which}.`);
      return { ok: false, suppressed: true, diagnostic: 'qa_missing_test_redirect', callerReal, receiverReal };
    }
  }

  if (caller === receiver) {
    logger.warn(`Plivo call refused — caller==receiver (${caller}). Cannot bridge a line to itself.`);
    return { ok: false, sameNumber: true, error: `Cannot place call — caller and receiver are the same number (${caller}).`, diagnostic: 'caller_equals_receiver', callerReal, receiverReal };
  }

  return { ok: true, callerReal, receiverReal, caller, receiver, overridden: caller !== callerReal || receiver !== receiverReal };
}

function previewCallLegs({ from, to, alwaysApplyEnvOverride = false }) {
  const legs = resolveCallLegs({ from, to, alwaysApplyEnvOverride });
  if (legs.ok) {
    return { from: maskForDisplay(legs.caller), to: maskForDisplay(legs.receiver), overridden: legs.overridden };
  }
  return {
    from: maskForDisplay(legs.callerReal),
    to: maskForDisplay(legs.receiverReal),
    suppressed: !!legs.suppressed,
    sameNumber: !!legs.sameNumber,
    diagnostic: legs.diagnostic || null,
    error: legs.error || null,
  };
}

// ── Call token: signs the destination + call row id into the callback URLs ──
function signCallToken({ dest, jci }) {
  return jwt.sign({ dest, jci }, tokenSecret(), { expiresIn: TOKEN_TTL_SEC });
}
function verifyCallToken(t) {
  try { return jwt.verify(t, tokenSecret()); } catch { return null; }
}

// Plivo call-control XML the public answer route returns when the agent picks
// up — bridges to the customer leg. callerId is the Plivo DID.
//
// Recording (2026-07-03): `record="true"` on <Dial> records the bridged
// conversation server-side at Plivo (dual-channel mp3). We do NOT set a
// recordingCallbackUrl — the recording is fetched LAZILY on demand (only when
// an operator plays it) via the Plivo Recording API keyed by CallUUID, then
// cached to our S3, so we don't store audio nobody listens to. Gated on
// `plivo.recording.enabled` by the caller so it can be turned off without a
// deploy. ⚠️ Recording customer calls needs compliance/consent sign-off.
function buildAnswerXml(dest, { record = false } = {}) {
  const callerId = process.env.PLIVO_CALLER_ID || '';
  const num = String(dest || '').replace(/[^0-9]/g, '');
  const dialAttrs = record
    ? ` callerId="${callerId}" record="true" recordFileFormat="mp3"`
    : ` callerId="${callerId}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Dial${dialAttrs}><Number>${num}</Number></Dial></Response>`;
}

function authHeader() {
  const id = process.env.PLIVO_AUTH_ID;
  const token = process.env.PLIVO_AUTH_TOKEN;
  if (!id || !token) return null;
  return 'Basic ' + Buffer.from(`${id}:${token}`).toString('base64');
}

/*
 * Place the bridge call. `from` = agent (rung first), `to` = customer (bridged
 * via answer XML). `jobCallerInfoId` ties the callbacks back to the audit row.
 * Returns the normalised contract (delivered / callId / diagnostic …) using
 * Plivo's request_uuid as callId.
 */
async function clickToCall({ from, to, jobCallerInfoId, alwaysApplyEnvOverride = false }) {
  const callerReal = normaliseIndianPhone(from);
  const receiverReal = normaliseIndianPhone(to);
  if (!callerReal) return { delivered: false, error: `invalid caller phone "${from}"` };
  if (!receiverReal) return { delivered: false, error: `invalid receiver phone "${to}"` };

  logger.info('Plivo click-to-call · jci=' + jobCallerInfoId + ' · agent=' + maskForDisplay(callerReal) + ' · customer=' + maskForDisplay(receiverReal));
  if (!callingEnabled()) {
    logger.test(`Plivo call suppressed (plivo.calling.enabled!='true') · from=${callerReal} · to=${receiverReal}`);
    return { delivered: false, suppressed: true, disabled: true };
  }
  const auth = authHeader();
  if (!auth || !process.env.PLIVO_AUTH_ID) return { delivered: false, error: 'PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN not configured' };
  if (!process.env.PLIVO_CALLER_ID) return { delivered: false, error: 'PLIVO_CALLER_ID not configured' };
  const base = callbackBase();
  if (!base) return { delivered: false, error: 'PLIVO_CALLBACK_BASE_URL not configured (public backend URL Plivo calls back on)' };

  const legs = resolveCallLegs({ from, to, alwaysApplyEnvOverride });
  if (legs.suppressed) return { delivered: false, suppressed: true, diagnostic: legs.diagnostic };
  if (legs.sameNumber) return { delivered: false, error: legs.error, diagnostic: legs.diagnostic };
  if (!legs.ok) return { delivered: false, error: legs.error };
  const { caller, receiver } = legs; // caller = agent leg, receiver = customer

  const token = signCallToken({ dest: receiver, jci: jobCallerInfoId });
  const cb = (path) => `${base}${path}?t=${encodeURIComponent(token)}`;
  const body = {
    from: process.env.PLIVO_CALLER_ID,
    to: caller, // ring the agent first; the answer XML bridges to the customer
    answer_url: cb('/api/public/plivo/answer'),
    answer_method: 'GET',
    ring_url: cb('/api/webhook/plivo/ring'),
    ring_method: 'POST',
    hangup_url: cb('/api/webhook/plivo/hangup'),
    hangup_method: 'POST',
  };

  const url = `${BASE}/Account/${encodeURIComponent(process.env.PLIVO_AUTH_ID)}/Call/`;
  logger.info(`Plivo REQ · from=${process.env.PLIVO_CALLER_ID} · agent=${caller} · customer=${maskForDisplay(receiver)}`);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* leave null */ }
    // Plivo returns 201 + { request_uuid: [ "..." ], message: "call fired" }.
    const ru = parsed?.request_uuid;
    const callId = Array.isArray(ru) ? ru[0] : ru || null;
    const accepted = (res.status === 200 || res.status === 201) && !!callId;
    const bodyForLog = (text || '').slice(0, 500).replace(/\s+/g, ' ');
    if (accepted) {
      logger.info(`📞 Plivo ACCEPTED · agent=${caller} · customer=${maskForDisplay(receiver)} · request_uuid=${callId} · body=${bodyForLog}`);
    } else {
      logger.warn(`✗ Plivo FAIL · http=${res.status} · body=${bodyForLog}`);
    }
    return {
      delivered: accepted,
      callId,
      providerResponse: text,
      providerStatus: parsed?.message || null,
      providerError: accepted ? null : (parsed?.error || parsed?.message || `HTTP ${res.status}`),
      httpStatus: res.status,
      overridden: caller !== callerReal || receiver !== receiverReal,
      diagnostic: accepted ? null : 'plivo_http_error',
    };
  } catch (err) {
    logger.error(`Plivo call network error · ${err.message}`);
    return { delivered: false, error: err.message, diagnostic: 'network_error' };
  }
}

// Terminate a live call. Plivo hangup is by CallUUID (captured from the first
// ring/answer/hangup callback and stored on the audit row).
async function hangupCall({ callUuid }) {
  logger.info('Plivo hangup requested · uuid=' + callUuid);
  if (!callUuid) return { ok: false, error: 'callUuid required' };
  const auth = authHeader();
  if (!auth || !process.env.PLIVO_AUTH_ID) return { ok: false, error: 'PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN not configured' };
  const url = `${BASE}/Account/${encodeURIComponent(process.env.PLIVO_AUTH_ID)}/Call/${encodeURIComponent(callUuid)}/`;
  try {
    const res = await fetch(url, { method: 'DELETE', headers: { Authorization: auth } });
    const ok = res.status === 204 || res.ok;
    if (!ok) logger.warn(`Plivo hangup FAIL · uuid=${callUuid} · http=${res.status}`);
    else logger.info('Plivo call terminated · uuid=' + callUuid + ' · http=' + res.status);
    return { ok, httpStatus: res.status };
  } catch (err) {
    logger.error(`Plivo hangup network error · uuid=${callUuid} · ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/*
 * Look up a call's recording by CallUUID via the Plivo Recording API
 * (GET /Account/{id}/Recording/?call_uuid=…). Returns the first recording's
 * hosted URL + duration/id, or { url: null } when none exists yet (Plivo may
 * lag a few seconds after hangup, or recording was off for this call).
 */
async function fetchRecordingMeta({ callUuid }) {
  if (!callUuid) return { ok: false, error: 'callUuid required', url: null };
  const auth = authHeader();
  if (!auth || !process.env.PLIVO_AUTH_ID) {
    return { ok: false, error: 'PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN not configured', url: null };
  }
  const url = `${BASE}/Account/${encodeURIComponent(process.env.PLIVO_AUTH_ID)}/Recording/?call_uuid=${encodeURIComponent(callUuid)}`;
  try {
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) {
      logger.warn(`Plivo recording lookup FAIL · uuid=${callUuid} · http=${res.status}`);
      return { ok: false, httpStatus: res.status, url: null };
    }
    const body = await res.json();
    const first = Array.isArray(body?.objects) ? body.objects[0] : null;
    return {
      ok: true,
      url: first?.recording_url || null,
      recordingId: first?.recording_id || null,
      duration: first?.recording_duration != null ? Number(first.recording_duration) : null,
    };
  } catch (err) {
    logger.error(`Plivo recording lookup network error · uuid=${callUuid} · ${err.message}`);
    return { ok: false, error: err.message, url: null };
  }
}

/*
 * Download the recording bytes from a Plivo-hosted recording URL. Plivo
 * recording URLs sit on api.plivo.com and require the same HTTP Basic auth as
 * every other call. Returns the raw Buffer + content-type for S3 upload.
 */
async function downloadRecording(recordingUrl) {
  if (!recordingUrl) return { ok: false, error: 'recordingUrl required' };
  const auth = authHeader();
  try {
    const res = await fetch(recordingUrl, { headers: auth ? { Authorization: auth } : {} });
    if (!res.ok) {
      logger.warn(`Plivo recording download FAIL · http=${res.status}`);
      return { ok: false, httpStatus: res.status };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: true, buffer, contentType: res.headers.get('content-type') || 'audio/mpeg' };
  } catch (err) {
    logger.error(`Plivo recording download network error · ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ── Web (browser / WebRTC) calling ───────────────────────────────────────────
// The Plivo Browser SDK logs in as a Plivo ENDPOINT (username/password) and
// places calls into our Voice Application; the app's Answer URL then bridges to
// the customer. To preserve the masking invariant — the real customer number
// must NEVER reach the browser — the FE dials an OPAQUE one-time id; the public
// answer route (/api/public/plivo/web-answer) resolves it back to the real
// number server-side and returns the Dial XML.
function webEndpoint() {
  const username = (process.env.PLIVO_ENDPOINT_USERNAME || '').trim();
  const password = process.env.PLIVO_ENDPOINT_PASSWORD || '';
  if (!username || !password) return null;
  return { username, password, appId: (process.env.PLIVO_WEB_APP_ID || '').trim() || null };
}

/*
 * Per-operator Plivo access token (replaces handing the endpoint password to the
 * browser). A short-lived JWT (HS256, signed with the Auth Token) the Browser
 * SDK logs in with via client.loginWithAccessToken(). Each operator gets their
 * own 1-hour token (unique jti) on the shared endpoint — no shared password
 * crosses the wire, tokens expire, and the jti ties a session to an operator.
 * Plivo token spec: header carries cty='plivo;v=1'; payload iss=AuthID,
 * sub=endpoint, nbf/exp, per.voice grants, app=AppID. Outgoing-only.
 */
function webAccessToken({ operatorId } = {}) {
  const authId = (process.env.PLIVO_AUTH_ID || '').trim();
  const authToken = process.env.PLIVO_AUTH_TOKEN || '';
  const endpoint = (process.env.PLIVO_ENDPOINT_USERNAME || '').trim();
  if (!authId || !authToken || !endpoint) {
    logger.warn('Plivo web access token unavailable · Plivo endpoint credentials not configured');
    return null;
  }
  logger.info('Issuing Plivo web access token · operatorId=' + (operatorId || 'op'));
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: authId,
    sub: endpoint,
    nbf: now - 5,
    exp: now + 3600,                 // 1 hour
    jti: `efweb-${operatorId || 'op'}-${now}-${crypto.randomBytes(4).toString('hex')}`,
    per: { voice: { incoming_allow: false, outgoing_allow: true } },
  };
  const appId = (process.env.PLIVO_WEB_APP_ID || '').trim();
  if (appId) payload.app = appId;
  return jwt.sign(payload, authToken, {
    algorithm: 'HS256',
    header: { cty: 'plivo;v=1', typ: 'JWT' },
  });
}

// In-process one-time dial store: dialId → { number, jci, expires }. Single-
// process only — a multi-replica deploy needs Redis here (same caveat as the
// live-status SSE follow-up). 2-min TTL spans click→answer; consumed on first
// resolve so a guessed/replayed dialId can neither re-trigger a dial nor leak a
// number.
const WEB_DIAL_TTL_MS = 2 * 60 * 1000;
const _webDials = new Map();
function stashWebDial({ number, jci }) {
  const now = Date.now();
  for (const [k, v] of _webDials) if (v.expires <= now) _webDials.delete(k); // sweep
  const id = crypto.randomBytes(16).toString('hex');
  _webDials.set(id, { number, jci, expires: now + WEB_DIAL_TTL_MS });
  return id;
}
function resolveWebDial(id) {
  const key = String(id || '');
  const v = _webDials.get(key);
  if (!v) return null;
  _webDials.delete(key); // one-time use
  if (v.expires <= Date.now()) return null;
  return { number: v.number, jci: v.jci };
}

module.exports = {
  clickToCall,
  previewCallLegs,
  resolveCallLegs,
  hangupCall,
  recordingEnabled,
  fetchRecordingMeta,
  downloadRecording,
  normaliseIndianPhone,
  signCallToken,
  verifyCallToken,
  buildAnswerXml,
  callingEnabled,
  maskForDisplay,
  webEndpoint,
  webAccessToken,
  stashWebDial,
  resolveWebDial,
};
