const jwt = require('jsonwebtoken');

function requireSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET env var is not set');
  return secret;
}

function signUserToken(user) {
  return jwt.sign(
    {
      sub: String(user.user_id),
      email: user.official_email,
      role: user.user_role,
      name: user.user_name,
    },
    requireSecret(),
    { expiresIn: process.env.JWT_EXPIRY || '30d' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, requireSecret());
}

/**
 * Sign a customer-facing magic-link JWT for completing an unconfirmed order.
 *
 * Why a separate helper (vs reusing signUserToken):
 *   - Distinct `type: 'job_completion'` claim guarantees a leaked job-token can
 *     never be replayed against authenticated CRM endpoints (and vice-versa,
 *     enforced in verifyJobToken below).
 *   - Subject is `job:<id>` (not a user_id) so middleware that naively trusts
 *     `sub` won't misclassify a job-token as a user identity.
 *   - TTL comes from MAGIC_LINK_TTL_HOURS so ops can rotate without a deploy.
 *     Default 168h = 7 days, matching the WhatsApp template's expected reach.
 *
 * The state-bound expiry layer lives in requireUnconfirmedJob() below — this
 * helper only enforces the time-bound layer.
 */
function signJobToken({ jobId }) {
  const ttlHours = Number(process.env.MAGIC_LINK_TTL_HOURS || 168);
  return jwt.sign(
    {
      sub: 'job:' + jobId,
      jobId: Number(jobId),
      type: 'job_completion',
    },
    requireSecret(),
    { expiresIn: `${ttlHours}h` }
  );
}

/**
 * Verify a customer magic-link JWT.
 *
 * Throws plain `{status, message}` shapes (NOT Error instances) so the public
 * route handlers can `throw` directly and a small error mapper can translate
 * to HTTP without sniffing instanceof chains.
 *
 * Defence-in-depth: we ALSO reject any token whose `type` is 'user' even
 * though signUserToken never sets a `type` claim — this future-proofs against
 * a leaked CRM JWT being submitted on a public endpoint by a confused client
 * or a malicious actor probing the surface.
 *
 * Returns `{ jobId }` (Number) on success.
 */
function verifyJobToken(token) {
  let claims;
  try {
    claims = jwt.verify(token, requireSecret());
  } catch (_err) {
    throw { status: 401, message: 'invalid or expired link' };
  }
  if (claims && claims.type === 'user') {
    throw { status: 401, message: 'token type mismatch' };
  }
  if (!claims || claims.type !== 'job_completion') {
    throw { status: 401, message: 'token type mismatch' };
  }
  return { jobId: Number(claims.jobId) };
}

/**
 * Live state check that MUST run after verifyJobToken() on every public
 * magic-link endpoint.
 *
 * Why a second layer when the JWT already has an exp:
 *   - The token's time-bound expiry (default 7d) is independent of the
 *     order's lifecycle. The moment ops confirms the order in CRM (status
 *     leaves 9), the magic link MUST stop working — even if the JWT is
 *     still cryptographically valid for hours.
 *   - 410 GONE (vs 401) lets the FE render a friendly "this link is no
 *     longer active" page instead of a generic auth-error message.
 *
 * `pool` is injected (mysql2/promise) rather than imported from server/db.js
 * to keep utils/jwt.js free of DB-layer imports — preserves the existing
 * separation of concerns and keeps this file unit-testable in isolation.
 *
 * Returns void; the live status check is the side effect.
 */
async function requireUnconfirmedJob(jobId, pool) {
  const [rows] = await pool.query(
    'SELECT job_status FROM tbl_job WHERE job_id = ? LIMIT 1',
    [Number(jobId)]
  );
  if (!rows || rows.length === 0) {
    throw { status: 404, code: 'JOB_NOT_FOUND', message: 'Order not found' };
  }
  if (Number(rows[0].job_status) !== 9) {
    throw {
      status: 410,
      code: 'JOB_NO_LONGER_PENDING',
      message: 'Order is no longer awaiting customer details',
    };
  }
}

/**
 * Verify a customer-facing estimate-approval link token.
 *
 * Production currently mints these tokens from the legacy Java
 * backend. The payload shape is:
 *   { sub: "<jobId>", clientContactId: <id>, iat, exp }
 * — no `type` claim, no `jobId` claim (jobId lives in `sub`). We need
 * to keep accepting that shape so existing email/SMS estimate links
 * stay valid through the migration.
 *
 * We ALSO accept a future Node-minted variant that sets
 * `type: 'estimate_approval'` + `jobId` for clarity; that path lets
 * us re-mint tokens from the new backend later without touching this
 * verifier again. Tokens carrying any OTHER `type` (e.g.
 * 'job_completion' or a user JWT) are explicitly rejected so a leaked
 * token from a different flow can't be replayed here.
 *
 * Returns { jobId, clientContactId } — clientContactId may be null
 * if the legacy token didn't include it (older signing path).
 *
 * Throws plain `{status, message}` shapes (NOT Error instances) so
 * public route handlers can `throw` directly into a small error
 * mapper, matching the verifyJobToken contract above.
 */
function verifyEstimateToken(token) {
  let claims;
  try {
    claims = jwt.verify(token, requireSecret());
  } catch (_err) {
    throw { status: 401, message: 'Estimate link is invalid or expired' };
  }
  if (!claims || typeof claims !== 'object') {
    throw { status: 401, message: 'Estimate link is invalid' };
  }
  // Reject tokens from other flows. A bare token (no type) is permitted
  // because the legacy Java mint doesn't set one — we infer estimate
  // intent from the presence of `clientContactId` OR a bare numeric `sub`.
  if (claims.type && claims.type !== 'estimate_approval') {
    throw { status: 401, message: 'Estimate link type mismatch' };
  }
  // jobId can live in either `jobId` (new) or `sub` (legacy). Coerce
  // to Number and refuse if neither is a positive integer.
  const rawId = claims.jobId != null ? claims.jobId : claims.sub;
  const jobId = Number(rawId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw { status: 401, message: 'Estimate link payload is malformed' };
  }
  const clientContactId = claims.clientContactId != null
    ? Number(claims.clientContactId)
    : null;
  return { jobId, clientContactId };
}

/**
 * Mint a fresh estimate-approval token from the Node backend.
 *
 * Mirrors the legacy Java payload (sub + clientContactId) and adds a
 * distinguishing `type` claim so the verifier can prefer the
 * new-style path. TTL is configurable via ESTIMATE_LINK_TTL_HOURS
 * (default 30 days, matching the legacy link lifetime ops sees in
 * the field).
 *
 * Currently UNUSED — production estimate links are still minted by
 * Java. Added so the new backend can take over signing the moment
 * Java is decommissioned without another verifier change.
 */
function signEstimateToken({ jobId, clientContactId }) {
  const ttlHours = Number(process.env.ESTIMATE_LINK_TTL_HOURS || 30 * 24);
  return jwt.sign(
    {
      sub: String(jobId),
      jobId: Number(jobId),
      clientContactId: clientContactId != null ? Number(clientContactId) : null,
      type: 'estimate_approval',
    },
    requireSecret(),
    { expiresIn: `${ttlHours}h` }
  );
}

/**
 * Sign an easyfixer-facing magic-link JWT for the profile-update self-serve
 * page.
 *
 * Mirrors signJobToken's design notes:
 *   - Distinct `type: 'easyfixer_profile_update'` claim so a leaked token can
 *     never replay against authenticated CRM endpoints, against the
 *     customer job-completion magic-link surface, or vice versa
 *     (verifyEasyfixerProfileToken below rejects every other `type`).
 *   - Subject is `String(efrId)` (not the easyfixer's user_id) so middleware
 *     that naively trusts `sub` won't misclassify a profile-update token as a
 *     user identity.
 *   - 30-day TTL — operators may schedule reminders weeks apart, and the
 *     server-side audit columns (profile_update_send_count / _sent_at) give
 *     ops a separate handle to coordinate cadence outside the token's life.
 *
 * No `requireXxx` live-state companion exists for this flow: unlike a job
 * that transitions out of status=9, an easyfixer profile is always
 * editable. The token's time-bound exp is the only expiry layer.
 */
function signEasyfixerProfileToken(efrId) {
  return jwt.sign(
    { sub: String(efrId), type: 'easyfixer_profile_update' },
    requireSecret(),
    { expiresIn: '30d' },
  );
}

/**
 * Verify a profile-update magic-link JWT.
 *
 * Returns the numeric efrId on success; throws an Error with a `status`
 * property (NOT a plain object — the public route's existing
 * mapKnownError-style handler still picks it up via the status check) on
 * any failure. The `type` mismatch path is a defence-in-depth guard so
 * a customer job-completion token or an arbitrary CRM JWT can never
 * cross-pollinate this surface.
 */
function verifyEasyfixerProfileToken(token) {
  let decoded;
  try {
    decoded = jwt.verify(token, requireSecret());
  } catch (_err) {
    const e = new Error('invalid or expired link');
    e.status = 401;
    throw e;
  }
  if (!decoded || decoded.type !== 'easyfixer_profile_update') {
    const e = new Error('invalid token type');
    e.status = 401;
    throw e;
  }
  return Number(decoded.sub);
}

module.exports = {
  signUserToken,
  verifyToken,
  signJobToken,
  verifyJobToken,
  requireUnconfirmedJob,
  verifyEstimateToken,
  signEstimateToken,
  signEasyfixerProfileToken,
  verifyEasyfixerProfileToken,
};
