const { pool } = require('../db');
const { resolveDeepSkillImageUrl } = require('../utils/s3-storage');

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
  // Resolve the bare filename in deepskill_image to a renderable URL
  // (S3 presigned if present, else /easydoc/upload_jobs/ disk URL). Raw
  // value is preserved so the legacy CRM contract is unaffected.
  await Promise.all(rows.map(async (r) => {
    r.deepskill_image_url = await resolveDeepSkillImageUrl(r.deepskill_image);
  }));
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
  row.deepskill_image_url = await resolveDeepSkillImageUrl(row.deepskill_image);
  return { ...row, options };
}

async function create(input, actor) {
  const [ins] = await pool.query(`
    INSERT INTO tbl_deep_skill
      (category_id, service_type_id, deepskill_name, deepskill_description,
       status, inserted_by, inserted_on, deepskill_image, skill_options)
    VALUES (?, ?, ?, ?, 1, ?, NOW(), ?, '[]')
  `, [
    input.category_id, input.service_type_id,
    input.deepskill_name, input.deepskill_description || null,
    actor?.user_id || null,
    input.deepskill_image || '',
  ]);
  return getById(ins.insertId);
}

async function update(deepskillId, patch) {
  const MUTABLE = ['category_id', 'service_type_id', 'deepskill_name',
    'deepskill_description', 'deepskill_image', 'status'];
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

module.exports = {
  list, getById, create, update, setStatus,
  addOption, updateOption, deleteOption,
};
