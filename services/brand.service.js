const { pool } = require('../db');
const logger = require('../logger');
const { nameKey } = require('../utils/name-key');
const refs = require('./material-references');

/*
 * Manage Materials — Brand Master (tbl_brand_master).
 *
 * Uniqueness: UNIQUE KEY on brand_key (nameKey(brand_name)) — the DB index is
 * the real guard, the pre-check below is UX only (see createBrand/updateBrand).
 *
 * `is_system` is a generic guard, kept for any future system-seeded brand:
 * a row with is_system=1 is not editable, not deactivatable, not deletable —
 * every mutating path 422s on it. No system brand is seeded today (the
 * former "Not Applicable" row was dropped — see
 * migrations/2026-09-17-manage-materials-drop-not-applicable-brand.sql and
 * Decision A in the QA-fixes scratchpad: "No Brand" pricing replaced it).
 */

function mkErr(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

const SORTABLE_COLUMNS = Object.freeze({
  brand_name: 'b.brand_name',
  status:     'b.status',
  // used_by is a derived subquery column — sorted via its alias.
  used_by:    'used_by',
});

async function listBrands({
  search, status = 'active',
  page = 0, limit = 20,
  sort_by = 'brand_name', sort_dir = 'asc',
} = {}) {
  limit = Math.min(Math.max(Number(limit) || 20, 1), 1000);
  page  = Math.max(Number(page) || 0, 0);
  const offset = page * limit;

  logger.info('List brands · search=' + (search || '') + ' status=' + status + ' page=' + page + ' limit=' + limit);

  // is_system rows (e.g. the retired "Not Applicable" brand) never surface
  // in the Brand Master list, regardless of the status filter.
  const where = ['b.is_system = 0'];
  const params = [];
  if (status === 'active') where.push('b.status = 1');
  else if (status === 'inactive') where.push('b.status = 0');
  // 'all' → no additional status filter

  if (search) {
    // Explicit LOWER() on both sides — case-insensitive substring match
    // regardless of the column's collation (matches pincode.service.js /
    // maps.service.js precedent rather than relying on a _ci default).
    where.push('LOWER(b.brand_name) LIKE LOWER(?)');
    params.push(`%${search}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sortExpr = SORTABLE_COLUMNS[sort_by] || SORTABLE_COLUMNS.brand_name;
  const dir = String(sort_dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const [rows] = await pool.query(
    `SELECT b.brand_id, b.brand_name, CAST(b.is_system AS SIGNED) AS is_system, CAST(b.status AS SIGNED) AS status,
            -- Used By = ACTIVE materials only (owner, QA 2026-09-17): deactivating a
            -- material must lower it. Delete protection counts ALL references via
            -- material-references.js — an inactive material still points at the brand.
            (SELECT COUNT(DISTINCT gb.material_id)
               FROM tbl_material_price_group_brand gb
               JOIN tbl_material_master m ON m.material_id = gb.material_id AND m.status = 1
              WHERE gb.brand_id = b.brand_id) AS used_by
       FROM tbl_brand_master b
       ${whereSql}
      ORDER BY ${sortExpr} ${dir}, b.brand_id ASC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_brand_master b ${whereSql}`,
    params
  );
  logger.info('Found ' + rows.length + ' brands (total=' + total + ')');
  return { items: rows, total };
}

async function getBrandById(id) {
  const [[row]] = await pool.query(
    `SELECT brand_id, brand_name, CAST(is_system AS SIGNED) AS is_system, CAST(status AS SIGNED) AS status FROM tbl_brand_master WHERE brand_id = ? LIMIT 1`,
    [id]
  );
  return row || null;
}

async function listActiveBrandOptions() {
  // Never offer an is_system row (e.g. the retired "Not Applicable" brand)
  // in the material-picker's brand options.
  const [rows] = await pool.query(
    `SELECT brand_id, brand_name, CAST(is_system AS SIGNED) AS is_system FROM tbl_brand_master WHERE status = 1 AND is_system = 0 ORDER BY brand_name ASC`
  );
  return rows;
}

async function createBrand({ brand_name }, actor = {}) {
  const name = String(brand_name || '').trim();
  if (!name) throw mkErr(400, 'brand_name is required');
  const key = nameKey(name);

  const [[dup]] = await pool.query(
    `SELECT brand_id, brand_name FROM tbl_brand_master WHERE brand_key = ? LIMIT 1`,
    [key]
  );
  if (dup) throw mkErr(409, `A brand named "${dup.brand_name}" already exists.`);

  try {
    const [r] = await pool.query(
      `INSERT INTO tbl_brand_master (brand_name, brand_key, is_system, status, created_by, created_at)
       VALUES (?, ?, 0, 1, ?, ?)`,
      [name, key, actor.userId || null, new Date()]
    );
    logger.info({ brand_id: r.insertId, name }, 'Brand created');
    return getBrandById(r.insertId);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw mkErr(409, `A brand named "${name}" already exists.`);
    throw e;
  }
}

async function updateBrand(id, { brand_name }, actor = {}) {
  const me = await getBrandById(id);
  if (!me) throw mkErr(404, 'Brand not found');
  if (me.is_system) throw mkErr(422, 'The system brand "Not Applicable" cannot be edited.');

  const name = String(brand_name || '').trim();
  if (!name) throw mkErr(400, 'brand_name is required');
  const key = nameKey(name);

  const [[dup]] = await pool.query(
    `SELECT brand_id, brand_name FROM tbl_brand_master WHERE brand_key = ? AND brand_id <> ? LIMIT 1`,
    [key, id]
  );
  if (dup) throw mkErr(409, `A brand named "${dup.brand_name}" already exists.`);

  try {
    await pool.query(
      `UPDATE tbl_brand_master SET brand_name = ?, brand_key = ?, updated_by = ?, updated_at = ? WHERE brand_id = ?`,
      [name, key, actor.userId || null, new Date(), id]
    );
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw mkErr(409, `A brand named "${name}" already exists.`);
    throw e;
  }
  logger.info({ brand_id: id }, 'Brand updated');
  return getBrandById(id);
}

async function setBrandStatus(id, isActive, actor = {}) {
  const me = await getBrandById(id);
  if (!me) throw mkErr(404, 'Brand not found');
  if (me.is_system) throw mkErr(422, 'The system brand "Not Applicable" cannot be deactivated.');

  await pool.query(
    `UPDATE tbl_brand_master SET status = ?, updated_by = ?, updated_at = ? WHERE brand_id = ?`,
    [isActive ? 1 : 0, actor.userId || null, new Date(), id]
  );
  logger.info({ brand_id: id, status: isActive ? 1 : 0 }, 'Brand status changed');
  return { brand_id: id, status: isActive ? 1 : 0 };
}

async function getBrandReferences(id) {
  const me = await getBrandById(id);
  if (!me) throw mkErr(404, 'Brand not found');
  return refs.countReferences('brand', id);
}

async function deleteBrand(id) {
  const me = await getBrandById(id);
  if (!me) throw mkErr(404, 'Brand not found');
  if (me.is_system) throw mkErr(422, 'The system brand "Not Applicable" cannot be deleted.');

  const { total, by_type } = await refs.countReferences('brand', id);
  if (total > 0) throw mkErr(409, `Cannot delete "${me.brand_name}" — it is referenced by ${total} record(s).`, { references: { total, by_type } });

  await pool.query('DELETE FROM tbl_brand_master WHERE brand_id = ?', [id]);
  logger.info({ brand_id: id }, 'Brand deleted');
  return { deleted: true };
}

async function replaceAndDeleteBrand(id, replacementId, actor = {}) {
  const id2 = Number(replacementId);
  if (!id2 || id2 === Number(id)) throw mkErr(422, 'replacement_id must differ from the brand being deleted.');

  const me = await getBrandById(id);
  if (!me) throw mkErr(404, 'Brand not found');
  if (me.is_system) throw mkErr(422, 'The system brand "Not Applicable" cannot be deleted.');

  const replacement = await getBrandById(id2);
  if (!replacement) throw mkErr(422, 'replacement_id does not exist.');

  const conflicts = await refs.findRepointConflicts('brand', id, id2);
  if (conflicts.length) {
    throw mkErr(409,
      `"${replacement.brand_name}" is already on ${conflicts.length} of the material(s) using "${me.brand_name}" — resolve those first.`,
      { conflicts: conflicts.map((c) => ({ material_id: c.material_id, material_name: c.material_name })) });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const repointed = await refs.repointReferences(conn, 'brand', id, id2);
    await conn.query('DELETE FROM tbl_brand_master WHERE brand_id = ?', [id]);
    await conn.commit();
    logger.info({ brand_id: id, replacement_id: id2, repointed }, 'Brand replaced and deleted');
    return { deleted: true, repointed };
  } catch (e) {
    await conn.rollback();
    logger.error('Replace-and-delete brand failed, rolled back · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  mkErr,
  listBrands,
  getBrandById,
  listActiveBrandOptions,
  createBrand,
  updateBrand,
  setBrandStatus,
  getBrandReferences,
  deleteBrand,
  replaceAndDeleteBrand,
};
