/*
 * Per-call media relay for the TELEPROMPTER: Plivo <Stream> (listen-only) → OSS STT
 * sidecar → live transcript + AI "next question" suggestion (published on the bus
 * to the Ops SSE stream). Unlike the AI-calling relay this NEVER sends audio back
 * (the humans are talking to each other); we only listen, transcribe, and suggest.
 *
 * Same event-loop discipline as ai-voice-relay: near-zero CPU per frame (μ-law→PCM
 * transcode is off-thread in the STT engine), backpressure = drop, bounded per call
 * (max-duration + idle + heartbeat), total error isolation, durable cross-replica
 * state in tbl_teleprompter_session. If STT is unusable/drops, the call continues
 * in MANUAL mode (no live highlight) — a lost sidecar never ends the human call.
 */

const WebSocket = require('ws');
const logger = require('../logger');
const { pool } = require('../db');
const teleprompter = require('./teleprompter.service');
const { resolveFlow, DEFAULT_FLOW } = require('./teleprompter-flows');
const stt = require('./stt-engines');
const bus = require('./teleprompter-bus');
const postCallQueue = require('./ai-post-call-queue');
const postcall = require('./teleprompter-postcall.service');

const IDLE_MS = Math.max(20, parseInt(process.env.TELEPROMPTER_IDLE_SEC || '60', 10)) * 1000;
const HEARTBEAT_MS = 15000;
// STT is mandatory: if the sidecar never signals ready (connection hangs without
// erroring), fail rather than run a whole call to max-duration with no transcript.
const STT_READY_TIMEOUT_MS = Math.max(4000, parseInt(process.env.TELEPROMPTER_STT_READY_TIMEOUT_MS || '12000', 10));
const MAX_TRANSCRIPT_CHARS = 40000;
const TRANSCRIPT_SAVE_MS = 5000;

function parseJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

// Best-effort: flow + question list + greeting language + STT provider. Any failure
// degrades to defaults (default flow, no question list, manual mode).
async function resolveSession(sessionId) {
  const out = { flowId: DEFAULT_FLOW, provider: teleprompter.sttProvider(), lang: null, questionList: [] };
  try {
    const [[s]] = await pool.query(
      'SELECT flow, target_id, question_list_json FROM tbl_teleprompter_session WHERE session_id = ? LIMIT 1', [sessionId]);
    if (s) {
      if (s.flow) out.flowId = String(s.flow);
      out.questionList = parseJson(s.question_list_json) || [];
      if (s.target_id) {
        const [[a]] = await pool.query(
          "SELECT language FROM tbl_easyfixer_app WHERE efr_id = ? AND language IS NOT NULL AND language <> '' LIMIT 1",
          [s.target_id]);
        if (a && a.language) out.lang = String(a.language).trim();
      }
    }
  } catch { /* keep defaults */ }
  return out;
}

function appendTranscript(state, text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || state.transcript.length >= MAX_TRANSCRIPT_CHARS) return;
  state.transcript += (state.transcript ? '\n' : '') + t;
  if (state.transcript.length > MAX_TRANSCRIPT_CHARS) state.transcript = state.transcript.slice(0, MAX_TRANSCRIPT_CHARS);
}

function maybeSaveTranscript(state) {
  const now = Date.now();
  if (now - (state.lastSaveAt || 0) < TRANSCRIPT_SAVE_MS) return;
  state.lastSaveAt = now;
  teleprompter.saveTranscript(state.sessionId, state.transcript).catch(() => {});
}

// Pick the next question from the running transcript (single-flight). Reads fresh
// asked/current from the DB (promote may run on another replica) so we never
// re-suggest an already-asked question or the one being read now.
async function recomputeNext(state) {
  if (state.deciding || state.closed) return;
  state.deciding = true;
  try {
    let askedIds = []; let currentId = null;
    try {
      const [[row]] = await pool.query(
        'SELECT asked_sequence_json, current_question_id FROM tbl_teleprompter_session WHERE session_id = ? LIMIT 1',
        [state.sessionId]);
      if (row) {
        const seq = parseJson(row.asked_sequence_json) || [];
        askedIds = seq.map((x) => x && x.id).filter(Boolean);
        currentId = row.current_question_id || null;
      }
    } catch { /* use empties */ }
    const nextId = await state.flow.decideNext({
      transcript: state.transcript, questionList: state.questionList, askedIds, currentId,
    });
    if (state.closed) return;
    if (nextId && nextId !== state.lastNextId) {
      state.lastNextId = nextId;
      await teleprompter.saveNextQuestion(state.sessionId, nextId);
      bus.publish(state.sessionId, { type: 'next', nextQuestionId: nextId });
    }
  } catch { /* isolate */ } finally { state.deciding = false; }
}

// Idempotent teardown: closes STT + Plivo, clears timers, releases the slot ONCE,
// persists the transcript, enqueues post-call work. Never throws.
async function cleanup(state, reason, errMsg) {
  if (state.closed) return;
  state.closed = true;
  try { clearTimeout(state.maxTimer); } catch { /* noop */ }
  try { clearTimeout(state.sttReadyTimer); } catch { /* noop */ }
  try { clearInterval(state.heartbeat); } catch { /* noop */ }
  try { if (state.stt) state.stt.close(state); } catch { /* noop */ }
  try { if (state.plivoWs) state.plivoWs.close(); } catch { /* noop */ }
  teleprompter.release();
  logger.info('Teleprompter teardown · session=' + state.sessionId + ' · reason=' + reason
    + (errMsg ? ' · ' + String(errMsg).slice(0, 160) : '') + ' · active=' + teleprompter.activeCount());

  try {
    await teleprompter.saveTranscript(state.sessionId, state.transcript);
    if (errMsg) {
      await teleprompter.setStatus(state.sessionId, 'failed', { error: errMsg });
      bus.publish(state.sessionId, { type: 'status', status: 'failed' });
      return;
    }
    await teleprompter.setStatus(state.sessionId, 'processing');
    bus.publish(state.sessionId, { type: 'status', status: 'processing' });
    postCallQueue.enqueueTask({
      label: 'teleprompter:' + state.sessionId,
      run: () => postcall.processCompleted(state.sessionId),
    });
  } catch (e) {
    logger.warn('Teleprompter post-call teardown failed · session=' + state.sessionId + ' · ' + e.message);
    try { await teleprompter.setStatus(state.sessionId, 'failed', { error: e.message }); } catch { /* noop */ }
  }
}

