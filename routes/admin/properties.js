/*
 * Admin properties routes — minimal management surface for
 * easyfix_properties feature flags.
 *
 * Mounted at /api/admin/properties.
 *
 *   GET  /                  — list every cached property (debug)
 *   POST /reload            — flush + reload the cache from MySQL
 *
 * The reload endpoint is fired by the FE's "10 quick clicks on the
 * Easyfix logo" gesture (see Easyfix_CRM_UI sidebar). Operators can
 * also curl it after a manual SQL UPDATE on easyfix_properties to
 * skip the 1-hour TTL refresh window.
 *
 * Auth: inherits the `/api/admin` chain (JWT + admin-group guard) from
 * routes/admin/index.js. No additional role gate — any admin who can
 * read the dashboard can also trigger a reload (the action is
 * idempotent + non-destructive: re-reads the table, swaps the cache,
 * no DB writes).
 */

const express = require('express');
const propertiesSvc = require('../../services/properties.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    logger.info('List cached properties');
    const all = await propertiesSvc.getAllProperties();
    logger.info('Returning ' + Object.keys(all).length + ' properties');
    modernOk(res, { count: Object.keys(all).length, properties: all });
  } catch (e) { next(e); }
});

router.post('/reload', async (_req, res, next) => {
  try {
    logger.info('Reload properties cache');
    const count = await propertiesSvc.flushCache();
    logger.info('Properties cache reloaded · count=' + count);
    modernOk(res, { reloaded: true, count });
  } catch (e) {
    logger.error('Properties reload failed · ' + e.message);
    return modernError(res, 500, e.message || 'reload failed');
  }
});

module.exports = router;
