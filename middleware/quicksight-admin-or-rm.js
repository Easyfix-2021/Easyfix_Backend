/*
 * Access gate for the two QuickSight reports whose audience is a RELATION,
 * not a role: Employee Productivity and the Floor-Discipline Admin Dashboard.
 *
 * "Reporting manager" is not a role in tbl_role — it means somebody reports to
 * you (tbl_user.reporting_manager). So these reports cannot be gated by the
 * per-report action key alone: a Project Manager with a team is exactly the
 * person who should see their team's productivity, and no amount of role
 * seeding expresses that.
 *
 * THE GATE IS ADDITIVE — family key, then any ONE of:
 *   • Admin (legacy role_id 2), or
 *   • the per-report action key, so Manage Roles can still grant it, or
 *   • being somebody's reporting manager.
 *
 * Additive on purpose: making the relation the ONLY gate would take the report
 * away from any role that had been granted it explicitly, which is a silent
 * revocation nobody asked for.
 *
 * WHY THIS IS SHARED AND NOT COPIED. It started as an inline block in
 * admin-dashboard.js, and the report the operator actually meant --
 * employee-productivity.js -- was left on the per-report key alone. The gate
 * and the report drifted apart the moment there were two of them, so there is
 * one definition and both routers mount it.
 */

const { getRoleById } = require('../services/role.service');
const { isReportingManager } = require('../services/quicksight/quicksight-admin-dashboard.service');
const { modernError } = require('../utils/response');

const ADMIN_ROLE_ID = 2; // legacy loginToFloorDiscipline gate: roleId == 2.

/*
 * Assumes requireQuickSight() has already run, so the family key is proven and
 * req.user.permissions is populated. Sets req.qsIsAdmin for the scope guard and
 * the /access endpoint.
 */
function adminOrReportingManager(reportKey) {
  if (typeof reportKey !== 'string' || !reportKey) {
    throw new Error('adminOrReportingManager(): reportKey must be a non-empty string');
  }
  return async function gate(req, res, next) {
    try {
      if (!req.user || !req.user.user_id) {
        return modernError(res, 401, 'authentication required');
      }
      const roleRow = await getRoleById(req.user.user_role);
      req.qsIsAdmin = Boolean(roleRow && roleRow.role_status && roleRow.role_id === ADMIN_ROLE_ID);
      if (req.qsIsAdmin) return next();

      const perms = (req.user.permissions && req.user.permissions.actionPermissions) || [];
      if (perms.includes(reportKey)) return next();

      /*
       * Same predicate that builds the Reporting Manager dropdown, so "can you
       * open this" and "are you in the list" cannot give different answers.
       */
      if (await isReportingManager(req.user.user_id)) return next();

      return modernError(res, 403, 'Access Denied. Only Admin can view this page.');
    } catch (err) {
      return next(err);
    }
  };
}

/*
 * THE SCOPE IS SERVER-SIDE, and it has to be.
 *
 * A reporting manager sees no Reporting Manager dropdown, but the field is
 * still a request parameter — hiding a control does not stop anyone sending the
 * value. So the id is OVERWRITTEN for every non-Admin, on every route and every
 * method, rather than trusted from the client.
 *
 * Mounted at the router level on purpose: a per-handler check is one a future
 * endpoint forgets. Runs before validate(), so Joi sees the forced value like
 * any other. resolveRmTeamUserIds(rmId) returns the manager's direct reports
 * PLUS the manager, so pinning this one field yields exactly "me and my team".
 */
function forceOwnHierarchy(req, _res, next) {
  if (req.qsIsAdmin) return next();
  const own = Number(req.user && req.user.user_id) || 0;
  if (req.body && typeof req.body === 'object') req.body.reportingManagerId = own;
  if (req.query && typeof req.query === 'object') req.query.reportingManagerId = String(own);
  return next();
}

module.exports = { adminOrReportingManager, forceOwnHierarchy, ADMIN_ROLE_ID };
