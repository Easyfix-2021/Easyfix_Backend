/*
 * QuickSight session-bridge token.
 *
 * Legacy CRM workflow (preserved 1:1):
 *   1. Operator clicks "QuickSight" in the page header.
 *   2. CRM backend generates a short-lived JWT with:
 *        - session_proof : random hex string (proof of an active CRM session)
 *        - user_id       : the operator's official email
 *        - exp           : iat + 1 hour
 *      signed HS256 with a shared secret QUICKSIGHT_JWT_SECRET (the same
 *      secret the EF-QuickSight Angular app's backend uses to verify).
 *   3. CRM redirects (or opens new tab) to:
 *        {QUICKSIGHT_BASE_URL}/EF-QuickSight/openOrders/{jwt}
 *   4. The QuickSight app's HTTP interceptor reads the JWT from the URL
 *      path, stores it in sessionStorage, and uses it as the bearer
 *      token on all subsequent API calls. The session_proof claim is
 *      what enforces "same logged-in session only" — pasting the URL
 *      in another browser that doesn't have the same session_proof
 *      bound on the CRM side fails verification.
 *
 * That's why the URL the user shared has the JWT directly in the path:
 *   /EF-QuickSight/openOrders/eyJhbGciOiJIUzI1NiJ9.eyJzZXNzaW9uX3Byb29mIjoi...
 *
 * IMPORTANT: this endpoint is permission-gated (`ef-QuickSight` action
 * key on the Home menu). Role middleware on the parent admin router
 * already enforces auth + group; we add the action check inline.
 */

const router = require('express').Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { modernOk, modernError } = require('../../../utils/response');
const { getEffectivePermissions } = require('../../../services/role.service');
const logger = require('../../../logger');

/*
 * Build the QuickSight session-bridge JWT for the current user.
 *
 * Returns:
 *   {
 *     token: "eyJhbGc...",
 *     baseUrl: "https://uat.easyfix.in" | "https://corporates.core.easyfix.in",
 *     fullUrl: "{baseUrl}/EF-QuickSight/openOrders/{token}"
 *   }
 *
 * Frontend can either:
 *   - open fullUrl directly (simplest)
 *   - OR build it itself from the env-specific NEXT_PUBLIC_*_QUICKSIGHT_URL
 *     and just append the token (gives the frontend more control if
 *     it wants to switch tabs / pop up / iframe).
 *
 * The session_proof is a fresh 32-byte hex string per call. Legacy CRM
 * stored this in a server-side session table for the QuickSight backend
 * to validate against. We mirror that by storing it in a short-TTL
 * in-memory map (`recentSessionProofs`) keyed by user_id — if a
 * /admin/quicksight/verify endpoint is ever needed by the QuickSight
 * app, it can hit this service to confirm the session_proof is live.
 * (Today the QuickSight Angular app trusts the JWT signature alone,
 * which is sufficient because the shared secret stays server-side.)
 */
const SESSION_PROOF_TTL_MS = 60 * 60 * 1000;            // 1 hour, matches JWT exp
const recentSessionProofs = new Map(); // user_id -> { proof, expires }

function pruneExpired() {
  const now = Date.now();
  for (const [k, v] of recentSessionProofs) {
    if (v.expires < now) recentSessionProofs.delete(k);
  }
}

router.get('/token', async (req, res, next) => {
  try {
    // Action-permission gate. Without this, any admin-group role could
    // mint a QuickSight token even if Manage Roles revoked their
    // ef-QuickSight access.
    const perms = await getEffectivePermissions(req.user.user_id);
    if (!perms.actionPermissions.includes('ef-QuickSight')) {
      return modernError(res, 403, 'You do not have QuickSight access');
    }

    const secret = process.env.QUICKSIGHT_JWT_SECRET;
    if (!secret) {
      // Surfaced as a 503 so the frontend can show a "QuickSight not
      // configured" toast instead of a generic crash.
      return modernError(res, 503, 'QuickSight is not configured (QUICKSIGHT_JWT_SECRET missing)');
    }

    const userEmail = req.user.official_email;
    if (!userEmail) {
      return modernError(res, 400, 'Current user has no email — QuickSight requires an email-keyed session_proof');
    }

    pruneExpired();
    const sessionProof = crypto.randomBytes(16).toString('hex');     // 32 hex chars, matches legacy
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      session_proof: sessionProof,
      user_id: userEmail,
      iat: now,
      exp: now + 3600,
    };
    // HS256 explicitly — same alg the legacy JWTs use (header is
    // `{"alg":"HS256"}` in the user-shared examples).
    const token = jwt.sign(payload, secret, { algorithm: 'HS256', noTimestamp: true });

    // Diagnostic logging — was added after an "Access Denied" was
    // observed on uat.easyfix.in/access-denied when the operator
    // clicked QuickSight. Possible causes:
    //   1) The shared secret here doesn't match the QuickSight
    //      backend's verifier secret → signature check fails.
    //   2) The operator's email isn't whitelisted in the QuickSight
    //      app's allowed-users list.
    //   3) The session_proof handshake (if QuickSight calls back to
    //      /admin/quicksight/verify) isn't wired yet.
    //
    // Log just the payload claims + the FIRST 16 chars of the token
    // (never the full token — that's a credential). With this log,
    // an ops engineer can copy the printed token from the dev server
    // logs, paste it into jwt.io with the known-good secret, and
    // confirm whether the signature is the rejection cause.
    logger.info({
      who: userEmail,
      tokenPreview: token.slice(0, 16) + '…',
      claims: { user_id: userEmail, exp: payload.exp },
      secretLen: secret.length,
    }, 'QuickSight token minted');

    recentSessionProofs.set(userEmail, {
      proof: sessionProof,
      expires: Date.now() + SESSION_PROOF_TTL_MS,
    });

    // Base URL is chosen by env. Backend doesn't strictly need to know
    // it — the frontend has the NEXT_PUBLIC_*_QUICKSIGHT_URL pair. We
    // still return one as a convenience so server-side callers (e.g.
    // future ops scripts) can use the endpoint without duplicating the
    // env detection logic.
    const envName = process.env.NODE_ENV === 'production' ? 'prod' : 'qa';
    const baseUrl = envName === 'prod'
      ? (process.env.QUICKSIGHT_PROD_URL || '')
      : (process.env.QUICKSIGHT_QA_URL   || '');
    const fullUrl = baseUrl
      ? `${baseUrl.replace(/\/+$/, '')}/EF-QuickSight/openOrders/${token}`
      : null;

    return modernOk(res, { token, baseUrl, fullUrl, env: envName });
  } catch (e) { next(e); }
});

module.exports = router;
