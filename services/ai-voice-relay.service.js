/*
 * Per-call media relay: Plivo <Stream> websocket ⇄ a pluggable voice ENGINE
 * (OpenAI Realtime or Gemini Live — see services/ai-voice-engines/ +
 * docs/AI_CALLING_ENGINES.md). The relay is provider-agnostic: it always speaks
 * μ-law base64 (Plivo's format) to the engine, and the engine converts internally
 * (OpenAI = passthrough; Gemini = worker-thread transcode).
 *
 * This runs IN the shared unified backend process, so protecting the event loop
 * is the entire design brief. Six rules drive every choice:
 *
 *  1. Near-zero CPU per audio frame on the main thread. OpenAI is μ-law passthrough
 *     (no transcode). Gemini's transcode is offloaded to a worker pool. Per inbound
 *     frame here: one small JSON.parse + a handoff to the engine — no per-frame
 *     logging, no main-thread sample math.
 *  2. Hard concurrency cap. The slot is acquired by the ws server (tryAcquire)
 *     BEFORE this runs; this relay releases it exactly once on teardown.
 *  3. Backpressure = drop, never queue. Before sending to a peer we check
 *     bufferedAmount and DROP the frame if it's backed up.
 *  4. Bounded per call. Max-duration timeout + idle reaper + heartbeat ping/pong.
 *     Transcript length capped.
 *  5. Total error isolation. Every handler is try/caught; a call's error tears
 *     down ONLY that call and never throws into the process.
 *  6. Cross-replica-safe durable state. status/transcript/mapped-result persist to
 *     tbl_ai_call_session so the poll endpoint on ANY replica returns correct data.
 */

const WebSocket = require('ws');
const logger = require('../logger');
const { pool } = require('../db');
const aiSession = require('./ai-call-session.service');
const { resolveFlow, DEFAULT_FLOW } = require('./ai-call-flows');
const { resolveEngine, DEFAULT_ENGINE } = require('./ai-voice-engines');
const postCallQueue = require('./ai-post-call-queue');
const aiCall = require('./plivo-ai-call.service');

// Tunables (env-overridable).
const IDLE_MS = Math.max(10, parseInt(process.env.AI_CALL_IDLE_SEC || '30', 10)) * 1000;
const HEARTBEAT_MS = 15000;
// If the Plivo socket has more than this many bytes buffered, drop outgoing audio
// until it drains. 256 KB ≈ several seconds of μ-law — well past useful.
const BACKPRESSURE_BYTES = Math.max(64 * 1024, parseInt(process.env.AI_CALL_BACKPRESSURE_BYTES || '262144', 10));
const MAX_TRANSCRIPT_CHARS = 20000;

