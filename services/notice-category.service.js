const { pool } = require('../db');
const logger = require('../logger');

/*
 * Notice categories — coloured-chip tags on every notice. Admin-managed
 * via the Compose form's inline "+ Add" affordance and the dedicated
 * settings page. Soft-delete only (`is_active=0`) so old notices keep
 * resolving their category name + colour even after the category is
 * retired from new-notice pickers.
 */

function mkErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function listCategories({ includeInactive = false } = {}) {
  logger.info('List notice categories · includeInactive=' + includeInactive);
  const where = includeInactive ? '1=1' : 'is_active = 1';
  const [rows] = await pool.query(
    `SELECT category_id, name, color, applies_to_surfaces, sort_order, is_active,
            created_at, updated_at
       FROM tbl_notice_category
      WHERE ${where}
      ORDER BY sort_order ASC, name ASC`,
  );
  logger.info('Found ' + rows.length + ' notice categories');
  return rows;
}

async function getCategoryById(categoryId) {
  const [[row]] = await pool.query(
    `SELECT category_id, name, color, applies_to_surfaces, sort_order, is_active,
            created_at, updated_at
       FROM tbl_notice_category
      WHERE category_id = ?`,
    [categoryId],
  );
  return row || null;
}

async function createCategory({ name, color, applies_to_surfaces, sort_order }) {
  logger.info('Create notice category · name=' + name + ' · color=' + color);
  // Name uniqueness is enforced by the UNIQUE INDEX, but we catch and
  // translate the error so callers see a friendly 409 instead of a raw
  // mysql ER_DUP_ENTRY.
  try {
    const [r] = await pool.query(
      `INSERT INTO tbl_notice_category
         (name, color, applies_to_surfaces, sort_order, is_active)
       VALUES (?, ?, ?, ?, 1)`,
      [name, color, applies_to_surfaces, sort_order],
    );
    logger.info('Notice category created · id=' + r.insertId);
    return getCategoryById(r.insertId);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      logger.warn('Create notice category rejected (duplicate name) · ' + e.message);
      throw mkErr(409, `Category "${name}" already exists`);
    }
    throw e;
  }
}

async function updateCategory(categoryId, fields) {
  logger.info('Update notice category · id=' + categoryId + ' · fields=' + Object.keys(fields || {}).join(','));
  const allowed = ['name', 'color', 'applies_to_surfaces', 'sort_order', 'is_active'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      params.push(fields[k]);
    }
  }
  if (!sets.length) return getCategoryById(categoryId);
  params.push(categoryId);
  try {
    await pool.query(
      `UPDATE tbl_notice_category SET ${sets.join(', ')} WHERE category_id = ?`,
      params,
    );
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      logger.warn('Update notice category rejected (duplicate name) · id=' + categoryId + ' · ' + e.message);
      throw mkErr(409, `Category name already in use`);
    }
    throw e;
  }
  logger.info('Notice category updated · id=' + categoryId);
  return getCategoryById(categoryId);
}

module.exports = {
  listCategories,
  getCategoryById,
  createCategory,
  updateCategory,
};
