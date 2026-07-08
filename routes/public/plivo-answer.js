const express = require('express');
const router = express.Router();
const logger = require('../../logger');
const { pool } = require('../../db');
const plivo = require('../../services/plivo.service');
const plivoLog = require('../../services/plivo-call-log.service');
const aiCall = require('../../services/plivo-ai-call.service');
const aiSession = require('../../services/ai-call-session.service');

/*
 * /api/public/plivo/answer — Plivo answer_url callback (truly public, no auth).
 *
 * Plivo GETs this URL the moment the AGENT leg is answered. We must return
 * call-control XML that bridges to the customer leg. The destination customer
 * number is NOT in the URL — it's carried inside the signed `t` JWT (along with
 * the tbl_job_caller_info id) minted by plivo.service.signCallToken when the
 * call was placed. See plivo.service.js header for the full flow.
 *
 * Reaching this route means the agent picked up, so it's the natural moment to
 * flip the audit row to 'answered' and stamp start_time. The DB write is
 * best-effort and wrapped in try/catch — Plivo MUST always receive valid XML,
 * even if the token is expired or the update fails, so the live leg isn't
 * dropped. An invalid/expired token yields an empty <Response/> (no bridge).
 *
 * No JWT/Basic auth here: the signed `t` token IS the authorisation, and the
 * public mount (routes/public/index.js) sits ahead of requireAuth.
 */
router.get('/answer', async (req, res) => {
  const xml = (body) => res.type('text/xml').send(body);

  logger.info('Plivo answer callback · CallUUID=' + (req.query.CallUUID || 'none'));

  const claims = plivo.verifyCallToken(req.query.t);
  if (!claims) {
    // Invalid / expired token → return a no-op Response so Plivo doesn't choke,
    // but we cannot (and must not) bridge to an unknown destination.
    logger.warn('Plivo answer: invalid/expired call token · returning empty Response');
    return xml('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>');
  }

  // Best-effort: mark the row answered (agent picked up). COALESCE so a
  // CallUUID that may have already been stamped by the ring callback isn't
  // clobbered with NULL when Plivo omits it here.
  try {
    await pool.query(
      `UPDATE tbl_job_caller_info
          SET caller_status = 'answered',
              start_time = NOW(),
              unique_id = COALESCE(?, unique_id)
        WHERE job_caller_info = ?`,
      [req.query.CallUUID || null, claims.jci]
    );
  } catch (err) {
    logger.warn({ jci: claims.jci, err: err && err.message }, 'plivo answer: audit update failed (returning XML anyway)');
  }
  // Decide recording ONCE (from the cached plivo.recording.enabled flag) and
  // use the same value for the log, the persisted per-call flag, and the Dial
  // XML — so "was this call set to record?" is answerable per call afterward.
  const record = plivo.recordingEnabled();
  logger.info('Plivo answer · jci=' + claims.jci + ' · CallUUID=' + (req.query.CallUUID || 'none') + ' · record=' + record);
  await plivoLog.markAnswered(claims.jci, req.query.CallUUID || null, record);

  logger.info('Plivo answer: bridging to customer · jci=' + claims.jci);
  return xml(plivo.buildAnswerXml(claims.dest, { record }));
});

/*
 * /api/public/plivo/web-answer — Answer URL for the Web Call (browser WebRTC)
 * Voice Application. Plivo invokes it when the operator's browser-endpoint call
 * connects; `To` is the OPAQUE one-time dialId minted by POST
 * /admin/calls/web-start — NOT the real number (masking preserved). We resolve
 * it server-side → real number and return Dial XML bridging to the customer.
 * One-time + 2-min TTL (plivo.resolveWebDial), so a guessed/replayed id yields
 * <Hangup/>, never a number. Best-effort audit stamp. Supports POST (the
 * configured method, form-urlencoded) and GET.
 */
