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
const { fileStamp, displayStamp, FMT, decorateColumns } = require('../../../services/quicksight/_shared');
const service = require('../../../services/quicksight/quicksight-admin-dashboard.service');
const logger = require('../../../logger');

const ADMIN_ROLE_ID = 2; // legacy loginToFloorDiscipline gate: roleId == 2.

// ── Access gate: ef-QuickSight family key + this report's per-report key ──
router.use(requireQuickSight('isQuickSightAdminDashboardView'));

/*
 * requireAdmin — strict Admin-only (legacy roleId==2). Mirrors the legacy
 * "Access Denied. Only Admin can view this page." 403. Resolves the acting
 * user's role via getRoleById (case-insensitive role_name match would also
 * work; role_id==2 is the verbatim legacy predicate).
 */
async function requireAdminOrReportingManager(req, res, next) {
  try {
    if (!req.user || !req.user.user_id) {
      return modernError(res, 401, 'authentication required');
    }
    const roleRow = await getRoleById(req.user.user_role);
    req.qsIsAdmin = Boolean(roleRow && roleRow.role_status && roleRow.role_id === ADMIN_ROLE_ID);
    if (req.qsIsAdmin) return next();

    /*
     * A REPORTING MANAGER may now open this report too — their own team only.
     * "Reporting manager" is a RELATION, not a role: somebody reports to them.
     * The predicate is the same one that builds the dropdown, so the answers to
     * "can you open this" and "are you in the list" cannot diverge.
     */
    if (await service.isReportingManager(req.user.user_id)) return next();

    return modernError(res, 403, 'Access Denied. Only Admin can view this page.');
  } catch (err) {
    return next(err);
  }
}
router.use(requireAdminOrReportingManager);

/*
 * THE SCOPE IS SERVER-SIDE, and it has to be.
 *
 * A reporting manager sees no Reporting Manager dropdown, but the field is
 * still a request parameter — hiding a control does not stop anyone sending
 * the value. So the id is OVERWRITTEN here for every non-Admin, on every route
 * and every method, rather than trusted from the client.
 *
 * At the router level on purpose: a per-handler check is one a future endpoint
 * forgets, and this file already has eight. Runs before validate(), so Joi sees
 * the forced value like any other.
 *
 * resolveRmTeamUserIds(rmId) returns the manager's direct reports PLUS the
 * manager, so pinning this one field yields exactly "me and my hierarchy".
 */
router.use((req, _res, next) => {
  if (req.qsIsAdmin) return next();
  const own = Number(req.user.user_id) || 0;
  if (req.body && typeof req.body === 'object') req.body.reportingManagerId = own;
  if (req.query && typeof req.query === 'object') req.query.reportingManagerId = String(own);
  return next();
});

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
// numFmt: counts → FMT.COUNT; revenue is rupees → FMT.RUPEE (no % columns).
// dataBar on the three volume columns (Booked / Scheduled / Closed) — never
// on the employee name or the rupee/audit columns. Hints applied via the
// shared decorateColumns() (first-match-wins rules; keys/headers unchanged).
const PRODUCTIVITY_XLSX_COLUMNS = decorateColumns(
  [
    { key: 'userName', header: 'Employee', width: 28 },
    { key: 'booked', header: 'Booked' },
    { key: 'scheduled', header: 'Scheduled' },
    { key: 'audit', header: 'Audit' },
    { key: 'closedCount', header: 'Closed' },
    { key: 'revenue', header: 'Revenue' },
    { key: 'cancelCount', header: 'Cancelled' },
  ],
  [
    { match: (key) => key === 'userName', hints: { align: 'left' } },
    { match: (key) => key === 'booked', hints: { numFmt: FMT.COUNT, dataBar: true, dataBarColor: 'FF6366F1' } },
    { match: (key) => key === 'scheduled', hints: { numFmt: FMT.COUNT, dataBar: true, dataBarColor: 'FF0EA5E9' } },
    { match: (key) => key === 'closedCount', hints: { numFmt: FMT.COUNT, dataBar: true, dataBarColor: 'FF10B981' } },
    { match: (key) => key === 'revenue', hints: { numFmt: FMT.RUPEE } },
    { match: (key) => key === 'audit' || key === 'cancelCount', hints: { numFmt: FMT.COUNT } },
  ]
);

// ── GET /access — mirrors loginToFloorDiscipline (isAdmin probe) ──────────
// Reaching here means the gate passed: Admin, or a reporting manager scoped
// to their own team by the router-level override above.
/*
 * isAdmin drives the FE: Admins get the Reporting Manager dropdown, reporting
 * managers do not. It used to be a hardcoded `true`, which was honest while the
 * router was Admin-only and is a lie now.
 */
router.get('/access', (req, res) => modernOk(res, {
  isAdmin: Boolean(req.qsIsAdmin),
  /*
   * Reaching this handler AT ALL means the gate above admitted the caller, so
   * canView is true by construction and a 403 is the "no" answer. That makes
   * this the cheapest possible question for the QuickSight index to ask before
   * it renders the Employee Productivity tile: one call, no payload.
   *
   * The alternative — asking the Reporting Manager dropdown endpoint and
   * looking for yourself in it — answers the same question by shipping every
   * manager's name to every caller, and re-derives access from a list built
   * for a different purpose. This says it directly.
   */
  canView: true,
  isReportingManager: !req.qsIsAdmin,
}));

