/*
 * Isolated Plivo path for the AI-calling TEST flow. Places an outbound call
 * whose answer XML returns <Stream> (NOT <Dial>) so the call audio is piped to
 * our media websocket → OpenAI Realtime. Deliberately separate from
 * services/plivo.service.js (the click-to-call / web-call bridge), which is
 * untouched. Reuses only the shared helpers (`normaliseIndianPhone`,
 * `callingEnabled`) from plivo.service.js.
 */

const logger = require('../logger');
const { normaliseIndianPhone, callingEnabled } = require('./plivo.service');

const PLIVO_API = (process.env.PLIVO_BASE_URL || 'https://api.plivo.com/v1').replace(/\/+$/, '');

// Public HTTPS backend base Plivo calls back on (same env as plivo.service.js).
function httpBase() {
  return (process.env.PLIVO_CALLBACK_BASE_URL || process.env.PUBLIC_API_BASE_URL || '').replace(/\/+$/, '');
}
// wss base for the <Stream> — derive from the http base (http→ws / https→wss).
function wsBase() {
  const b = httpBase();
  if (!b) return '';
  return b.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
}
function authHeader() {
  const id = process.env.PLIVO_AUTH_ID;
  const token = process.env.PLIVO_AUTH_TOKEN;
  if (!id || !token) return null;
  return 'Basic ' + Buffer.from(`${id}:${token}`).toString('base64');
}

// Answer XML that STREAMS the call audio (bidirectional μ-law 8k) to our ws.
// μ-law 8k ↔ OpenAI g711_ulaw = passthrough (no transcoding). Attributes/format
// verified against Plivo's audio-streaming reference: bidirectional + keepCallAlive,
// contentType "audio/x-mulaw;rate=8000", ws URL as the element's text content.
function buildStreamXml(wssUrl) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Response><Stream bidirectional="true" keepCallAlive="true" ` +
    `contentType="audio/x-mulaw;rate=8000">${wssUrl}</Stream></Response>`;
}

// Place the outbound AI call to `to`. Plivo answers → GET /api/public/plivo/ai-answer
// (carrying the session `token`) → <Stream> to /ai-voice-stream.
async function placeAiCall({ to, token }) {
  const dest = normaliseIndianPhone(to);
  if (!dest) return { ok: false, error: `invalid destination phone "${to}"` };
  if (!callingEnabled()) return { ok: false, error: "plivo.calling.enabled is not 'true'" };
  const auth = authHeader();
  if (!auth || !process.env.PLIVO_AUTH_ID) return { ok: false, error: 'PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN not configured' };
  if (!process.env.PLIVO_CALLER_ID) return { ok: false, error: 'PLIVO_CALLER_ID not configured' };
  const base = httpBase();
  if (!base) return { ok: false, error: 'PLIVO_CALLBACK_BASE_URL not configured (public backend URL Plivo calls back on)' };
  if (!wsBase()) return { ok: false, error: 'callback base is not wss-capable' };

  const answerUrl = `${base}/api/public/plivo/ai-answer?t=${encodeURIComponent(token)}`;
  const body = {
    from: process.env.PLIVO_CALLER_ID,
    to: dest,
    answer_url: answerUrl,
    answer_method: 'GET',
  };
  const url = `${PLIVO_API}/Account/${encodeURIComponent(process.env.PLIVO_AUTH_ID)}/Call/`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* leave null */ }
    const ru = parsed && parsed.request_uuid;
    const callId = Array.isArray(ru) ? ru[0] : ru || null;
    const ok = (res.status === 200 || res.status === 201) && !!callId;
    if (!ok) logger.warn('Plivo AI call FAIL · http=' + res.status + ' · ' + (text || '').slice(0, 300));
    else logger.debug('Plivo AI call ACCEPTED · request_uuid=' + callId); // start is logged once by the route ("placed")
    return { ok, callId, httpStatus: res.status, error: ok ? null : ((parsed && parsed.error) || `HTTP ${res.status}`) };
  } catch (e) {
    logger.error('Plivo AI call network error · ' + e.message);
    return { ok: false, error: e.message };
  }
}

// Start recording an in-progress AI call (Plivo Record API). Plivo POSTs the
// finished recording to `recording_callback_url` → /api/public/plivo/ai-recording.
// Best-effort + fully guarded — recording must NEVER disrupt the live call.
async function startRecording(callUuid) {
  if (!callUuid) return { ok: false, error: 'callUuid required' };
  const auth = authHeader();
  if (!auth || !process.env.PLIVO_AUTH_ID) return { ok: false, error: 'Plivo not configured' };
  const base = httpBase();
  const body = { file_format: 'mp3' };
  if (base) {
    body.recording_callback_url = `${base}/api/public/plivo/ai-recording`;
    body.recording_callback_method = 'POST';
  }
  const url = `${PLIVO_API}/Account/${encodeURIComponent(process.env.PLIVO_AUTH_ID)}/Call/${encodeURIComponent(callUuid)}/Record/`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ok = res.status >= 200 && res.status < 300;
    if (!ok) logger.warn('Plivo AI record start FAIL · http=' + res.status + ' · ' + (await res.text()).slice(0, 200));
    return { ok, httpStatus: res.status };
  } catch (e) {
    logger.warn('Plivo AI record start error · ' + e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { placeAiCall, buildStreamXml, wsBase, httpBase, startRecording };
