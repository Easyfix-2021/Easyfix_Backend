/*
 * Call-quality analysis over the RECORDING (audio), the sibling of the
 * TRANSCRIPT path in call-analysis.service.js. Same coaching prompt, same JSON
 * shape — the model just listens to the call instead of reading Plivo's ASR of
 * it, which is the whole point: a poor transcript caps the achievable score.
 *
 * Gemini is called DIRECTLY (Google AI Studio REST, `?key=` query param, no SDK)
 * and NOT through Sophy. That is forced, not a preference: Sophy is text-only by
 * design (services/sophy.service.js:16) — its request body carries a plain string
 * `content`, so there is physically nowhere to attach audio bytes, and the model
 * is a key-level setting on Sophy's side. Precedent: the AI-calling voice leg and
 * CRS's transcriber both bypass Sophy for exactly this reason.
 * See docs/gemini-transcription-plan.md §1.
 *
 * ⚠ Customer call audio leaving for Google is a NEW data processor — retention /
 * DPA review applies before this is switched on in Production.
 *
 * Fail-closed: no GEMINI_API_KEY ⇒ geminiEnabled() is false and recording mode is
 * simply unavailable; the caller falls back to the transcript path. Never throws.
 */

const logger = require('../logger');
const callAnalysis = require('./call-analysis.service');
// parseJsonLoose is a pure string helper (no Sophy round-trip) — reused rather
// than re-implemented because Gemini can also fence its JSON in markdown.
const { parseJsonLoose } = require('./sophy.service');
const properties = require('./properties.service');
const s3 = require('../utils/s3-storage');

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/*
 * Default model. `gemini-2.5-flash` is the current GA, audio-capable
 * generateContent model — cheap and fast enough to run inside a user request.
 * DO NOT treat this as pinned: `call.analysis.gemini.model` in easyfix_properties
 * overrides it with no redeploy (CRS's pattern), so ops move to a newer id the
 * day Google ships one. CRS's own hints (`gemini-1.5-flash`) are stale — not
 * inherited on purpose.
 */
const DEFAULT_MODEL = 'gemini-2.5-flash';

/*
 * The analysis runs INSIDE GET /admin/calls/:id/analysis, so an unbounded audio
 * upload would hang the endpoint. 45s covers a multi-MB upload plus generation;
 * past that the caller degrades to the transcript path rather than blocking.
 */
const TIMEOUT_MS = Number(process.env.GEMINI_HTTP_TIMEOUT_MS) || 45000;

/*
 * ⚠ Inline-base64 ceiling. Two facts stack against us: our recordings are
 * `fileFormat="mp3"` AND `recordChannelType="stereo"` (ch0=agent / ch1=customer —
 * load-bearing for AWS Call Analytics, never switch to mono to suit a transcript
 * provider), so the bytes are DOUBLE a mono recording, and base64 inflates them a
 * further 4/3 against Gemini's ~20 MB total request limit.
 *
 * We enforce a raw-bytes guard at 14 MB (14 MB × 4/3 ≈ 18.7 MB encoded, inside
 * the limit with headroom for the prompt) and FAIL CLEANLY above it rather than
 * firing a request we know will be rejected. Deliberately NOT the Files API and
 * NOT a downmix: the Files API adds a resumable upload + ACTIVE-state poll + 48h
 * object lifecycle for a synchronous in-request path, and a downmix needs ffmpeg,
 * which this service does not ship. An oversized call falls back to the
 * transcript mode, which has no size ceiling — so the operator still gets an
 * analysis, just from the ASR text. Revisit if long calls become the norm.
 */
const MAX_INLINE_AUDIO_BYTES = Number(process.env.GEMINI_MAX_INLINE_AUDIO_BYTES) || 14 * 1024 * 1024;

function apiKey() { return process.env.GEMINI_API_KEY || null; }

// Recording mode is available only with a key. No cross-feature fallback.
function geminiEnabled() { return !!apiKey(); }

// DB property → code default. Runtime-switchable, no redeploy.
function model() {
  const v = String(properties.getProperty('call.analysis.gemini.model') ?? '').trim();
  return v || DEFAULT_MODEL;
}

