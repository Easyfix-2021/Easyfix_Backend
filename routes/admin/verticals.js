const router = require('express').Router();
const Joi    = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

/*
 * Manage Vertical — master for tbl_vertical.
 *
 * Schema (verified 2026-05-12):
 *   vertical_id (PK), vertical_name, vertical_desc,
 *   inserted_on, inserted_by, updated_on, updated_by, status.
 *
 * Soft-delete only (status = 0). tbl_vertical_mapping is out of scope.
 */

const SORTABLE_COLUMNS = Object.freeze({
  vertical_id:   'vertical_id',
  vertical_name: 'vertical_name',
  status:        'status',
  updated_on:    'updated_on',
});

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  q:               Joi.string().allow('', null).optional(),
  includeInactive: Joi.boolean().default(false),
  limit:           Joi.number().integer().min(1).max(1000).default(200),
  offset:          Joi.number().integer().min(0).default(0),
  sortBy:          Joi.string().valid(...Object.keys(SORTABLE_COLUMNS)).default('vertical_name'),
  sortDir:         Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

const createBody = Joi.object({
  vertical_name: Joi.string().trim().min(1).max(200).required(),
  vertical_desc: Joi.string().trim().max(500).allow('', null).optional(),
});

const updateBody = Joi.object({
  vertical_name: Joi.string().trim().min(1).max(200).optional(),
  vertical_desc: Joi.string().trim().max(500).allow('', null).optional(),
  status:        Joi.number().integer().valid(0, 1).optional(),
}).min(1);

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

async function getById(id) {
  const [[row]] = await pool.query(
    `SELECT vertical_id, vertical_name, vertical_desc,
            inserted_on, inserted_by, updated_on, updated_by, status
       FROM tbl_vertical
      WHERE vertical_id = ?
      LIMIT 1`,
    [id]
  );
  return row || null;
}

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    let { q, includeInactive, limit, offset, sortBy, sortDir } = req.query;
    logger.info('List verticals · q=' + (q || '') + ' includeInactive=' + includeInactive + ' limit=' + limit + ' offset=' + offset + ' sortBy=' + sortBy + ' sortDir=' + sortDir);
    limit  = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    offset = Math.max(Number(offset) || 0, 0);

    const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.vertical_name;
    const dir      = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const orderBy  = `${sortExpr} ${dir}, vertical_id ASC`;

    const where  = ['1=1'];
    const params = [];
    if (!includeInactive) where.push('status = 1');
    if (q) {
      where.push('(vertical_name LIKE ? OR vertical_desc LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }

    const [rows] = await pool.query(
      `SELECT vertical_id, vertical_name, vertical_desc,
              inserted_on, inserted_by, updated_on, updated_by, status
         FROM tbl_vertical
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    logger.info('Found ' + rows.length + ' verticals');
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM tbl_vertical WHERE ${where.join(' AND ')}`,
      params
    );
    logger.info('Returning ' + rows.length + ' verticals · total=' + total);
    modernOk(res, { items: rows, total });
  } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Get vertical · id=' + req.params.id);
    const row = await getById(Number(req.params.id));
    if (!row) return modernError(res, 404, 'Vertical not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});

router.post('/', roleByName(['Admin']), validate(createBody), async (req, res, next) => {
  try {
    const name = String(req.body.vertical_name).trim();
    const desc = req.body.vertical_desc ? String(req.body.vertical_desc).trim() : null;
    const userId = req.user && req.user.user_id ? req.user.user_id : null;
    logger.info('Create vertical · name=' + name);

    const [[dup]] = await pool.query(
      'SELECT vertical_id FROM tbl_vertical WHERE LOWER(vertical_name) = LOWER(?) LIMIT 1',
      [name]
    );
    if (dup) throw mkErr(409, `Vertical "${name}" already exists`);

    const [r] = await pool.query(
      `INSERT INTO tbl_vertical
         (vertical_name, vertical_desc, inserted_on, inserted_by, updated_on, updated_by, status)
       VALUES (?, ?, NOW(), ?, NOW(), ?, 1)`,
      [name, desc, userId, userId]
    );
    const created = await getById(r.insertId);
    logger.info('Vertical created · id=' + r.insertId);
    res.status(201);
    modernOk(res, created, 'Vertical added');
  } catch (e) {
    if (e.status) logger.warn('Create vertical failed · ' + e.message);
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.patch('/:id', roleByName(['Admin']), validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    logger.info('Update vertical · id=' + id);
    const existing = await getById(id);
    if (!existing) return modernError(res, 404, 'Vertical not found');

    const userId = req.user && req.user.user_id ? req.user.user_id : null;
    const sets = [];
    const params = [];

    if (req.body.vertical_name !== undefined) {
      const name = String(req.body.vertical_name).trim();
      if (!name) throw mkErr(400, 'vertical_name cannot be blank');
      const [[dup]] = await pool.query(
        'SELECT vertical_id FROM tbl_vertical WHERE LOWER(vertical_name) = LOWER(?) AND vertical_id <> ? LIMIT 1',
        [name, id]
      );
      if (dup) throw mkErr(409, `Vertical "${name}" already exists`);
      sets.push('vertical_name = ?'); params.push(name);
    }
    if (req.body.vertical_desc !== undefined) {
      const desc = req.body.vertical_desc ? String(req.body.vertical_desc).trim() : null;
      sets.push('vertical_desc = ?'); params.push(desc);
    }
    if (req.body.status !== undefined) {
      sets.push('status = ?'); params.push(req.body.status);
    }
    if (!sets.length) return modernError(res, 400, 'No mutable fields supplied');

    sets.push('updated_on = NOW()');
    sets.push('updated_by = ?'); params.push(userId);

    params.push(id);
    await pool.query(`UPDATE tbl_vertical SET ${sets.join(', ')} WHERE vertical_id = ?`, params);
    const updated = await getById(id);
    logger.info('Vertical updated · id=' + id);
    modernOk(res, updated, 'Vertical updated');
  } catch (e) {
    if (e.status) logger.warn('Update vertical failed · ' + e.message);
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.delete('/:id', roleByName(['Admin']), validate(idParam, 'params'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    logger.info('Deactivate vertical · id=' + id);
    const userId = req.user && req.user.user_id ? req.user.user_id : null;
    const [r] = await pool.query(
      'UPDATE tbl_vertical SET status = 0, updated_on = NOW(), updated_by = ? WHERE vertical_id = ?',
      [userId, id]
    );
    if (r.affectedRows === 0) return modernError(res, 404, 'Vertical not found');
    logger.info('Vertical deleted · id=' + id);
    modernOk(res, { deactivated: true });
  } catch (e) {
    if (e.status) logger.warn('Deactivate vertical failed · ' + e.message);
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

module.exports = router;
