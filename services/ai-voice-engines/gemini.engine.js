/*
 * Gemini Live engine (BidiGenerateContent WebSocket, native audio-to-audio).
 * Gemini is PCM-only, so every frame is transcoded via the worker pool:
 *   caller μ-law 8k  → PCM16 16k  → Gemini
 *   Gemini PCM16 24k → μ-law 8k   → caller
 * Ordering is preserved with per-direction promise chains (the pool is
 * round-robin, so raw results could arrive out of order).
 *
 * Default model `gemini-2.5-flash-native-audio-preview-12-2025` — native audio
 * with AFFECTIVE (emotion-adaptive) dialog + ASYNC (NON_BLOCKING) function calling,
 * which matter for a human-sounding call that fetches details mid-conversation
 * (see docs/AI_CALLING_ENGINES.md §7). `GEMINI_LIVE_MODEL` overrides (e.g. to
 * gemini-3.1-flash-live-preview for lowest latency without affect/async tools).
 *
 * ⚠ The exact wire fields of the Live API (`realtimeInput.audio`, `setupComplete`,
 * `serverContent.modelTurn.parts[].inlineData`, transcription shapes) are from the
 * documented v1beta protocol and are NOT live-verified here — confirm against a
 * real session. All parsing is defensive so a shape mismatch degrades, not crashes.
 */

const WebSocket = require('ws');
const transcoder = require('../audio-transcode-pool');

const HOST = 'wss://generativelanguage.googleapis.com';
const WS_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
// Default `gemini-3.1-flash-live-preview` — lowest latency + most fluent voice.
// We PRE-LOAD the technician's context into the agent brief (so no mid-call lookups
// are needed), which removes the reason to prefer 2.5's async tools; latency then
// wins. Switch GEMINI_LIVE_MODEL to a native-audio model (e.g.
// gemini-2.5-flash-native-audio-preview-12-2025) if you want affective dialog.
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
const VOICE = process.env.GEMINI_VOICE || 'Autonoe'; // fallback; per-call voice comes via opts.voice
// Affective (emotion-adaptive) dialog is native-audio-only — the flag is sent ONLY
// for native-audio models so 3.1 (or a half-cascade model) never rejects it.
const AFFECTIVE = /native-audio/i.test(MODEL);
const WS_MAX_PAYLOAD = 1 << 20;
const BACKPRESSURE_BYTES = 1 << 18;

function apiKey() { return process.env.GEMINI_API_KEY || null; }
function configured() { return !!apiKey(); }

