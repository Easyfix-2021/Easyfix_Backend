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
// Returns [{ service_name, deep_skill_id, confidence }].
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
  const validIds = new Set(skills.map((s) => s.deepskill_id));
  const result = [];
  for (const m of (out?.mappings || [])) {
    const name = String(m?.service ?? '').trim();
    if (!name) continue;
    const conf = Number(m?.confidence);
    for (const id of (Array.isArray(m?.ids) ? m.ids : [])) {
      const did = Number(id);
      if (validIds.has(did)) {
        result.push({ service_name: name, deep_skill_id: did, confidence: Number.isFinite(conf) ? conf : null });
      }
    }
  }
  return result;
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
  for (const [catgId, skills] of byCatg) {
    const names = await loadServiceNames(catgId);
    if (names.length === 0) continue;
    categoriesProcessed++;
    servicesSeen += names.length;

    const found = [];
    for (let i = 0; i < names.length; i += BATCH) {
      llmCalls++;
      found.push(...(await classifyBatch(catgId, catgNameById.get(catgId), skills, names.slice(i, i + BATCH))));
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

  const summary = { categoriesProcessed, servicesSeen, mappingsFound, mappingsWritten, llmCalls, dryRun, model: MODEL };
  logger.info('Skill-matrix build done · ' + JSON.stringify(summary));
  return summary;
}

async function getStats() {
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

module.exports = { buildMatrix, getStats, list, llmEnabled, SORTABLE_COLUMNS };
