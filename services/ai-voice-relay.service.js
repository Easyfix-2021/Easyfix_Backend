/*
 * Per-call media relay: Plivo <Stream> websocket  ⇄  OpenAI Realtime websocket.
 *
 * This runs IN the shared unified backend process, so protecting the event loop
 * is the entire design brief. Every choice below serves one of six rules:
 *
 *  1. Near-zero CPU per audio frame. Audio is μ-law 8k on BOTH legs
 *     (Plivo `audio/x-mulaw;rate=8000` ↔ OpenAI `g711_ulaw`) → pure PASSTHROUGH,
 *     no transcode/resample. Per inbound frame: one small JSON.parse + one small
 *     JSON.stringify; the base64 payload is forwarded as-is (no Buffer alloc, no
 *     per-frame logging).
 *  2. Hard concurrency cap. The slot is acquired by the ws server (tryAcquire)
 *     BEFORE this runs; this relay owns it and releases it exactly once on
 *     teardown. (Cap is also pre-checked at POST /ai-calling/start.)
 *  3. Backpressure = drop, never queue. Before forwarding to a peer we check its
 *     socket.bufferedAmount; if it's backed up we DROP the frame (stale realtime
 *     audio is worthless) rather than growing an unbounded buffer.
 *  4. Bounded per call. Max-duration hard timeout + idle reaper + heartbeat
 *     ping/pong reap stuck/dead sockets. Transcript length is capped.
 *  5. Total error isolation. Every handler is try/caught; a single call's error
 *     tears down ONLY that call and never throws into the process.
 *  6. Cross-replica-safe durable state. The live sockets are in-memory here, but
 *     status/transcript/mapped-result are persisted to tbl_ai_call_session so the
 *     poll endpoint on ANY replica returns correct data.
 */

const WebSocket = require('ws');
const logger = require('../logger');
const { pool } = require('../db');
const aiSession = require('./ai-call-session.service');
const { resolveFlow, DEFAULT_FLOW } = require('./ai-call-flows');

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

// Tunables (env-overridable).
const IDLE_MS = Math.max(10, parseInt(process.env.AI_CALL_IDLE_SEC || '30', 10)) * 1000;
const HEARTBEAT_MS = 15000;
// If a peer socket has more than this many bytes buffered, drop outgoing frames
// until it drains. 256 KB ≈ several seconds of μ-law audio — well past useful.
const BACKPRESSURE_BYTES = Math.max(64 * 1024, parseInt(process.env.AI_CALL_BACKPRESSURE_BYTES || '262144', 10));
const MAX_TRANSCRIPT_CHARS = 20000;
const VOICE = process.env.OPENAI_REALTIME_VOICE || 'alloy';
const WS_MAX_PAYLOAD = 1 << 20; // 1 MB — audio frames are ~hundreds of bytes.

// Best-effort session lookup for the relay: the FLOW to run + greeting language.
// Any failure (missing column/table/row) degrades to the default flow + no lang
// (the agent then auto-detects language from the first reply).
async function resolveSession(sessionId) {
  const out = { flowId: DEFAULT_FLOW, lang: null };
  try {
    const [[s]] = await pool.query(
      'SELECT efr_id, flow FROM tbl_ai_call_session WHERE session_id = ? LIMIT 1', [sessionId]);
    if (s && s.flow) out.flowId = String(s.flow);
    if (s && s.efr_id) {
      const [[a]] = await pool.query(
        "SELECT language FROM tbl_easyfixer_app WHERE efr_id = ? AND language IS NOT NULL AND language <> '' LIMIT 1",
        [s.efr_id]);
      if (a && a.language) out.lang = String(a.language).trim();
    }
  } catch { /* keep defaults */ }
  return out;
}

function appendTranscript(state, who, text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || state.transcript.length >= MAX_TRANSCRIPT_CHARS) return;
  state.transcript += (state.transcript ? '\n' : '') + who + ': ' + t;
  if (state.transcript.length > MAX_TRANSCRIPT_CHARS) {
    state.transcript = state.transcript.slice(0, MAX_TRANSCRIPT_CHARS);
  }
}

