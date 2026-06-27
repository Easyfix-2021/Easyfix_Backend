const { pool } = require('../db');
const logger = require('../logger');

/*
 * Manage Tools — master for tbl_tools (legacy /tool screen).
 *
 * Columns: tool_id, tool_name, tool_desc, tool_status, tool_img.
 * Image upload is deferred — the column accepts NULL and the API
 * surfaces it so future UI work can plug into /api/shared/files.
 */

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

const SORTABLE_COLUMNS = Object.freeze({
  tool_id:     'tool_id',
  tool_name:   'tool_name',
  tool_status: 'tool_status',
});

async function listTools({
  q, includeInactive = false,
  limit = 200, offset = 0,
  sortBy = 'tool_name', sortDir = 'asc',
} = {}) {
  limit  = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  logger.info('List tools · q=' + (q || '') + ' · includeInactive=' + includeInactive + ' · limit=' + limit + ' · offset=' + offset);

  const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.tool_name;
  const dir      = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const orderBy  = `${sortExpr} ${dir}, tool_id ASC`;

  const where  = ['1=1'];
  const params = [];
  if (!includeInactive) where.push("(tool_status = '1' OR tool_status = 1)");
  if (q) {
    where.push('(tool_name LIKE ? OR tool_desc LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  const [rows] = await pool.query(
    `SELECT tool_id, tool_name, tool_desc, tool_status, tool_img
       FROM tbl_tools
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_tools WHERE ${where.join(' AND ')}`,
    params
  );
  logger.info('Found ' + rows.length + ' tools (total=' + total + ')');
  return { items: rows, total };
}

async function getToolById(id) {
  logger.info('Get tool by id · id=' + id);
  const [[row]] = await pool.query(
    'SELECT tool_id, tool_name, tool_desc, tool_status, tool_img FROM tbl_tools WHERE tool_id = ? LIMIT 1',
    [id]
  );
  return row || null;
}

async function createTool({ tool_name, tool_desc, tool_img }) {
  logger.info('Create tool · name=' + (tool_name || ''));
  const name = String(tool_name || '').trim();
  if (!name) throw mkErr(400, 'tool_name is required');

  const [[dup]] = await pool.query(
    'SELECT tool_id FROM tbl_tools WHERE LOWER(tool_name) = LOWER(?) LIMIT 1',
    [name]
  );
  if (dup) {
    logger.warn('Create tool rejected · duplicate name=' + name);
    throw mkErr(409, `Tool "${name}" already exists`);
  }

  const [r] = await pool.query(
    `INSERT INTO tbl_tools (tool_name, tool_desc, tool_status, tool_img) VALUES (?, ?, '1', ?)`,
    [name, tool_desc ? String(tool_desc).trim() : null, tool_img || null]
  );
  logger.info('Tool created · id=' + r.insertId);
  return getToolById(r.insertId);
}

async function updateTool(id, fields) {
  logger.info('Update tool · id=' + id);
  const [[me]] = await pool.query('SELECT tool_id FROM tbl_tools WHERE tool_id = ? LIMIT 1', [id]);
  if (!me) {
    logger.warn('Update tool rejected · not found · id=' + id);
    throw mkErr(404, 'Tool not found');
  }

  const sets = [];
  const params = [];
  if (fields.tool_name !== undefined) {
    const name = String(fields.tool_name).trim();
    if (!name) throw mkErr(400, 'tool_name cannot be blank');
    sets.push('tool_name = ?'); params.push(name);
  }
  if (fields.tool_desc !== undefined) {
    sets.push('tool_desc = ?');
    params.push(fields.tool_desc ? String(fields.tool_desc).trim() : null);
  }
  if (fields.tool_img !== undefined) {
    sets.push('tool_img = ?'); params.push(fields.tool_img || null);
  }
  if (fields.is_active !== undefined) {
    sets.push('tool_status = ?'); params.push(fields.is_active ? '1' : '0');
  }
  if (!sets.length) throw mkErr(400, 'No mutable fields supplied');

  params.push(id);
  await pool.query(`UPDATE tbl_tools SET ${sets.join(', ')} WHERE tool_id = ?`, params);
  logger.info('Tool updated · id=' + id + ' · fields=' + sets.length);
  return getToolById(id);
}

async function deactivateTool(id) {
  logger.info('Deactivate tool · id=' + id);
  const [r] = await pool.query("UPDATE tbl_tools SET tool_status = '0' WHERE tool_id = ?", [id]);
  logger.info('Tool deactivated · id=' + id + ' · affected=' + r.affectedRows);
  return r.affectedRows > 0;
}

module.exports = { listTools, getToolById, createTool, updateTool, deactivateTool, SORTABLE_COLUMNS };