// ── POST /open-orders — three bucket tiles ───────────────────────────────
router.post('/open-orders', validate(filterSchema), async (req, res, next) => {
  try {
    logger.info('Admin dashboard open-orders · ' + (req.body.startDate || '…') + '→' + (req.body.endDate || '…') + ' verticalId=' + req.body.verticalId + ' basedOn=' + req.body.findByDateType);
    const data = await service.openOrders(req.body, req.user.user_id);
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) { logger.warn('Open-orders failed · ' + err.message); return modernError(res, err.status, err.message); }
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
      logger.info('Admin dashboard employee-productivity · ' + (req.body.startDate || '…') + '→' + (req.body.endDate || '…') + ' format=' + req.body.format + ' page=' + page + ' size=' + size);

      if (req.body.format === 'xlsx') {
        // XLSX reflects the FULL filtered set, not one page: fetch at the
        // BE safety cap (USER_LIST_LIMIT=5000) so KPI cards, totalRow, and
        // data rows aggregate every matching employee. The JSON branch +
        // on-screen pagination below stay unchanged.
        const fullResult = await service.employeeProductivity(req.body, 1, service.USER_LIST_LIMIT);
        const rows = fullResult.data || [];
        logger.info('Exporting ' + rows.length + ' employee-productivity rows to xlsx');
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
        const meta = `${filterBits.join(' · ')} · ${rows.length} Employees · Generated ${displayStamp()}`;

        await streamStyledXlsx(res, `employee-productivity-${fileStamp()}.xlsx`, {
          title: 'EasyFix · Employee Productivity',
          meta,
          sheetName: 'Productivity',
          columns: PRODUCTIVITY_XLSX_COLUMNS,
          rows,
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
            audit: sum('audit'),
            closedCount: totalClosed,
            revenue: totalRevenue,
            cancelCount: sum('cancelCount'),
          },
          emptyMessage: 'No employees found for the selected filters.',
        });
        return;
      }
      const result = await service.employeeProductivity(req.body, page, size);
      logger.info('Returning ' + ((result.data && result.data.length) || 0) + ' employee-productivity rows');
      return modernOk(res, result);
    } catch (err) {
      if (err && err.status) { logger.warn('Employee-productivity failed · ' + err.message); return modernError(res, err.status, err.message); }
      return next(err);
    }
  }
);

// ── POST /kra-metrics — single aggregate KPI row ─────────────────────────
router.post('/kra-metrics', validate(filterSchema), async (req, res, next) => {
  try {
    logger.info('Admin dashboard kra-metrics · ' + (req.body.startDate || '…') + '→' + (req.body.endDate || '…') + ' verticalId=' + req.body.verticalId);
    const data = await service.kraMetrics(req.body, req.user.user_id);
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) { logger.warn('Kra-metrics failed · ' + err.message); return modernError(res, err.status, err.message); }
    return next(err);
  }
});

// ── POST /cancellation-details — buckets + before/after summary ───────────
router.post('/cancellation-details', validate(filterSchema), async (req, res, next) => {
  try {
    logger.info('Admin dashboard cancellation-details · ' + (req.body.startDate || '…') + '→' + (req.body.endDate || '…') + ' verticalId=' + req.body.verticalId);
    const data = await service.cancellationDetails(req.body, req.user.user_id);
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) { logger.warn('Cancellation-details failed · ' + err.message); return modernError(res, err.status, err.message); }
    return next(err);
  }
});

// ── GET /manager-team — org-chart tree rooted at user_id=3 ('CEO') ────────
router.get('/manager-team', async (req, res, next) => {
  try {
    logger.info('Admin dashboard manager-team tree');
    const tree = await service.managerTeam();
    if (!tree) return modernError(res, 404, 'No organization data found');
    return modernOk(res, tree);
  } catch (err) {
    if (err && err.status) { logger.warn('Manager-team failed · ' + err.message); return modernError(res, err.status, err.message); }
    return next(err);
  }
});

// ── GET /vertical-managers?verticalId= — RM-by-vertical dropdown ──────────
router.get(
  '/vertical-managers',
  validate(verticalManagersQuerySchema, 'query'),
  async (req, res, next) => {
    try {
      logger.info('Admin dashboard vertical-managers · verticalId=' + req.query.verticalId);
      const data = await service.verticalManagers(req.query.verticalId);
      return modernOk(res, data);
    } catch (err) {
      if (err && err.status) { logger.warn('Vertical-managers failed · ' + err.message); return modernError(res, err.status, err.message); }
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
      logger.info('Admin dashboard rm-team-users · verticalId=' + req.query.verticalId + ' reportingManagerId=' + req.query.reportingManagerId);
      const data = await service.rmTeamUsers(
        req.query.verticalId,
        req.query.reportingManagerId
      );
      return modernOk(res, data);
    } catch (err) {
      if (err && err.status) { logger.warn('Rm-team-users failed · ' + err.message); return modernError(res, err.status, err.message); }
      return next(err);
    }
  }
);

module.exports = router;
