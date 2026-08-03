/*
 * Worker-thread audio transcoder for the Gemini AI-calling engine. Plivo speaks
 * G.711 μ-law @ 8 kHz; Gemini Live speaks raw 16-bit PCM (16 kHz in / 24 kHz out).
 * OpenAI Realtime needs none of this (μ-law native) — only the Gemini engine
 * routes frames through here, off the shared event loop.
 *
 * Two ops (stateless per frame; a single carried sample would barely help voice):
 *   dir 'in'  : μ-law 8k bytes      → PCM16 16k (decode + ×2 linear upsample)
 *   dir 'out' : PCM16 24k samples   → μ-law 8k bytes (÷3 averaged decimation + encode)
 *
 * Messages: { id, dir, buf:ArrayBuffer } → { id, buf:ArrayBuffer } (buf transferred).
 */

const { parentPort } = require('worker_threads');

// ── G.711 μ-law decode table: byte → int16 PCM ──
const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i += 1) {
  const u = ~i & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  MULAW_DECODE[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84);
}

// ── μ-law encode: int16 PCM sample → byte ──
const MU_BIAS = 0x84;
const MU_CLIP = 32635;
function linearToMuLaw(s) {
  let sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > MU_CLIP) s = MU_CLIP;
  s += MU_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent -= 1, mask >>= 1) { /* find exp */ }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

// μ-law 8k → PCM16 16k (decode + ×2 linear upsample).
function muLawToPcm16k(mulaw) {
  const n = mulaw.length;
  const pcm8 = new Int16Array(n);
  for (let i = 0; i < n; i += 1) pcm8[i] = MULAW_DECODE[mulaw[i]];
  const out = new Int16Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    const cur = pcm8[i];
    const next = i + 1 < n ? pcm8[i + 1] : cur;
    out[2 * i] = cur;
    out[2 * i + 1] = (cur + next) >> 1; // interpolated midpoint
  }
  return out;
}

// PCM16 24k → μ-law 8k (÷3 averaged decimation + encode). 3-tap box average is a
// cheap anti-alias for voice; keeps CPU low while avoiding harsh downsample noise.
function pcm24kToMuLaw(pcm) {
  const n = pcm.length;
  const outLen = Math.floor(n / 3);
  const out = new Uint8Array(outLen);
  for (let j = 0, i = 0; j < outLen; j += 1, i += 3) {
    const a = pcm[i];
    const b = i + 1 < n ? pcm[i + 1] : a;
    const c = i + 2 < n ? pcm[i + 2] : a;
    out[j] = linearToMuLaw(((a + b + c) / 3) | 0);
  }
  return out;
}

parentPort.on('message', (msg) => {
  const { id, dir, buf } = msg;
  try {
    if (dir === 'in') {
      const pcm = muLawToPcm16k(new Uint8Array(buf));
      parentPort.postMessage({ id, buf: pcm.buffer }, [pcm.buffer]);
    } else {
      // PCM16 is 2 bytes/sample; a streaming delta can split mid-sample → odd byte
      // count, which would throw in new Int16Array(buf). Round down to whole samples
      // (drop a trailing straggler byte) rather than fail the whole frame.
      const samples = buf.byteLength >> 1;
      const mulaw = pcm24kToMuLaw(new Int16Array(buf, 0, samples));
      parentPort.postMessage({ id, buf: mulaw.buffer }, [mulaw.buffer]);
    }
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
