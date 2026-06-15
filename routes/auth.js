const router = require('express').Router();

const validate = require('../middleware/validate');
const requireAuth = require('../middleware/auth');
const { loginOtpRequest, verifyOtpRequest } = require('../validators/auth.validator');
const { createLoginOtp, verifyLoginOtp } = require('../services/auth.service');
const { getRoleById } = require('../services/role.service');
const { signUserToken } = require('../utils/jwt');
const { modernOk, modernError } = require('../utils/response');

/*
 * POST /api/auth/login
 *
 * tbl_user has no password column. Legacy EasyFix_CRM uses Microsoft Azure AD
 * OAuth instead of email+password. Until that path is wired up (or a password
 * column is added intentionally), this endpoint refuses with 501 so clients
 * can clearly route to /login-otp.
 */
router.post('/login', (_req, res) => {
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
    const result = await createLoginOtp(identifier);
    if (!result.found) {
      return modernError(
        res,
        404,
        'This account is not registered in the CRM. Please check the email / mobile or contact your admin.'
      );
    }
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
    const result = await verifyLoginOtp(identifier, otp);

    if (!result.ok) {
      const map = {
        USER_NOT_FOUND: [401, 'invalid credentials'],
        NO_OTP_ISSUED: [400, 'no active OTP — request one first'],
        OTP_EXPIRED:   [401, 'OTP expired — request a new one'],
        OTP_MISMATCH:  [401, 'incorrect OTP'],
      };
      const [status, message] = map[result.reason] || [401, 'authentication failed'];
      return modernError(res, status, message);
    }

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
    const role = await getRoleById(req.user.user_role);
    // Resolve menu_ids + action permissions in the same shape the legacy
    // session map exposed (LoginAction.java lines 92–98). Frontend treats
    // menuIds as the sidebar allowlist and actionPermissions as the
    // button-gating Set.
    const { getEffectivePermissions } = require('../services/role.service');
    const { parseScope, bypassesScope, mergeScopeRespectingCap } = require('../lib/scope');
    const { findDescendantUserIds } = require('../services/user.service');
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
  res.clearCookie('token');
  res.clearCookie('client_auth_token');
  res.clearCookie('spocToken');
  modernOk(res, { loggedOut: true });
});

module.exports = router;
