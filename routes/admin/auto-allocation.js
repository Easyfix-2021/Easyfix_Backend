const router = require('express').Router();
const Joi = require('joi');
const logger = require('../../logger');
const { pool } = require('../../db');
const validate = require('../../middleware/validate');
const { getAllForClient, invalidate } = require('../../services/settings.service');
const { modernOk, modernError } = require('../../utils/response');

/*
 * Auto-allocation configuration — reads/writes tbl_autoallocation_setting
 * (master keys + default values) and tbl_client_setting (per-client overrides).
 *
 * Core flag driving on-create auto-assign: `running_frequency`
 *   'instant'  → run the 3-layer pipeline at job creation, assign top candidate
 *   'schedule' → daily batch picks it up instead (default)
 *
 * Other keys control scoring weights (performance, distance, rating, …) and
 * the batch-schedule window. We expose them as a single editable list; the
 * backend stores per-client overrides against the `setting_id`.
 */

const clientIdQuery = Joi.object({
  clientId: Joi.number().integer().positive().optional(),
});
const overrideBody = Joi.object({
  clientId:  Joi.number().integer().positive().required(),
  settingId: Joi.number().integer().positive().required(),
  value:     Joi.string().allow('', null).required(),
});
const clearBody = Joi.object({
  clientId:  Joi.number().integer().positive().required(),
  settingId: Joi.number().integer().positive().required(),
});
const defaultBody = Joi.object({
  settingId: Joi.number().integer().positive().required(),
  value:     Joi.string().allow('', null).required(),
});

// GET /api/admin/auto-allocation?clientId=…
// Returns every setting row with its effective value (override or default).
router.get('/', validate(clientIdQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('Listing auto-allocation settings · clientId=' + (req.query.clientId || 'default'));
    const data = await getAllForClient(req.query.clientId ? Number(req.query.clientId) : null);
    logger.info('Returning ' + (Array.isArray(data) ? data.length : 0) + ' auto-allocation settings');
    modernOk(res, data);
  } catch (e) { next(e); }
});

/*
 * PUT /api/admin/auto-allocation/override
 *   body: { clientId, settingId, value }
 * Upserts a per-client override. Uses the tbl_client_setting soft-delete column
 * `deleted=0`; if a deleted row exists for the same (client, setting), reactivate
 * and update rather than insert a duplicate.
 */
router.put('/override', validate(overrideBody), async (req, res, next) => {
  try {
    const { clientId, settingId, value } = req.body;
    logger.info('Upserting auto-allocation override · clientId=' + clientId + ' settingId=' + settingId);
    const [[existing]] = await pool.query(
      'SELECT id, deleted FROM tbl_client_setting WHERE client_id = ? AND setting_id = ? LIMIT 1',
      [clientId, settingId]
    );
    if (existing) {
      await pool.query(
        'UPDATE tbl_client_setting SET value = ?, deleted = 0, endtimestamp = NULL WHERE id = ?',
        [value, existing.id]
      );
    } else {
      await pool.query(
        `INSERT INTO tbl_client_setting (client_id, setting_id, value, deleted, starttimestamp)
         VALUES (?, ?, ?, 0, NOW())`,
        [clientId, settingId, value]
      );
    }
    invalidate(clientId);
    logger.info('Auto-allocation override saved · clientId=' + clientId + ' settingId=' + settingId);
    modernOk(res, { ok: true });
  } catch (e) { next(e); }
});

/*
 * DELETE /api/admin/auto-allocation/override?clientId=…&settingId=…
 * Soft-removes a client override so the default_value takes over.
 * Query-param (not body) so our fetch wrapper's plain api.delete() works.
 */
router.delete('/override', validate(clearBody, 'query'), async (req, res, next) => {
  try {
    const clientId  = Number(req.query.clientId);
    const settingId = Number(req.query.settingId);
    logger.info('Clearing auto-allocation override · clientId=' + clientId + ' settingId=' + settingId);
    const [r] = await pool.query(
      'UPDATE tbl_client_setting SET deleted = 1, endtimestamp = NOW() WHERE client_id = ? AND setting_id = ?',
      [clientId, settingId]
    );
    invalidate(clientId);
    if (r.affectedRows === 0) {
      logger.warn('Auto-allocation override clear · override not found · clientId=' + clientId + ' settingId=' + settingId);
      return modernError(res, 404, 'override not found');
    }
    logger.info('Auto-allocation override cleared · clientId=' + clientId + ' settingId=' + settingId);
    modernOk(res, { ok: true });
  } catch (e) { next(e); }
});

/*
 * PATCH /api/admin/auto-allocation/default
 *   body: { settingId, value }
 * Updates tbl_autoallocation_setting.default_value — i.e., the value used when
 * a client has no per-client override. Affects the default behaviour for
 * CRM-created jobs (and any client not overridden).
 */
router.patch('/default', validate(defaultBody), async (req, res, next) => {
  try {
    const { settingId, value } = req.body;
    logger.info('Updating auto-allocation default · settingId=' + settingId);
    const [r] = await pool.query(
      'UPDATE tbl_autoallocation_setting SET default_value = ? WHERE id = ?',
      [value, settingId]
    );
    if (r.affectedRows === 0) {
      logger.warn('Auto-allocation default update · setting not found · settingId=' + settingId);
      return modernError(res, 404, 'setting not found');
    }
    logger.info('Auto-allocation default updated · settingId=' + settingId);
    // No cache to bust — settings service reads realtime.
    modernOk(res, { ok: true });
  } catch (e) { next(e); }
});

// GET /api/admin/auto-allocation/clients-with-overrides
// Returns the list of clients that have any override row — useful for the
// "per-client overrides" list in the Settings UI (so ops can jump to an
// existing override without paging through every client).
router.get('/clients-with-overrides', async (_req, res, next) => {
  try {
    logger.info('Listing clients with auto-allocation overrides');
    const [rows] = await pool.query(`
      SELECT DISTINCT cs.client_id, c.client_name
        FROM tbl_client_setting cs
        JOIN tbl_client c ON c.client_id = cs.client_id
       WHERE cs.deleted = 0
         AND cs.setting_id IN (SELECT id FROM tbl_autoallocation_setting)
       ORDER BY c.client_name ASC
    `);
    logger.info('Found ' + rows.length + ' clients with overrides');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

module.exports = router;
