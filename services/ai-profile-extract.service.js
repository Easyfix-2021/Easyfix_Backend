/*
 * Post-call mapping for the AI-calling flow's `profile_update` step. Takes the
 * raw conversation transcript and produces DISPLAY-ONLY semantic IDs:
 *   - deep_skill_items[] : {category_id, service_type_id, deep_skill_id, option_id}
 *     matched against the live Deep-Skill catalog (fetchDeepSkillCatalog).
 *   - serviceable_pincode_ids[] : resolved via searchPincodes / ensurePincode.
 * NOTHING is written to real profile tables — the caller only shows this on UI.
 *
 * The LLM step routes through Sophy (services/sophy.service.js), the central AI
 * gateway — model/prompt/quota are key-controlled. Sophy folds our instructions
 * into the user turn and parses JSON leniently, so we just pass system+user and
 * get back an object (or null → the flow degrades to "unmapped" cleanly).
 */

const logger = require('../logger');
const { fetchDeepSkillCatalog, searchPincodes } = require('./easyfixer-profile-update-link.service');
const { ensurePincode } = require('./pincode.service');
const sophy = require('./sophy.service');

// Bound the prompt: catalogs are usually a few hundred options; hard-cap so a
// pathological catalog can never blow the context window (we log if we clip).
const MAX_CATALOG_TUPLES = 700;
const MAX_TRANSCRIPT_CHARS = 12000;
const MAX_AREAS = 25;
const PINCODES_PER_AREA = 50;

// Flatten the nested catalog into option-level tuples + a validation key set +
// a key→label map (for display chips). `keys` guards against hallucinated IDs.
function flattenCatalog(tree) {
  const tuples = [];
  const keys = new Set();
  const labelByKey = new Map();
  for (const c of tree || []) {
    for (const t of c.service_types || []) {
      for (const d of t.deep_skills || []) {
        for (const o of d.options || []) {
          const key = `${c.category_id}|${t.service_type_id}|${d.deep_skill_id}|${o.option_id}`;
          if (keys.has(key)) continue;
          keys.add(key);
          const label = `${c.category_name} > ${t.service_type_name} > ${d.deep_skill_name} > ${o.option_name}`;
          labelByKey.set(key, label);
          tuples.push({ ci: c.category_id, ti: t.service_type_id, di: d.deep_skill_id, oi: o.option_id, label });
        }
      }
    }
  }
  return { tuples, keys, labelByKey };
}

function catalogListing(tuples) {
  // One compact line per option, ids inline so the model returns real IDs.
  return tuples
    .map((x) => `[ci=${x.ci} ti=${x.ti} di=${x.di} oi=${x.oi}] ${x.label}`)
    .join('\n');
}

// Keep only matches that correspond to a REAL catalog tuple; dedupe + attach label.
function validateMatches(matches, keys, labelByKey) {
  const out = [];
  const seen = new Set();
  for (const m of Array.isArray(matches) ? matches : []) {
    const ci = Number(m && m.category_id);
    const ti = Number(m && m.service_type_id);
    const di = Number(m && m.deep_skill_id);
    const oi = Number(m && m.option_id);
    if (![ci, ti, di, oi].every(Number.isFinite)) continue;
    const key = `${ci}|${ti}|${di}|${oi}`;
    if (!keys.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      category_id: ci, service_type_id: ti, deep_skill_id: di, option_id: oi,
      label: labelByKey.get(key) || null,
    });
  }
  return out;
}

// Resolve spoken service areas (city names OR 6-digit codes) to pincodes. Returns
// both the id list (for a future real save) and display rows (for the UI list).
async function mapAreas(areas, pool) {
  const byId = new Map(); // pincode_id → {pincode_id, pincode, city_name}
  const unmapped = [];
  const list = (Array.isArray(areas) ? areas : []).slice(0, MAX_AREAS);
  for (const raw of list) {
    const area = String(raw == null ? '' : raw).trim();
    if (!area) continue;
    let rows = [];
    try { rows = await searchPincodes(area, PINCODES_PER_AREA, pool); } catch { rows = []; }
    // Spoken 6-digit code with no catalog row yet → geocode-create (best effort).
    if ((!rows || rows.length === 0) && /^\d{6}$/.test(area)) {
      try {
        const p = await ensurePincode(area, {});
        if (p && p.pincode_id) rows = [p];
      } catch (e) {
        logger.warn('ai-profile-extract ensurePincode(' + area + ') · ' + e.message);
      }
    }
    if (rows && rows.length) {
      for (const r of rows) {
        const pid = Number(r.pincode_id);
        if (!Number.isFinite(pid) || byId.has(pid)) continue;
        byId.set(pid, {
          pincode_id: pid,
          pincode: r.pincode != null ? String(r.pincode) : null,
          city_name: r.city_name || null,
        });
      }
    } else {
      unmapped.push(area);
    }
  }
  const pincodes = Array.from(byId.values());
  return { ids: pincodes.map((p) => p.pincode_id), pincodes, unmapped };
}