// Idempotent teardown: closes both sockets, clears timers, releases the
// concurrency slot ONCE, persists transcript, then maps → result. Never throws.
async function cleanup(state, reason, errMsg) {
  if (state.closed) return;
  state.closed = true;
  try { clearTimeout(state.maxTimer); } catch { /* noop */ }
  try { clearInterval(state.heartbeat); } catch { /* noop */ }
  try { if (state.openaiWs) state.openaiWs.close(); } catch { /* noop */ }
  try { if (state.plivoWs) state.plivoWs.close(); } catch { /* noop */ }
  aiSession.release();
  logger.info('AI voice teardown · session=' + state.sessionId + ' · reason=' + reason
    + (errMsg ? ' · ' + String(errMsg).slice(0, 160) : '') + ' · active=' + aiSession.activeCount());

  try {
    await aiSession.saveTranscript(state.sessionId, state.transcript);
    if (errMsg) {
      await aiSession.setStatus(state.sessionId, 'failed', { error: errMsg });
      return;
    }
    await aiSession.setStatus(state.sessionId, 'mapping');
    // Per-flow post-call mapping (routed through Sophy inside the flow's mapper).
    const flow = state.flow || resolveFlow(DEFAULT_FLOW);
    const result = await flow.mapResult(state.transcript, pool, { session: state });
    await aiSession.saveResult(state.sessionId, result);
  } catch (e) {
    logger.warn('AI voice post-call processing failed · session=' + state.sessionId + ' · ' + e.message);
    try { await aiSession.setStatus(state.sessionId, 'failed', { error: e.message }); } catch { /* noop */ }
  }
}

function sendToPlivo(state, obj) {
  const p = state.plivoWs;
  if (!p || p.readyState !== WebSocket.OPEN) return;
  if (p.bufferedAmount > BACKPRESSURE_BYTES) return; // Rule 3: drop stale audio.
  try { p.send(JSON.stringify(obj)); } catch { /* peer closing; teardown fires via close/error */ }
}

function connectOpenAI(state, lang) {
  const key = aiSession.openaiKey();
  const url = OPENAI_REALTIME_URL + '?model=' + encodeURIComponent(aiSession.MODEL);
  let oa;
  try {
    oa = new WebSocket(url, {
      headers: { Authorization: 'Bearer ' + key, 'OpenAI-Beta': 'realtime=v1' },
      perMessageDeflate: false,
      maxPayload: WS_MAX_PAYLOAD,
    });
  } catch (e) {
    cleanup(state, 'openai-connect-throw', e && e.message);
    return;
  }
  state.openaiWs = oa;
  state.openaiAlive = true;

  oa.on('open', () => {
    try {
      oa.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          instructions: (state.flow || resolveFlow(DEFAULT_FLOW)).buildInstructions({ lang, session: state }),
          voice: VOICE,
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600 },
        },
      }));
      state.openaiReady = true;
      // Agent speaks first (greeting).
      oa.send(JSON.stringify({ type: 'response.create' }));
    } catch (e) {
      cleanup(state, 'openai-open-error', e && e.message);
    }
  });

  oa.on('message', (data) => {
    try {
      const evt = JSON.parse(data);
      switch (evt.type) {
        case 'response.audio.delta':
          // Passthrough μ-law → Plivo playAudio (Rule 1).
          if (evt.delta) {
            sendToPlivo(state, {
              event: 'playAudio',
              media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: evt.delta },
            });
          }
          break;
        case 'input_audio_buffer.speech_started':
          // Barge-in: person started talking → stop the AI audio already queued
          // on Plivo so it doesn't talk over them.
          sendToPlivo(state, state.streamId
            ? { event: 'clearAudio', streamId: state.streamId }
            : { event: 'clearAudio' });
          break;
        case 'conversation.item.input_audio_transcription.completed':
          appendTranscript(state, 'User', evt.transcript);
          break;
        case 'response.audio_transcript.done':
          appendTranscript(state, 'Agent', evt.transcript);
          break;
        case 'error':
          // Realtime surfaces non-fatal errors (e.g. cancel with no active
          // response). Log, but do NOT kill the call for these.
          logger.warn('OpenAI realtime error · session=' + state.sessionId + ' · '
            + (evt.error && (evt.error.message || evt.error.code || 'unknown')));
          break;
        default:
          break;
      }
    } catch { /* Rule 5: never throw into the process */ }
  });

  oa.on('pong', () => { state.openaiAlive = true; });
  oa.on('close', () => cleanup(state, 'openai-close'));
  oa.on('error', (e) => cleanup(state, 'openai-error', e && e.message));
}

