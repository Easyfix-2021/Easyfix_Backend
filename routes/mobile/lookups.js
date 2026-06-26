const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const lookupsService = require('../../services/mobile-lookups.service');

/*
 * Technician lookup/dropdown sub-router.
 *
 * Mounted at the mobile ROOT (no path prefix) in routes/mobile/index.js:
 *   router.use(require('./lookups'));
 * so the full path it declares below resolves to:
 *   GET /api/mobile/experience
 *
 * DUPLICATES REMOVED: `service-categories`, `banks`, and `job-reasons`
 * were removed — they duplicate /api/shared/lookup/service-categories,
 * /api/shared/lookup/banks, and /api/shared/lookup/cancel-reasons +
 * /reschedule-reasons. Only `/experience` (no existing equivalent) remains.
 *
 * Auth: requireTechAuth is applied UPSTREAM in routes/mobile/index.js
 * BEFORE this sub-router is mounted, so `req.tech` is populated. This
 * lookup is technician-scoped only in that it requires a valid tech
 * token; the list itself is a global master (no per-tech filtering).
 */

// ─── GET /experience — experience options ──────────────────────────────
//   → [ { id, name, description } ]
router.get('/experience', async (_req, res, next) => {
  try {
    modernOk(res, await lookupsService.experience());
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

// ─── GET /lookups/pincode/:pincode — resolve a pincode to city/district/state ──
//   → { pincode, cityId, city, district, state }  (404 when not seeded)
router.get(
  '/lookups/pincode/:pincode',
  validate(Joi.object({ pincode: Joi.string().trim().pattern(/^\d{6}$/).required() }), 'params'),
  async (req, res, next) => {
    try {
      const result = await lookupsService.resolvePincode(req.params.pincode);
      if (!result) return modernError(res, 404, 'pincode not found');
      modernOk(res, result);
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

module.exports = router;
