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
const { getProperty } = require('../services/properties.service');

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
  /*
   * Profile update requests (2026-09-01). Same class of data as /users and the
   * same reasoning: these are STAFF numbers, and the payload is one CRM user's
   * own mobile awaiting HR approval.
   *
   * It is also not optional here. The whole screen exists so an approver can
   * decide whether to write a number onto a colleague's record — and a decision
   * about 9876•••••• is not a decision. Masked, the Approve button would be
   * asking HR to rubber-stamp a value they were not shown.
   *
   * Left at route level rather than making the frontend append ?unmasked=true:
   * the escape hatch works, but it puts the correctness of the screen in the
   * caller's memory, and the next consumer of this route would silently get
   * masked values back with no hint that they had opted out of anything.
   *
   * Scope is genuinely staff-only — the route reads tbl_user_profile_update_request,
   * which has no customer or technician numbers in it — and access is already
   * gated by isProfileApprovalView / isProfileApprovalProcess.
   */
  '/profile-update-requests',
];

// Read-only audit/report surfaces never need edit-form prefill. Keep them
// masked even if a caller adds the generic ?unmasked=true escape hatch.
const ALWAYS_MASKED_PATH_PREFIXES = [
  '/rewards/referrals',
];

/*
 * Same rule, for routes whose path carries an id and so has no static prefix.
 *
 * /easyfixers/:id/mirror/* replays the technician's own mobile screens into
 * the CRM — their job list, their order detail — so its payload is a window
 * onto every customer mobile that technician has ever touched. `?unmasked=true`
 * is a bare query param any operator can append (see :98 below), and there is
 * no edit form behind a read-only mirror, so the escape hatch has no
 * legitimate use here and exactly one illegitimate one.
 *
 * Matched by pattern rather than by adding '/easyfixers' to the prefix list
 * above: the rest of /easyfixers/* is edit forms that genuinely need the
 * prefill, and blanket-masking them would break Manage Easyfixers.
 */
const ALWAYS_MASKED_PATH_PATTERNS = [
  /^\/easyfixers\/\d+\/mirror(\/|$)/,
];

function isUnmaskedPath(reqPath) {
  return UNMASKED_PATH_PREFIXES.some((prefix) => reqPath === prefix || reqPath.startsWith(prefix + '/'));
}

function isAlwaysMaskedPath(reqPath) {
  return ALWAYS_MASKED_PATH_PREFIXES.some((prefix) => reqPath === prefix || reqPath.startsWith(prefix + '/'))
    || ALWAYS_MASKED_PATH_PATTERNS.some((re) => re.test(reqPath));
}

/*
 * Global CUSTOMER-number visibility toggle (easyfix_properties, DB-flipped).
 * When 'true', CUSTOMER-facing mobile fields (see CUSTOMER_MOBILE_FIELDS in
 * utils/mask-mobile.js) ship UNMASKED to CRM operational screens; technician
 * / client-SPOC / staff numbers stay masked either way. Absent → false
 * (masked — the long-standing default).
 */
function customerNumbersVisible() {
  return String(getProperty('ui.customer.number.visible')).trim().toLowerCase() === 'true';
}

/*
 * QuickSight report responses must stay masked even when the visibility flag
 * is ON — the 'mask numbers in reports' posture is deliberate and independent.
 * req.path here is mounted UNDER /api/admin, so report routes start with
 * '/quicksight'.
 */
function isReportPath(reqPath) {
  return reqPath === '/quicksight' || reqPath.startsWith('/quicksight/');
}

function maskMobileResponseMiddleware(req, res, next) {
  const wantsUnmasked = String(req.query?.unmasked).toLowerCase() === 'true'
    && !isAlwaysMaskedPath(req.path);
  if (wantsUnmasked || isUnmaskedPath(req.path)) {
    // Short-circuit: edit-form opt-out OR whitelisted internal-staff
    // route. The route's own auth + role checks already gate this;
    // no further permission check here.
    return next();
  }

  // Customer-number visibility flag ON (and NOT a report path) → leave
  // customer fields raw; everything else still masks. Flag OFF → mask all
  // (identical to the historical behaviour).
  const unmaskCustomer = customerNumbersVisible() && !isReportPath(req.path);
  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(maskMobileInResponse(body, { unmaskCustomer }));
  return next();
}

module.exports = maskMobileResponseMiddleware;
