/*
 * QuickSight report sub-router — Employee Productivity (floor discipline).
 *
 *   registry slug   : productivity
 *   urlBase         : employee-productivity   (mounted at /api/admin/quicksight/employee-productivity)
 *   action key      : isQuickSightEmployeeProductivityView
 *   service file    : services/quicksight/quicksight-employee-productivity.service.js
 *
 * Parent chain (routes/admin/index.js) already runs requireAuth → role(['admin']).
 * This sub-router layers the QuickSight family key + per-report key on top via
 * requireQuickSight (restores the legacy roleId==2 Admin-only intent; the admin
 * group is wider than the legacy single role but is the platform-correct gate).
 *
 * All endpoints are GET so the FE can drive them with useFetch keyed on the
 * serialized filter state. The main table endpoint honours ?format=xlsx for a
 * server-side download (replaces the legacy Copy-Data clipboard affordance,
 * which the FE keeps in addition).
 *
 * Legacy mapping (ACD_APIs FloorDiscipline*):
 *   GET /employee-productivity ← POST /floorDiscipline/employeeProductivity
 *   GET /kra-metrics           ← POST /floorDiscipline/kraMetrics
 *   GET /dashboard-counts      ← POST /floorDiscipline/openOrderResponse
 *   GET /cancellation-details  ← POST /floorDiscipline/getCancellationDetails
 *   GET /reporting-managers    ← POST /floorDiscipline/verticalManagerDetails
 *   GET /rm-team-users         ← POST /floorDiscipline/rmTeamUserList
 *
 * Joi schemas are defined INLINE here (the shared validator is read-only).
 * Filter ids default to '0' (legacy "0 = All" sentinel) — processFloorFilters
 * in the service maps 0 → null / no-restriction.
 */

const router = require('express').Router();
const Joi = require('joi');

const requireQuickSight = require('../../../middleware/require-quicksight');
const validate = require('../../../middleware/validate');
const { modernOk, modernError } = require('../../../utils/response');
const { streamStyledXlsx } = require('../../../utils/xlsx-styled-export');
const service = require('../../../services/quicksight/quicksight-employee-productivity.service');

// Per-report access gate: ef-QuickSight family key + this report's own key.
router.use(requireQuickSight('isQuickSightEmployeeProductivityView'));

// ── Joi schemas (inline) ─────────────────────────────────────────────
// 'YYYY-MM-DD' date strings; ids default '0' (= All); findByDateType drives
// the Open Orders aging window source. Service does the 0→null mapping + the
// +1-day endDate bump, so these schemas stay thin / shape-only.
const isoDate = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);

// Shared filter contract for the windowed report endpoints.
const baseFilter = {
  startDate: isoDate.allow('', null),
  endDate: isoDate.allow('', null),
  verticalId: Joi.number().integer().min(0).default(0),
  zonalManagerId: Joi.number().integer().min(0).default(0),
  reportingManagerId: Joi.number().integer().min(0).default(0),
  userId: Joi.number().integer().min(0).default(0),
  findByDateType: Joi.string().valid('original', 'requested').default('requested'),
  format: Joi.string().valid('json', 'xlsx').default('json'),
};

// Main table — adds pagination (FE [10,50,80]; size capped at 500).
const productivitySchema = Joi.object({
  ...baseFilter,
  page: Joi.number().integer().min(1).default(1),
  size: Joi.number().integer().min(1).max(500).default(10),
});

// KRA / dashboard / cancellation share the windowed base filter.
const windowedSchema = Joi.object({ ...baseFilter });

// Lookups.
const reportingManagersSchema = Joi.object({
  verticalId: Joi.number().integer().min(0).default(0),
});
const rmTeamUsersSchema = Joi.object({
  verticalId: Joi.number().integer().min(0).default(0),
  reportingManagerId: Joi.number().integer().min(0).default(0),
});

