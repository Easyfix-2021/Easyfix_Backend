const express = require('express');
const router = express.Router();
const logger = require('../../logger');
const { pool } = require('../../db');
const plivo = require('../../services/plivo.service');
const plivoLog = require('../../services/plivo-call-log.service');
const conference = require('../../services/plivo-conference.service');
const aiCall = require('../../services/plivo-ai-call.service');
const aiSession = require('../../services/ai-call-session.service');
const teleprompter = require('../../services/teleprompter.service');

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

  /*
   * CONFERENCE MODE (2026-08-04). When the call token carries a conference the
   * operator's leg JOINS that Multi-Party Call instead of bridging straight to
   * the customer with <Dial>.
   *
   * THIS IS THE ONE LINE THAT MAKES CONFERENCES POSSIBLE AT ALL. Plivo has no
   * API to promote a live <Dial> into a conference — they are different objects.
   * So the decision has to be made HERE, at answer time, before any audio is
   * bridged. Once this returns <Dial>, that call can never gain a third party
   * without being hung up and redialled.
   *
   * The customer is NOT dialled by this XML; they are added as a participant by
   * the caller that placed this leg. That is what leaves the room open for ops
   * to add a technician later without touching the live audio.
   *
   * Falls through to the classic bridge whenever the token carries no
   * conference, so every non-conference caller behaves exactly as before.
   */
  if (claims.conf) {
    logger.info('Plivo answer: joining conference · jci=' + claims.jci + ' · conf=' + claims.conf
      + ' · record=' + (record ? 'yes' : 'no'));
    /*
     * Recording rides the SAME switch and the SAME callback as the bridge below
     * — plivo.recordingEnabled() and the jci-keyed token — so a conference is
     * recorded exactly when a 1:1 call would be. Conferences were previously
     * never recorded at all (no <Record> element existed in the MPC answer XML),
     * which is why every conference leg had a NULL recording_url while the Call
     * History UI still offered Play.
     */
    xml(conference.operatorAnswerXml(claims.conf, {
      confId: claims.confId || null,
      recordingCallbackUrl: record ? plivo.recordingCallbackUrl(claims.jci) : null,
    }));

    /*
     * NOW dial the receiver into the room — AFTER the XML has gone back, never
     * before.
     *
     * This callback firing IS "the operator answered", which makes it the exact
     * right trigger and preserves today's behaviour: the receiver's phone only
     * rings once a human is actually on the line. Adding them when the call was
     * PLACED would ring the customer even when the operator never picks up — a
     * regression on the classic bridge, which dials the second leg only from
     * this same moment.
     *
     * Deliberately not awaited before responding: Plivo is holding an HTTP
     * request open waiting for call-control XML, and a slow participant-add
     * would delay the operator's own audio. Fail-soft — if the add fails the
     * operator is alone in a room with hold music, which the logs will say
     * plainly, rather than the call dying.
     */
    conference.addParticipant({
      conferenceId: claims.confId,
      toNumber: claims.dest,
      targetKind: claims.destKind || 'customer',
      displayName: claims.destName || null,
      jobCallerInfoId: claims.jci,
    }, pool).then((r) => {
      if (r && r.ok) {
        logger.info('Conference: receiver dialled in · conf=' + claims.conf + ' · participantId=' + r.participantId);
      } else {
        logger.warn('Conference: receiver NOT added · conf=' + claims.conf
          + ' · ' + ((r && r.code) || 'unknown') + ' · ' + ((r && r.message) || '')
          + ' — the operator is in the room ALONE');
      }
    }).catch((e) => {
      logger.error({ err: e && e.message, conf: claims.conf }, 'Conference: participant add threw');
    });
    return;
  }

  logger.info('Plivo answer: bridging to customer · jci=' + claims.jci);
  // recordingCallbackUrl: Plivo pushes us the recording URL/id when ready, so
  // playback doesn't depend on guessing the recording's call_uuid.
  const recCbUrl = record ? plivo.recordingCallbackUrl(claims.jci) : null;
  return xml(plivo.buildAnswerXml(claims.dest, { record, recordingCallbackUrl: recCbUrl }));
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
  const recCbUrl = record ? plivo.recordingCallbackUrl(resolved.jci) : null;

  /*
   * CONFERENCE MODE — WEB EDITION. The exact twin of the branch in /answer.
   *
   * There are TWO answer routes, one per call mode (voice.call.mode =
   * 'mobile' | 'web'), and each is an INDEPENDENT decision point: whatever XML
   * it returns is what that call becomes for its whole life, because Plivo
   * cannot promote a live <Dial> into a conference. Wiring only one of them
   * would mean conferencing quietly worked or quietly did not depending on a
   * property nobody would think to associate with it.
   *
   * The conference rides the SERVER-SIDE dial stash, not the dialId — the
   * dialId crosses to the browser and is deliberately opaque.
   */
  if (resolved.conferenceName) {
    logger.info('Plivo web-answer: joining conference · jci=' + resolved.jci + ' · conf=' + resolved.conferenceName
      + ' · record=' + (record ? 'yes' : 'no'));
    // Same recording wiring as the mobile branch above — BOTH answer routes must
    // carry it, or recording would silently depend on voice.call.mode.
    xml(conference.operatorAnswerXml(resolved.conferenceName, {
      confId: resolved.conferenceId || null,
      recordingCallbackUrl: record ? plivo.recordingCallbackUrl(resolved.jci) : null,
    }));
    /*
     * Dial the receiver in only NOW — the operator's browser leg is connected.
     * Same reasoning as the mobile branch: adding them when the call was PLACED
     * would ring the receiver for a call the operator never joined.
     */
    conference.addParticipant({
      conferenceId: resolved.conferenceId,
      toNumber: resolved.number,
      targetKind: resolved.receiverKind || 'customer',
      displayName: resolved.receiverName || null,
      jobCallerInfoId: resolved.jci,
    }, pool).then((r) => {
      if (r && r.ok) {
        logger.info('Conference: receiver dialled in (web) · conf=' + resolved.conferenceName + ' · participantId=' + r.participantId);
      } else {
        logger.warn('Conference: receiver NOT added (web) · conf=' + resolved.conferenceName
          + ' · ' + ((r && r.code) || 'unknown') + ' · ' + ((r && r.message) || '')
          + ' — the operator is in the room ALONE');
      }
    }).catch((e) => {
      logger.error({ err: e && e.message, conf: resolved.conferenceName }, 'Conference: participant add threw (web)');
    });
    return;
  }

  // AI Teleprompter (additive, flag-gated): if this web call is a guided
  // teleprompter session AND the feature is on AND a wss base is configured, fork
  // the call audio (listen-only) to the STT websocket for this session. Any
  // failure/absence ⇒ streamWssUrl stays null ⇒ the exact previous <Dial> XML.
  let streamWssUrl = null;
  try {
    if (resolved.teleprompterSessionId && teleprompter.enabled()) {
      const base = aiCall.wsBase();
      if (base) {
        const t = teleprompter.signToken(resolved.teleprompterSessionId);
        streamWssUrl = `${base}/teleprompter-stream?t=${encodeURIComponent(t)}`;
        logger.info('Plivo web-answer: forking audio to teleprompter STT · session=' + resolved.teleprompterSessionId);
      } else {
        logger.warn('Plivo web-answer: teleprompter on but no wss base configured — no STT fork');
      }
    }
  } catch (e) { logger.warn('Plivo web-answer: teleprompter stream setup failed (bridging normally) · ' + (e && e.message)); }

  return xml(plivo.buildAnswerXml(resolved.number, { record, recordingCallbackUrl: recCbUrl, streamWssUrl }));
}
router.post('/web-answer', express.urlencoded({ extended: false }), webAnswer);
router.get('/web-answer', webAnswer);

