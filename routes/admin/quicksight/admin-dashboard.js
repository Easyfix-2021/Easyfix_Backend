/*
 * QuickSight report sub-router — Admin Dashboard.
 *
 *   registry slug   : adminDashboard
 *   urlBase         : admin-dashboard   (mounted at /api/admin/quicksight/admin-dashboard)
 *   action key      : isQuickSightAdminDashboardView
 *   service file    : services/quicksight/quicksight-admin-dashboard.service.js
 *
 * The legacy `adminDashboard` Angular route is an "Access Denied" decoy; the
 * REAL admin-level dashboard is the Floor Discipline / Employee Productivity
 * dashboard backed by FloorDisciplineController. This sub-router is the native
 * port of its seven endpoints + two dropdown lookups.
 *
 * Parent chain (routes/admin/index.js) already runs requireAuth → role(['admin']).
 * This sub-router layers:
 *   1. requireQuickSight('isQuickSightAdminDashboardView') — ef-QuickSight
 *      family key + this report's own per-report key (Manage-Role gating).
 *   2. requireAdmin — the legacy roleId==2 (Admin-only) gate. The legacy
 *      FloorDiscipline app-level gate (loginToFloorDiscipline) admits ONLY
 *      tbl_role.role_id==2; EasyFix's admin GROUP is broader (2,3,5,7,…), so
 *      we re-assert the strict Admin-only intent here ("Only Admin can view
 *      this page."). This matches the registry openQuestion recommendation
 *      (roleByName(['Admin']) — implemented via role_id==2 to match verbatim).
 *
 * The productivity endpoint honours ?format=xlsx for a server-side download
 * (replaces the legacy clipboard-TSV "Copy Data" affordance).
 */

const router = require('express').Router();
const Joi = require('joi');

const requireQuickSight = require('../../../middleware/require-quicksight');
const validate = require('../../../middleware/validate');
const { modernOk, modernError } = require('../../../utils/response');
const { streamStyledXlsx } = require('../../../utils/xlsx-styled-export');
const { getRoleById } = require('../../../services/role.service');
const service = require('../../../services/quicksight/quicksight-admin-dashboard.service');

const ADMIN_ROLE_ID = 2; // legacy loginToFloorDiscipline gate: roleId == 2.

// ── Access gate: ef-QuickSight family key + this report's per-report key ──
router.use(requireQuickSight('isQuickSightAdminDashboardView'));

/*
 * requireAdmin — strict Admin-only (legacy roleId==2). Mirrors the legacy
 * "Access Denied. Only Admin can view this page." 403. Resolves the acting
 * user's role via getRoleById (case-insensitive role_name match would also
 * work; role_id==2 is the verbatim legacy predicate).
 */
async function requireAdmin(req, res, next) {
  try {
    if (!req.user || !req.user.user_id) {
      return modernError(res, 401, 'authentication required');
    }
    const roleRow = await getRoleById(req.user.user_role);
    if (!roleRow || !roleRow.role_status || roleRow.role_id !== ADMIN_ROLE_ID) {
      return modernError(res, 403, 'Access Denied. Only Admin can view this page.');
    }
    return next();
  } catch (err) {
    return next(err);
  }
}
router.use(requireAdmin);

// ── Joi schemas (inline; the legacy FloorFilterDto) ──────────────────────
const filterSchema = Joi.object({
  startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('').optional(),
  endDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('').optional(),
  verticalId: Joi.number().integer().min(0).default(0),
  reportingManagerId: Joi.number().integer().min(0).default(0),
  zonalManagerId: Joi.number().integer().min(0).default(0),
  userId: Joi.number().integer().min(0).default(0),
  findByDateType: Joi.string().valid('original', 'requested', '').default('requested'),
  // Productivity export branch toggle (other endpoints ignore it).
  format: Joi.string().valid('json', 'xlsx').default('json'),
});

// employee-productivity pagination (query). size.max=500 honours the legacy
// copy-all loop (which fetched size=500 pages).
const productivityQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  size: Joi.number().integer().min(1).max(500).default(10),
});

const verticalManagersQuerySchema = Joi.object({
  verticalId: Joi.number().integer().min(0).required(),
});

const rmTeamUsersQuerySchema = Joi.object({
  verticalId: Joi.number().integer().min(0).required(),
  reportingManagerId: Joi.number().integer().min(0).required(),
});

// ── XLSX column set for the Employee Productivity export ──────────────────
// numFmt: counts → '#,##0'; revenue is rupees → '"₹"#,##0' (no % columns).
// dataBar on the three volume columns (Booked / Scheduled / Closed) — never
// on the employee name or the rupee/audit columns.
const PRODUCTIVITY_XLSX_COLUMNS = [
  { key: 'userName', header: 'Employee', width: 28, align: 'left' },
  { key: 'booked', header: 'Booked', numFmt: '#,##0', dataBar: true, dataBarColor: 'FF6366F1' },
  { key: 'scheduled', header: 'Scheduled', numFmt: '#,##0', dataBar: true, dataBarColor: 'FF0EA5E9' },
  { key: 'audit', header: 'Audit', numFmt: '#,##0' },
  { key: 'closedCount', header: 'Closed', numFmt: '#,##0', dataBar: true, dataBarColor: 'FF10B981' },
  { key: 'revenue', header: 'Revenue', numFmt: '"₹"#,##0' },
  { key: 'cancelCount', header: 'Cancelled', numFmt: '#,##0' },
];