async function webAnswer(req, res) {
  const xml = (body) => res.type('text/xml').send(body);
  const src = { ...req.query, ...(req.body || {}) };
  // The dialId arrives as a custom INVITE header the browser passed to
  // client.call() — Plivo forwards X-PH-* extra headers to this URL as params.
  // Casing/prefix can vary, so match any param containing "dialid"; fall back
  // to To in case a future caller dials the id directly.
  const dialIdKey = Object.keys(src).find((k) => /dialid/i.test(k));
  const dialId = (dialIdKey && src[dialIdKey]) || src.To;
  logger.info('Plivo web-answer callback · CallUUID=' + (src.CallUUID || 'none'));
  const resolved = plivo.resolveWebDial(dialId);
  if (!resolved) {
    logger.warn({ keys: Object.keys(src) }, 'plivo web-answer: unknown/expired/replayed dialId — hanging up');
    return xml('<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup/></Response>');
  }
  logger.info(`plivo web-answer: bridging row=${resolved.jci}`);
  // NOTE: this fires when the BROWSER endpoint is bridged and the customer is
  // about to be DIALED — NOT when the customer answers. So mark 'ringing' (and
  // stamp the CallUUID for hangup correlation); do NOT set start_time/answered_on
  // (else a no-answer call would wrongly look answered). The terminal hangup
  // callback sets the final status + duration.
  try {
    await pool.query(
      `UPDATE tbl_job_caller_info
          SET caller_status = 'ringing', unique_id = COALESCE(?, unique_id)
        WHERE job_caller_info = ?`,
      [src.CallUUID || null, resolved.jci]
    );
  } catch (err) {
    logger.warn({ jci: resolved.jci, err: err && err.message }, 'plivo web-answer: audit update failed (returning XML anyway)');
  }
  const record = plivo.recordingEnabled();
  logger.info('Plivo web-answer · jci=' + resolved.jci + ' · CallUUID=' + (src.CallUUID || 'none') + ' · record=' + record);
  await plivoLog.markRinging(resolved.jci, src.CallUUID || null);
  await plivoLog.setRecordingRequested(resolved.jci, record);
  return xml(plivo.buildAnswerXml(resolved.number, { record }));
}
router.post('/web-answer', express.urlencoded({ extended: false }), webAnswer);
router.get('/web-answer', webAnswer);

/*
 * /api/public/plivo/ai-answer — answer_url for the AI-calling TEST flow ONLY.
 * SEPARATE from /answer (which bridges to a human via <Dial>): this returns
 * <Stream> so Plivo pipes the call audio to our media websocket → OpenAI
 * Realtime. Authorisation is the signed `t` JWT minted by
 * ai-call-session.signToken (carries the sessionId). Any invalid/expired token,
 * disabled feature, or missing wss base yields an empty <Response/> so Plivo
 * never chokes and the existing bridge flow is entirely untouched.
 */
router.get('/ai-answer', async (req, res) => {
  const xml = (body) => res.type('text/xml').send(body);
  const empty = '<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>';

  const claims = aiSession.verifyToken(req.query.t);
  if (!claims || !claims.sid) {
    logger.warn('Plivo ai-answer: invalid/expired token · returning empty Response');
    return xml(empty);
  }
  if (!aiSession.enabled()) {
    logger.warn('Plivo ai-answer: ai.calling.enabled is off · returning empty Response');
    return xml(empty);
  }
  const base = aiCall.wsBase();
  if (!base) {
    logger.error('Plivo ai-answer: no wss callback base configured · returning empty Response');
    return xml(empty);
  }

  // NOTE: we intentionally do NOT flip status to 'streaming' here. The call is
  // answered but the media ws may still fail to connect (cap/gate/replica). The
  // relay stamps 'streaming' (+ CallUUID) from its 'start' event once audio
  // actually flows, so the session status stays truthful.
  const wssUrl = `${base}/ai-voice-stream?t=${encodeURIComponent(req.query.t)}`;
  logger.info('Plivo ai-answer: returning Stream XML · session=' + claims.sid);
  return xml(aiCall.buildStreamXml(wssUrl));
});

// Plivo also POSTs the answer_url as a terminal/stream callback once the <Stream>
// ends. The GET above is the real answer; reply to POST with an empty Response so
// Plivo gets clean XML (a clean hangup) instead of a 404 + error log.
router.post('/ai-answer', (req, res) =>
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>'));

module.exports = router;
