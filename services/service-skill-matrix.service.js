const { pool } = require('../db');
const logger = require('../logger');
const sophy = require('./sophy.service');

/*
 * Job Skill Matrix builder.
 *
 * Maps each SERVICE (a distinct rate-card name within a service CATEGORY) to the
 * DEEP SKILL(s) it needs, using the LLM to read the names. Keyed on CATEGORY,
 * NOT service_type: on live data deep skills and rate-card services use DISJOINT
 * service_type_id sets (0 overlap) — category is the only shared axis, and jobs
 * are matched by category anyway. Per category the model picks among that
 * category's deep skills (each tagged with its service-type for context) and
 * returns nothing for charge / fee / non-service line items. Results land in
 * tbl_service_skill_mapping (source=ai); candidate-ranking will later resolve a
 * job's services → required deep skills through this table (a separate, flagged
 * integration step).
 *
 * The LLM step routes through Sophy (services/sophy.service.js), the central AI
 * gateway — model/prompt/quota are key-controlled. Sophy folds our system prompt
 * into the user turn and parses JSON leniently, so callers pass {system,user} and
 * get an object (or null → degrade gracefully; never throws).
 */

const MODEL = 'sophy'; // reported in the build summary; the real model is key-set
const BATCH = 25; // service names classified per LLM call

/*
 * tbl_service_skill_mapping.source values — Title Case, acronym preserved
 * ('AI', not 'Ai'). ONE owner so the write, the replace-DELETE, and the stats
 * SUM can never drift to different casings. The CRM Skill Matrix page renders
 * this string verbatim (no transform), so the stored casing IS the displayed
 * casing. The column collation is utf8mb4_0900_ai_ci (case-INSENSITIVE), so
 * these comparisons still match legacy lower-case rows until the one-shot
 * normalisation migration (2026-07-19-title-case-service-skill-source.sql) runs
 * — nothing breaks in the interim; the next build self-heals AI rows to 'AI'.
 */
const SOURCE = Object.freeze({ AI: 'AI', MANUAL: 'Manual' });

// This feature's OWN Sophy key (own model/prompt/quota/cost line).
function sophyKey() {
  return process.env.SOPHY_API_KEY_SKILL_MATRIX;
}
function llmEnabled() {
  return sophy.enabled(sophyKey());
}

/*
 * SCHEMA-DRIFT GUARD. tbl_service_skill_mapping is EasyFix-owned, but some
 * environments still carry the PRE-RECUT shape keyed on `service_type_id`
 * instead of the canonical `service_catg_id` (see
 * migrations/executed/2026-07-02-create-tbl-service-skill-mapping.sql — the
 * table was deliberately re-keyed from service_type to service CATEGORY). Every
 * query here selects `service_catg_id`, so on a drifted env they 500 with
 * "Unknown column 'ssm.service_catg_id'" (observed on the Job Skill Matrix
 * page). This probe lets the read paths degrade to an empty, clearly-labelled
 * state instead of erroring, until the reconcile migration
 * (2026-07-24-reconcile-service-skill-mapping-schema.sql) is run on that host.
 *
 * ONLY a positive result is cached — same reasoning as candidate-ranking's
 * skillMatrixReadable(): a transient probe failure must not latch the feature
 * off for the whole process.
 */
let _categoryKeyed;
async function matrixCategoryKeyed() {
  if (_categoryKeyed === true) return true;
  try {
    const [rows] = await pool.query(
      "SHOW COLUMNS FROM tbl_service_skill_mapping WHERE Field = 'service_catg_id'",
    );
    if (rows.length) { _categoryKeyed = true; return true; }
  } catch (e) {
    logger.warn('Skill-matrix schema probe failed (will retry) · ' + e.message);
    return false;
  }
  logger.warn('tbl_service_skill_mapping is NOT category-keyed on this host — Job Skill Matrix reads return empty until the reconcile migration runs.');
  return false;
}

// Generic JSON chat call — routed through Sophy on the skill-matrix key. Returns
// the parsed object, or null on any failure (never throws; caller degrades).
async function chatJson({ system, user, maxTokens = 1500 }) {
  return sophy.chatJson({ system, user, maxTokens, apiKey: sophyKey() });
}

