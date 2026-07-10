/*
 * OSS STT engine — a thin client to a self-hosted speech-to-text SIDECAR over
 * WebSocket. Both supported OSS providers (AI4Bharat IndicConformer, Vosk) speak
 * the SAME protocol; only the model the sidecar loads differs (selected by the
 * `provider` we send in the config frame), so one client serves both.
 *
 * Why a sidecar (not in-process): STT inference is CPU/GPU-heavy and would violate
 * the "never degrade the shared event loop" rule. The sidecar is a separate
 * deployable (see stt-service/ + docs/AI_TELEPROMPTER_FOR_CALLS.md). $0 licence.
 *
 * Protocol (client → sidecar):
 *   1. on open, one JSON text frame: { type:'config', provider, sampleRate:16000,
 *      encoding:'pcm16le', language }
 *   2. then BINARY frames of raw PCM16LE @16k mono (transcoded here from Plivo μ-law)
 *   3. on end: { type:'eof' } then close
 * Protocol (sidecar → client), JSON text frames:
 *   { type:'partial', text }         interim hypothesis
 *   { type:'final',   text, speaker? } settled turn (speaker optional if diarized)
 *   { type:'error',   message }
 *
 * All parsing is defensive; a bad frame degrades (no live highlight), never crashes.
 */

const WebSocket = require('ws');
const transcoder = require('../audio-transcode-pool');

const WS_MAX_PAYLOAD = 1 << 20;
const BACKPRESSURE_BYTES = Math.max(64 * 1024, parseInt(process.env.STT_BACKPRESSURE_BYTES || '262144', 10));

function sidecarUrl() {
  const u = process.env.STT_SERVICE_URL;
  return u && String(u).trim() ? String(u).trim() : null;
}

function create(provider) {
  return {
    provider,
    configured() { return !!sidecarUrl(); },

    start(state, { language, onPartial, onFinal, onError, onReady, onClosed } = {}) {
      const url = sidecarUrl();
      if (!url) { if (onClosed) onClosed('stt-no-url'); return; }
      let sw;
      try {
        sw = new WebSocket(url, { perMessageDeflate: false, maxPayload: WS_MAX_PAYLOAD });
      } catch (e) {
        if (onClosed) onClosed('stt-connect-throw:' + (e && e.message));
        return;
      }
      state.sttConn = sw;
      state.sttAlive = true;
      state.sttChain = Promise.resolve();

      sw.on('open', () => {
        try {
          sw.send(JSON.stringify({
            type: 'config', provider, sampleRate: 16000, encoding: 'pcm16le', language: language || null,
          }));
          if (onReady) onReady();
        } catch (e) { if (onClosed) onClosed('stt-config-error:' + (e && e.message)); }
      });

      sw.on('message', (data, isBinary) => {
        if (isBinary) return; // sidecar only sends JSON text back
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'partial' && msg.text != null && onPartial) onPartial(String(msg.text), msg.speaker);
          else if (msg.type === 'final' && msg.text != null && onFinal) onFinal(String(msg.text), msg.speaker);
          else if (msg.type === 'error' && onError) onError(msg.message || 'stt-error');
        } catch { /* ignore a malformed frame */ }
      });

      sw.on('pong', () => { state.sttAlive = true; });
      sw.on('close', () => { if (onClosed) onClosed('stt-close'); });
      sw.on('error', (e) => { if (onClosed) onClosed('stt-error:' + (e && e.message)); });
    },

    // Plivo μ-law base64 → PCM16 16k (worker pool) → binary to the sidecar.
    // Ordered per-connection chain (the pool is round-robin → raw results can
    // arrive out of order). Backpressure = drop stale audio.
    sendAudio(state, muLawB64) {
      const sw = state.sttConn;
      if (!sw || sw.readyState !== WebSocket.OPEN) return;
      if (sw.bufferedAmount > BACKPRESSURE_BYTES) return;
      const mulaw = Buffer.from(muLawB64, 'base64');
      state.sttChain = (state.sttChain || Promise.resolve())
        .then(() => transcoder.muLawToPcm16k(mulaw))
        .then((pcm) => { if (sw.readyState === WebSocket.OPEN) sw.send(pcm); })
        .catch(() => { /* drop a bad frame */ });
    },

    heartbeat(state) {
      const sw = state.sttConn;
      if (!sw || sw.readyState !== WebSocket.OPEN) return true; // not open yet; relay reapers cover it
      if (!state.sttAlive) return false;
      state.sttAlive = false;
      try { sw.ping(); } catch { /* noop */ }
      return true;
    },

    close(state) {
      try { if (state.sttConn && state.sttConn.readyState === WebSocket.OPEN) state.sttConn.send(JSON.stringify({ type: 'eof' })); } catch { /* noop */ }
      try { if (state.sttConn) state.sttConn.close(); } catch { /* noop */ }
    },
  };
}

module.exports = { create };
