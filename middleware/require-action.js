/*
 * Action-permission guard middleware factory.
 *
 * The legacy CRM gates buttons + endpoints by free-text "action keys"
 * (e.g. `isJobMagicLinkSend`, `isNoticeManage`, `isClientEdit`) stored in
 * the `menu_action` table and granted per-role via `role_menu_action`.
 *
 * Usage:
 *   router.post('/foo', requireAction('isJobMagicLinkSend'), handler);
 *
 * Why this exists:
 *   Prior to 2026-05-30, individual route files (notices.js, clients.js,
 *   job-magic-link.js) each declared their own inline check:
 *     const perms = req.user?.permissions?.actionPermissions || [];
 *     if (!perms.includes('isXxx')) return modernError(res, 403, ...);
 *   That pattern silently never matched, because `requireAuth` only
 *   attaches the raw `tbl_user` row to `req.user` — no `.permissions`
 *   property is ever populated by upstream middleware. The check always
 *   fell back to `[]`, so every gated action returned 403 even when the
 *   user's role had the grant. The bug was latent for admin users only
 *   because admins typically hit endpoints through other paths or had
 *   button-level FE gating already do the right thing; it surfaced when
 *   the new magic-link feature called the BE check directly. This
 *   middleware is the unifying replacement called out by the
 *   "If/when an requireAction() middleware lands" comment in notices.js.
 *
 * Behaviour:
 *   - On first invocation per request, fetches the user's effective
 *     permissions via getEffectivePermissions(user_id) and stashes the
 *     full {menuIds, actionPermissions} object on `req.user.permissions`.
 *   - If `req.user.permissions` is already populated (a previous
 *     requireAction or upstream middleware already hydrated it), reuses
 *     it — single DB read per request even when multiple actions chain.
 *   - If the requested action key is in `actionPermissions`, passes
 *     through. Else returns 403 with the canonical
 *     `Missing permission: <key>` body.
 *
 * Caching:
 *   None at the middleware layer. Each request triggers one
 *   getEffectivePermissions call against the DB (a 2-statement
 *   lookup: tbl_user.user_role + role_menu_action JOIN menu_action).
 *   On the order of 1-2ms steady state. If perf ever needs it, add
 *   an LRU cache inside services/role.service.js scoped to userId
 *   with a short TTL (1-2 min) so a Manage-Role grant change is
 *   visible to users within reasonable bounds without re-login.
 *
 * Auth precondition:
 *   This middleware ASSUMES `req.user.user_id` is set by upstream
 *   `requireAuth`. It will 401 if absent rather than silently passing.
 *   The 5 standard mount chains (/api/admin, /api/client, /api/mobile,
 *   /api/shared, /api/auth) all run requireAuth first, so the
 *   precondition holds in normal use.
 */

const { getEffectivePermissions } = require('../services/role.service');
const { modernError } = require('../utils/response');

function requireAction(actionKey) {
  if (!actionKey || typeof actionKey !== 'string') {
    throw new Error('requireAction(): actionKey must be a non-empty string');
  }

  return async function actionGuard(req, res, next) {
    try {
      if (!req.user || !req.user.user_id) {
        return modernError(res, 401, 'authentication required');
      }

      // Lazy-load permissions once per request. Subsequent
      // requireAction() calls in the same chain reuse the cached
      // result on req.user.permissions.
      if (!req.user.permissions) {
        req.user.permissions = await getEffectivePermissions(req.user.user_id);
      }

      const perms = (req.user.permissions && req.user.permissions.actionPermissions) || [];
      if (!perms.includes(actionKey)) {
        return modernError(res, 403, `Missing permission: ${actionKey}`);
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = requireAction;