// Active deep skills grouped by category_id, each tagged with its service-type
// name (context for the LLM). Optionally scoped to one category.
async function loadSkillsByCategory({ categoryId = null } = {}) {
  const where = ['ds.status = 1'];
  const params = [];
  if (categoryId) { where.push('ds.category_id = ?'); params.push(categoryId); }
  const [rows] = await pool.query(
    `SELECT ds.deepskill_id, ds.deepskill_name, ds.category_id, st.service_type_name
       FROM tbl_deep_skill ds
       LEFT JOIN tbl_service_type st ON st.service_type_id = ds.service_type_id
      WHERE ${where.join(' AND ')}
      ORDER BY ds.category_id, ds.deepskill_id`,
    params,
  );
  const byCatg = new Map();
  for (const r of rows) {
    if (!byCatg.has(r.category_id)) byCatg.set(r.category_id, []);
    byCatg.get(r.category_id).push({
      deepskill_id: r.deepskill_id,
      name: r.deepskill_name,
      type: r.service_type_name || null,
    });
  }
  return byCatg;
}

// Distinct, trimmed, active service (rate-card) names for one category.
async function loadServiceNames(categoryId) {
  const [rows] = await pool.query(
    `SELECT DISTINCT TRIM(cr.crc_ratecard_name) AS name
       FROM tbl_client_service cs
       JOIN tbl_client_rate_card cr ON cr.crc_id = cs.rate_card_id
      WHERE cs.service_catg_id = ?
        AND cs.service_status = 1
        AND cr.crc_ratecard_name IS NOT NULL
        AND TRIM(cr.crc_ratecard_name) <> ''`,
    [categoryId],
  );
  return rows.map((r) => r.name).filter(Boolean);
}

// Classify a batch of service names against a category's deep skills.
// Returns { results: [{ service_name, deep_skill_id, confidence }], llmOk }.
// llmOk === false ONLY when the Sophy call itself failed (so the caller can
// retry); a genuine empty answer returns { results: [], llmOk: true }.
async function classifyBatch(categoryId, categoryName, skills, names) {
  const skillList = skills
    .map((s) => `${s.deepskill_id}: ${s.name}${s.type ? ` (${s.type})` : ''}`)
    .join('\n');
  const system = [
    'You map home-service booking line-items to the technical DEEP SKILL(s) a technician needs to perform them.',
    'You get a list of candidate deep skills (as "id: name (service type)") and a list of service line-item names, all within one service category.',
    'For EACH service name, choose the deep skill id(s) actually required to do that work.',
    'Rules:',
    '- Only choose ids from the given list. NEVER invent ids.',
    '- A service maps to 0, 1, or a few deep skills. Prefer the single best match; add more only when clearly needed.',
    '- If the name is a fee/charge/discount/incentive/visit-charge/tax or any non-service line item, or nothing fits, return an EMPTY ids array.',
    '- confidence is 0..1 (your certainty).',
    'Return STRICT JSON: {"mappings":[{"service":"<exact input name>","ids":[<id>,...],"confidence":<0..1>}]}',
  ].join('\n');
  const user =
    `Service Category: ${categoryName || categoryId}\n\n` +
    `Candidate deep skills:\n${skillList}\n\n` +
    `Service names:\n${names.map((n) => `- ${n}`).join('\n')}`;

  const out = await chatJson({ system, user });
  // out === null ⇒ the Sophy call itself failed (timeout / quota / unparseable).
  // Signal that so buildMatrix can RETRY — an empty {mappings:[]} is a real answer
  // (all non-service line items) and must NOT be retried.
  if (out == null) return { results: [], llmOk: false };

  const validIds = new Set(skills.map((s) => s.deepskill_id));
  // Map the model's echoed name back to the EXACT rate-card name we asked about.
  // Consumption (candidate-ranking loadJobSkillMatrix) joins ssm.service_name =
  // TRIM(crc_ratecard_name), so a name the model paraphrased even slightly would
  // store a row that never matches a real job again — a silent "missed in build".
  // Any returned name that isn't one of our inputs is a hallucination and dropped.
  const byNorm = new Map(names.map((n) => [n.trim().toLowerCase(), n]));
  const results = [];
  for (const m of (out?.mappings || [])) {
    const echoed = String(m?.service ?? '').trim();
    if (!echoed) continue;
    const name = byNorm.get(echoed.toLowerCase());
    if (!name) continue;
    const conf = Number(m?.confidence);
    for (const id of (Array.isArray(m?.ids) ? m.ids : [])) {
      const did = Number(id);
      if (validIds.has(did)) {
        results.push({ service_name: name, deep_skill_id: did, confidence: Number.isFinite(conf) ? conf : null });
      }
    }
  }
  return { results, llmOk: true };
}

