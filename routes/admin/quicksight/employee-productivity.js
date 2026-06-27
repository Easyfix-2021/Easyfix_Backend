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
const { fileStamp, displayStamp, FMT } = require('../../../services/quicksight/_shared');
const service = require('../../../services/quicksight/quicksight-employee-productivity.service');
const logger = require('../../../logger');

// XLSX export fetches the FULL filtered set (not one page). Sized to the
// service's grouped-rows cap (GROUPED_CAP) so the download reflects every
// matching employee — referenced symbolically so it can't drift from the cap.
const XLSX_EXPORT_SIZE = service.GROUPED_CAP;

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
  { key: 'booked', header: 'Booked', numFmt: FMT.COUNT, align: 'right', dataBar: true, dataBarColor: 'FF6366F1' },
  { key: 'scheduled', header: 'Scheduled', numFmt: FMT.COUNT, align: 'right', dataBar: true, dataBarColor: 'FF0EA5E9' },
  { key: 'audit', header: 'Audit', numFmt: FMT.COUNT, align: 'right' },
  { key: 'closedCount', header: 'Closed', numFmt: FMT.COUNT, align: 'right', dataBar: true, dataBarColor: 'FF10B981' },
  { key: 'revenue', header: 'Revenue', width: 14, numFmt: FMT.RUPEE, align: 'right' },
  { key: 'cancelCount', header: 'Cancelled', numFmt: FMT.COUNT, align: 'right' },
];

/*
 * GET /employee-productivity — paginated per-employee productivity table.
 * ?format=xlsx streams the FULL filtered set (KPIs + totalRow + rows aggregate
 * every matching employee, not just the on-screen page). The JSON branch keeps
 * server-side pagination for the table view.
 */