const SKILL_SYSTEM = (listing) => [
  'You map a field technician\'s spoken answers (from a phone-call transcript) to a',
  'fixed CATALOG of deep-skill options. The technician talks in Hindi / Hinglish /',
  'English about what work they can do and which areas they serve.',
  '',
  'CATALOG (each line is ONE selectable option with its exact IDs):',
  listing,
  '',
  'Return STRICT JSON ONLY with this EXACT shape:',
  '{',
  '  "matches": [ { "category_id": <ci>, "service_type_id": <ti>, "deep_skill_id": <di>, "option_id": <oi> } ],',
  '  "skills_unmapped": [ "<skill the technician mentioned that has NO catalog match>" ],',
  '  "areas": [ "<city / locality / 6-digit pincode the technician said they serve>" ]',
  '}',
  'Rules:',
  '- Use ONLY id combinations that appear together on a single CATALOG line above. Never invent IDs.',
  '- Include a match only when the transcript clearly supports it. Prefer precision over recall.',
  '- If the technician names a skill with no catalog line, put it in skills_unmapped (do NOT force a match).',
  '- areas: list every place/pincode they said they can service. Empty array if none.',
  '- Output nothing but the JSON object.',
].join('\n');

/**
 * mapTranscript(transcript, pool, { apiKey }) → {
 *   deep_skill_items, serviceable_pincode_ids,
 *   unmapped: { skills:[], areas:[] }, extracted: { areas:[] }, note?
 * }
 * `apiKey` is the AI-calling flow's own Sophy key (passed by the flow registry).
 * Never throws — returns empty arrays with a note on any failure.
 */
async function mapTranscript(transcript, pool, { apiKey } = {}) {
  const text = String(transcript == null ? '' : transcript).trim();
  const empty = {
    deep_skill_items: [], serviceable_pincode_ids: [], serviceable_pincodes: [],
    unmapped: { skills: [], areas: [] }, extracted: { areas: [] },
  };
  if (text.length < 5) return { ...empty, note: 'empty transcript' };
  if (!sophy.enabled(apiKey)) return { ...empty, note: 'Sophy (AI gateway) not configured — mapping skipped' };

  let tree = [];
  try { tree = await fetchDeepSkillCatalog(pool); } catch (e) {
    logger.warn('ai-profile-extract catalog load failed · ' + e.message);
    return { ...empty, note: 'catalog unavailable' };
  }
  const { tuples, keys, labelByKey } = flattenCatalog(tree);
  const clipped = tuples.length > MAX_CATALOG_TUPLES;
  if (clipped) {
    logger.warn('ai-profile-extract catalog clipped ' + tuples.length + '→' + MAX_CATALOG_TUPLES);
  }
  const listing = catalogListing(tuples.slice(0, MAX_CATALOG_TUPLES));

  const out = await sophy.chatJson({
    system: SKILL_SYSTEM(listing),
    user: 'Transcript:\n"""\n' + text.slice(0, MAX_TRANSCRIPT_CHARS) + '\n"""',
    maxTokens: 1500,
    apiKey,
  });
  if (!out) return { ...empty, note: 'LLM mapping failed' };

  const deep_skill_items = validateMatches(out.matches, keys, labelByKey);
  const areas = Array.isArray(out.areas) ? out.areas : [];
  const { ids, pincodes, unmapped: unmappedAreas } = await mapAreas(areas, pool);

  return {
    deep_skill_items,
    serviceable_pincode_ids: ids,
    serviceable_pincodes: pincodes,
    unmapped: {
      skills: Array.isArray(out.skills_unmapped) ? out.skills_unmapped.map(String) : [],
      areas: unmappedAreas,
    },
    extracted: { areas: areas.map(String) },
    // Observability: the skill catalog was larger than the prompt cap, so tail
    // options couldn't be matched — surface it rather than only logging it.
    ...(clipped ? { note: `Only the first ${MAX_CATALOG_TUPLES} catalog options were considered — some skills may be unmatched.` } : {}),
  };
}

module.exports = { mapTranscript };