function start(state, { instructions, voice, callbacks }) {
  const key = apiKey();
  if (!key) { callbacks.onClosed('gemini-no-key'); return; }
  const url = HOST + WS_PATH + '?key=' + encodeURIComponent(key);
  let gw;
  try {
    gw = new WebSocket(url, { perMessageDeflate: false, maxPayload: WS_MAX_PAYLOAD });
  } catch (e) {
    callbacks.onClosed('gemini-connect-throw:' + (e && e.message));
    return;
  }
  state.engineConn = gw;
  state.engineAlive = true;
  state.gemini = { setupDone: false, outChain: Promise.resolve(), inChain: Promise.resolve(), userBuf: '', agentBuf: '' };
  const g = state.gemini;

  gw.on('open', () => {
    try {
      const setup = {
        model: 'models/' + MODEL,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || VOICE } } },
        },
        systemInstruction: { parts: [{ text: instructions }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: { automaticActivityDetection: {} },
      };
      // Emotion-adaptive dialog (native-audio only) — makes the agent read + adapt
      // to the caller's tone for a more human call. NOT proactive audio (that's an
      // ambient-device feature; a 1:1 call wants the agent to always respond).
      if (AFFECTIVE) setup.enableAffectiveDialog = true;
      // end_call tool → lets the agent hang up itself once it has said goodbye, so
      // the line doesn't stay open until the idle/max-duration reaper.
      setup.tools = [{
        functionDeclarations: [{
          name: 'end_call',
          description: 'Hang up and end the phone call. Call this ONLY after you have said your goodbye and the conversation is complete.',
          parameters: { type: 'object', properties: {} },
        }],
      }];
      gw.send(JSON.stringify({ setup }));
    } catch (e) {
      callbacks.onClosed('gemini-setup-error:' + (e && e.message));
    }
  });

  gw.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.setupComplete || msg.setup_complete) {
        g.setupDone = true;
        callbacks.onReady();
        // Kick off the greeting: a minimal user turn so the agent speaks first.
        try {
          gw.send(JSON.stringify({
            clientContent: { turns: [{ role: 'user', parts: [{ text: 'The call just connected. Greet the person warmly and begin.' }] }], turnComplete: true },
          }));
        } catch { /* noop */ }
        return;
      }

      // Tool call — the only tool is end_call (agent hanging up after goodbye).
      const toolCall = msg.toolCall || msg.tool_call;
      if (toolCall && Array.isArray(toolCall.functionCalls || toolCall.function_calls)) {
        const calls = toolCall.functionCalls || toolCall.function_calls;
        for (const fc of calls) {
          try {
            gw.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { result: 'ok' } }] } }));
          } catch { /* noop */ }
          if (fc.name === 'end_call' && callbacks.onEndCall) callbacks.onEndCall();
        }
        return;
      }

      const sc = msg.serverContent || msg.server_content;
      if (!sc) return;

      if (sc.interrupted) callbacks.onBargeIn(); // barge-in → relay clears Plivo playback

      // Agent audio (PCM16 24k, base64) → transcode → μ-law, order-preserved.
      const parts = (sc.modelTurn && sc.modelTurn.parts) || (sc.model_turn && sc.model_turn.parts) || [];
      for (const p of parts) {
        const inl = p.inlineData || p.inline_data;
        if (inl && inl.data) {
          // Backpressure BEFORE chaining: if the caller socket is backed up, drop
          // rather than queue transcode work onto outChain (bounds it symmetrically
          // with sendCallerAudio; the chain can only grow if the transcoder stalls).
          if (state.plivoWs && state.plivoWs.bufferedAmount > BACKPRESSURE_BYTES) continue;
          const pcm = Buffer.from(inl.data, 'base64');
          g.outChain = g.outChain
            .then(() => transcoder.pcm24kToMuLaw(pcm))
            .then((mulaw) => callbacks.onAudioToCaller(mulaw.toString('base64')))
            .catch(() => { /* drop a bad frame, keep the call alive */ });
        }
      }

      // Transcripts stream in; buffer and flush on turn end so the transcript
      // reads as clean "User: …" / "Agent: …" lines for the post-call mapper.
      const inT = sc.inputTranscription || sc.input_transcription;
      if (inT && inT.text) g.userBuf += inT.text;
      const outT = sc.outputTranscription || sc.output_transcription;
      if (outT && outT.text) g.agentBuf += outT.text;
      if (sc.turnComplete || sc.turn_complete) {
        if (g.userBuf.trim()) { callbacks.onUserText(g.userBuf.trim()); g.userBuf = ''; }
        if (g.agentBuf.trim()) { callbacks.onAgentText(g.agentBuf.trim()); g.agentBuf = ''; }
      }
    } catch { /* never throw into the process */ }
  });

  gw.on('pong', () => { state.engineAlive = true; });
  gw.on('close', () => callbacks.onClosed('gemini-close'));
  gw.on('error', (e) => callbacks.onClosed('gemini-error:' + (e && e.message)));
}

function sendCallerAudio(state, muLawB64) {
  const gw = state.engineConn;
  const g = state.gemini;
  if (!gw || gw.readyState !== WebSocket.OPEN || !g || !g.setupDone) return;
  if (gw.bufferedAmount > BACKPRESSURE_BYTES) return; // drop stale caller audio
  const mulaw = Buffer.from(muLawB64, 'base64');
  g.inChain = g.inChain
    .then(() => transcoder.muLawToPcm16k(mulaw))
    .then((pcm) => {
      if (gw.readyState !== WebSocket.OPEN) return;
      gw.send(JSON.stringify({ realtimeInput: { audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
    })
    .catch(() => { /* drop a bad frame */ });
}

function heartbeat(state) {
  const gw = state.engineConn;
  if (!gw || gw.readyState !== WebSocket.OPEN) return true;
  if (!state.engineAlive) return false;
  state.engineAlive = false;
  try { gw.ping(); } catch { /* noop */ }
  return true;
}

function close(state) { try { if (state.engineConn) state.engineConn.close(); } catch { /* noop */ } }

module.exports = { configured, start, sendCallerAudio, heartbeat, close };
