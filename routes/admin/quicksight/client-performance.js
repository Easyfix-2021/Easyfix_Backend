/*
 * QuickSight report sub-router — Client Performance.
 *
 *   registry slug   : performance
 *   urlBase         : client-performance   (mounted at /api/admin/quicksight/client-performance)
 *   action key      : isQuickSightClientPerformanceView
 *   service file    : services/quicksight/quicksight-client-performance.service.js
 *
 * Parent chain (routes/admin/index.js) already applies requireAuth →
 * role(['admin']) → maskMobile → req.scope. This sub-router layers the
 * QuickSight family key + the per-report key on top via requireQuickSight,
 * and (per the legacy roleId==2 Admin-only gate) restricts to the Admin role
 * by name. Other admin-group roles get a hard 403 (registry decision
 * `accessDenied`: the FE shows its access panel — diverges intentionally from
 * the legacy soft-200 message).
 *
 * Endpoint:
 *   GET /api/admin/quicksight/client-performance
 *       ?period=monthly|weekly
 *       &clientId=&zonalManagerId=&verticalId=&projectManagerId=&serviceCategoryId=
 *       &format=xlsx
 *   - Read-only report (legacy used POST only to carry an array body; we
 *     accept repeatable/scalar query params via Joi `.single()`).
 *   - period defaults to monthly (mirrors the legacy else-branch).
 *   - format=xlsx streams the workbook via utils/xlsx-export.sendXlsx.
 */

const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../../middleware/validate');
const requireQuickSight = require('../../../middleware/require-quicksight');
const { roleByName } = require('../../../middleware/role');
const { modernOk, modernError } = require('../../../utils/response');
const { sendXlsx } = require('../../../utils/xlsx-export');
const { extendJobFilter } = require('../../../validators/quicksight.validator');
const service = require('../../../services/quicksight/quicksight-client-performance.service');

const ACTION_KEY = 'isQuickSightClientPerformanceView';

// All endpoints in this sub-router require the QuickSight family key + this
// report's view key, AND the Admin role (legacy roleId==2 parity).
router.use(requireQuickSight(ACTION_KEY));
router.use(roleByName(['Admin']));

/*
 * Query schema — jobFilterBase (clientId / verticalId / zonalManagerId /
 * serviceCategoryId / projectManagerId / format …) extended with `period`.
 * jobFilterBase already includes stateId / cityId (ignored by this report,
 * matching the legacy "present on the DTO but unread" behaviour) and the
 * `format` valid('json','xlsx') toggle.
 */
const querySchema = extendJobFilter({
  period: Joi.string().valid('monthly', 'weekly').default('monthly'),
});

const stamp = () => new Date().toISOString().slice(0, 10);

router.get('/', validate(querySchema, 'query'), async (req, res, next) => {
  try {
    const { period, format } = req.query;
    const filters = {
      clientId: req.query.clientId,
      zonalManagerId: req.query.zonalManagerId,
      verticalId: req.query.verticalId,
      projectManagerId: req.query.projectManagerId,
      serviceCategoryId: req.query.serviceCategoryId,
    };

    const rows = await service.getClientPerformance({ period, filters });

    if (format === 'xlsx') {
      const { columns, rows: flatRows } = service.toXlsx(rows, period);
      return sendXlsx(res, {
        filename: `client-performance-${period}-${stamp()}.xlsx`,
        sheetName: 'Client Performance',
        columns,
        rows: flatRows,
      });
    }

    return modernOk(res, rows);
  } catch (err) {
    if (err && err.status) {
      return modernError(res, err.status, err.message || 'Request failed');
    }
    return next(err);
  }
});

module.exports = router;
