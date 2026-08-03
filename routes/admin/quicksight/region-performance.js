/*
 * QuickSight report sub-router — STATE + USER Performance.
 *
 *   action keys  : isQuickSightStatePerformanceView
 *                  isQuickSightUserPerformanceView
 *   service file : services/quicksight/quicksight-region-performance.service.js
 *
 * ONE file, TWO reports: they are the same scorecard over two dimensions and
 * share every schema, filter and export rule, so splitting them would duplicate
 * ~80 lines to no benefit. They keep SEPARATE action keys because access is a
 * per-report decision — "who manages which regions" (User) is more sensitive
 * than aggregate geography (State).
 *
 * Mounted TWICE from index.js (/state-performance and /user-performance) so
 * each report keeps its own urlBase, matching every sibling report. The mount
 * path selects the dimension via `req.baseUrl`, and the per-report key is
 * enforced per-route rather than with a router-level requireQuickSight —
 * because a router-level gate would apply the WRONG key to one of the mounts.
 *
 * Endpoints (both dimensions):
 *   GET /   — paginated scorecard (?format=xlsx export)
 *       ?flag=monthly|weekly &page &pageSize
 *       &clientId &zonalManagerId &verticalId &serviceCategoryId &stateId &projectManagerId
 *
 * Metrics are IDENTICAL to City Performance (same periods, same SDA/TAT
 * definitions) — see the service header. The USER report additionally returns
 * `note`, the overlapping-regions caveat, which the FE must render.
 */

const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../../middleware/validate');
const requireQuickSight = require('../../../middleware/require-quicksight');
const { modernOk } = require('../../../utils/response');
const { streamStyledXlsx } = require('../../../utils/xlsx-styled-export');
const { extendJobFilter } = require('../../../validators/quicksight.validator');
const { fileStamp, displayStamp, FMT, decorateColumns } = require('../../../services/quicksight/_shared');
const service = require('../../../services/quicksight/quicksight-region-performance.service');
const logger = require('../../../logger');

const STATE_KEY = 'isQuickSightStatePerformanceView';
const USER_KEY = 'isQuickSightUserPerformanceView';

// Same schema as City Performance's table query (jobFilterBase + flag +
// pagination). stateId is accepted for the USER report and ignored for the
// STATE one (state is the group dimension there, not a filter) — mirroring how
// City accepts-but-ignores cityId.
const tableSchema = extendJobFilter({
  flag: Joi.string().valid('monthly', 'weekly').default('monthly'),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(200).default(10),
});

/*
 * Which dimension this request is for, from the MOUNT path. Keyed off baseUrl
 * rather than a query param so the two reports keep distinct URLs (cacheable,
 * bookmarkable) and distinct permission keys.
 */
function dimensionOf(req) {
  return String(req.baseUrl || '').endsWith('/user-performance') ? 'user' : 'state';
}

router.get(
  '/',
  // Gate with the key matching THIS mount — see the file header for why this is
  // per-route rather than router-level.
  (req, res, next) => requireQuickSight(dimensionOf(req) === 'user' ? USER_KEY : STATE_KEY)(req, res, next),
  validate(tableSchema, 'query'),
  async (req, res, next) => {
    try {
      const dimension = dimensionOf(req);
      const { flag, page, pageSize, format } = req.query;
      logger.info(dimension + ' Performance scorecard · flag=' + flag + ' page=' + page + ' pageSize=' + pageSize + ' format=' + (format || 'json'));
      const filters = {
        clientId: req.query.clientId,
        zonalManagerId: req.query.zonalManagerId,
        verticalId: req.query.verticalId,
        serviceCategoryId: req.query.serviceCategoryId,
        stateId: req.query.stateId,
        projectManagerId: req.query.projectManagerId,
      };

      const payload = dimension === 'user'
        ? await service.getUserPerformance({ flag, page, pageSize, filters })
        : await service.getStatePerformance({ flag, page, pageSize, filters });

      if (format === 'xlsx') {
        const { columns, rows } = service.toXlsx(payload, flag, dimension);
        // Same display polish as City Performance: data bars on the VOLUME
        // columns, right-aligned numerics, percent format on the % columns.
        const styledColumns = decorateColumns(columns, [
          { match: (k) => /_tkt$/.test(k), hints: { align: 'right', numFmt: FMT.COUNT, dataBar: true, dataBarColor: 'FF2E86DE' } },
          { match: (k) => /_open$/.test(k), hints: { align: 'right', numFmt: FMT.COUNT, dataBar: true, dataBarColor: 'FFF59E0B' } },
          { match: (k) => /_sda$|_tat$/.test(k), hints: { align: 'right', numFmt: FMT.PCT } },
          { match: (k) => k === 'regionLabel', hints: { align: 'right' } },
        ]);
        const label = dimension === 'user' ? 'User' : 'State';
        await streamStyledXlsx(res, `${dimension}-performance-${fileStamp()}.xlsx`, {
          title: `EasyFix · ${label} Performance`,
          // The User report's caveat rides into the export too — a spreadsheet
          // detached from the UI must not lose the reason its totals are high.
          meta: `${payload.totalRecords} ${label}s · ${flag} · Generated ${displayStamp()}`
            + (payload.note ? ` · NOTE: ${payload.note}` : ''),
          sheetName: `${label} Performance`,
          columns: styledColumns,
          rows,
          emptyMessage: `No ${label} Data Found.`,
        });
        return;
      }
      return modernOk(res, payload);
    } catch (e) {
      next(e);
    }
  },
);

module.exports = router;
