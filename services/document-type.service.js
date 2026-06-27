const { pool } = require('../db');
const logger = require('../logger');

/*
 * Manage Document Type — master for tbl_document_type.
 *
 * Schema columns in use:
 *   document_type_id, document_name, document_mandatory (varchar 'Yes'/'No'),
 *   document_type_status (0/1; legacy uses tinyint(2)).
 *
 * document_catg_id is present in the legacy model but never exposed on
 * the form — kept here so existing rows aren't disturbed on UPDATE.
 */

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

const SORTABLE_COLUMNS = Object.freeze({
  document_type_id:     'document_type_id',
  document_name:        'document_name',
  document_mandatory:   'document_mandatory',
  document_type_status: 'document_type_status',
});

async function listDocTypes({
  q, includeInactive = false,
  limit = 200, offset = 0,
  sortBy = 'document_name', sortDir = 'asc',
} = {}) {
  limit  = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  logger.info('List document types · q=' + (q || '') + ' · includeInactive=' + includeInactive + ' · limit=' + limit + ' · offset=' + offset + ' · sortBy=' + sortBy + ' · sortDir=' + sortDir);

  const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.document_name;
  const dir      = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const orderBy  = `${sortExpr} ${dir}, document_type_id ASC`;

  const where  = ['1=1'];
  const params = [];
  if (!includeInactive) where.push('document_type_status = 1');
  if (q) {
    where.push('document_name LIKE ?');
    params.push(`%${q}%`);
  }

  const [rows] = await pool.query(
    `SELECT document_type_id, document_name, document_mandatory, document_type_status, document_catg_id
       FROM tbl_document_type
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_document_type WHERE ${where.join(' AND ')}`,
    params
  );

  logger.info('Found ' + rows.length + ' document types (total=' + total + ')');

  return { items: rows, total };
}

async function getDocTypeById(id) {
  logger.info('Get document type · id=' + id);
  const [[row]] = await pool.query(
    `SELECT document_type_id, document_name, document_mandatory, document_type_status, document_catg_id
       FROM tbl_document_type
      WHERE document_type_id = ? LIMIT 1`,
    [id]
  );
  return row || null;
}

async function createDocType({ document_name, document_mandatory, document_catg_id }) {
  logger.info('Create document type · name=' + (document_name || '') + ' · mandatory=' + document_mandatory + ' · catgId=' + (document_catg_id || ''));
  const name = String(document_name || '').trim();
  if (!name) throw mkErr(400, 'document_name is required');
  if (document_mandatory !== 'Yes' && document_mandatory !== 'No') {
    throw mkErr(400, 'document_mandatory must be "Yes" or "No"');
  }

  const [[dup]] = await pool.query(
    `SELECT document_type_id FROM tbl_document_type
      WHERE LOWER(document_name) = LOWER(?) LIMIT 1`,
    [name]
  );
  if (dup) throw mkErr(409, `Document type "${name}" already exists`);

  const [r] = await pool.query(
    `INSERT INTO tbl_document_type
       (document_name, document_mandatory, document_catg_id, document_type_status)
     VALUES (?, ?, ?, 1)`,
    [name, document_mandatory, document_catg_id ? Number(document_catg_id) : null]
  );
  logger.info('Document type created · id=' + r.insertId);
  return getDocTypeById(r.insertId);
}

async function updateDocType(id, fields) {
  logger.info('Update document type · id=' + id + ' · fields=' + Object.keys(fields || {}).join(','));
  const [[me]] = await pool.query(
    'SELECT document_type_id FROM tbl_document_type WHERE document_type_id = ? LIMIT 1',
    [id]
  );
  if (!me) throw mkErr(404, 'Document Type not found');

  const sets = [];
  const params = [];
  if (fields.document_name !== undefined) {
    const name = String(fields.document_name).trim();
    if (!name) throw mkErr(400, 'document_name cannot be blank');
    sets.push('document_name = ?'); params.push(name);
  }
  if (fields.document_mandatory !== undefined) {
    if (fields.document_mandatory !== 'Yes' && fields.document_mandatory !== 'No') {
      throw mkErr(400, 'document_mandatory must be "Yes" or "No"');
    }
    sets.push('document_mandatory = ?'); params.push(fields.document_mandatory);
  }
  if (fields.is_active !== undefined) {
    sets.push('document_type_status = ?'); params.push(fields.is_active ? 1 : 0);
  }
  if (!sets.length) throw mkErr(400, 'No mutable fields supplied');

  params.push(id);
  await pool.query(`UPDATE tbl_document_type SET ${sets.join(', ')} WHERE document_type_id = ?`, params);
  logger.info('Document type updated · id=' + id);
  return getDocTypeById(id);
}

async function deactivateDocType(id) {
  logger.info('Deactivate document type · id=' + id);
  const [r] = await pool.query(
    'UPDATE tbl_document_type SET document_type_status = 0 WHERE document_type_id = ?',
    [id]
  );
  logger.info('Document type deactivated · id=' + id + ' · affected=' + r.affectedRows);
  return r.affectedRows > 0;
}

module.exports = {
  listDocTypes,
  getDocTypeById,
  createDocType,
  updateDocType,
  deactivateDocType,
  SORTABLE_COLUMNS,
};
