/*
 * Voice SAMPLE synthesis for the AI-calling voice picker — a short one-off TTS clip
 * so an operator can hear a voice before selecting/defaulting it. Uses each
 * provider's REST TTS API (NOT the realtime/relay path):
 *   - gemini → gemini-2.5-flash-preview-tts → PCM16 24k → wrapped as WAV
 *   - openai → gpt-4o-mini-tts → mp3
 * Returns { ok, buffer, contentType } or { ok:false, error }. Never throws.
 */

const logger = require('../logger');
const aiSession = require('./ai-call-session.service');

const SAMPLE_TEXT = process.env.AI_VOICE_SAMPLE_TEXT
  || 'Namaste! Main EasyFix se baat kar raha hoon, aapka work profile update karne ke liye.';

// Minimal WAV (44-byte) header around raw little-endian PCM.
function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function geminiSample(voice) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, error: 'GEMINI_API_KEY not configured' };
  const model = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ parts: [{ text: SAMPLE_TEXT }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) return { ok: false, error: 'Gemini TTS http ' + res.status + ' · ' + (await res.text()).slice(0, 200) };
  const data = await res.json();
  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const inl = parts.map((p) => p.inlineData || p.inline_data).find(Boolean);
  if (!inl || !inl.data) return { ok: false, error: 'Gemini TTS returned no audio' };
  // inlineData is PCM16 mono @ 24 kHz (mimeType audio/L16;rate=24000).
  return { ok: true, buffer: pcmToWav(Buffer.from(inl.data, 'base64'), 24000), contentType: 'audio/wav' };
}

async function openaiSample(voice) {
  const key = aiSession.openaiKey();
  if (!key) return { ok: false, error: 'OpenAI key not configured' };
  const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, voice, input: SAMPLE_TEXT, response_format: 'mp3' }),
  });
  if (!res.ok) return { ok: false, error: 'OpenAI TTS http ' + res.status + ' · ' + (await res.text()).slice(0, 200) };
  return { ok: true, buffer: Buffer.from(await res.arrayBuffer()), contentType: 'audio/mpeg' };
}

async function synthesize(engine, voice) {
  try {
    return engine === 'openai' ? await openaiSample(voice) : await geminiSample(voice);
  } catch (e) {
    logger.warn('voice-sample synth error · engine=' + engine + ' · ' + e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { synthesize, SAMPLE_TEXT };