/*
 * Build (or dry-run) the matrix. Scope is optional (categoryId). For each
 * in-scope category with active deep skills, classifies its distinct service
 * names in BATCHes, then wholesale-replaces the category's source=AI rows
 * (manual overrides preserved via INSERT IGNORE). Returns a summary.
 */
async function buildMatrix({ categoryId = null, dryRun = false } = {}) {
  if (!llmEnabled()) {
    const e = new Error('Sophy (SOPHY_API_KEY) is not configured — cannot build the skill matrix.');
    e.status = 422;
    throw e;
  }
  // A build WRITES service_catg_id rows — refuse clearly on a drifted schema
  // rather than failing mid-INSERT and leaving a half-built matrix.
  if (!(await matrixCategoryKeyed())) {
    const e = new Error('tbl_service_skill_mapping is not category-keyed on this host — run the reconcile migration (2026-07-24-reconcile-service-skill-mapping-schema.sql) before building.');
    e.status = 422;
    throw e;
  }
  const byCatg = await loadSkillsByCategory({ categoryId });
  logger.info(
    'Skill-matrix build start · categories=' + byCatg.size + ' · dryRun=' + dryRun +
    (categoryId ? ' · categoryId=' + categoryId : ''),
  );

  const catgNameById = new Map();
  if (byCatg.size) {
    const [cn] = await pool.query(
      `SELECT service_catg_id, service_catg_name FROM tbl_service_catg
        WHERE service_catg_id IN (${[...byCatg.keys()].map(() => '?').join(',')})`,
      [...byCatg.keys()],
    );
    for (const r of cn) catgNameById.set(r.service_catg_id, r.service_catg_name);
  }

  let categoriesProcessed = 0, servicesSeen = 0, mappingsFound = 0, mappingsWritten = 0, llmCalls = 0;
  let llmFailedBatches = 0;
  // (categoryId|serviceName) that received >=1 skill — lets the build report how
  // many services it left with NO mapping (visit/charge line items the model
  // deliberately skips, plus any genuine gaps worth a manual override).
  const mappedNames = new Set();
  for (const [catgId, skills] of byCatg) {
    const names = await loadServiceNames(catgId);
    if (names.length === 0) continue;
    categoriesProcessed++;
    servicesSeen += names.length;

    const found = [];
    for (let i = 0; i < names.length; i += BATCH) {
      const batchNames = names.slice(i, i + BATCH);
      llmCalls++;
      let { results, llmOk } = await classifyBatch(catgId, catgNameById.get(catgId), skills, batchNames);
      if (!llmOk) {
        // Retry ONCE. Without this a single transient Sophy failure silently
        // drops this whole batch's services from the matrix — the exact "some
        // are missed in build" symptom. A genuine empty answer never lands here.
        llmCalls++;
        ({ results, llmOk } = await classifyBatch(catgId, catgNameById.get(catgId), skills, batchNames));
        if (!llmOk) {
          llmFailedBatches++;
          logger.warn('skill-matrix: LLM batch failed twice — ' + batchNames.length + ' service(s) left unmapped this build · categoryId=' + catgId);
        }
      }
      for (const r of results) mappedNames.add(catgId + '|' + r.service_name.slice(0, 255));
      found.push(...results);
    }
    mappingsFound += found.length;

    if (!dryRun && found.length) {
      // De-dup within this build to satisfy the unique key.
      const seen = new Set();
      const values = [];
      for (const f of found) {
        const nm = f.service_name.slice(0, 255);
        const k = catgId + '|' + nm + '|' + f.deep_skill_id;
        if (seen.has(k)) continue;
        seen.add(k);
        values.push([catgId, nm, f.deep_skill_id, f.confidence, SOURCE.AI, 1]);
      }
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // Replace this category's AI mappings; INSERT IGNORE keeps manual overrides.
        await conn.query('DELETE FROM tbl_service_skill_mapping WHERE service_catg_id = ? AND source = ?', [catgId, SOURCE.AI]);
        if (values.length) {
          const [r] = await conn.query(
            'INSERT IGNORE INTO tbl_service_skill_mapping ' +
            '(service_catg_id, service_name, deep_skill_id, confidence, source, status) VALUES ?',
            [values],
          );
          mappingsWritten += r.affectedRows || 0;
        }
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        logger.warn('skill-matrix write failed for category ' + catgId + ' · ' + e.message);
      } finally {
        conn.release();
      }
    }
  }

  const servicesUnmapped = Math.max(servicesSeen - mappedNames.size, 0);
  const summary = { categoriesProcessed, servicesSeen, mappingsFound, mappingsWritten, servicesUnmapped, llmFailedBatches, llmCalls, dryRun, model: MODEL };
  logger.info('Skill-matrix build done · ' + JSON.stringify(summary));
  return summary;
}