// ── GET /access — mirrors loginToFloorDiscipline (isAdmin probe) ──────────
// Reaching here means requireAdmin already passed (role_id==2), so isAdmin=true.
router.get('/access', (req, res) => modernOk(res, { isAdmin: true }));

// ── POST /open-orders — three bucket tiles ───────────────────────────────
router.post('/open-orders', validate(filterSchema), async (req, res, next) => {
  try {
    const data = await service.openOrders(req.body, req.user.user_id);
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// ── POST /employee-productivity?page=&size= — paginated metric rows ───────
router.post(
  '/employee-productivity',
  validate(productivityQuerySchema, 'query'),
  validate(filterSchema),
  async (req, res, next) => {
    try {
      const { page, size } = req.query;
      const result = await service.employeeProductivity(req.body, page, size);

      if (req.body.format === 'xlsx') {
        const rows = result.data || [];
        const sum = (key) => rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);
        const totalBooked = sum('booked');
        const totalScheduled = sum('scheduled');
        const totalClosed = sum('closedCount');
        const totalRevenue = sum('revenue');

        // Filter context for the meta band (only non-default filters shown).
        const filterBits = [];
        if (req.body.startDate || req.body.endDate) {
          filterBits.push(`Dates: ${req.body.startDate || '…'} → ${req.body.endDate || '…'}`);
        }
        if (Number(req.body.verticalId) > 0) filterBits.push(`Vertical ${req.body.verticalId}`);
        if (Number(req.body.reportingManagerId) > 0) {
          filterBits.push(`RM ${req.body.reportingManagerId}`);
        }
        if (Number(req.body.zonalManagerId) > 0) {
          filterBits.push(`Zonal ${req.body.zonalManagerId}`);
        }
        if (Number(req.body.userId) > 0) filterBits.push(`User ${req.body.userId}`);
        filterBits.push(`Based On ${req.body.findByDateType || 'requested'}`);
        const generated = new Date().toLocaleDateString('en-GB', {
          day: '2-digit', month: 'short', year: 'numeric',
        });
        const meta = `${filterBits.join(' · ')} · ${rows.length} Employees · Generated ${generated}`;

        await streamStyledXlsx(res, 'employee-productivity.xlsx', {
          title: 'EasyFix · Employee Productivity',
          meta,
          sheetName: 'Productivity',
          columns: PRODUCTIVITY_XLSX_COLUMNS,
          rows,
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
            audit: sum('audit'),
            closedCount: totalClosed,
            revenue: totalRevenue,
            cancelCount: sum('cancelCount'),
          },
          emptyMessage: 'No employees found for the selected filters.',
        });
        return;
      }
      return modernOk(res, result);
    } catch (err) {
      if (err && err.status) return modernError(res, err.status, err.message);
      return next(err);
    }
  }
);

// ── POST /kra-metrics — single aggregate KPI row ─────────────────────────
router.post('/kra-metrics', validate(filterSchema), async (req, res, next) => {
  try {
    const data = await service.kraMetrics(req.body, req.user.user_id);
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// ── POST /cancellation-details — buckets + before/after summary ───────────
router.post('/cancellation-details', validate(filterSchema), async (req, res, next) => {
  try {
    const data = await service.cancellationDetails(req.body, req.user.user_id);
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// ── GET /manager-team — org-chart tree rooted at user_id=3 ('CEO') ────────
router.get('/manager-team', async (req, res, next) => {
  try {
    const tree = await service.managerTeam();
    if (!tree) return modernError(res, 404, 'No organization data found');
    return modernOk(res, tree);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// ── GET /vertical-managers?verticalId= — RM-by-vertical dropdown ──────────
router.get(
  '/vertical-managers',
  validate(verticalManagersQuerySchema, 'query'),
  async (req, res, next) => {
    try {
      const data = await service.verticalManagers(req.query.verticalId);
      return modernOk(res, data);
    } catch (err) {
      if (err && err.status) return modernError(res, err.status, err.message);
      return next(err);
    }
  }
);

// ── GET /rm-team-users?verticalId=&reportingManagerId= — users-by-RM ──────
router.get(
  '/rm-team-users',
  validate(rmTeamUsersQuerySchema, 'query'),
  async (req, res, next) => {
    try {
      const data = await service.rmTeamUsers(
        req.query.verticalId,
        req.query.reportingManagerId
      );
      return modernOk(res, data);
    } catch (err) {
      if (err && err.status) return modernError(res, err.status, err.message);
      return next(err);
    }
  }
);

module.exports = router;
