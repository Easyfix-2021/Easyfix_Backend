/*
 * QuickSight report sub-router — City Performance.
 *
 *   registry slug   : cityperformance
 *   urlBase         : city-performance   (mounted at /api/admin/quicksight/city-performance)
 *   action key      : isQuickSightCityPerformanceView
 *   service file    : services/quicksight/quicksight-city-performance.service.js
 *
 * Parent chain (routes/admin/index.js) already applies requireAuth →
 * role(['admin']) → maskMobile → req.scope. This sub-router layers the
 * QuickSight family key + the per-report key on top via requireQuickSight.
 *
 * The legacy report was a pair of permitAll() POST endpoints sharing the same
 * JobSearchListDto body + flag, so they MUST migrate together. Native uses GET
 * query params (read-only / cacheable; Joi .single() accepts repeatable or
 * scalar id params) — the no-role gate is replaced by the ef-QuickSight family
 * key + this report's view key (registry `accessDenied` hard-403 decision;
 * the FE shows its access panel). No data-level scoping — admin sees ALL.
 *
 * Endpoints:
 *   GET /                 — paginated per-city scorecard  (?format=xlsx export)
 *       ?flag=monthly|weekly &page &pageSize
 *       &clientId &zonalManagerId &verticalId &serviceCategoryId &stateId &projectManagerId
 *   GET /tat-summary      — 3-period TAT highlights widget (no pagination)
 *       ?flag=monthly|weekly
 *       &clientId &zonalManagerId &serviceCategoryId &stateId
 *       (deliberately IGNORES verticalId & projectManagerId — legacy asymmetry)
 */

const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../../middleware/validate');
const requireQuickSight = require('../../../middleware/require-quicksight');
const { modernOk, modernError } = require('../../../utils/response');
const { sendXlsx } = require('../../../utils/xlsx-export');
const { extendJobFilter } = require('../../../validators/quicksight.validator');
const service = require('../../../services/quicksight/quicksight-city-performance.service');

const ACTION_KEY = 'isQuickSightCityPerformanceView';

// Per-report access gate: ef-QuickSight family key + this report's own key.
router.use(requireQuickSight(ACTION_KEY));

/*
 * Table query schema — jobFilterBase (clientId / verticalId / zonalManagerId /
 * serviceCategoryId / projectManagerId / stateId / cityId / format) extended
 * with flag + pagination. cityId is accepted (present on the legacy DTO) but
 * IGNORED by the service — city is the GROUP dimension here, not a filter.
 * pageSize caps at 200 (the FE "All" → pageSizeToLimit(200) ceiling).
 */
const tableSchema = extendJobFilter({
  flag: Joi.string().valid('monthly', 'weekly').default('monthly'),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(200).default(10),
});

/*
 * TAT-summary query schema — flag + ONLY the four filters the legacy widget
 * reads (client / zonal / category / state). verticalId & projectManagerId are
 * intentionally NOT exposed here (legacy commented them out); cityId likewise
 * unused. No pagination — always 3 period summaries. Built fresh (not via
 * extendJobFilter) so the unread filters aren't silently accepted.
 */
const idArray = Joi.array().items(Joi.number().integer()).single().default([]);
const tatSummarySchema = Joi.object({
  flag: Joi.string().valid('monthly', 'weekly').default('monthly'),
  clientId: idArray,
  zonalManagerId: idArray,
  serviceCategoryId: idArray,
  stateId: idArray,
  format: Joi.string().valid('json', 'xlsx').default('json'),
});

const stamp = () => new Date().toISOString().slice(0, 10);

// ── GET / — paginated per-city scorecard ─────────────────────────────
router.get('/', validate(tableSchema, 'query'), async (req, res, next) => {
  try {
    const { flag, page, pageSize, format } = req.query;
    const filters = {
      clientId: req.query.clientId,
      zonalManagerId: req.query.zonalManagerId,
      verticalId: req.query.verticalId,
      serviceCategoryId: req.query.serviceCategoryId,
      stateId: req.query.stateId,
      projectManagerId: req.query.projectManagerId,
    };

    const payload = await service.getCityPerformance({ flag, page, pageSize, filters });

    if (format === 'xlsx') {
      const { columns, rows } = service.toXlsx(payload, flag);
      return sendXlsx(res, {
        filename: `city-performance-${flag}-${stamp()}.xlsx`,
        sheetName: 'City Performance',
        columns,
        rows,
      });
    }

    return modernOk(res, payload);
  } catch (err) {
    if (err && err.status) {
      return modernError(res, err.status, err.message || 'Request failed');
    }
    return next(err);
  }
});

// ── GET /tat-summary — 3-period TAT highlights widget ────────────────
router.get('/tat-summary', validate(tatSummarySchema, 'query'), async (req, res, next) => {
  try {
    const { flag } = req.query;
    const filters = {
      clientId: req.query.clientId,
      zonalManagerId: req.query.zonalManagerId,
      serviceCategoryId: req.query.serviceCategoryId,
      stateId: req.query.stateId,
    };

    const summary = await service.getCityTatSummary({ flag, filters });
    return modernOk(res, summary);
  } catch (err) {
    if (err && err.status) {
      return modernError(res, err.status, err.message || 'Request failed');
    }
    return next(err);
  }
});

module.exports = router;