async function getStats() {
  // Drifted schema → empty stats + a flag the FE renders as "not available here"
  // rather than a 500. `schemaReady:false` is the signal.
  if (!(await matrixCategoryKeyed())) {
    return { total: 0, categories: 0, skills: 0, manual: 0, llmConfigured: llmEnabled(), schemaReady: false };
  }
  const [[m]] = await pool.query(
    `SELECT COUNT(*) AS total,
            COUNT(DISTINCT service_catg_id) AS categories,
            COUNT(DISTINCT deep_skill_id) AS skills,
            SUM(source = ?) AS manual
       FROM tbl_service_skill_mapping WHERE status = 1`,
    [SOURCE.MANUAL],
  );
  return {
    total: m.total || 0,
    categories: m.categories || 0,
    skills: m.skills || 0,
    manual: Number(m.manual) || 0,
    llmConfigured: llmEnabled(),
  };
}

/*
 * Sortable columns for the CRM matrix table — the ONLY strings ever spliced
 * into ORDER BY. Keys are what the client sends; values are the real SQL
 * expressions. Never interpolate a raw client string here (the route Joi
 * whitelists against Object.keys(...) too, so this is defence-in-depth).
 *
 * Two of the five live on JOINED tables (sc / ds), which is exactly why the
 * COUNT query below has to carry the same LEFT JOINs — see list().
 */
const SORTABLE_COLUMNS = Object.freeze({
  service_catg_name: 'sc.service_catg_name',
  service_name:      'ssm.service_name',
  deepskill_name:    'ds.deepskill_name',
  confidence:        'ssm.confidence',
  source:            'ssm.source',
});

// Order applied when the client sends no (or an unrecognised) sortBy — the
// table's historical default, so the 3rd-click "unsorted" state restores it.
const DEFAULT_ORDER = 'ssm.service_catg_id, ssm.service_name';

/*
 * One page of the matrix, plus the TOTAL of the full filtered set.
 *
 * Search / sort / pagination are all server-side: a full build spans
 * thousands of (category, service) pairs, so the client can never hold the
 * whole matrix and sort it in memory. Returns { items, total } — `total`
 * drives the CRM's TablePagination.
 */