// ── XLSX column set (Title Case headers; corrected field alignment) ───
// Counts → '#,##0'; revenue (rupees) → '"₹"#,##0'. In-cell DATA BARS on the
// three most meaningful productivity VOLUME columns (Booked / Scheduled /
// Closed) — never on the name column or the rupee column.
const PRODUCTIVITY_XLSX_COLUMNS = [
  { key: 'userName', header: 'Employee', width: 28, align: 'left' },
  { key: 'booked', header: 'Booked', numFmt: '#,##0', align: 'right', dataBar: true, dataBarColor: 'FF6366F1' },
  { key: 'scheduled', header: 'Scheduled', numFmt: '#,##0', align: 'right', dataBar: true, dataBarColor: 'FF0EA5E9' },
  { key: 'audit', header: 'Audit', numFmt: '#,##0', align: 'right' },
  { key: 'closedCount', header: 'Closed', numFmt: '#,##0', align: 'right', dataBar: true, dataBarColor: 'FF10B981' },
  { key: 'revenue', header: 'Revenue', width: 14, numFmt: '"₹"#,##0', align: 'right' },
  { key: 'cancelCount', header: 'Cancelled', numFmt: '#,##0', align: 'right' },
];

/*
 * GET /employee-productivity — paginated per-employee productivity table.
 * ?format=xlsx streams ALL rows of the CURRENT filter/page (legacy Copy-Data
 * copied per page; the xlsx mirrors that — one page per download — to keep
 * parity, while the FE Copy Data button can still walk all pages client-side).
 */
router.get('/employee-productivity', validate(productivitySchema, 'query'), async (req, res, next) => {
  try {
    const pf = await service.processFloorFilters(req.query);
    const result = await service.getEmployeeProductivity({
      pf,
      page: req.query.page,
      size: req.query.size,
    });

    if (req.query.format === 'xlsx') {
      const exportRows = result.data || [];
      // Headline KPIs from the exported page rows (plain numbers, Title Case).
      const sumOf = (k) => exportRows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
      const totalBooked = sumOf('booked');
      const totalScheduled = sumOf('scheduled');
      const totalClosed = sumOf('closedCount');
      const totalRevenue = sumOf('revenue');

      const generatedOn = new Date().toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
      });
      const meta = `${exportRows.length} Employees · Generated ${generatedOn}`;

      await streamStyledXlsx(res, 'employee-productivity.xlsx', {
        title: 'EasyFix · Employee Productivity',
        meta,
        sheetName: 'Productivity',
        columns: PRODUCTIVITY_XLSX_COLUMNS,
        rows: exportRows,
        kpis: [
          { label: 'Total Booked', value: totalBooked, accent: 'FF6366F1' },
          { label: 'Total Scheduled', value: totalScheduled, accent: 'FF0EA5E9' },
          { label: 'Total Closed', value: totalClosed, accent: 'FF10B981' },
          { label: 'Total Revenue', value: totalRevenue, accent: 'FFF59E0B', numFmt: '"₹"#,##0' },
        ],
        totalRow: {
          userName: 'Total',
          booked: totalBooked,
          scheduled: totalScheduled,
          audit: sumOf('audit'),
          closedCount: totalClosed,
          revenue: totalRevenue,
          cancelCount: sumOf('cancelCount'),
        },
        emptyMessage: 'No Employees Found.',
      });
      return;
    }
    return modernOk(res, result);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// GET /kra-metrics — single-row KRA aggregate (OTA/SDA/TAT/ticket-size/margin/
// rating/unconfirmed/call-later).
router.get('/kra-metrics', validate(windowedSchema, 'query'), async (req, res, next) => {
  try {
    const pf = await service.processFloorFilters(req.query);
    const data = await service.getKraMetrics({ pf });
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// GET /dashboard-counts — 3 open-order tiles (open / call-later / escalation).
router.get('/dashboard-counts', validate(windowedSchema, 'query'), async (req, res, next) => {
  try {
    const pf = await service.processFloorFilters(req.query);
    const data = await service.getDashboardCounts({ pf });
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// GET /cancellation-details — 4 cancellation aging buckets + before/after summary.
router.get('/cancellation-details', validate(windowedSchema, 'query'), async (req, res, next) => {
  try {
    const pf = await service.processFloorFilters(req.query);
    const data = await service.getCancellationDetails({ pf });
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// GET /reporting-managers — RM picker, filtered by vertical (0 = all).
router.get('/reporting-managers', validate(reportingManagersSchema, 'query'), async (req, res, next) => {
  try {
    const data = await service.getReportingManagers({ verticalId: req.query.verticalId });
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// GET /rm-team-users — user picker, filtered by vertical + RM (0 = all).
router.get('/rm-team-users', validate(rmTeamUsersSchema, 'query'), async (req, res, next) => {
  try {
    const data = await service.getRmTeamUsers({
      verticalId: req.query.verticalId,
      reportingManagerId: req.query.reportingManagerId,
    });
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

module.exports = router;