router.get('/employee-productivity', validate(productivitySchema, 'query'), async (req, res, next) => {
  try {
    logger.info('Employee Productivity table · ' + req.query.startDate + '→' + req.query.endDate + ' verticalId=' + req.query.verticalId + ' zonalManagerId=' + req.query.zonalManagerId + ' reportingManagerId=' + req.query.reportingManagerId + ' userId=' + req.query.userId + ' page=' + req.query.page + ' size=' + req.query.size + ' format=' + (req.query.format || 'json'));
    const pf = await service.processFloorFilters(req.query);

    if (req.query.format === 'xlsx') {
      // Export reflects the FULL filtered set, not the on-screen page: fetch
      // page 1 at the high export ceiling so KPIs / totalRow / rows aggregate
      // every matching employee. JSON branch below keeps real pagination.
      const fullResult = await service.getEmployeeProductivity({
        pf,
        page: 1,
        size: XLSX_EXPORT_SIZE,
      });
      const exportRows = fullResult.data || [];
      logger.info('Streaming Employee Productivity xlsx · ' + exportRows.length + ' employees');
      // Headline KPIs over the full filtered set (plain numbers, Title Case).
      const sumOf = (k) => exportRows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
      const totalBooked = sumOf('booked');
      const totalScheduled = sumOf('scheduled');
      const totalClosed = sumOf('closedCount');
      const totalRevenue = sumOf('revenue');

      const meta = `${exportRows.length} Employees · Generated ${displayStamp()}`;

      await streamStyledXlsx(res, `employee-productivity-${fileStamp()}.xlsx`, {
        title: 'EasyFix · Employee Productivity',
        meta,
        sheetName: 'Productivity',
        columns: PRODUCTIVITY_XLSX_COLUMNS,
        rows: exportRows,
        kpis: [
          { label: 'Total Booked', value: totalBooked, accent: 'FF6366F1' },
          { label: 'Total Scheduled', value: totalScheduled, accent: 'FF0EA5E9' },
          { label: 'Total Closed', value: totalClosed, accent: 'FF10B981' },
          { label: 'Total Revenue', value: totalRevenue, accent: 'FFF59E0B', numFmt: FMT.RUPEE },
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

    // JSON branch — server-side pagination unchanged.
    const result = await service.getEmployeeProductivity({
      pf,
      page: req.query.page,
      size: req.query.size,
    });
    logger.info('Returning ' + ((result && result.data ? result.data.length : 0)) + ' employees · total=' + (result && result.total != null ? result.total : 'n/a'));
    return modernOk(res, result);
  } catch (err) {
    if (err && err.status) logger.warn('Employee Productivity table failed · ' + err.message);
    else logger.error('Employee Productivity table error · ' + err.message);
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// GET /kra-metrics — single-row KRA aggregate (OTA/SDA/TAT/ticket-size/margin/
// rating/unconfirmed/call-later).
router.get('/kra-metrics', validate(windowedSchema, 'query'), async (req, res, next) => {
  try {
    logger.info('KRA metrics · ' + req.query.startDate + '→' + req.query.endDate + ' verticalId=' + req.query.verticalId + ' userId=' + req.query.userId);
    const pf = await service.processFloorFilters(req.query);
    const data = await service.getKraMetrics({ pf });
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) logger.warn('KRA metrics failed · ' + err.message);
    else logger.error('KRA metrics error · ' + err.message);
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// GET /dashboard-counts — 3 open-order tiles (open / call-later / escalation).
router.get('/dashboard-counts', validate(windowedSchema, 'query'), async (req, res, next) => {
  try {
    logger.info('Open-order dashboard counts · ' + req.query.startDate + '→' + req.query.endDate + ' verticalId=' + req.query.verticalId + ' userId=' + req.query.userId);
    const pf = await service.processFloorFilters(req.query);
    const data = await service.getDashboardCounts({ pf });
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) logger.warn('Dashboard counts failed · ' + err.message);
    else logger.error('Dashboard counts error · ' + err.message);
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// GET /cancellation-details — 4 cancellation aging buckets + before/after summary.
router.get('/cancellation-details', validate(windowedSchema, 'query'), async (req, res, next) => {
  try {
    logger.info('Cancellation details · ' + req.query.startDate + '→' + req.query.endDate + ' verticalId=' + req.query.verticalId + ' userId=' + req.query.userId);
    const pf = await service.processFloorFilters(req.query);
    const data = await service.getCancellationDetails({ pf });
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) logger.warn('Cancellation details failed · ' + err.message);
    else logger.error('Cancellation details error · ' + err.message);
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// GET /reporting-managers — RM picker, filtered by vertical (0 = all).
router.get('/reporting-managers', validate(reportingManagersSchema, 'query'), async (req, res, next) => {
  try {
    logger.info('Reporting managers lookup · verticalId=' + req.query.verticalId);
    const data = await service.getReportingManagers({ verticalId: req.query.verticalId });
    logger.info('Returning ' + (Array.isArray(data) ? data.length : 0) + ' reporting managers');
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) logger.warn('Reporting managers lookup failed · ' + err.message);
    else logger.error('Reporting managers lookup error · ' + err.message);
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// GET /rm-team-users — user picker, filtered by vertical + RM (0 = all).
router.get('/rm-team-users', validate(rmTeamUsersSchema, 'query'), async (req, res, next) => {
  try {
    logger.info('RM team users lookup · verticalId=' + req.query.verticalId + ' reportingManagerId=' + req.query.reportingManagerId);
    const data = await service.getRmTeamUsers({
      verticalId: req.query.verticalId,
      reportingManagerId: req.query.reportingManagerId,
    });
    logger.info('Returning ' + (Array.isArray(data) ? data.length : 0) + ' team users');
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) logger.warn('RM team users lookup failed · ' + err.message);
    else logger.error('RM team users lookup error · ' + err.message);
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// GET /spoc-revenue — revenue + completed-job counts aggregated by Primary SPOC.
// Uses the same windowed filter schema as kra-metrics. Primary SPOC =
// tbl_vertical_mapping rows with user_type=1; window = checkout_date_time BETWEEN
// processFloorFilters start/end; completed = job_status IN (3, 5).
router.get('/spoc-revenue', validate(windowedSchema, 'query'), async (req, res, next) => {
  try {
    logger.info('SPOC revenue · ' + req.query.startDate + '→' + req.query.endDate + ' verticalId=' + req.query.verticalId + ' userId=' + req.query.userId);
    const pf = await service.processFloorFilters(req.query);
    const data = await service.getSpocRevenue({ pf });
    logger.info('Returning ' + (Array.isArray(data) ? data.length : 0) + ' SPOC revenue rows');
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) logger.warn('SPOC revenue failed · ' + err.message);
    else logger.error('SPOC revenue error · ' + err.message);
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

module.exports = router;
