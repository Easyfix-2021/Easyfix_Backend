const router = require('express').Router();
const Joi = require('joi');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const validate = require('../../middleware/validate');
const logger = require('../../logger');

/*
 * Admin CRUD for master/lookup tables.
 * Read endpoints also exist in /api/shared/lookup/* — this tree provides
 * mutating endpoints (create/update/deactivate) admin-only.
 */

// Joi shorthands for the per-table field schemas below.
const str = Joi.string().trim().max(255);
const int = Joi.number().integer();
const bit = Joi.number().integer().valid(0, 1);

function crudFactory(table, pk, nameCol, statusCol, allowedCols, fieldSchemas) {
  const r = require('express').Router();

  // POST requires the name column; PUT is a partial update. Both reject
  // empty / wrongly-typed values before they reach the shared master tables.
  const postSchema = nameCol
    ? Joi.object(fieldSchemas).fork([nameCol], (s) => s.required()).min(1)
    : Joi.object(fieldSchemas).min(1);
  const putSchema = Joi.object(fieldSchemas).min(1);

  r.get('/', async (req, res, next) => {
    try {
      const { includeInactive, q } = req.query;
      logger.info('List ' + table + ' · q=' + (q || '') + ' includeInactive=' + (includeInactive || 'false'));
      const clauses = [], params = [];
      if (includeInactive !== 'true' && statusCol) clauses.push(`${statusCol} = 1`);
      if (q && nameCol) { clauses.push(`${nameCol} LIKE ?`); params.push(`%${q}%`); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      params.push(limit);
      const [rows] = await pool.query(`SELECT * FROM ${table} ${where} ORDER BY ${pk} DESC LIMIT ?`, params);
      logger.info('Found ' + rows.length + ' ' + table + ' rows');
      modernOk(res, rows);
    } catch (e) { logger.error('List ' + table + ' failed · ' + e.message); next(e); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      logger.info('Get ' + table + ' · id=' + req.params.id);
      const [[row]] = await pool.query(`SELECT * FROM ${table} WHERE ${pk} = ?`, [req.params.id]);
      if (!row) {
        logger.warn(table + ' not found · id=' + req.params.id);
        return modernError(res, 404, 'not found');
      }
      modernOk(res, row);
    } catch (e) { logger.error('Get ' + table + ' failed · id=' + req.params.id + ' · ' + e.message); next(e); }
  });

  r.post('/', validate(postSchema), async (req, res, next) => {
    try {
      const b = req.body || {};
      logger.info('Create ' + table + ' · fields=' + Object.keys(b).join(','));
      const cols = [], vals = [];
      for (const c of allowedCols) if (b[c] !== undefined) { cols.push(c); vals.push(b[c]); }
      if (cols.length === 0) {
        logger.warn('Create ' + table + ' rejected · no allowed columns supplied');
        return modernError(res, 400, 'body required');
      }
      if (statusCol && b[statusCol] === undefined) { cols.push(statusCol); vals.push(1); }
      const [ins] = await pool.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
      logger.info(table + ' created · id=' + ins.insertId);
      res.status(201);
      modernOk(res, { id: ins.insertId });
    } catch (e) { logger.error('Create ' + table + ' failed · ' + e.message); next(e); }
  });

  r.put('/:id', validate(putSchema), async (req, res, next) => {
    try {
      const b = req.body || {};
      logger.info('Update ' + table + ' · id=' + req.params.id + ' fields=' + Object.keys(b).join(','));
      const sets = [], vals = [];
      for (const c of allowedCols) if (b[c] !== undefined) { sets.push(`${c} = ?`); vals.push(b[c]); }
      if (sets.length === 0) {
        logger.warn('Update ' + table + ' rejected · id=' + req.params.id + ' · no allowed columns supplied');
        return modernError(res, 400, 'nothing to update');
      }
      vals.push(req.params.id);
      await pool.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${pk} = ?`, vals);
      logger.info(table + ' updated · id=' + req.params.id);
      modernOk(res, { updated: true });
    } catch (e) { logger.error('Update ' + table + ' failed · id=' + req.params.id + ' · ' + e.message); next(e); }
  });

  if (statusCol) {
    r.delete('/:id', async (req, res, next) => {
      try {
        logger.info('Deactivate ' + table + ' · id=' + req.params.id);
        await pool.query(`UPDATE ${table} SET ${statusCol} = 0 WHERE ${pk} = ?`, [req.params.id]);
        logger.info(table + ' deactivated · id=' + req.params.id);
        modernOk(res, { deactivated: true });
      } catch (e) { logger.error('Deactivate ' + table + ' failed · id=' + req.params.id + ' · ' + e.message); next(e); }
    });
  }
  return r;
}

router.use('/cities',              crudFactory('tbl_city',          'city_id',         'city_name',         'city_status',         ['city_name', 'state_id', 'city_status', 'tier', 'district', 'reference_pincode', 'tat_days'],
  { city_name: str.max(100), state_id: int, city_status: bit, tier: int.min(0), district: str, reference_pincode: Joi.string().trim().pattern(/^\d{6}$/), tat_days: int.min(0) }));
router.use('/states',              crudFactory('tbl_state',         'state_id',        'state_name',         null,                  ['state_name', 'state_code', 'country_id'],
  { state_name: str.max(100), state_code: str.max(10), country_id: int }));
router.use('/service-categories',  crudFactory('tbl_service_catg',  'service_catg_id', 'service_catg_name', 'service_catg_status', ['service_catg_name', 'service_catg_desc', 'service_catg_status'],
  { service_catg_name: str, service_catg_desc: str.max(1000), service_catg_status: bit }));
router.use('/service-types',       crudFactory('tbl_service_type',  'service_type_id', 'service_type_name', 'service_type_status', ['service_type_name', 'service_type_desc', 'service_type_status', 'service_catg_id'],
  { service_type_name: str, service_type_desc: str.max(1000), service_type_status: bit, service_catg_id: int }));
router.use('/document-types',      crudFactory('tbl_document_type', 'document_type_id','document_name',     'document_type_status',['document_name', 'document_mandatory', 'document_type_status', 'document_catg_id'],
  { document_name: str, document_mandatory: bit, document_type_status: bit, document_catg_id: int }));
router.use('/cancel-reasons',      crudFactory('tbl_cancel_reason', 'cancel_id',       'cancel_reason',     'status',              ['cancel_reason', 'status'],
  { cancel_reason: str.max(500), status: bit }));
router.use('/banks',               crudFactory('bank_name',         'id',              'bank_name',         null,                  ['bank_name', 'is_easyfix_bank'],
  { bank_name: str.max(100), is_easyfix_bank: bit }));

module.exports = router;
