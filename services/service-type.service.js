const { pool } = require('../db');

/*
 * Manage Service Type — master for tbl_service_type.
 *
 * Schema columns in use:
 *   service_type_id, service_type_name, service_type_desc, service_type_status,
 *   service_catg_id (FK → tbl_service_catg), display (1=Display to All, 0=CRM rate-card, 2=Tx App deep-skill),
 *   service_type_tools (CSV of tool_ids), service_type_tool_names (display CSV).
 *
 * Soft-delete: status flips to 0; legacy =3 rows stay hidden.
 * Required FK: service_catg_id. Validated against tbl_service_catg.
 * Tools are stored as the legacy CSV pair (ids + names) to match
 * how the legacy CRM persists them and how tbl_easyfixer queries join.
 */

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

const SORTABLE_COLUMNS = Object.freeze({
  service_type_id:     'st.service_type_id',
  service_type_name:   'st.service_type_name',
  service_type_status: 'st.service_type_status',
  service_catg_name:   'sc.service_catg_name',
  display:             'st.display',
});

async function listTypes({
  q, categoryId, includeInactive = false,
  limit = 200, offset = 0,
  sortBy = 'service_type_name', sortDir = 'asc',
} = {}) {
  limit  = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.service_type_name;
  const dir      = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const orderBy  = `${sortExpr} ${dir}, st.service_type_id ASC`;

  const where  = ['st.service_type_status <> 3'];
  const params = [];
  if (!includeInactive) where.push('st.service_type_status = 1');
  if (categoryId)       { where.push('st.service_catg_id = ?'); params.push(Number(categoryId)); }
  if (q) {
    where.push('(st.service_type_name LIKE ? OR st.service_type_desc LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  const [rows] = await pool.query(
    `SELECT st.service_type_id, st.service_type_name, st.service_type_desc,
            st.service_type_status, st.service_catg_id, sc.service_catg_name,
            st.display, st.service_type_tools, st.service_type_tool_names
       FROM tbl_service_type st
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = st.service_catg_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_service_type st WHERE ${where.join(' AND ')}`,
    params
  );

  return { items: rows, total };
}

async function getTypeById(id) {
  const [[row]] = await pool.query(
    `SELECT st.service_type_id, st.service_type_name, st.service_type_desc,
            st.service_type_status, st.service_catg_id, sc.service_catg_name,
            st.display, st.service_type_tools, st.service_type_tool_names
       FROM tbl_service_type st
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = st.service_catg_id
      WHERE st.service_type_id = ? AND st.service_type_status <> 3
      LIMIT 1`,
    [id]
  );
  return row || null;
}

async function createType({ service_type_name, service_type_desc, service_catg_id, display, service_type_tools, service_type_tool_names }) {
  const name = String(service_type_name || '').trim();
  if (!name)             throw mkErr(400, 'service_type_name is required');
  if (!service_catg_id)  throw mkErr(400, 'service_catg_id is required');

  const [[cat]] = await pool.query(
    'SELECT service_catg_id FROM tbl_service_catg WHERE service_catg_id = ? AND service_catg_status <> 3 LIMIT 1',
    [service_catg_id]
  );
  if (!cat) throw mkErr(400, `Unknown service_catg_id ${service_catg_id}`);

  const [[dup]] = await pool.query(
    `SELECT service_type_id FROM tbl_service_type
      WHERE LOWER(service_type_name) = LOWER(?) AND service_catg_id = ? AND service_type_status <> 3
      LIMIT 1`,
    [name, service_catg_id]
  );
  if (dup) throw mkErr(409, `Service Type "${name}" already exists in this category`);

  const [r] = await pool.query(
    `INSERT INTO tbl_service_type
       (service_type_name, service_type_desc, service_catg_id, display,
        service_type_tools, service_type_tool_names, service_type_status)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [
      name,
      service_type_desc ? String(service_type_desc).trim() : null,
      Number(service_catg_id),
      // display: 0=CRM rate-card · 1=Display to All · 2=Tx App deep-skill.
      // Store the raw whitelisted value (default 1) — no 0/1 coercion.
      [0, 1, 2].includes(Number(display)) ? Number(display) : 1,
      service_type_tools || null,
      service_type_tool_names || null,
    ]
  );
  return getTypeById(r.insertId);
}

async function updateType(id, fields) {
  const [[me]] = await pool.query(
    'SELECT service_type_id FROM tbl_service_type WHERE service_type_id = ? AND service_type_status <> 3 LIMIT 1',
    [id]
  );
  if (!me) throw mkErr(404, 'Service Type not found');

  const sets = [];
  const params = [];
  if (fields.service_type_name !== undefined) {
    const name = String(fields.service_type_name).trim();
    if (!name) throw mkErr(400, 'service_type_name cannot be blank');
    sets.push('service_type_name = ?'); params.push(name);
  }
  if (fields.service_type_desc !== undefined) {
    sets.push('service_type_desc = ?');
    params.push(fields.service_type_desc ? String(fields.service_type_desc).trim() : null);
  }
  if (fields.service_catg_id !== undefined) {
    const [[cat]] = await pool.query(
      'SELECT service_catg_id FROM tbl_service_catg WHERE service_catg_id = ? AND service_catg_status <> 3 LIMIT 1',
      [fields.service_catg_id]
    );
    if (!cat) throw mkErr(400, `Unknown service_catg_id ${fields.service_catg_id}`);
    sets.push('service_catg_id = ?'); params.push(Number(fields.service_catg_id));
  }
  if (fields.display !== undefined) {
    // Store the raw whitelisted value (0/1/2) — no 0/1 coercion.
    sets.push('display = ?'); params.push([0, 1, 2].includes(Number(fields.display)) ? Number(fields.display) : 1);
  }
  if (fields.service_type_tools !== undefined) {
    sets.push('service_type_tools = ?'); params.push(fields.service_type_tools || null);
  }
  if (fields.service_type_tool_names !== undefined) {
    sets.push('service_type_tool_names = ?'); params.push(fields.service_type_tool_names || null);
  }
  if (fields.is_active !== undefined) {
    sets.push('service_type_status = ?'); params.push(fields.is_active ? 1 : 0);
  }
  if (!sets.length) throw mkErr(400, 'No mutable fields supplied');

  params.push(id);
  await pool.query(`UPDATE tbl_service_type SET ${sets.join(', ')} WHERE service_type_id = ?`, params);
  return getTypeById(id);
}

async function deactivateType(id) {
  const [r] = await pool.query(
    'UPDATE tbl_service_type SET service_type_status = 0 WHERE service_type_id = ? AND service_type_status <> 3',
    [id]
  );
  return r.affectedRows > 0;
}

module.exports = {
  listTypes,
  getTypeById,
  createType,
  updateType,
  deactivateType,
  SORTABLE_COLUMNS,
};
