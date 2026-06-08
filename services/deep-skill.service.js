const { pool } = require('../db');

/*
 * Deep-skill catalogue management.
 *
 * Schema (existing, legacy):
 *   tbl_deep_skill          — the leaf rows ("Window AC", "Office Chair")
 *   tbl_deepskill_options   — options per skill ("Installation", "Repair", …)
 *
 * One weirdness to preserve: `tbl_deep_skill.skill_options` is a denormalised
 * JSON string that mirrors the normalised rows in tbl_deepskill_options. Legacy
 * code reads from both depending on the caller. We keep them in sync on every
 * option write via syncSkillOptionsJson().
 *
 * Other deep-skill tables we DO NOT touch here:
 *   tbl_efr_deepskill_mapping — tech assignments, managed via the profile flow
 *   efr_dskill_status         — verification state per (tech, category)
 *   tx_category_skill_status  — empty bigint-keyed shadow (newer schema, not in use)
 *   tbl_skill_master          — legacy L1/L2 skill tiers, unrelated
 */

// ─── Deep-skill CRUD ────────────────────────────────────────────────
async function list({ categoryId, serviceTypeId, includeInactive = false } = {}) {
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('ds.status = 1');
  if (categoryId    != null) { clauses.push('ds.category_id = ?');     params.push(categoryId); }
  if (serviceTypeId != null) { clauses.push('ds.service_type_id = ?'); params.push(serviceTypeId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(`
    SELECT ds.deepskill_id, ds.category_id, ds.service_type_id,
           ds.deepskill_name, ds.deepskill_description, ds.status,
           ds.deepskill_image, ds.inserted_on, ds.inserted_by,
           sc.service_catg_name AS category_name,
           st.service_type_name,
           (SELECT COUNT(*) FROM tbl_deepskill_options o
             WHERE o.deepskill_id = ds.deepskill_id AND o.status = 1) AS option_count
      FROM tbl_deep_skill ds
      LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = ds.category_id
      LEFT JOIN tbl_service_type st ON st.service_type_id = ds.service_type_id
      ${where}
      ORDER BY ds.deepskill_name ASC
  `, params);
  return rows;
}

async function getById(deepskillId) {
  const [[row]] = await pool.query(`
    SELECT ds.*, sc.service_catg_name AS category_name, st.service_type_name
      FROM tbl_deep_skill ds
      LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = ds.category_id
      LEFT JOIN tbl_service_type st ON st.service_type_id = ds.service_type_id
     WHERE ds.deepskill_id = ? LIMIT 1
  `, [deepskillId]);
  if (!row) return null;
  const [options] = await pool.query(
    'SELECT id, skill_option, status FROM tbl_deepskill_options WHERE deepskill_id = ? ORDER BY id',
    [deepskillId]
  );
  return { ...row, options };
}

async function create(input, actor) {
  const [ins] = await pool.query(`
    INSERT INTO tbl_deep_skill
      (category_id, service_type_id, deepskill_name, deepskill_description,
       deepskill_tag_words,
       status, inserted_by, inserted_on, deepskill_image, skill_options)
    VALUES (?, ?, ?, ?, ?, 1, ?, NOW(), ?, '[]')
  `, [
    input.category_id, input.service_type_id,
    input.deepskill_name, input.deepskill_description || null,
    // deepskill_tag_words (2026-06-06): per-skill technician-visit
    // tag(s), max ~2 short phrases per ops file Col B. Separate
    // semantic from the keyword search string in deepskill_description.
    input.deepskill_tag_words || null,
    actor?.user_id || null,
    input.deepskill_image || '',
  ]);
  return getById(ins.insertId);
}

async function update(deepskillId, patch) {
  const MUTABLE = ['category_id', 'service_type_id', 'deepskill_name',
    'deepskill_description', 'deepskill_tag_words', 'deepskill_image', 'status'];
  const sets = []; const values = [];
  for (const col of MUTABLE) {
    if (patch[col] !== undefined) { sets.push(`${col} = ?`); values.push(patch[col]); }
  }
  if (sets.length === 0) return getById(deepskillId);
  values.push(deepskillId);
  await pool.query(`UPDATE tbl_deep_skill SET ${sets.join(', ')} WHERE deepskill_id = ?`, values);
  return getById(deepskillId);
}

async function setStatus(deepskillId, active) {
  await pool.query('UPDATE tbl_deep_skill SET status = ? WHERE deepskill_id = ?',
    [active ? 1 : 0, deepskillId]);
  return getById(deepskillId);
}

// ─── Options CRUD (under a deep skill) ──────────────────────────────
/*
 * Every write to tbl_deepskill_options also refreshes the denormalised JSON
 * blob on tbl_deep_skill.skill_options. Legacy consumers (Angular dashboard,
 * technician mobile flow) read one or the other; keeping them in sync is the
 * price we pay for not refactoring the schema.
 */
async function syncSkillOptionsJson(deepskillId) {
  const [rows] = await pool.query(
    'SELECT skill_option FROM tbl_deepskill_options WHERE deepskill_id = ? AND status = 1 ORDER BY id',
    [deepskillId]
  );
  const json = JSON.stringify(rows.map((r) => r.skill_option));
  await pool.query('UPDATE tbl_deep_skill SET skill_options = ? WHERE deepskill_id = ?',
    [json, deepskillId]);
}

async function addOption(deepskillId, { skill_option }) {
  const [ins] = await pool.query(
    'INSERT INTO tbl_deepskill_options (deepskill_id, skill_option, status) VALUES (?, ?, 1)',
    [deepskillId, skill_option]
  );
  await syncSkillOptionsJson(deepskillId);
  return { id: ins.insertId };
}

async function updateOption(deepskillId, optionId, patch) {
  const sets = []; const values = [];
  if (patch.skill_option !== undefined) { sets.push('skill_option = ?'); values.push(patch.skill_option); }
  if (patch.status       !== undefined) { sets.push('status = ?');       values.push(patch.status ? 1 : 0); }
  if (sets.length === 0) return { ok: true };
  values.push(optionId, deepskillId);
  await pool.query(
    `UPDATE tbl_deepskill_options SET ${sets.join(', ')} WHERE id = ? AND deepskill_id = ?`,
    values
  );
  await syncSkillOptionsJson(deepskillId);
  return { ok: true };
}

async function deleteOption(deepskillId, optionId) {
  // Soft delete — set status=0 and refresh the JSON blob. Hard delete would
  // break historical tbl_efr_deepskill_mapping rows that reference the option.
  await pool.query(
    'UPDATE tbl_deepskill_options SET status = 0 WHERE id = ? AND deepskill_id = ?',
    [optionId, deepskillId]
  );
  await syncSkillOptionsJson(deepskillId);
  return { ok: true };
}

// ─── Sub-resource: Mapped Easyfixers ────────────────────────────────
/*
 * Feeds the "View Mapped Easyfixers" modal on the Manage Deep Skills page.
 *
 * Schema reality (legacy column naming inversion — preserved, do NOT
 * "correct" these names; see services/candidate-ranking.service.js:120-141):
 *
 *   tbl_efr_deepskill_mapping
 *     easyfixer_id      → FK to tbl_easyfixer.efr_id
 *     parent_skill_id   → legacy: actually holds deep_skill_id (3rd-level)
 *     deep_skill_id     → legacy: actually holds option_id (tbl_deepskill_options.id)
 *     is_repairing      → active flag (1 active / 0 inactive)
 *     insert_date       → audit timestamp (column attested in
 *                         easyfixer.service.js:591 — `m.insert_date AS mapped_at`)
 *
 * A single easyfixer can map to MULTIPLE options under the same deep skill,
 * so we GROUP BY easyfixer_id and GROUP_CONCAT the option labels.
 */
async function listMappedEasyfixers(deepSkillId, { limit = 10, offset = 0 } = {}) {
  const [[{ total }]] = await pool.query(`
    SELECT COUNT(DISTINCT m.easyfixer_id) AS total
      FROM tbl_efr_deepskill_mapping m
     WHERE m.parent_skill_id = ?
       AND m.is_repairing = 1
  `, [deepSkillId]);

  const [rows] = await pool.query(`
    SELECT e.efr_id,
           e.efr_name,
           e.efr_no,
           e.efr_email,
           c.city_name,
           COUNT(DISTINCT o.id) AS option_count,
           GROUP_CONCAT(DISTINCT o.skill_option ORDER BY o.skill_option SEPARATOR ', ') AS mapped_options,
           e.efr_status,
           e.is_technician_verified,
           MAX(m.insert_date) AS last_mapped_at
      FROM tbl_efr_deepskill_mapping m
      JOIN tbl_easyfixer e              ON e.efr_id = m.easyfixer_id
      LEFT JOIN tbl_city c              ON c.city_id = e.efr_cityId
      LEFT JOIN tbl_deepskill_options o ON o.id = m.deep_skill_id
     WHERE m.parent_skill_id = ?
       AND m.is_repairing = 1
     GROUP BY e.efr_id, e.efr_name, e.efr_no, e.efr_email, c.city_name, e.efr_status, e.is_technician_verified
     ORDER BY e.efr_name ASC
     LIMIT ? OFFSET ?
  `, [deepSkillId, Number(limit), Number(offset)]);

  return { rows, total };
}

/*
 * Bulk mapped-easyfixer counts (2026-06-08). Drives the new "Mapped
 * Easyfixers" aggregate column on the Manage Deep Skills list page —
 * one count per skill_id passed in, returned as a flat array of
 * { deepskill_id, count } pairs.
 *
 * Same JOIN/filter logic as listMappedEasyfixers above, but rolled up
 * by parent_skill_id instead of paginating one skill's easyfixers.
 * Single round-trip for the whole page (typically 10-50 skill ids per
 * call); GROUP BY uses the legacy-named `parent_skill_id` (which
 * actually holds the deep_skill_id per the column-inversion docblock
 * at the top of this file).
 *
 * Hard cap of 500 ids per call — mirrors the aggregates endpoint cap
 * on /admin/easyfixers and is well above any realistic page size.
 * Empty / non-positive ids are silently dropped.
 */
async function mappedEasyfixerCounts(deepSkillIds) {
  if (!Array.isArray(deepSkillIds) || deepSkillIds.length === 0) {
    return { rows: [] };
  }
  const ids = deepSkillIds
    .slice(0, 500)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return { rows: [] };

  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(`
    SELECT m.parent_skill_id              AS deepskill_id,
           COUNT(DISTINCT m.easyfixer_id) AS count
      FROM tbl_efr_deepskill_mapping m
     WHERE m.parent_skill_id IN (${placeholders})
       AND m.is_repairing = 1
     GROUP BY m.parent_skill_id
  `, ids);

  return { rows };
}

module.exports = {
  list, getById, create, update, setStatus,
  addOption, updateOption, deleteOption,
  listMappedEasyfixers,
  mappedEasyfixerCounts,
};
