const router = require('express').Router();

const validate = require('../middleware/validate');
const requireAuth = require('../middleware/auth');
const { loginOtpRequest, verifyOtpRequest } = require('../validators/auth.validator');
const { createLoginOtp, verifyLoginOtp } = require('../services/auth.service');
const { getRoleById } = require('../services/role.service');
const { signUserToken } = require('../utils/jwt');
const { modernOk, modernError } = require('../utils/response');
const { FEATURES, emailAllowed } = require('../services/feature-access.service');
const logger = require('../logger');

/*
 * POST /api/auth/login
 *
 * tbl_user has no password column. Legacy EasyFix_CRM uses Microsoft Azure AD
 * OAuth instead of email+password. Until that path is wired up (or a password
 * column is added intentionally), this endpoint refuses with 501 so clients
 * can clearly route to /login-otp.
 */
router.post('/login', (_req, res) => {
  logger.info('Password login attempt rejected · not supported (use login-otp)');
  modernError(
    res,
    501,
    'password login is not supported for internal users; use POST /api/auth/login-otp',
    { alternative: '/api/auth/login-otp' }
  );
});

/*
 * POST /api/auth/login-otp
 * Body: { identifier: email | 10-digit mobile }
 *
 * Surfaces an explicit "account not registered" error when no matching
 * tbl_user row exists. This trades the anti-enumeration guarantee for a
 * clearer UX — operators specifically requested it because internal CRM
 * users were getting "OTP sent" messages and then waiting forever for
 * SMS/email that would never come (because the user simply didn't exist
 * in the system). The trade-off is acceptable for an internal-only CRM
 * behind VPN auth; do NOT copy this pattern to externally-exposed
 * endpoints (client/mobile/integration) without re-evaluating.
 */
router.post('/login-otp', validate(loginOtpRequest), async (req, res, next) => {
  try {
    const { identifier } = req.body;
    logger.info('Login OTP requested');
    const result = await createLoginOtp(identifier);
    if (!result.found) {
      logger.warn('Login OTP request failed · account not registered');
      return modernError(
        res,
        404,
        'This account is not registered in the CRM. Please check the email / mobile or contact your admin.'
      );
    }
    /*
     * `delivered` is the REAL outcome from the delivery ladder, not a constant.
     * It used to be hardcoded true, so an OTP whose email was suppressed (no
     * mailbox) and whose WhatsApp fallback also failed still answered
     * "OTP sent" — the user then waited for a code no channel ever carried.
     * A hard error is the honest answer: the OTP row exists, but nothing
     * reached the user, so retrying or contacting an admin is the only way on.
     */
    if (!result.delivered) {
      logger.error('Login OTP could not be delivered on any channel · channels=[' + (result.channelsTried || '') + ']');
      return modernError(
        res,
        502,
        'We generated your OTP but could not deliver it on any channel (email / WhatsApp / SMS). '
        + 'Your registered email may have no mailbox, or no mobile number is on file. Please contact your admin.',
      );
    }
    logger.info('Login OTP issued · delivered');
    return modernOk(
      res,
      { delivered: true, expiresAt: result.expiresAt ?? null },
      'OTP sent'
    );
  } catch (err) {
    return next(err);
  }
});

/*
 * POST /api/auth/verify-otp
 * Body: { identifier, otp }
 * On success: issues JWT and sets httpOnly cookie.
 */
