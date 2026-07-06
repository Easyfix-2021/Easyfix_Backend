/*
 * Call-quality analysis — runs an LLM over a call TRANSCRIPT and returns a
 * structured coaching report (per-dimension scores + strengths / improvements /
 * what-to-avoid / what-to-add). Plivo gives us the transcript (ASR); the
 * COMMUNICATION analysis is not something Plivo provides, so we do it here.
 *
 * Reuses the same OpenAI Chat-Completions plumbing as
 * services/service-skill-matrix.service.js (temperature 0, JSON response,
 * returns null on ANY failure so callers degrade gracefully). Key resolution
 * falls back across a few env vars so it works wherever an OpenAI key exists.
 */

const logger = require('../logger');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_CALL_ANALYTICS_MODEL || process.env.OPENAI_NLU_MODEL || 'gpt-4o-mini';

function apiKey() {
  return process.env.OPENAI_API_KEY_CALL_ANALYTICS
    || process.env.OPENAI_API_KEY_SKILL_MATRIX
    || process.env.OPENAI_API_KEY
    || null;
}

function llmEnabled() {
  return !!apiKey();
}

async function chatJson({ system, user, maxTokens = 1600 }) {
  const key = apiKey();
  if (!key) return null;
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      logger.warn('call-analysis LLM http ' + res.status + ' · ' + (await res.text()).slice(0, 200));
      return null;
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    try { return JSON.parse(content); } catch { return null; }
  } catch (e) {
    logger.warn('call-analysis LLM error · ' + e.message);
    return null;
  }
}

const SYSTEM = [
  "You are a call-quality coach for a field-service company's phone agents.",
  'Calls are in English and Hindi/Hinglish, between an AGENT and a customer.',
  'Analyse the AGENT\'s communication (not the customer) from the transcript and',
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
  'Ground EVERY point in evidence from the transcript. Keep each array to 3-6',
  'concise, concrete items. If the transcript is too short or unusable, still',
  'return the exact shape with low scores and a note explaining why.',
].join('\n');

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

module.exports = { analyzeTranscript, llmEnabled };
