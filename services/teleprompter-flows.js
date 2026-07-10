/*
 * TELEPROMPTER FLOW REGISTRY (mirrors ai-call-flows.js).
 *
 * The teleprompter ENGINE — Plivo <Stream> capture, the media relay, STT, the
 * session store, the concurrency cap, SSE — is flow-agnostic. Each FLOW plugs in:
 *
 *   buildQuestionList(catalog, ctx) -> [{ id, text, type, required, meta }]
 *       The fixed, ordered on-screen script for THIS flow. Built from live data
 *       (e.g. the deep-skill catalog) so it always matches the current taxonomy.
 *
 *   decideNext({ transcript, questionList, askedIds, currentId }) -> Promise<string|null>
 *       Given the running transcript, pick the BEST NEXT question id (never the
 *       current one — the UI locks that). Sophy (text LLM) when available, else a
 *       deterministic "next unasked in order" fallback. Never throws.
 *
 *   mapResult(transcript, pool) -> Promise<object>   (async, never throws)
 *       Post-call reasoning over the transcript (via Sophy) → the captured result
 *       the UI pre-fills. For guided_verification this is the existing
 *       ai-profile-extract mapper (deep_skill_items + serviceable_pincode_ids).
 *
 * Add a flow (booking_details, tech_reminder, …): add ONE entry here. No engine /
 * relay / route / schema changes — tbl_teleprompter_session.flow selects which runs.
 */

const sophy = require('./sophy.service');
const { mapTranscript } = require('./ai-profile-extract.service');
const { computeCoverage } = require('./teleprompter.service');

function sophyKey() {
  return process.env.SOPHY_API_KEY_TELEPROMPTER || process.env.SOPHY_API_KEY_AI_CALLING || null;
}

// ── guided_verification: New Technician Lead vetting ────────────────────────
// Build the ordered question list from the deep-skill catalog: greeting →
// availability → category overview → one deep-dive per category → serviceable
// areas → closing. The AI highlights which to ask next; per-category deep-dives
// are optional (bonus coverage) since only the categories the tech works in apply.
function firstName(full) {
  // Strip a leading honorific (Mr./Mrs./Ms./Dr./Shri/Smt./Sri/Sh./Kumari/M/s)
  // so we greet by the actual name, then take the first token.
  const cleaned = String(full || '').trim()
    .replace(/^(mr|mrs|ms|dr|shri|smt|sri|sh|kum|kumari|m\/s)\.?\s+/i, '');
  const t = cleaned.split(/\s+/)[0];
  return t || null;
}
// Drop a trailing "Services"/"Service" so a category reads conversationally
// ("Carpentry Services" → "Carpentry").
function catShort(name) {
  const n = String(name || '').trim();
  return n.replace(/\s*services?$/i, '').trim() || n;
}

function guidedBuildQuestionList(catalog, { efrName } = {}) {
  const fn = firstName(efrName);
  const cats = Array.isArray(catalog) ? catalog : [];
  const list = [];

  // Warm, human opening: greet neutrally, confirm the person by first name, then
  // confirm they registered on the app — before asking anything about their work.
  list.push({
    id: 'greeting', type: 'script', required: false,
    text: 'Namaste Sir/Ma\'am! Main EasyFix se baat kar raha hoon.',
  });
  list.push({
    id: 'confirm_identity', type: 'script', required: false,
    text: fn ? `Kya main ${fn} ji se baat kar raha hoon?` : 'Kya main sahi vyakti se baat kar raha hoon?',
  });
  list.push({
    id: 'confirm_registration', type: 'script', required: false,
    text: 'Aapne EasyFix app par register kiya tha, right?',
  });

  // Open-ended: let them describe their work in their own words; the AI then
  // highlights the matching category deep-dive next (conversational, not a checklist).
  list.push({
    id: 'cat_overview', type: 'question', required: true,
    text: 'Kya aap apne baare mein thoda bata sakte hain? Aap kya kya kaam karte hain?',
    meta: { categories: cats.map((c) => ({ category_id: c.category_id, name: c.category_name })) },
  });

  for (const c of cats) {
    const skills = [];
    for (const st of (c.service_types || [])) {
      for (const ds of (st.deep_skills || [])) skills.push(ds.deep_skill_name);
    }
    const hint = skills.length ? ` (jaise ${skills.slice(0, 5).join(', ')})` : '';
    list.push({
      id: 'cat_' + c.category_id, type: 'question', required: false,
      text: `Achha, aap ${catShort(c.category_name)} ka kaam bhi karte hain! Usme kya kya karte hain?${hint}`,
      meta: { category_id: c.category_id },
    });
  }

  list.push({
    id: 'areas', type: 'question', required: true,
    text: 'Aap kaun kaun se area ya pincode mein service dete hain?',
  });
  list.push({
    id: 'closing', type: 'script', required: false,
    text: 'Aapki details ke liye bahut dhanyavaad! Kisi bhi update ke liye aap EasyFix app par dekhte rahiyega.',
  });
  return list;
}