/*
 * /api/public/plivo/recording-callback — Plivo POSTs the recording URL/id here
 * once the mp3 is ready (set via the <Record callbackUrl> in buildAnswerXml).
 * Plivo params: RecordUrl / RecordingID / RecordingDuration. UNAUTHENTICATED;
 * the signed `t` token (kind:'rec', carries jci) is the authorisation. Storing
 * by jci is robust to whichever leg's call_uuid the recording is filed under —
 * exactly why the old lazy call_uuid lookup failed for web calls. ALWAYS 200 so
 * Plivo doesn't retry-storm; the DB write is best-effort.
 */
async function recordingCallback(req, res) {
  const src = { ...req.query, ...(req.body || {}) };
  const claims = plivo.verifyRecordingToken(req.query.t);
  if (!claims || claims.jci == null) {
    logger.warn('Plivo recording-callback: invalid/expired token · ignoring');
    return res.status(200).type('text/plain').send('ok');
  }
  const url = src.RecordUrl || src.recording_url || null;
  const id = src.RecordingID || src.recording_id || null;
  const duration = src.RecordingDuration || src.recording_duration || null;
  logger.info('Plivo recording-callback · jci=' + claims.jci + ' · id=' + (id || 'none') + ' · hasUrl=' + !!url);
  if (url) await plivoLog.setRecording(claims.jci, { url, id, duration });
  return res.status(200).type('text/plain').send('ok');
}
router.post('/recording-callback', express.urlencoded({ extended: false }), recordingCallback);
router.get('/recording-callback', recordingCallback);

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

/*
 * /api/public/plivo/ai-recording — Plivo POSTs the finished recording here (set as
 * recording_callback_url by plivo-ai-call.startRecording). We ack 200 immediately
 * and persist off the live path via the bounded post-call queue.
 */
const aiPostCallQueue = require('../../services/ai-post-call-queue');
router.post('/ai-recording', express.urlencoded({ extended: false }), (req, res) => {
  const src = { ...req.query, ...(req.body || {}) };
  const callUuid = src.CallUUID || src.call_uuid || null;
  const recordUrl = src.RecordUrl || src.recording_url || null;
  const duration = src.RecordingDuration || src.recording_duration || null;
  res.status(200).type('text/plain').send('ok');
  if (!callUuid || !recordUrl) { logger.warn('Plivo ai-recording: missing CallUUID/RecordUrl'); return; }
  aiPostCallQueue.enqueueTask({
    label: 'record:' + callUuid,
    run: async () => {
      const sessionId = await aiSession.getSessionIdByCallUuid(callUuid);
      if (!sessionId) { logger.warn('Plivo ai-recording: no session for CallUUID=' + callUuid); return; }
      await aiSession.saveRecording(sessionId, { url: recordUrl, duration });
      logger.info('AI voice recording saved · session=' + sessionId + ' · dur=' + (duration || '?') + 's');
    },
  });
});

module.exports = router;