// Best-effort session lookup: the ENGINE + FLOW to run + greeting language. Any
// failure degrades to the defaults (auto-detect language, default flow/engine).
async function resolveSession(sessionId) {
  const out = { flowId: DEFAULT_FLOW, engine: DEFAULT_ENGINE, lang: null, efrId: null, mobile: null };
  try {
    const [[s]] = await pool.query(
      'SELECT efr_id, mobile, flow, engine FROM tbl_ai_call_session WHERE session_id = ? LIMIT 1', [sessionId]);
    if (s && s.flow) out.flowId = String(s.flow);
    if (s && s.engine) out.engine = String(s.engine);
    if (s && s.mobile) out.mobile = String(s.mobile);
    if (s && s.efr_id) {
      out.efrId = s.efr_id;
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

// Send a control/audio message to the Plivo socket, with backpressure drop.
function sendToPlivo(state, obj) {
  const p = state.plivoWs;
  if (!p || p.readyState !== WebSocket.OPEN) return;
  if (p.bufferedAmount > BACKPRESSURE_BYTES) return; // Rule 3: drop stale audio.
  try { p.send(JSON.stringify(obj)); } catch { /* peer closing; teardown via close/error */ }
}

// Idempotent teardown: closes the engine + Plivo socket, clears timers, releases
// the concurrency slot ONCE, persists transcript, then maps → result. Never throws.
async function cleanup(state, reason, errMsg) {
  if (state.closed) return;
  state.closed = true;
  try { clearTimeout(state.maxTimer); } catch { /* noop */ }
  try { clearInterval(state.heartbeat); } catch { /* noop */ }
  try { if (state.engine) state.engine.close(state); } catch { /* noop */ }
  try { if (state.plivoWs) state.plivoWs.close(); } catch { /* noop */ }
  aiSession.release();
  logger.info('AI voice teardown · session=' + state.sessionId + ' · engine=' + state.engineName
    + ' · reason=' + reason + (errMsg ? ' · ' + String(errMsg).slice(0, 160) : '')
    + ' · active=' + aiSession.activeCount());

  try {
    await aiSession.saveTranscript(state.sessionId, state.transcript);
    if (errMsg) {
      await aiSession.setStatus(state.sessionId, 'failed', { error: errMsg });
      return;
    }
    await aiSession.setStatus(state.sessionId, 'mapping');
    // Decouple the I/O-heavy, non-time-critical mapping (Sophy LLM + catalog +
    // pincode/geocode) from teardown and BOUND its concurrency, so a burst of
    // ending calls can't saturate Sophy/DB/geocode and hurt live calls.
    postCallQueue.enqueueMapping({
      sessionId: state.sessionId,
      flow: state.flow || resolveFlow(DEFAULT_FLOW),
      transcript: state.transcript,
    });
  } catch (e) {
    logger.warn('AI voice post-call teardown failed · session=' + state.sessionId + ' · ' + e.message);
    try { await aiSession.setStatus(state.sessionId, 'failed', { error: e.message }); } catch { /* noop */ }
  }
}

/**
 * Entry point — the ws server calls this AFTER verifying the token and acquiring
 * the concurrency slot. Owns the socket lifecycle. Returns a promise that never
 * rejects (all errors route through cleanup()).
 */
async function handleConnection(plivoWs, { sessionId, voice }) {
  const state = {
    sessionId,
    plivoWs,
    engine: resolveEngine(DEFAULT_ENGINE), // overwritten once the session is read
    engineName: DEFAULT_ENGINE,
    engineConn: null,
    closed: false,
    transcript: '',
    streamId: null,
    flow: resolveFlow(DEFAULT_FLOW),
    lastMediaAt: Date.now(),
    plivoAlive: true,
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
            if (payload) state.engine.sendCallerAudio(state, payload);
            break;
          }
          case 'start':
            state.streamId = (msg.start && msg.start.streamId) || msg.streamId || null;
            if (msg.start && msg.start.callId) {
              aiSession.setStatus(sessionId, 'streaming', { callUuid: msg.start.callId }).catch(() => {});
              // Best-effort recording (property-gated) — never blocks the live call.
              if (aiSession.recordEnabled()) aiCall.startRecording(msg.start.callId).catch(() => {});
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

    // Rule 4: hard duration cap (unref'd so it can't block graceful shutdown).
    state.maxTimer = setTimeout(() => cleanup(state, 'max-duration'), aiSession.MAX_DURATION_MS);
    if (state.maxTimer && state.maxTimer.unref) state.maxTimer.unref();

    // Rule 4: one interval drives idle-reap + heartbeat liveness for Plivo AND
    // the engine's provider socket.
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
        if (state.engine.heartbeat && state.engine.heartbeat(state) === false) {
          cleanup(state, 'engine-heartbeat-timeout');
        }
      } catch { /* Rule 5 */ }
    }, HEARTBEAT_MS);
    if (state.heartbeat && state.heartbeat.unref) state.heartbeat.unref();

    // Resolve engine + flow + greeting language, THEN open the provider leg.
    const { flowId, engine, lang, efrId, mobile } = await resolveSession(sessionId);
    state.flow = resolveFlow(flowId);
    state.engine = resolveEngine(engine);
    state.engineName = engine;
    if (state.closed) return; // Plivo socket may have closed during the lookup.

    // Pre-load the flow's known context (best-effort) so the agent opens relevantly
    // WITHOUT any mid-call lookup (this is why we don't need async in-call tools).
    let context = null;
    if (state.flow.preload) {
      try { context = await state.flow.preload({ efrId, mobile }, pool); } catch { context = null; }
    }
    if (state.closed) return; // socket may have closed during the preload await.

    const instructions = state.flow.buildInstructions({ lang, context, session: state });
    state.engine.start(state, {
      instructions,
      voice, // per-call voice from the JWT (Gemini engine uses it)
      callbacks: {
        onReady: () => { /* provider ready; engine gates its own send-readiness */ },
        onAudioToCaller: (muLawB64) => sendToPlivo(state, {
          event: 'playAudio',
          media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: muLawB64 },
        }),
        onBargeIn: () => sendToPlivo(state, state.streamId
          ? { event: 'clearAudio', streamId: state.streamId }
          : { event: 'clearAudio' }),
        onUserText: (t) => appendTranscript(state, 'User', t),
        onAgentText: (t) => appendTranscript(state, 'Agent', t),
        onError: (msg) => logger.warn('AI voice engine error · session=' + sessionId + ' · engine=' + state.engineName + ' · ' + msg),
        // Agent invoked end_call (after its goodbye) → give the last audio ~1.8s to
        // play out, then tear down. cleanup is idempotent, so racing a real close is safe.
        onEndCall: () => { const t = setTimeout(() => cleanup(state, 'agent-ended'), 1800); if (t && t.unref) t.unref(); },
        onClosed: (reason) => cleanup(state, reason),
      },
    });
  } catch (e) {
    cleanup(state, 'init-error', e && e.message);
  }
}

module.exports = { handleConnection };