/**
 * Entry point — the ws server calls this AFTER it has verified the token and
 * acquired the concurrency slot. Owns the socket lifecycle from here.
 * Returns a promise but never rejects (all errors route through cleanup()).
 */
async function handleConnection(plivoWs, { sessionId }) {
  const state = {
    sessionId,
    plivoWs,
    openaiWs: null,
    closed: false,
    openaiReady: false,
    transcript: '',
    streamId: null,
    flow: resolveFlow(DEFAULT_FLOW), // overwritten once the session's flow is read
    lastMediaAt: Date.now(),
    plivoAlive: true,
    openaiAlive: true,
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
            if (!payload) return;
            const oa = state.openaiWs;
            if (!oa || oa.readyState !== WebSocket.OPEN || !state.openaiReady) return;
            if (oa.bufferedAmount > BACKPRESSURE_BYTES) return; // Rule 3.
            oa.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
            break;
          }
          case 'start':
            state.streamId = (msg.start && msg.start.streamId) || msg.streamId || null;
            if (msg.start && msg.start.callId) {
              aiSession.setStatus(sessionId, 'streaming', { callUuid: msg.start.callId }).catch(() => {});
            }
            break;
          case 'stop':
            cleanup(state, 'plivo-stop');
            break;
          default:
            break; // dtmf / playedStream / clearedAudio — ignore.
        }
      } catch { /* Rule 5 */ }
    });
    plivoWs.on('pong', () => { state.plivoAlive = true; });
    plivoWs.on('close', () => cleanup(state, 'plivo-close'));
    plivoWs.on('error', (e) => cleanup(state, 'plivo-error', e && e.message));

    // Rule 4: hard duration cap. .unref() so a live call's timer can't hold the
    // event loop open during graceful shutdown (server.close() doesn't reap
    // upgraded ws connections — see ai-voice-server.shutdown()).
    state.maxTimer = setTimeout(() => cleanup(state, 'max-duration'), aiSession.MAX_DURATION_MS);
    if (state.maxTimer && state.maxTimer.unref) state.maxTimer.unref();

    // Rule 4: single interval drives idle-reap + heartbeat liveness for BOTH
    // sockets (no per-frame timers — that would add per-frame work).
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
        const oa = state.openaiWs;
        if (oa && oa.readyState === WebSocket.OPEN) {
          if (!state.openaiAlive) { cleanup(state, 'openai-heartbeat-timeout'); return; }
          state.openaiAlive = false;
          try { oa.ping(); } catch { /* noop */ }
        }
      } catch { /* Rule 5 */ }
    }, HEARTBEAT_MS);
    if (state.heartbeat && state.heartbeat.unref) state.heartbeat.unref();

    // Resolve the flow + greeting language (best-effort) THEN open the OpenAI leg.
    const { flowId, lang } = await resolveSession(sessionId);
    state.flow = resolveFlow(flowId);
    if (state.closed) return; // Plivo socket may have closed during the lookup.
    connectOpenAI(state, lang);
  } catch (e) {
    cleanup(state, 'init-error', e && e.message);
  }
}

module.exports = { handleConnection };