/*
 * Pull the audio bytes + their REAL content type off S3.
 *
 * ⚠ The content type is read from the object, never hardcoded. CRS hardcodes
 * `audio/wav` because Plivo hands IT wav; EasyFix records mp3 and S3-caches it as
 * audio/mpeg, so a blind port would label mp3 bytes as wav. Anything that isn't
 * an audio/* type is treated as unusable rather than guessed at.
 */
async function fetchAudio(recordingKey) {
  const { GetObjectCommand, S3Client } = require('@aws-sdk/client-s3');
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';
  const client = new S3Client({ region });
  const r = await client.send(new GetObjectCommand({ Bucket: s3.bucketName(), Key: recordingKey }));
  const buffer = Buffer.from(await r.Body.transformToByteArray());
  const contentType = String(r.ContentType || '').split(';')[0].trim().toLowerCase();
  return { buffer, mimeType: /^audio\//.test(contentType) ? contentType : 'audio/mpeg' };
}

/*
 * Analyse a call RECORDING. Returns { ok, analysis, reason } — `reason` is a
 * short machine code so the caller can say WHY it fell back to the transcript
 * ('gemini_disabled' | 'audio_too_large' | 'audio_unavailable' | 'gemini_failed').
 * Never throws.
 */
async function analyzeRecording({ recordingKey }) {
  const key = apiKey();
  if (!key) return { ok: false, reason: 'gemini_disabled' };
  if (!recordingKey) return { ok: false, reason: 'audio_unavailable' };
  if (!s3.isEnabled()) return { ok: false, reason: 'audio_unavailable' };

  let audio;
  try {
    audio = await fetchAudio(recordingKey);
  } catch (e) {
    logger.warn('Gemini analysis · audio fetch failed · key=' + recordingKey + ' · ' + e.message);
    return { ok: false, reason: 'audio_unavailable' };
  }
  if (!audio.buffer || !audio.buffer.length) return { ok: false, reason: 'audio_unavailable' };
  if (audio.buffer.length > MAX_INLINE_AUDIO_BYTES) {
    logger.warn(
      'Gemini analysis · recording too large for inline audio · key=' + recordingKey
      + ' · bytes=' + audio.buffer.length + ' · max=' + MAX_INLINE_AUDIO_BYTES,
    );
    return { ok: false, reason: 'audio_too_large' };
  }

  // Text part FIRST, then the audio part — the order CRS's working call uses.
  // `inlineData` is camelCase (NOT inline_data); this is not the Files API.
  const system = callAnalysis.coachingSystemPrompt({ source: 'call recording' });
  const instructions = [
    system,
    '',
    'The attached audio is the recorded phone call. It is a 2-channel (stereo)',
    'recording: channel 0 is the AGENT and channel 1 is the CUSTOMER — use that to',
    'attribute speech correctly. Judge pronunciation, tone, pace and clarity from',
    'the audio itself, not just the words.',
  ].join('\n');

  const body = {
    contents: [{
      parts: [
        { text: instructions },
        { inlineData: { mimeType: audio.mimeType, data: audio.buffer.toString('base64') } },
      ],
    }],
    // Minimal on purpose so an operator-switched model id can't hit an
    // unsupported knob; parseJsonLoose still recovers a fenced reply.
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  };

  const url = `${BASE}/${encodeURIComponent(model())}:generateContent?key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch { /* noop */ }
      logger.warn('Gemini analysis http ' + res.status + ' · ' + detail);
      return { ok: false, reason: 'gemini_failed' };
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts) ? parts.map((p) => p && p.text).filter(Boolean).join('') : null;
    const analysis = parseJsonLoose(text);
    if (!analysis) {
      logger.warn('Gemini analysis · unparseable response · key=' + recordingKey);
      return { ok: false, reason: 'gemini_failed' };
    }
    return { ok: true, analysis };
  } catch (e) {
    logger.warn('Gemini analysis request error · ' + e.message);
    return { ok: false, reason: 'gemini_failed' };
  }
}

module.exports = {
  geminiEnabled, analyzeRecording, model, DEFAULT_MODEL, MAX_INLINE_AUDIO_BYTES,
};