async function list({
  categoryId = null, q: searchTerm = null,
  sortBy = null, sortDir = 'asc',
  limit = 100, offset = 0,
} = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);

  // Drifted schema → empty page instead of a 500. The FE's stats call already
  // surfaces schemaReady:false, so an empty list here reads coherently.
  if (!(await matrixCategoryKeyed())) return { items: [], total: 0, schemaReady: false };

  const where = ['ssm.status = 1'];
  const params = [];
  if (categoryId) { where.push('ssm.service_catg_id = ?'); params.push(categoryId); }

  /*
   * Search spans the three NAME columns only (Category / Service / Deep
   * Skill), matching what the CRM used to filter client-side. Parameterised
   * LIKE with %-wrapped params — never string concatenation.
   */
  const q = String(searchTerm ?? '').trim();
  if (q) {
    where.push('(sc.service_catg_name LIKE ? OR ssm.service_name LIKE ? OR ds.deepskill_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const sortExpr = SORTABLE_COLUMNS[sortBy];
  const dir = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  // `ssm.id` is the tiebreaker on BOTH branches: without a unique trailing
  // key, rows tying on the sort column can shuffle between LIMIT windows and
  // the same row shows up on two pages (or on none).
  const orderBy = sortExpr ? `${sortExpr} ${dir}, ssm.id ASC` : `${DEFAULT_ORDER}, ssm.id ASC`;

  /*
   * The joins are NOT decoration — sc / ds supply two of the searchable name
   * columns and two of the sortable expressions. The COUNT query therefore
   * repeats them verbatim: a bare COUNT(*) over tbl_service_skill_mapping
   * would throw "Unknown column 'sc.service_catg_name'" the moment anyone
   * typed a category name into the search box.
   */
  const from =
    `FROM tbl_service_skill_mapping ssm
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = ssm.service_catg_id
       LEFT JOIN tbl_deep_skill ds ON ds.deepskill_id = ssm.deep_skill_id
      WHERE ${where.join(' AND ')}`;

  const [rows] = await pool.query(
    `SELECT ssm.id, ssm.service_catg_id, sc.service_catg_name, ssm.service_name,
            ssm.deep_skill_id, ds.deepskill_name, ssm.confidence, ssm.source, ssm.updated_on
       ${from}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, lim, off],
  );

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from}`, params);

  logger.info(
    'Skill-matrix list · returned=' + rows.length + ' · total=' + total +
    (categoryId ? ' · categoryId=' + categoryId : '') +
    (q ? ' · search=yes' : '') + (sortExpr ? ' · sortBy=' + sortBy + ' ' + dir : ''),
  );
  return { items: rows, total };
}

/* ────────────────────────────────────────────────────────────────────────
 * MANUAL GAP-FILL.
 *
 * The AI build deliberately leaves some services with NO skill (visit / charge
 * / estimate line items) and occasionally misses a genuine one. These let ops
 * map a gap by hand. Manual rows are PRESERVED across rebuilds — buildMatrix
 * only wholesale-replaces source='AI' rows — so a hand mapping sticks, and it
 * feeds candidate-ranking the same way an AI row does.
 * ──────────────────────────────────────────────────────────────────────── */

// Active deep skills for one category — the "which skill" picker. Same source
// (loadSkillsByCategory) that feeds the build, so a manual mapping can only
// point at a skill the build itself would consider valid for the category.
async function listDeepSkillsForCategory(categoryId) {
  const catgId = Number(categoryId);
  if (!catgId) return [];
  const byCatg = await loadSkillsByCategory({ categoryId: catgId });
  return (byCatg.get(catgId) || []).map((s) => ({
    deep_skill_id: s.deepskill_id, deepskill_name: s.name, service_type_name: s.type,
  }));
}

// Distinct active service names in a category, each flagged whether the matrix
// already maps it — the "which service" picker. Unmapped names are the gaps ops
// came to fill; mapped ones are still offered (a service can need a 2nd skill).
async function listCategoryServices(categoryId) {
  const catgId = Number(categoryId);
  if (!catgId || !(await matrixCategoryKeyed())) return [];
  const names = await loadServiceNames(catgId);
  if (!names.length) return [];
  const [mapped] = await pool.query(
    'SELECT DISTINCT service_name FROM tbl_service_skill_mapping WHERE service_catg_id = ? AND status = 1',
    [catgId],
  );
  const mappedSet = new Set(mapped.map((r) => String(r.service_name).trim().toLowerCase()));
  return names.map((n) => ({ service_name: n, mapped: mappedSet.has(n.trim().toLowerCase()) }));
}

/*
 * Lightweight gap COUNT for one category — powers the "Gaps Only (N)" badge on
 * the CRM matrix page WITHOUT shipping /category-services' full (1000+ row)
 * list. Reuses the SAME two reads listCategoryServices uses — loadServiceNames()
 * for active names + the distinct-mapped-names query — and intersects them
 * server-side. `unmapped` here is EXACTLY gapServices.length on the FE (active
 * names not in the mapped set), so the badge always agrees with the Gaps list.
 * Returns integers only. Schema-drift → schemaReady:false (mirrors getStats).
 */
async function gapsCount(categoryId) {
  const catgId = Number(categoryId);
  if (!catgId) return { total: 0, mapped: 0, unmapped: 0 };
  if (!(await matrixCategoryKeyed())) {
    return { total: 0, mapped: 0, unmapped: 0, schemaReady: false };
  }
  const names = await loadServiceNames(catgId);
  const total = names.length;
  if (!total) return { total: 0, mapped: 0, unmapped: 0 };
  const [mappedRows] = await pool.query(
    'SELECT DISTINCT service_name FROM tbl_service_skill_mapping WHERE service_catg_id = ? AND status = 1',
    [catgId],
  );
  const mappedSet = new Set(mappedRows.map((r) => String(r.service_name).trim().toLowerCase()));
  let mapped = 0;
  for (const n of names) if (mappedSet.has(n.trim().toLowerCase())) mapped++;
  return { total, mapped, unmapped: total - mapped };
}

/*
 * Add (or re-activate) a MANUAL mapping. Validated so a hand mapping can never
 * store a row the consumption join would silently miss:
 *   - service_name is resolved to the EXACT active rate-card name in the category
 *     (same reason the build resolves the model's echo — ranking joins on
 *     ssm.service_name = TRIM(crc_ratecard_name)).
 *   - deep_skill_id must be an ACTIVE deep skill in that category.
 * ON DUPLICATE upgrades an existing AI row for the same triple to Manual, so a
 * later rebuild won't wipe it.
 */
async function addManualMapping({ serviceCatgId, serviceName, deepSkillId }) {
  if (!(await matrixCategoryKeyed())) {
    const e = new Error('tbl_service_skill_mapping is not category-keyed on this host — run the reconcile migration before adding mappings.');
    e.status = 422;
    throw e;
  }
  const catgId = Number(serviceCatgId);
  const skillId = Number(deepSkillId);

  // Resolve the typed service name → the exact stored form (case/space-insensitive).
  const names = await loadServiceNames(catgId);
  const canonical = names.find(
    (n) => n.trim().toLowerCase() === String(serviceName || '').trim().toLowerCase(),
  );
  if (!canonical) {
    const e = new Error('That service name is not an active service in this category.');
    e.status = 422;
    throw e;
  }
  // The deep skill must belong to this category and be active.
  const skills = await listDeepSkillsForCategory(catgId);
  if (!skills.some((s) => Number(s.deep_skill_id) === skillId)) {
    const e = new Error('That deep skill is not an active skill in this category.');
    e.status = 422;
    throw e;
  }

  const [r] = await pool.query(
    `INSERT INTO tbl_service_skill_mapping
        (service_catg_id, service_name, deep_skill_id, confidence, source, status)
      VALUES (?, ?, ?, NULL, ?, 1)
      ON DUPLICATE KEY UPDATE source = VALUES(source), status = 1, confidence = NULL`,
    [catgId, canonical.slice(0, 255), skillId, SOURCE.MANUAL],
  );
  logger.info('skill-matrix manual mapping saved · categoryId=' + catgId + ' · skillId=' + skillId + ' · service=' + canonical);
  return { ok: true, service_name: canonical, insertId: r.insertId || null };
}

// Remove a mapping by id. Hard delete: a Manual row is gone for good; an AI row
// would return on the next build (the UI copy says so).
async function deleteMapping(id) {
  const [r] = await pool.query('DELETE FROM tbl_service_skill_mapping WHERE id = ?', [Number(id)]);
  logger.info('skill-matrix mapping deleted · id=' + id + ' · affected=' + (r.affectedRows || 0));
  return { ok: true, deleted: r.affectedRows || 0 };
}

module.exports = {
  buildMatrix, getStats, list, llmEnabled, SORTABLE_COLUMNS,
  listDeepSkillsForCategory, listCategoryServices, gapsCount, addManualMapping, deleteMapping,
};
