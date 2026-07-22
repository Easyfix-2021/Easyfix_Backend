/*
 * THE entry point for call-quality analysis, and the only place that decides
 * which INPUT it runs over:
 *   'transcript' — Plivo's ASR text → Sophy (call-analysis.service.js)
 *   'recording'  — the call audio    → Gemini direct (gemini-call-analysis.service.js)
 *
 * Two levers, deliberately: `call.analysis.mode` in easyfix_properties is the
 * GLOBAL DEFAULT ops set once, and every read / re-analyse endpoint accepts a
 * per-call `mode` override on top of it. Absent / unrecognised property ⇒
 * 'transcript', which is both the historical behaviour and the fail-closed one
 * (per feedback_easyfix_property_gated_features): recording mode ships customer
 * audio to a new processor, so it is never the accidental default.
 *
 * Availability is separate from preference. A resolved 'recording' with no
 * GEMINI_API_KEY runs the transcript instead — callers report the mode that
 * ACTUALLY ran, never the one that was asked for.
 *
 * Callers use analyzeCall() and nothing else: the transcript-vs-recording branch,
 * the degradation rules and the `analysis_mode` provenance stamp live here once
 * (feedback_easyfix_no_route_duplication). What happens to the returned JSON
 * afterwards — the DB write, the scorecard rollup — is identical for both modes
 * and stays with the caller that owns those rows.
 */

const logger = require('../logger');
const callAnalysis = require('./call-analysis.service');
const gemini = require('./gemini-call-analysis.service');
const callRecording = require('./call-recording.service');
const properties = require('./properties.service');

const MODE_TRANSCRIPT = 'transcript';
const MODE_RECORDING = 'recording';
const MODES = [MODE_TRANSCRIPT, MODE_RECORDING];

// Below this a "transcript" is a fragment of dead air, not something to score.
// Owned here so the threshold stops being restated at each call site.
const MIN_TRANSCRIPT_CHARS = 10;

function normaliseMode(m) {
  return String(m ?? '').trim().toLowerCase();
}

function isValidMode(m) {
  return MODES.includes(normaliseMode(m));
}

// The global default. Anything we don't recognise reads as 'transcript'.
function globalMode() {
  return normaliseMode(properties.getProperty('call.analysis.mode')) === MODE_RECORDING
    ? MODE_RECORDING
    : MODE_TRANSCRIPT;
}

/*
 * What this environment can actually run right now. The FE uses it to disable /
 * hide the audio option rather than offering a mode that would only fall back.
 */
function modeAvailable() {
  return {
    transcript: callAnalysis.llmEnabled(),
    recording: gemini.geminiEnabled(),
  };
}

/*
 * Per-call override ?? global default, clamped to what's available.
 * { mode, requested, fellBack } — `fellBack` true when recording was asked for
 * and the environment can't run it.
 */
function resolveMode(override) {
  const requested = isValidMode(override) ? normaliseMode(override) : globalMode();
  if (requested === MODE_RECORDING && !gemini.geminiEnabled()) {
    return { mode: MODE_TRANSCRIPT, requested, fellBack: true };
  }
  return { mode: requested, requested, fellBack: false };
}

// Provenance goes INSIDE the analysis JSON — no new column, no schema change.
// Stamped by the producer so every persister just stores what it was handed.
function stamp(analysis, mode) {
  return { ...analysis, analysis_mode: mode };
}

/*
 * Run the analysis. Single execution entry point — no caller re-implements the
 * branch.
 *
 * `transcript` may be a string OR an async thunk returning one: recording mode
 * needs no transcript at all and acquiring one can cost a provider round-trip,
 * so a thunk is invoked only if/when the transcript path actually runs.
 *
 * Returns:
 *   analysis       parsed report, already stamped with `analysis_mode`, or null
 *   mode           the mode that ACTUALLY produced it
 *   requested      the mode that was asked for
 *   fellBack       true when recording was requested but transcript ran
 *   fallbackReason machine code for WHY it fell back ('gemini_disabled' |
 *                  'no_recording' | 'audio_too_large' | 'gemini_failed' | …)
 *   reason         machine code for why there's NO analysis ('no_transcript' |
 *                  'llm_disabled' | 'analysis_failed'), null on success
 *
 * Never throws — every failure is a reason code so callers degrade gracefully.
 */
async function analyzeCall({ jobCallerInfoId = null, transcript = null, mode = null } = {}) {
  const resolved = resolveMode(mode);
  // A resolve-time fall-back is already a real reason: no key at all.
  let fallbackReason = resolved.fellBack ? 'gemini_disabled' : null;

  if (resolved.mode === MODE_RECORDING) {
    // No call row to resolve audio from (e.g. a caller holding only a transcript)
    // is simply "no audio" — it degrades like any other missing recording.
    const rec = jobCallerInfoId
      ? await callRecording.resolveRecordingKey(jobCallerInfoId)
      : { key: null, reason: 'audio_unavailable' };
    const out = rec.key
      ? await gemini.analyzeRecording({ recordingKey: rec.key })
      : { ok: false, reason: rec.reason };
    if (out.ok) {
      return {
        analysis: stamp(out.analysis, MODE_RECORDING),
        mode: MODE_RECORDING, requested: resolved.requested,
        fellBack: false, fallbackReason: null, reason: null,
      };
    }
    // A fallback analysis beats none — degrade to the transcript rather than fail.
    fallbackReason = out.reason;
    logger.warn('Recording-mode analysis fell back to transcript · jci=' + (jobCallerInfoId ?? '—') + ' · reason=' + fallbackReason);
  }

  const base = {
    mode: MODE_TRANSCRIPT,
    requested: resolved.requested,
    fellBack: resolved.requested === MODE_RECORDING,
    fallbackReason,
  };
  const raw = typeof transcript === 'function' ? await transcript() : transcript;
  const text = raw == null ? '' : String(raw).trim();
  if (text.length < MIN_TRANSCRIPT_CHARS) return { ...base, analysis: null, reason: 'no_transcript' };
  if (!callAnalysis.llmEnabled()) return { ...base, analysis: null, reason: 'llm_disabled' };
  const analysis = await callAnalysis.analyzeTranscript(text);
  if (!analysis) return { ...base, analysis: null, reason: 'analysis_failed' };
  return { ...base, analysis: stamp(analysis, MODE_TRANSCRIPT), reason: null };
}

/*
 * Which mode produced an already-STORED analysis. Rows written before recording
 * mode existed carry no marker and were, by construction, transcript-produced.
 */
function analysisModeOf(analysis) {
  const m = analysis && analysis.analysis_mode;
  return isValidMode(m) ? normaliseMode(m) : MODE_TRANSCRIPT;
}

module.exports = {
  MODE_TRANSCRIPT, MODE_RECORDING, MODES, MIN_TRANSCRIPT_CHARS,
  isValidMode, normaliseMode, globalMode, modeAvailable, resolveMode,
  analyzeCall, analysisModeOf,
};
