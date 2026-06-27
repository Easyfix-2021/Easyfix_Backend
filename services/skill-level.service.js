const { pool } = require('../db');
const logger = require('../logger');

/*
 * Manage Skill Level — master for tbl_skill_master.
 *
 * Legacy schema columns: skill_id, skill_name, skill_desc, skill_status.
 * No FK relationships, no image upload, no dependent dropdowns —
 * the simplest of the master-data screens.
 *
 * Distinct from the new app's "Deep Skill" feature (4-level hierarchy
 * managed at /settings/deep-skills). Skill Level here is the legacy
 * L1/L2/L3 tier master used by legacy scoring; both exist side-by-side.
 */

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

const SORTABLE_COLUMNS = Object.freeze({
  skill_id:     'skill_id',
  skill_name:   'skill_name',
  skill_status: 'skill_status',
});

async function listSkills({
  q, includeInactive = false,
  limit = 200, offset = 0,
  sortBy = 'skill_name', sortDir = 'asc',
} = {}) {
  limit  = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);
  logger.info('Listing skills · q=' + (q || '-') + ' · includeInactive=' + includeInactive + ' · limit=' + limit + ' · offset=' + offset + ' · sortBy=' + sortBy + ' · sortDir=' + sortDir);

  const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.skill_name;
  const dir      = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const orderBy  = `${sortExpr} ${dir}, skill_id ASC`;

  const where  = ['1=1'];
  const params = [];
  if (!includeInactive) where.push('skill_status = 1');
  if (q) {
    where.push('(skill_name LIKE ? OR skill_desc LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  const [rows] = await pool.query(
    `SELECT skill_id, skill_name, skill_desc, skill_status
       FROM tbl_skill_master
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_skill_master WHERE ${where.join(' AND ')}`,
    params
  );
  logger.info('Found ' + rows.length + ' skills · total=' + total);
  return { items: rows, total };
}

async function getSkillById(id) {
  logger.info('Fetching skill · id=' + id);
  const [[row]] = await pool.query(
    'SELECT skill_id, skill_name, skill_desc, skill_status FROM tbl_skill_master WHERE skill_id = ? LIMIT 1',
    [id]
  );
  return row || null;
}

async function createSkill({ skill_name, skill_desc }) {
  const name = String(skill_name || '').trim();
  logger.info('Creating skill · skill_name=' + (name || '-'));
  if (!name) throw mkErr(400, 'skill_name is required');

  const [[dup]] = await pool.query(
    'SELECT skill_id FROM tbl_skill_master WHERE LOWER(skill_name) = LOWER(?) LIMIT 1',
    [name]
  );
  if (dup) {
    logger.warn('Skill create rejected, duplicate name=' + name);
    throw mkErr(409, `Skill "${name}" already exists`);
  }

  const [r] = await pool.query(
    'INSERT INTO tbl_skill_master (skill_name, skill_desc, skill_status) VALUES (?, ?, 1)',
    [name, skill_desc ? String(skill_desc).trim() : null]
  );
  logger.info('Skill created · id=' + r.insertId);
  return getSkillById(r.insertId);
}

async function updateSkill(id, fields) {
  logger.info('Updating skill · id=' + id + ' · fields=' + Object.keys(fields || {}).join(','));
  const [[me]] = await pool.query(
    'SELECT skill_id FROM tbl_skill_master WHERE skill_id = ? LIMIT 1',
    [id]
  );
  if (!me) {
    logger.warn('Skill update failed, not found · id=' + id);
    throw mkErr(404, 'Skill not found');
  }

  const sets = [];
  const params = [];
  if (fields.skill_name !== undefined) {
    const name = String(fields.skill_name).trim();
    if (!name) throw mkErr(400, 'skill_name cannot be blank');
    sets.push('skill_name = ?'); params.push(name);
  }
  if (fields.skill_desc !== undefined) {
    sets.push('skill_desc = ?');
    params.push(fields.skill_desc ? String(fields.skill_desc).trim() : null);
  }
  if (fields.is_active !== undefined) {
    sets.push('skill_status = ?'); params.push(fields.is_active ? 1 : 0);
  }
  if (!sets.length) throw mkErr(400, 'No mutable fields supplied');

  params.push(id);
  await pool.query(`UPDATE tbl_skill_master SET ${sets.join(', ')} WHERE skill_id = ?`, params);
  logger.info('Skill updated · id=' + id);
  return getSkillById(id);
}

async function deactivateSkill(id) {
  logger.info('Deactivating skill · id=' + id);
  const [r] = await pool.query('UPDATE tbl_skill_master SET skill_status = 0 WHERE skill_id = ?', [id]);
  if (r.affectedRows > 0) logger.info('Skill deactivated · id=' + id);
  else logger.warn('Skill deactivate matched no row · id=' + id);
  return r.affectedRows > 0;
}

module.exports = {
  listSkills, getSkillById, createSkill, updateSkill, deactivateSkill, SORTABLE_COLUMNS,
};