// Deterministic fallback: first not-yet-asked, not-current question in order.
function firstUnasked(questionList, askedIds, currentId) {
  const asked = new Set(askedIds || []);
  for (const q of questionList) {
    if (q.id === currentId) continue;
    if (!asked.has(q.id)) return q.id;
  }
  return null;
}

async function guidedDecideNext({ transcript, questionList, askedIds, currentId } = {}) {
  const list = Array.isArray(questionList) ? questionList : [];
  const asked = new Set(askedIds || []);
  const remaining = list.filter((q) => q.id !== currentId && !asked.has(q.id));
  if (!remaining.length) return null;

  const key = sophyKey();
  if (!sophy.enabled(key) || !transcript || String(transcript).trim().length < 4) {
    return firstUnasked(list, askedIds, currentId);
  }
  try {
    const listing = remaining.map((q) => `- ${q.id}: ${q.text}`).join('\n');
    const system = 'You help a call agent interview an Indian field technician. Given the running call '
      + 'transcript and a list of REMAINING questions (id: text), choose the single BEST next question to ask, '
      + 'based on what the technician just said — prefer questions about the categories, skills, or areas they '
      + 'mentioned; skip topics already covered. Return STRICT JSON only: {"next_id":"<id from the list>"} or '
      + '{"next_id":null} if none fit. Use ONLY an id present in the list.';
    const user = 'Transcript so far:\n"""\n' + String(transcript).slice(-4000) + '\n"""\n\nRemaining questions:\n' + listing;
    const out = await sophy.chatJson({ system, user, maxTokens: 60, apiKey: key });
    const nextId = out && out.next_id;
    if (nextId && remaining.some((q) => q.id === nextId)) return nextId;
    return firstUnasked(list, askedIds, currentId);
  } catch {
    return firstUnasked(list, askedIds, currentId);
  }
}

const FLOWS = {
  guided_verification: {
    id: 'guided_verification',
    label: 'Guided Verification Call',
    targetType: 'easyfixer',
    // Best-effort technician name for a personal greeting; null-safe.
    async preload({ targetId } = {}, pool) {
      if (!targetId || !pool) return null;
      try {
        const [[t]] = await pool.query('SELECT efr_name FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1', [targetId]);
        return t ? { efrName: t.efr_name ? String(t.efr_name).trim() : null } : null;
      } catch { return null; }
    },
    buildQuestionList: guidedBuildQuestionList,
    decideNext: guidedDecideNext,
    mapResult: (transcript, pool) => mapTranscript(transcript, pool, { apiKey: sophyKey() }),
    coverage: (askedSequence, questionList) => computeCoverage(askedSequence, questionList),
  },

  /*
   * FUTURE FLOWS — add here, no engine changes. e.g.
   * booking_details: { id, label, buildQuestionList, decideNext, mapResult, coverage }
   */
};

const DEFAULT_FLOW = 'guided_verification';

function getFlow(flowId) { return FLOWS[flowId] || null; }
function resolveFlow(flowId) { return FLOWS[flowId] || FLOWS[DEFAULT_FLOW]; }
function listFlows() { return Object.values(FLOWS).map((f) => ({ id: f.id, label: f.label })); }

module.exports = { getFlow, resolveFlow, listFlows, DEFAULT_FLOW };
