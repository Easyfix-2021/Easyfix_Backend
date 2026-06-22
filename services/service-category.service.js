const { pool } = require('../db');
const logger = require('../logger');

/*
 * Manage Service Category — master for tbl_service_catg.
 *
 * Legacy parity (EasyFix_CRM ServiceCategoryDaoImpl / addEditServicesCategory.vm):
 *   Columns touched: service_catg_id, service_catg_name, service_catg_desc,
 *   service_catg_status. (No image / sequence / display-order / parent column
 *   exists on tbl_service_catg — the legacy add/update stored proc takes only
 *   id/name/desc/status, so there is nothing further to wire.)
 *   Validation: name + desc both REQUIRED, minlength 2.
 *
 * Status convention: 1=Active, 0=Inactive, 3=Deleted.
 *   - The list defaults to status=1 only.
 *   - "Include inactive" surfaces status=0 as well.
 *   - status=3 rows stay hidden from every read (legacy "removed").
 *
 * Uniqueness on (LOWER(service_catg_name)) — app-level only, matches the
 * legacy DAO which doesn't enforce a DB unique constraint.
 *
 * Two distinct write paths, mirroring the Manage Service Type sibling:
 *   - deleteCategory()     → status 3 (legacy /addDeleteServiceCatg "trash";
 *                            row leaves every list). Wired to DELETE.
 *   - deactivateCategory() → status 0 (Active toggle off; row still surfaces
 *                            under "include inactive"). Reached via PATCH
 *                            { is_active:false }; reactivate via is_active:true.
 */

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

const SORTABLE_COLUMNS = Object.freeze({
  service_catg_id:     'c.service_catg_id',
  service_catg_name:   'c.service_catg_name',
  service_catg_status: 'c.service_catg_status',
  service_type_count:  'service_type_count',
});

