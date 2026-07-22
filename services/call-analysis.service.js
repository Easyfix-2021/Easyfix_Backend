/*
 * Call-quality analysis — runs an LLM over a call TRANSCRIPT and returns a
 * structured coaching report (per-dimension scores + strengths / improvements /
 * what-to-avoid / what-to-add). Plivo gives us the transcript (ASR); the
 * COMMUNICATION analysis is not something Plivo provides, so we do it here.
 *
 * The LLM step routes through Sophy (services/sophy.service.js), the central AI
 * gateway — model/prompt/quota are key-controlled. Sophy folds our system prompt
 * into the user turn and parses JSON leniently, so we pass {system,user} and get
 * an object (or null on ANY failure so callers degrade gracefully).
 *
 * This module owns the coaching PROMPT + output shape for BOTH analysis modes.
 * The RECORDING mode (services/gemini-call-analysis.service.js) sends the audio
 * to Gemini direct — Sophy is text-only and physically cannot carry audio — but
 * must produce the IDENTICAL JSON so the stored analysis, the scorecard rollup
 * and the FE modal render unchanged. Hence coachingSystemPrompt() is exported
 * rather than the prompt being copy-pasted into the audio path.
 */

const sophy = require('./sophy.service');

// This feature's OWN Sophy key (own model/prompt/quota/cost line).
function sophyKey() {
  return process.env.SOPHY_API_KEY_CALL_ANALYSIS;
}
function llmEnabled() {
  return sophy.enabled(sophyKey());
}

// JSON chat call — routed through Sophy on the call-analysis key. Returns the
// parsed object, or null on any failure (never throws; caller degrades).
async function chatJson({ system, user, maxTokens = 1600 }) {
  return sophy.chatJson({ system, user, maxTokens, apiKey: sophyKey() });
}

/*
 * The one coaching prompt, parameterised ONLY by what the model is looking at
 * ('transcript' for the Sophy/text path, 'call recording' for the Gemini/audio
 * path). `source` defaults to 'transcript' so the text path's prompt is
 * byte-identical to what it has always sent — the scores stay comparable across
 * the two modes because everything except that noun is the same.
 */
function coachingSystemPrompt({ source = 'transcript' } = {}) {
  return [
    "You are a call-quality coach for a field-service company's phone agents.",
    'Calls are in English and Hindi/Hinglish, between an AGENT and a customer.',
    `Analyse the AGENT's communication (not the customer) from the ${source} and`,
    'return STRICT JSON only (no markdown, no prose) with this EXACT shape:',
    '{',
    '  "overall_score": <integer 1-10>,',
    '  "summary": "<2-3 sentence overview of the agent\'s performance>",',
    '  "dimensions": [',
    '    { "name": "Pronunciation", "score": <1-10>, "notes": "<specific, actionable>" },',
    '    { "name": "Vocabulary", "score": <1-10>, "notes": "..." },',
    '    { "name": "Communication Skills", "score": <1-10>, "notes": "..." },',
    '    { "name": "Professionalism", "score": <1-10>, "notes": "..." }',
    '  ],',
    '  "strengths": ["<point>", ...],',
    '  "areas_of_improvement": ["<point>", ...],',
    '  "what_to_avoid": ["<phrase or behaviour to avoid saying>", ...],',
    '  "what_to_add": ["<phrase or behaviour to add>", ...]',
    '}',
    `Ground EVERY point in evidence from the ${source}. Keep each array to 3-6`,
    `concise, concrete items. If the ${source} is too short or unusable, still`,
    'return the exact shape with low scores and a note explaining why.',
  ].join('\n');
}

const SYSTEM = coachingSystemPrompt();

/*
 * Analyse a transcript. Returns the parsed analysis object, or null when the
 * transcript is empty/too short or the LLM is unavailable/failed. Never throws.
 */
async function analyzeTranscript(transcript) {
  const text = transcript == null ? '' : String(transcript).trim();
  if (text.length < 10) return null;
  // Cap the transcript so a very long call can't blow the token budget.
  const user = 'Call transcript:\n"""\n' + text.slice(0, 12000) + '\n"""';
  return chatJson({ system: SYSTEM, user });
}

module.exports = { analyzeTranscript, llmEnabled, coachingSystemPrompt };
