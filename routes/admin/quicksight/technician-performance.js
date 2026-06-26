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
const { streamStyledXlsx } = require('../../../utils/xlsx-styled-export');
const { extendJobFilter } = require('../../../validators/quicksight.validator');
const {
  fileStamp,
  displayStamp,
  FMT,
  decorateColumns,
} = require('../../../services/quicksight/_shared');
const service = require('../../../services/quicksight/quicksight-technician-performance.service');

const ACTION_KEY = 'isQuickSightTechnicianPerformanceView';

// Full-set page size for ?format=xlsx — sized to the service's distinct-tech
// safety cap (TECH_LIST_CAP) so a single page covers every matching technician
// and the export's rows/KPIs/totals span the whole filtered set, not just the
// on-screen page. Referenced symbolically so it can't drift from the cap; the
// service logger.warns if its cap is hit.
const FULL_SET_PAGE_SIZE = service.TECH_LIST_CAP;

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

// ── XLSX column set for the category drill-down (flat one-row-per-category-
// per-period; period label prefixes keep the 3 blocks distinguishable). Title
// Case headers, corrected label/field alignment. Counts get the FMT.COUNT
// format; SDA%/TAT% are WHOLE numbers from pct() (86 = 86%) so use FMT.PCT
// (0.0"%") — NOT 0.0% which would render 8600%. Data bars on the two volume
// columns only. Hints are applied via the shared decorateColumns() decorator
// (exact-key rules; first match wins) rather than baked inline.
const CATEGORY_XLSX_BASE_COLUMNS = [
  { key: 'detailsFor', header: 'Period', width: 16, align: 'left' },
  { key: 'categoryName', header: 'Category Name', width: 24, align: 'left' },
  { key: 'tktCount', header: 'Ticket Allocated', width: 16 },
  { key: 'tktCompleted', header: 'Completed', width: 12 },
  { key: 'sdaPercentage', header: 'SDA%', width: 10 },
  { key: 'tatPercentage', header: 'TAT%', width: 10 },
  { key: 'txOpenOrderOnApp', header: 'Open Order In App', width: 18 },
];
const CATEGORY_XLSX_COLUMNS = decorateColumns(CATEGORY_XLSX_BASE_COLUMNS, [
  { match: (k) => k === 'tktCount', hints: { numFmt: FMT.COUNT, dataBar: true, dataBarColor: 'FF2E86DE' } },
  { match: (k) => k === 'tktCompleted', hints: { numFmt: FMT.COUNT, dataBar: true, dataBarColor: 'FF10B981' } },
  { match: (k) => k === 'sdaPercentage' || k === 'tatPercentage', hints: { numFmt: FMT.PCT } },
  { match: (k) => k === 'txOpenOrderOnApp', hints: { numFmt: FMT.COUNT } },
]);

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

    if (format === 'xlsx') {
      // The download must reflect the FULL filtered technician set, not just
      // the on-screen page. Re-run the service as a single full-set page
      // (page 1, pageSize = the full-set cap below) so rows, KPI cards and
      // totals all aggregate every matching technician. The JSON branch +
      // pagination below are untouched.
      const payload = await service.getTechnicianPerformance({
        flag, page: 1, pageSize: FULL_SET_PAGE_SIZE, filters,
      });
      const { columns, rows } = service.toXlsx(payload);

      // Enrich the flat columns with number formats / alignment / data bars via
      // the shared decorateColumns() decorator (first matching rule wins). Keys
      // are dynamic (p{i}_ticketAssigned|sda|tat|openApp) so match by key:
      //   counts (Ticket Assigned / Open Order In App) → FMT.COUNT + data bar on
      //   the allocation volume; SDA%/TAT% are WHOLE numbers (86 = 86%) → FMT.PCT.
      const styledColumns = decorateColumns(columns, [
        { match: (k) => k === 'txId', hints: { align: 'center' } },
        { match: (k) => k === 'txCurrentBalance', hints: { numFmt: '#,##0.00', align: 'right' } },
        { match: (k) => /_ticketAssigned$/.test(k), hints: { numFmt: FMT.COUNT, align: 'right', dataBar: true, dataBarColor: 'FF2E86DE' } },
        { match: (k) => /_openApp$/.test(k), hints: { numFmt: FMT.COUNT, align: 'right' } },
        { match: (k) => /_sda$/.test(k) || /_tat$/.test(k), hints: { numFmt: FMT.PCT, align: 'right' } },
        { match: (k) => k === 'stateName' || k === 'txCity' || k === 'txName', hints: { align: 'left' } },
      ]);

      // KPIs — totals across the FULL filtered set, summed from the most-recent
      // period (last bucket; periods are oldest→newest) so the cards reflect the
      // current window the user is looking at.
      const list = (payload && payload.data) || [];
      let totalAllocated = 0;
      let totalCompleted = 0;
      for (const tx of list) {
        const dw = tx.technicianPerformanceDataDateWise || [];
        const latest = dw[dw.length - 1];
        if (!latest || tx.txId == null) continue; // skip synthetic "No Technician" row
        totalAllocated += Number(latest.txTktCreated) || 0;
        totalCompleted += Number(latest.txCompletedOrder) || 0;
      }
      const completionPct = totalAllocated > 0
        ? Math.round((totalCompleted / totalAllocated) * 1000) / 10
        : 0;
      const sampleLatest =
        list[0]?.technicianPerformanceDataDateWise?.slice(-1)[0]?.detailsFor || '';

      await streamStyledXlsx(res, `technician-performance-${flag}-${fileStamp()}.xlsx`, {
        title: 'EasyFix · Technician Performance',
        meta: `Flag: ${flag}${sampleLatest ? ` · Latest Period: ${sampleLatest}` : ''} · ${rows.length} Technicians · Generated ${displayStamp()}`,
        sheetName: 'Technician Performance',
        kpis: [
          { label: 'Technicians', value: rows.length },
          { label: 'Total Allocated', value: totalAllocated },
          { label: 'Total Completed', value: totalCompleted, accent: 'FF10B981' },
          { label: 'Completion %', value: completionPct, numFmt: FMT.PCT, accent: 'FFF59E0B' },
        ],
        columns: styledColumns,
        rows,
        emptyMessage: 'No Technicians Found.',
      });
      return;
    }

    // JSON branch — paginated page as requested (unchanged contract).
    const payload = await service.getTechnicianPerformance({ flag, page, pageSize, filters });
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
        // KPIs + total footer summed across every period × category row.
        let totalAllocated = 0;
        let totalCompleted = 0;
        let totalOpenApp = 0;
        for (const r of rows) {
          totalAllocated += Number(r.tktCount) || 0;
          totalCompleted += Number(r.tktCompleted) || 0;
          totalOpenApp += Number(r.txOpenOrderOnApp) || 0;
        }
        const completionPct = totalAllocated > 0
          ? Math.round((totalCompleted / totalAllocated) * 1000) / 10
          : 0;

        await streamStyledXlsx(
          res,
          `technician-performance-category-${txId}-${flag}-${fileStamp()}.xlsx`,
          {
            title: 'EasyFix · Technician Performance — By Category',
            meta: `Flag: ${flag} · Technician #${txId} · ${rows.length} Rows · Generated ${displayStamp()}`,
            sheetName: 'Category Performance',
            kpis: [
              { label: 'Total Allocated', value: totalAllocated },
              { label: 'Total Completed', value: totalCompleted, accent: 'FF10B981' },
              { label: 'Completion %', value: completionPct, numFmt: FMT.PCT, accent: 'FFF59E0B' },
            ],
            columns: CATEGORY_XLSX_COLUMNS,
            rows,
            totalRow: {
              detailsFor: 'Total',
              tktCount: totalAllocated,
              tktCompleted: totalCompleted,
              txOpenOrderOnApp: totalOpenApp,
            },
            emptyMessage: 'No Category Data Found.',
          },
        );
        return;
      }

      return modernOk(res, payload);
    } catch (err) {
      if (err && err.status) return modernError(res, err.status, err.message || 'Request failed');
      return next(err);
    }
  },
);

module.exports = router;
