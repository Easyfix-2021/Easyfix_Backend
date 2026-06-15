/*
 * QuickSight access guard middleware factory.
 *
 * Every native QuickSight report is gated by TWO action keys:
 *   1. `ef-QuickSight`            — the FAMILY key (already exists; legacy
 *                                   gate on the /token session-bridge
 *                                   endpoint). Holding it means "this user
 *                                   may use QuickSight at all".
 *   2. `isQuickSight<Report>View` — the per-report key, so Manage Roles can
 *                                   grant/revoke each report independently
 *                                   (platform permission-gating rule: every
 *                                   page must be individually reachable in
 *                                   Manage Role).
 *
 * Usage (in a report sub-router):
 *   const requireQuickSight = require('../../../middleware/require-quicksight');
 *   router.use(requireQuickSight('isQuickSightOpenOrdersView'));
 *
 * Family-only (no per-report key, e.g. a landing/index endpoint):
 *   router.use(requireQuickSight());
 *
 * Behaviour mirrors the inline check the old quicksight.js /token handler
 * performed (getEffectivePermissions → actionPermissions.includes(
 * 'ef-QuickSight')), generalised to also require the optional per-report
 * key. 403s via modernError on any missing key.
 *
 * Auth precondition: assumes `req.user.user_id` is set by upstream
 * requireAuth (the parent /api/admin/* chain runs it first). 401s if absent
 * rather than silently passing. Permissions are loaded once per request and
 * cached on `req.user.permissions` so chained guards do a single DB read
 * (same pattern as middleware/require-action.js).
 */

const { getEffectivePermissions } = require('../services/role.service');
const { modernError } = require('../utils/response');

const FAMILY_KEY = 'ef-QuickSight';

function requireQuickSight(extraKey) {
  if (extraKey !== undefined && (typeof extraKey !== 'string' || !extraKey)) {
    throw new Error('requireQuickSight(): extraKey, when provided, must be a non-empty string');
  }

  return async function quickSightGuard(req, res, next) {
    try {
      if (!req.user || !req.user.user_id) {
        return modernError(res, 401, 'authentication required');
      }

      // Lazy-load permissions once per request; reuse across chained guards.
      if (!req.user.permissions) {
        req.user.permissions = await getEffectivePermissions(req.user.user_id);
      }

      const perms = (req.user.permissions && req.user.permissions.actionPermissions) || [];

      if (!perms.includes(FAMILY_KEY)) {
        return modernError(res, 403, 'You do not have QuickSight access');
      }
      if (extraKey && !perms.includes(extraKey)) {
        return modernError(res, 403, `Missing permission: ${extraKey}`);
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = requireQuickSight;
