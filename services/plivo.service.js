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
function buildAnswerXml(dest) {
  const callerId = process.env.PLIVO_CALLER_ID || '';
  const num = String(dest || '').replace(/[^0-9]/g, '');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Dial callerId="${callerId}"><Number>${num}</Number></Dial></Response>`;
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
  if (!callUuid) return { ok: false, error: 'callUuid required' };
  const auth = authHeader();
  if (!auth || !process.env.PLIVO_AUTH_ID) return { ok: false, error: 'PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN not configured' };
  const url = `${BASE}/Account/${encodeURIComponent(process.env.PLIVO_AUTH_ID)}/Call/${encodeURIComponent(callUuid)}/`;
  try {
    const res = await fetch(url, { method: 'DELETE', headers: { Authorization: auth } });
    const ok = res.status === 204 || res.ok;
    if (!ok) logger.warn(`Plivo hangup FAIL · uuid=${callUuid} · http=${res.status}`);
    return { ok, httpStatus: res.status };
  } catch (err) {
    logger.error(`Plivo hangup network error · uuid=${callUuid} · ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  clickToCall,
  previewCallLegs,
  resolveCallLegs,
  hangupCall,
  normaliseIndianPhone,
  signCallToken,
  verifyCallToken,
  buildAnswerXml,
  callingEnabled,
};