router.post('/verify-otp', validate(verifyOtpRequest), async (req, res, next) => {
  try {
    const { identifier, otp } = req.body;
    logger.info('Verify OTP attempt');
    const result = await verifyLoginOtp(identifier, otp);

    if (!result.ok) {
      const map = {
        USER_NOT_FOUND: [401, 'invalid credentials'],
        NO_OTP_ISSUED: [400, 'no active OTP — request one first'],
        OTP_EXPIRED:   [401, 'OTP expired — request a new one'],
        OTP_MISMATCH:  [401, 'incorrect OTP'],
      };
      const [status, message] = map[result.reason] || [401, 'authentication failed'];
      logger.warn('Verify OTP failed · reason=' + (result.reason || 'UNKNOWN') + ' status=' + status);
      return modernError(res, status, message);
    }
    logger.info('OTP verified · token issued · user_id=' + (result.user && result.user.user_id) + ' role=' + (result.user && result.user.user_role));

    res.cookie('token', result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    return modernOk(res, {
      token: result.token,
      user: {
        user_id: result.user.user_id,
        user_name: result.user.user_name,
        official_email: result.user.official_email,
        user_role: result.user.user_role,
        city_id: result.user.city_id,
      },
    });
  } catch (err) {
    return next(err);
  }
});

/*
 * GET /api/auth/me
 * Requires a valid JWT. Returns the fresh tbl_user row + role metadata so the
 * frontend can gate UI without a second request.
 */
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    logger.info('Resolve current identity (me) · principal=' + (req.user.__principal || 'crm') + ' role=' + req.user.user_role);
    const role = await getRoleById(req.user.user_role);

    // Technician (mobile) principals authenticate against tbl_easyfixer and
    // carry no tbl_user permission/scope columns. Their `user_id` is the
    // non-numeric `efr:<id>` form, so the tbl_user permission/scope resolution
    // below would coerce it to NaN and emit `WHERE user_id = NaN` (a 500). The
    // CRM RBAC/scope model does not apply to technicians — the mobile app gates
    // itself via /api/mobile/*. Return a clean, empty-permission identity so a
    // mobile bearer is a first-class /api/shared principal without the 500.
    if (req.user.__principal === 'mobile') {
      logger.info('Returning mobile identity · empty CRM permissions/scope');
      return modernOk(res, {
        user: req.user,
        role: role && {
          role_id: role.role_id,
          role_name: role.role_name,
          group: role.group,
          active: role.role_status,
        },
        permissions: { menuIds: [], actionPermissions: [] },
        scope: {
          clients:   { mode: 'none', ids: [] },
          cities:    { mode: 'none', ids: [] },
          states:    { mode: 'none', ids: [] },
          verticals: { mode: 'none', ids: [] },
        },
        hierarchy: { directReportsCount: 0, descendantsCount: 0 },
        scheduledJobsAccess: false,
        canManageJobCharges: false,
        // Job Stage Access — technicians carry no CRM stage restriction.
        allowedStages: { mode: 'all', stages: [] },
      });
    }

    // Resolve menu_ids + action permissions in the same shape the legacy
    // session map exposed (LoginAction.java lines 92–98). Frontend treats
    // menuIds as the sidebar allowlist and actionPermissions as the
    // button-gating Set.
    const { getEffectivePermissions } = require('../services/role.service');
    const { parseScope, bypassesScope, mergeScopeRespectingCap, expandStatesToCities } = require('../lib/scope');
    const { findDescendantUserIds, loadAllowedStages } = require('../services/user.service');
    const { pool } = require('../db');
    const permissions = await getEffectivePermissions(req.user.user_id);

    // Row-level RBAC scope — parsed from the user's `manage_*` CSV
    // columns + UNIONED with the scope of every direct/indirect report
    // (reporting hierarchy DFS via tbl_user.reporting_manager). A PM
    // sees their own assigned data PLUS the union of every downstream
    // report's assigned data. Bypass roles (Admin/Finance) get 'all'
    // across the board.
    const bypass = role && bypassesScope(role.role_name);
    let scope;
    let hierarchy = { directReports: [], descendants: [] };
    if (bypass) {
      scope = {
        clients:   { mode: 'all', ids: [] },
        cities:    { mode: 'all', ids: [] },
        states:    { mode: 'all', ids: [] },
        verticals: { mode: 'all', ids: [] },
      };
    } else {
      // Own scope
      scope = {
        clients:   parseScope(req.user.manage_clients),
        cities:    parseScope(req.user.manage_cities),
        states:    parseScope(req.user.manage_states),
        verticals: parseScope(req.user.manage_verticals),
      };
      // Union in every downstream report's scope
      hierarchy = await findDescendantUserIds(req.user.user_id);
      if (hierarchy.descendants.length > 0) {
        const placeholders = hierarchy.descendants.map(() => '?').join(',');
        const [rows] = await pool.query(
          `SELECT manage_clients, manage_cities, manage_states, manage_verticals
             FROM tbl_user WHERE user_id IN (${placeholders})`,
          hierarchy.descendants
        );
        // Cap each dimension at the caller's OWN explicit list. A direct
        // or indirect report with broader access must NOT widen the
        // manager's visibility on a dimension where they were
        // deliberately restricted (e.g. Priyanka with manage_clients
        // = "10,17" must stay scoped to those 2 clients even if one of
        // her reports has manage_clients = "0"). See
        // lib/scope.js::mergeScopeRespectingCap for the full rationale.
        for (const r of rows) {
          scope.clients   = mergeScopeRespectingCap(scope.clients,   parseScope(r.manage_clients));
          scope.cities    = mergeScopeRespectingCap(scope.cities,    parseScope(r.manage_cities));
          scope.states    = mergeScopeRespectingCap(scope.states,    parseScope(r.manage_states));
          scope.verticals = mergeScopeRespectingCap(scope.verticals, parseScope(r.manage_verticals));
        }
      }
    }

    // Manage Regions: mirror the API scope-build (lib/scope.js) — a user scoped
    // to specific Regions (states) gets ALL cities in those states as their
    // effective city scope, so the FE scope object matches what the jobs API
    // actually enforces. Bypass roles have states.mode='all' → no-op.
    if (scope.states && scope.states.mode === 'allow') {
      scope.cities = await expandStatesToCities(pool, scope.states);
    }

    // scheduledJobsAccess (2026-06-06): mirrors the same email-allowlist
    // check used by routes/admin/scheduled-jobs.js. The FE reads this
    // boolean to decide whether to render the "Scheduled Jobs" entry
    // at the bottom of the Settings sidebar. Default false — the
    // BE is the source of truth either way (the route 403s if the
    // FE ever sneaks in for an off-allowlist user).
    const sj = require('../services/scheduled-jobs.service');
    const scheduledJobsAccess = sj.isAllowedUser(req.user);

    // canManageJobCharges (2026-07-28): property-allowlist gate for the
    // Billing & Charges job-workspace tab. Same fail-closed model as
    // canBuildSkillMatrix — the FE reads this to show/hide the tab; every
    // mutating charges/documents route independently enforces the same
    // allowlist, so a forged flag buys nothing.
    const canManageJobCharges = emailAllowed(FEATURES.canManageJobCharges, req.user.official_email);

    /*
     * Job Stage Access — the FE gates its stage tabs + row actions off this.
     * Deliberately NOT subject to the Admin/Finance scope bypass: unlike
     * manage_* (a broad data-visibility default those roles are expected to
     * ignore), a stage grant is an explicit per-user setting an operator typed
     * into the Manage Users form, and silently ignoring it for the very roles
     * most likely to be edited made the picker look broken. No rows still means
     * { mode:'all' } = unrestricted, so every Admin is unrestricted by default
     * and Manage Users itself is never stage-gated — an over-restricted admin
     * is always recoverable from there. The BE enforces the same thing
     * regardless, so this is display-only.
     */
    const allowedStages = await loadAllowedStages(req.user.user_id);

    logger.info('Returning identity · bypassScope=' + !!bypass + ' menuIds=' + ((permissions && permissions.menuIds && permissions.menuIds.length) || 0) + ' directReports=' + hierarchy.directReports.length + ' descendants=' + hierarchy.descendants.length + ' scheduledJobsAccess=' + scheduledJobsAccess + ' allowedStages=' + (allowedStages.mode === 'all' ? 'all' : allowedStages.stages.join(',')));
    modernOk(res, {
      user: req.user,
      role: role && {
        role_id: role.role_id,
        role_name: role.role_name,
        group: role.group,
        active: role.role_status,
      },
      permissions,
      scope,
      hierarchy: {
        directReportsCount: hierarchy.directReports.length,
        descendantsCount: hierarchy.descendants.length,
      },
      scheduledJobsAccess,
      canManageJobCharges,
      allowedStages,
    });
  } catch (err) {
    next(err);
  }
});

/*
 * POST /api/auth/refresh
 * Issues a new JWT based on the currently valid one. Extends session.
 */
router.post('/refresh', requireAuth, (req, res) => {
  logger.info('Refresh token · user_id=' + (req.user && req.user.user_id));
  const token = signUserToken(req.user);
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  modernOk(res, { token });
});

/*
 * POST /api/auth/logout
 * Clears every known auth cookie. JWTs themselves stay valid until expiry
 * — stateless by design. Cookies cleared:
 *   `token`              — admin/CRM staff session
 *   `client_auth_token`  — SPOC session (current name, matches frontend localStorage key)
 *   `spocToken`          — SPOC session (legacy name, kept for rolling-deploy callers)
 * Frontends are still responsible for wiping their own localStorage tokens.
 */
router.post('/logout', (_req, res) => {
  logger.info('Logout · clearing auth cookies');
  res.clearCookie('token');
  res.clearCookie('client_auth_token');
  res.clearCookie('spocToken');
  modernOk(res, { loggedOut: true });
});

module.exports = router;