/**
 * Entry point — the ws server calls this AFTER verifying the token + acquiring the
 * concurrency slot. Owns the socket lifecycle. Never rejects (errors → cleanup).
 */
async function handleConnection(plivoWs, { sessionId }) {
  const state = {
    sessionId,
    plivoWs,
    closed: false,
    transcript: '',
    streamId: null,
    flow: resolveFlow(DEFAULT_FLOW),
    questionList: [],
    stt: null,
    sttReady: false,
    sttReadyTimer: null,
    lastMediaAt: Date.now(),
    plivoAlive: true,
    deciding: false,
    lastNextId: null,
    lastSaveAt: 0,
    maxTimer: null,
    heartbeat: null,
  };

  try {
    plivoWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        switch (msg.event) {
          case 'media': {
            state.lastMediaAt = Date.now();
            const payload = msg.media && msg.media.payload;
            if (payload && state.stt) state.stt.sendAudio(state, payload);
            break;
          }
          case 'start':
            state.streamId = (msg.start && msg.start.streamId) || msg.streamId || null;
            if (msg.start && msg.start.callId) {
              teleprompter.setStatus(sessionId, 'streaming', { callUuid: msg.start.callId }).catch(() => {});
              bus.publish(sessionId, { type: 'status', status: 'streaming' });
            }
            break;
          case 'stop':
            cleanup(state, 'plivo-stop');
            break;
          default:
            break;
        }
      } catch { /* isolate */ }
    });
    plivoWs.on('pong', () => { state.plivoAlive = true; });
    plivoWs.on('close', () => cleanup(state, 'plivo-close'));
    plivoWs.on('error', (e) => cleanup(state, 'plivo-error', e && e.message));

    state.maxTimer = setTimeout(() => cleanup(state, 'max-duration'), teleprompter.MAX_DURATION_MS);
    if (state.maxTimer && state.maxTimer.unref) state.maxTimer.unref();

    state.heartbeat = setInterval(() => {
      try {
        if (state.closed) return;
        if (Date.now() - state.lastMediaAt > IDLE_MS) { cleanup(state, 'idle'); return; }
        const p = state.plivoWs;
        if (p && p.readyState === WebSocket.OPEN) {
          if (!state.plivoAlive) { cleanup(state, 'plivo-heartbeat-timeout'); return; }
          state.plivoAlive = false;
          try { p.ping(); } catch { /* noop */ }
        }
        // STT is mandatory — an unresponsive sidecar FAILS the call (no silent
        // degrade to a manual, analysis-less session).
        if (state.stt && state.stt.heartbeat && state.stt.heartbeat(state) === false) {
          cleanup(state, 'stt-heartbeat-timeout', 'The speech-to-text service stopped responding.');
        }
      } catch { /* isolate */ }
    }, HEARTBEAT_MS);
    if (state.heartbeat && state.heartbeat.unref) state.heartbeat.unref();

    const { flowId, provider, lang, questionList } = await resolveSession(sessionId);
    state.flow = resolveFlow(flowId);
    state.questionList = questionList;
    if (state.closed) return;

    // STT is MANDATORY (it drives the live next-question suggestion AND the
    // post-call analysis). /start already refuses when it's not configured; this
    // is defence for a config change mid-flight — fail the call rather than run
    // a degraded, analysis-less session.
    if (!stt.sttUsable(provider)) {
      cleanup(state, 'stt-unavailable', 'The AI Teleprompter needs the speech-to-text service, which is not available.');
      return;
    }
    state.stt = stt.resolveEngine(provider);
    state.stt.start(state, {
      language: lang,
      onReady: () => { state.sttReady = true; try { clearTimeout(state.sttReadyTimer); } catch { /* noop */ } },
      onPartial: (text) => bus.publish(sessionId, { type: 'partial', text }),
      onFinal: (text) => {
        appendTranscript(state, text);
        maybeSaveTranscript(state);
        bus.publish(sessionId, { type: 'final', text });
        recomputeNext(state);
      },
      onError: (m) => logger.warn('Teleprompter STT error · ' + sessionId + ' · ' + m),
      // A drop (connect failure or mid-call) FAILS the guided call — STT is required.
      // During our own teardown state.closed is already true, so this is a no-op then.
      onClosed: (r) => { if (!state.closed) cleanup(state, 'stt-closed', 'Speech-to-text stopped (' + r + '). The guided call needs the STT service running.'); },
    });
    // Fail if the sidecar never becomes ready (a silent connect hang).
    state.sttReadyTimer = setTimeout(() => {
      if (!state.closed && !state.sttReady) cleanup(state, 'stt-ready-timeout', 'The speech-to-text service did not become ready in time.');
    }, STT_READY_TIMEOUT_MS);
    if (state.sttReadyTimer && state.sttReadyTimer.unref) state.sttReadyTimer.unref();
  } catch (e) {
    cleanup(state, 'init-error', e && e.message);
  }
}

module.exports = { handleConnection };
