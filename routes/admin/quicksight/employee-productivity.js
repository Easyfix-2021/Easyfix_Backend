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
const { sendXlsx } = require('../../../utils/xlsx-export');
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
const PRODUCTIVITY_XLSX_COLUMNS = [
  { key: 'userName', header: 'Employee', width: 28 },
  { key: 'booked', header: 'Booked' },
  { key: 'scheduled', header: 'Scheduled' },
  { key: 'audit', header: 'Audit' },
  { key: 'closedCount', header: 'Closed' },
  { key: 'revenue', header: 'Revenue', width: 14 },
  { key: 'cancelCount', header: 'Cancelled' },
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
      return sendXlsx(res, {
        filename: 'employee-productivity.xlsx',
        sheetName: 'Productivity',
        columns: PRODUCTIVITY_XLSX_COLUMNS,
        rows: result.data,
      });
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
