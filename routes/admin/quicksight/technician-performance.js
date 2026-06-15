/*
 * QuickSight report sub-router — Technician Performance.
 *
 *   registry slug   : txperformance
 *   urlBase         : technician-performance   (mounted at /api/admin/quicksight/technician-performance)
 *   action key      : isQuickSightTechnicianPerformanceView
 *   service file    : services/quicksight/quicksight-technician-performance.service.js
 *
 * Parent chain (routes/admin/index.js) already runs requireAuth → role(['admin']).
 * This sub-router layers the QuickSight family key + this report's per-report key
 * on top via requireQuickSight. The legacy ACD_APIs endpoints were permitAll()
 * (gating was FE-only via the JWT-bridge token in the URL) — the native rebuild
 * adds real RBAC: a missing key returns a hard 403 (registry `accessDenied`
 * decision; the FE renders its access panel).
 *
 * Endpoints (legacy POST-with-body switched to GET-with-query to mirror the
 * sibling client-performance report and reuse the shared FE filter components;
 * multi-select filters accept repeated/scalar query params via Joi `.single()`):
 *   GET /  ?flag=monthly|weekly&page=1&pageSize=10
 *          &clientId=&zonalManagerId=&cityId=&stateId=&serviceCategoryId=&reportingManagerId=
 *          &format=xlsx
 *     ← legacy POST /pmJobs/technicianPerformance
 *   GET /:txId/by-category ?flag=monthly|weekly
 *     ← legacy GET /pmJobs/technicianPerformanceCategoryWise
 *
 * Both honour ?format=xlsx for a server-side download (replaces the legacy
 * clipboard "Copy Data" affordance).
 */

const router = require('express').Router();
const Joi = require('joi');

const requireQuickSight = require('../../../middleware/require-quicksight');
const validate = require('../../../middleware/validate');
const { modernOk, modernError } = require('../../../utils/response');
const { sendXlsx } = require('../../../utils/xlsx-export');
const { extendJobFilter } = require('../../../validators/quicksight.validator');
const service = require('../../../services/quicksight/quicksight-technician-performance.service');

const ACTION_KEY = 'isQuickSightTechnicianPerformanceView';

// Per-report access gate: ef-QuickSight family key + this report's own key.
router.use(requireQuickSight(ACTION_KEY));

/*
 * Main-list query schema. Built from the shared jobFilterBase (clientId /
 * zonalManagerId / serviceCategoryId / stateId / cityId / format already
 * present; verticalId / projectManagerId are in the base but UNUSED by this
 * report — matching the legacy "present on the DTO but unread" behaviour). We
 * extend it with the report-specific keys: flag, page, pageSize, and the scalar
 * reportingManagerId (mutually exclusive with clientId; FE clears clientId when
 * an RM is picked). pageSize max=100 mirrors the legacy Copy-Data rowsPerPage
 * and bounds the LIMIT.
 */
const listQuery = extendJobFilter({
  flag: Joi.string().valid('monthly', 'weekly').default('monthly'),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
  reportingManagerId: Joi.number().integer().allow(null, 0).default(null),
});

// Category drill-down: params { txId } + query { flag, format }.
const categoryParams = Joi.object({
  txId: Joi.number().integer().required(),
});
const categoryQuery = Joi.object({
  flag: Joi.string().valid('monthly', 'weekly').default('monthly'),
  format: Joi.string().valid('json', 'xlsx').default('json'),
});

const stamp = () => new Date().toISOString().slice(0, 10);

// ── XLSX column set for the category drill-down (flat one-row-per-category-
// per-period; period label prefixes keep the 3 blocks distinguishable). Title
// Case headers, corrected label/field alignment.
const CATEGORY_XLSX_COLUMNS = [
  { key: 'detailsFor', header: 'Period', width: 16 },
  { key: 'categoryName', header: 'Category Name', width: 24 },
  { key: 'tktCount', header: 'Ticket Allocated', width: 16 },
  { key: 'tktCompleted', header: 'Completed', width: 12 },
  { key: 'sdaPercentage', header: 'SDA%', width: 10 },
  { key: 'tatPercentage', header: 'TAT%', width: 10 },
  { key: 'txOpenOrderOnApp', header: 'Open Order In App', width: 18 },
];

// ── GET / — main Technician Performance list (paginated over technicians) ──
router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const { flag, page, pageSize, format } = req.query;
    const filters = {
      clientId: req.query.clientId,
      zonalManagerId: req.query.zonalManagerId,
      cityId: req.query.cityId,
      stateId: req.query.stateId,
      serviceCategoryId: req.query.serviceCategoryId,
      reportingManagerId: req.query.reportingManagerId,
    };

    const payload = await service.getTechnicianPerformance({ flag, page, pageSize, filters });

    if (format === 'xlsx') {
      const { columns, rows } = service.toXlsx(payload);
      return sendXlsx(res, {
        filename: `technician-performance-${flag}-${stamp()}.xlsx`,
        sheetName: 'Technician Performance',
        columns,
        rows,
      });
    }

    return modernOk(res, payload);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message || 'Request failed');
    return next(err);
  }
});

// ── GET /:txId/by-category — per-tech category drill-down ─────────────
router.get(
  '/:txId/by-category',
  validate(categoryParams, 'params'),
  validate(categoryQuery, 'query'),
  async (req, res, next) => {
    try {
      const { txId } = req.params;
      const { flag, format } = req.query;

      const payload = await service.getTxPerformanceCategoryWise({ flag, txId });

      if (format === 'xlsx') {
        // Flatten the 3 periods × categories into one sheet for export.
        const rows = [];
        for (const period of payload.performanceData || []) {
          for (const c of period.categories || []) {
            rows.push({
              detailsFor: period.detailsFor,
              categoryName: c.categoryName,
              tktCount: c.tktCount,
              tktCompleted: c.tktCompleted,
              sdaPercentage: c.sdaPercentage == null ? '-' : c.sdaPercentage,
              tatPercentage: c.tatPercentage == null ? '-' : c.tatPercentage,
              txOpenOrderOnApp: c.txOpenOrderOnApp,
            });
          }
        }
        return sendXlsx(res, {
          filename: `technician-performance-category-${txId}-${flag}-${stamp()}.xlsx`,
          sheetName: 'Category Performance',
          columns: CATEGORY_XLSX_COLUMNS,
          rows,
        });
      }

      return modernOk(res, payload);
    } catch (err) {
      if (err && err.status) return modernError(res, err.status, err.message || 'Request failed');
      return next(err);
    }
  },
);

module.exports = router;