async function listCategories({
  q, includeInactive = false,
  limit = 200, offset = 0,
  sortBy = 'service_catg_name', sortDir = 'asc',
} = {}) {
  limit  = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.service_catg_name;
  const dir      = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const orderBy  = `${sortExpr} ${dir}, c.service_catg_id ASC`;

  const where  = ['c.service_catg_status <> 3'];
  const params = [];
  if (!includeInactive) where.push('c.service_catg_status = 1');
  if (q) {
    where.push('(c.service_catg_name LIKE ? OR c.service_catg_desc LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  const [rows] = await pool.query(
    `SELECT c.service_catg_id, c.service_catg_name, c.service_catg_desc,
            c.service_catg_status,
            (SELECT COUNT(*) FROM tbl_service_type st
              WHERE st.service_catg_id = c.service_catg_id
                AND st.service_type_status = 1)        AS service_type_count
       FROM tbl_service_catg c
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_service_catg c WHERE ${where.join(' AND ')}`,
    params
  );

  return { items: rows, total };
}

async function getCategoryById(id) {
  const [[row]] = await pool.query(
    `SELECT service_catg_id, service_catg_name, service_catg_desc, service_catg_status
       FROM tbl_service_catg
      WHERE service_catg_id = ? AND service_catg_status <> 3
      LIMIT 1`,
    [id]
  );
  return row || null;
}

async function createCategory({ service_catg_name, service_catg_desc }) {
  const name = String(service_catg_name || '').trim();
  if (!name) throw mkErr(400, 'service_catg_name is required');
  if (name.length < 2) throw mkErr(400, 'service_catg_name is too short (min 2)');
  if (name.length > 200) throw mkErr(400, 'service_catg_name is too long (max 200)');

  // Legacy parity: service_catg_desc is REQUIRED (addEditServicesCategory.vm
  // marks it with * and validate-servicecategory.js enforces required+minlength:2).
  const desc = String(service_catg_desc || '').trim();
  if (!desc) throw mkErr(400, 'service_catg_desc is required');
  if (desc.length < 2) throw mkErr(400, 'service_catg_desc is too short (min 2)');

  const [[dup]] = await pool.query(
    `SELECT service_catg_id FROM tbl_service_catg
      WHERE LOWER(service_catg_name) = LOWER(?) AND service_catg_status <> 3
      LIMIT 1`,
    [name]
  );
  if (dup) throw mkErr(409, `Service Category "${name}" already exists`);

  const [r] = await pool.query(
    `INSERT INTO tbl_service_catg (service_catg_name, service_catg_desc, service_catg_status)
     VALUES (?, ?, 1)`,
    [name, desc]
  );
  logger.info({ service_catg_id: r.insertId, name }, 'Service Category created');
  return getCategoryById(r.insertId);
}

async function updateCategory(id, fields) {
  const [[me]] = await pool.query(
    'SELECT service_catg_id FROM tbl_service_catg WHERE service_catg_id = ? AND service_catg_status <> 3 LIMIT 1',
    [id]
  );
  if (!me) throw mkErr(404, 'Service Category not found');

  const sets = [];
  const params = [];
  if (fields.service_catg_name !== undefined) {
    const name = String(fields.service_catg_name).trim();
    if (!name) throw mkErr(400, 'service_catg_name cannot be blank');
    const [[dup]] = await pool.query(
      `SELECT service_catg_id FROM tbl_service_catg
        WHERE LOWER(service_catg_name) = LOWER(?) AND service_catg_id <> ?
          AND service_catg_status <> 3
        LIMIT 1`,
      [name, id]
    );
    if (dup) throw mkErr(409, `Another Service Category named "${name}" exists`);
    sets.push('service_catg_name = ?'); params.push(name);
  }
  if (fields.service_catg_desc !== undefined) {
    // Legacy parity: description is required. When explicitly supplied it
    // must be non-blank (min 2) — same treatment as the name field.
    const desc = String(fields.service_catg_desc).trim();
    if (!desc) throw mkErr(400, 'service_catg_desc cannot be blank');
    if (desc.length < 2) throw mkErr(400, 'service_catg_desc is too short (min 2)');
    sets.push('service_catg_desc = ?'); params.push(desc);
  }
  if (fields.is_active !== undefined) {
    // Deactivating (→ status 0) is guarded the same as delete: a category with
    // active service types can't be hidden out from under them. (Reactivating,
    // is_active=true, is unguarded.) Mirrors deleteCategory's guard so both the
    // inline Deactivate button and the edit-modal toggle enforce it.
    if (fields.is_active === false) {
      const n = await activeTypeCount(id);
      if (n > 0) {
        throw mkErr(409,
          `Cannot deactivate — ${n} active service type(s) still reference this category. Deactivate or reassign them first.`);
      }
    }
    sets.push('service_catg_status = ?');
    params.push(fields.is_active ? 1 : 0);
  }

  if (!sets.length) throw mkErr(400, 'No mutable fields supplied');

  params.push(id);
  await pool.query(`UPDATE tbl_service_catg SET ${sets.join(', ')} WHERE service_catg_id = ?`, params);
  logger.info({ service_catg_id: id }, 'Service Category updated');
  return getCategoryById(id);
}

async function activeTypeCount(id) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM tbl_service_type
      WHERE service_catg_id = ? AND service_type_status = 1`,
    [id]
  );
  return row.n;
}

async function deactivateCategory(id) {
  // Guard: don't deactivate while active service types reference this category.
  const n = await activeTypeCount(id);
  if (n > 0) {
    throw mkErr(409,
      `Cannot deactivate — ${n} active service type(s) still reference this category. Deactivate or reassign them first.`);
  }

  const [r] = await pool.query(
    'UPDATE tbl_service_catg SET service_catg_status = 0 WHERE service_catg_id = ? AND service_catg_status <> 3',
    [id]
  );
  if (r.affectedRows > 0) logger.info({ service_catg_id: id }, 'Service Category deactivated (status=0)');
  return r.affectedRows > 0;
}

// Legacy "delete" = soft-delete to status 3 (row leaves every list). Mirrors
// the legacy CRM trash action `UPDATE tbl_service_catg SET service_catg_status=3`
// (ServiceCategoryDaoImpl) and the Manage Service Type sibling's deleteType().
// Distinct from Deactivate (status 0), which keeps the row listable under
// "include inactive". We keep the active-type guard the legacy lacked so a
// delete can't orphan live service types.
async function deleteCategory(id) {
  const n = await activeTypeCount(id);
  if (n > 0) {
    throw mkErr(409,
      `Cannot delete — ${n} active service type(s) still reference this category. Deactivate or reassign them first.`);
  }

  const [r] = await pool.query(
    'UPDATE tbl_service_catg SET service_catg_status = 3 WHERE service_catg_id = ? AND service_catg_status <> 3',
    [id]
  );
  if (r.affectedRows > 0) logger.info({ service_catg_id: id }, 'Service Category deleted (status=3)');
  return r.affectedRows > 0;
}

module.exports = {
  listCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deactivateCategory,
  deleteCategory,
  SORTABLE_COLUMNS,
};
