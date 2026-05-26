/*
 * Mobile-number masking middleware for /api/admin/* responses.
 *
 * Wraps `res.json` so any payload heading to a CRM operator's browser
 * has its mobile-bearing fields (customer_mob_no, mobile_no, efr_no,
 * caller, reciever, …) replaced with first-4-digits-then-bullets BEFORE
 * Express serialises the response.
 *
 * Why middleware rather than per-route masking:
 *   - Single point of enforcement. New endpoints inherit masking
 *     automatically; we can't forget to add it on a fresh route.
 *   - The audit surface is one file instead of dozens.
 *
 * Edit-form escape hatch (?unmasked=true):
 *   Edit forms need to pre-fill the mobile input with the actual current
 *   number so the operator can verify + selectively edit. The masked
 *   string can't round-trip through a save without corrupting the
 *   record (Joi mobile pattern is digits-only).
 *
 *   The opt-out is a query param `?unmasked=true` on the request. The
 *   middleware short-circuits when present, returning the payload raw.
 *   Permission gating is the responsibility of the calling route — any
 *   admin who can hit a /:id endpoint already has read access; if
 *   tightening is needed later, gate at the route by checking
 *   `req.query.unmasked === 'true'` and rejecting based on a permission
 *   action.
 *
 * Not applied to:
 *   - /api/integration/v1/*  (external client contract; CLAUDE.md no-
 *                              client-change rule)
 *   - /api/webhook/*          (outbound integrations expect raw numbers)
 *   - File downloads (.xlsx)  (res.json is not called for those —
 *                              middleware is a no-op)
 */

const { maskMobileInResponse } = require('../utils/mask-mobile');

/*
 * Per-route mask opt-out (2026-05-25):
 *
 * Some admin pages need to display the real mobile number — Manage
 * Users in particular shows a staff roster where masking adds zero
 * security value (operators viewing this list already see the same
 * data in /admin/users/:id detail when they open the edit modal).
 * Surfaces listed here bypass the masking middleware entirely.
 *
 * SECURITY NOTE: this is a route-level opt-out, not a global one.
 * Customer-facing mobiles (tbl_customer, tbl_easyfixer SPOC etc.)
 * continue to be masked everywhere else. Only the internal-staff
 * directory route is whitelisted.
 *
 * Match style: `req.path` here is mounted UNDER `/api/admin` so it
 * starts with `/users` for routes like `GET /api/admin/users`.
 * Hierarchy + bulk-lookup + check-* sub-routes are also internal
 * directory data — same opt-out applies.
 */
const UNMASKED_PATH_PREFIXES = [
  '/users',          // list, detail, hierarchy, bulk-lookups, check-mobile/email
];

function isUnmaskedPath(reqPath) {
  return UNMASKED_PATH_PREFIXES.some((prefix) => reqPath === prefix || reqPath.startsWith(prefix + '/'));
}

function maskMobileResponseMiddleware(req, res, next) {
  const wantsUnmasked = String(req.query?.unmasked).toLowerCase() === 'true';
  if (wantsUnmasked || isUnmaskedPath(req.path)) {
    // Short-circuit: edit-form opt-out OR whitelisted internal-staff
    // route. The route's own auth + role checks already gate this;
    // no further permission check here.
    return next();
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(maskMobileInResponse(body));
  return next();
}

module.exports = maskMobileResponseMiddleware;
