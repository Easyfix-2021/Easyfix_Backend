/*
 * OpenAI Realtime engine (GA API). μ-law NATIVE — Plivo's `audio/pcmu` maps
 * straight to OpenAI's `audio/pcmu`, so caller audio and agent audio pass through
 * with ZERO transcode. See docs/AI_CALLING_ENGINES.md §1.
 */

const WebSocket = require('ws');
const aiSession = require('../ai-call-session.service');

const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const VOICE = process.env.OPENAI_REALTIME_VOICE || 'alloy';
const WS_MAX_PAYLOAD = 1 << 20;
const BACKPRESSURE_BYTES = 1 << 18; // 256 KB — drop caller frames if OpenAI backs up

function configured() { return !!aiSession.openaiKey(); }

function start(state, { instructions, callbacks }) {
  const key = aiSession.openaiKey();
  if (!key) { callbacks.onClosed('openai-no-key'); return; } // clean fail (parity with gemini)
  const url = REALTIME_URL + '?model=' + encodeURIComponent(aiSession.MODEL);
  let oa;
  try {
    // GA: Authorization is the only header (no OpenAI-Beta).
    oa = new WebSocket(url, { headers: { Authorization: 'Bearer ' + key }, perMessageDeflate: false, maxPayload: WS_MAX_PAYLOAD });
  } catch (e) {
    callbacks.onClosed('openai-connect-throw:' + (e && e.message));
    return;
  }
  state.engineConn = oa;
  state.engineAlive = true;

  oa.on('open', () => {
    try {
      oa.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['audio'],
          instructions,
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600 },
              transcription: { model: process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || 'whisper-1' },
            },
            output: { format: { type: 'audio/pcmu' }, voice: VOICE },
          },
        },
      }));
      oa.send(JSON.stringify({ type: 'response.create' })); // agent greets first
      callbacks.onReady();
    } catch (e) {
      callbacks.onClosed('openai-open-error:' + (e && e.message));
    }
  });

  oa.on('message', (data) => {
    try {
      const evt = JSON.parse(data);
      switch (evt.type) {
        case 'response.output_audio.delta':
          if (evt.delta) callbacks.onAudioToCaller(evt.delta); // pcmu = μ-law passthrough
          break;
        case 'input_audio_buffer.speech_started':
          callbacks.onBargeIn();
          break;
        case 'conversation.item.input_audio_transcription.completed':
          callbacks.onUserText(evt.transcript);
          break;
        case 'response.output_audio_transcript.done':
          callbacks.onAgentText(evt.transcript);
          break;
        case 'error':
          callbacks.onError(evt.error && (evt.error.message || evt.error.code || 'unknown'));
          break;
        default:
          break;
      }
    } catch { /* never throw into the process */ }
  });

  oa.on('pong', () => { state.engineAlive = true; });
  oa.on('close', () => callbacks.onClosed('openai-close'));
  oa.on('error', (e) => callbacks.onClosed('openai-error:' + (e && e.message)));
}

function sendCallerAudio(state, muLawB64) {
  const oa = state.engineConn;
  if (!oa || oa.readyState !== WebSocket.OPEN) return;
  if (oa.bufferedAmount > BACKPRESSURE_BYTES) return; // drop stale caller audio
  try { oa.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: muLawB64 })); } catch { /* teardown via close/error */ }
}

function heartbeat(state) {
  const oa = state.engineConn;
  if (!oa || oa.readyState !== WebSocket.OPEN) return true; // not open yet; reapers cover it
  if (!state.engineAlive) return false;
  state.engineAlive = false;
  try { oa.ping(); } catch { /* noop */ }
  return true;
}

function close(state) { try { if (state.engineConn) state.engineConn.close(); } catch { /* noop */ } }

module.exports = { configured, start, sendCallerAudio, heartbeat, close };
