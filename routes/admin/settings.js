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

/*
 * tbl_city is NOT served by crudFactory. Removed 2026-09-09.
 *
 * It used to be, and that mount was a second, weaker way to write the city
 * master. crudFactory is deliberately generic: no per-action permission (this
 * file inherits only requireAuth + role(['admin']), so all ten admin-group
 * roles reached it regardless of Manage Role), no duplicate-name check, and a
 * blind `city_status` column write. Against tbl_city specifically that meant:
 *
 *   POST   created a city ACTIVE, skipping the approval queue entirely
 *   PUT    could flip a PENDING city 2 → 1, bypassing approveCity, leaving
 *          approved_by / approved_at / approval_decision NULL — an approved
 *          city with no record of who approved it
 *   DELETE retired a city to 0 with no merge and no merged_into_city_id, the
 *          exact orphaned state the reject flow exists to prevent
 *
 * Every one of those operations already exists on /api/admin/cities, gated on
 * isCityAddNew / isCityEdit / isCityApprove, with the dedup check and the
 * approval semantics. Nothing in this repo or in CRM_UI called the settings
 * variant. If some caller turns up, point it at /api/admin/cities rather than
 * reinstating this — a generic CRUD factory cannot express "rejecting is a
 * merge".
 */
/*
 * tbl_state is NOT served by crudFactory either. Removed 2026-09-21, for the
 * same reasons as tbl_city above: no per-action permission (any admin-group
 * role could write), no duplicate check, and — the new reason — no zonal
 * manager. Every state must carry one, and a manager change must reach the
 * state's cities in the same transaction; a generic CRUD cannot express that.
 * Nothing in this repo or CRM_UI called it. Use /api/admin/states
 * (routes/admin/states.js, gated on isStateEdit). Read-only state lists stay
 * at /api/shared/lookup/states.
 */
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
