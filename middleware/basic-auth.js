const crypto = require('crypto');
const { pool } = require('../db');
const logger = require('../logger');
const { legacyError } = require('../utils/response');

/*
 * HTTP Basic Auth against tbl_client_website for /api/integration/v1/*.
 * Legacy Dropwizard used @RolesAllowed per method — here we only authenticate;
 * role-style checks (who can POST jobs vs. just read) can layer on later.
 */
module.exports = async function basicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="EasyFix API"');
    return legacyError(res, 401, 'Unauthorized');
  }
  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':', 2);
  if (!user || !pass) return legacyError(res, 401, 'Unauthorized');

  const row = await findCredential(user);

  /*
   * Password compared in Node (timing-safe) rather than in SQL — keeps the
   * secret out of the query text (no slow-query / error-log leak) and avoids
   * the DB's non-constant-time string comparison.
   *
   * Storage stays PLAINTEXT, deliberately. The legacy Dropwizard :8090 service
   * still serves /v1/* during coexistence (confirmed 2026-06-12) and does a
   * plaintext String.equals() against this same tbl_client_website.login_password
   * column. Hashing it now would (a) break legacy auth for every integration
   * partner and (b) buy no real security — a dump of this shared table exposes
   * the plaintext regardless of any hash column sitting beside it.
   *
   * ─── DECOMMISSION RUNBOOK (do this when, and only when, legacy /v1/* is fully
   *     cut over to this backend and the Dropwizard service is retired) ───
   *   1. Add `login_password_hash VARCHAR(100) NULL` to tbl_client_website
   *      (new migration file; the shared-schema rule is lifted once no legacy
   *      service reads the table).
   *   2. Add bcryptjs; on each successful plaintext login, lazily backfill the
   *      hash. After a coexistence window, every ACTIVE partner has a hash.
   *   3. Switch this compare to: verify against login_password_hash if present,
   *      else plaintext + backfill. Then NULL/drop login_password.
   * Until step 1's precondition holds, leave this exactly as it is.
   */
  const supplied = Buffer.from(String(pass), 'utf8');
  const stored = Buffer.from(String(row?.login_password ?? ''), 'utf8');
  const ok = !!row && supplied.length === stored.length && crypto.timingSafeEqual(supplied, stored);
  if (!ok) return legacyError(res, 401, 'Invalid credentials');

  req.integrationClient = {
    id: row.client_id,
    name: row.client_name || null,
    loginName: row.login_name,
    loginId: row.login_id,
    // When the credential came from tbl_client_user the role arrived on the
    // same row — legacy read both from that one table. Only the fallback
    // store needs the extra lookup.
    role: row.role_name ?? (await resolveLegacyRole(row.login_name)),
  };
  logger.info('Integration auth OK · login=' + row.login_name + ' · client=' + row.client_id
    + ' · via=' + row.source + ' · role=' + (row.role_name || 'unresolved'));
  next();
};

/*
 * Find an integration credential, preferring the store BOTH legacy services
 * used.
 *
 * ─── Why two stores ──────────────────────────────────────────────────────
 *
 * The legacy Dropwizard /v1 API (EasyFix_API EasyFixAuthenticator →
 * ClientLogin → tbl_client_user) and the legacy webhook relay (Webhook_2023
 * auth.controller.js, same table) BOTH authenticate against tbl_client_user.
 * This backend originally read tbl_client_website instead — a different table
 * with a different population. Measured on QA: ~250 logins live in
 * tbl_client_website, of which only two also exist in tbl_client_user. So a
 * partner provisioned for legacy simply did not exist to this backend, and
 * got a 401 on credentials that worked yesterday.
 *
 * tbl_client_user is therefore tried FIRST — it is the store the migrated
 * /v1 contract was written against, and matching it is the whole point of
 * the no-client-change rule.
 *
 * tbl_client_website is kept as a FALLBACK rather than dropped: it is what
 * this backend has been accepting, and silently invalidating those logins
 * would trade one outage for another. A login present in both resolves from
 * tbl_client_user, so legacy wins any disagreement — which is the correct
 * precedence while legacy is still serving traffic.
 *
 * ─── One real difference, deliberately preserved ─────────────────────────
 *
 * tbl_client_website has a `status` column and we gate on `status = 1`.
 * tbl_client_user has no such column, so a legacy credential cannot be
 * disabled by flipping a flag — it has to be removed. That is legacy's own
 * behaviour and changing it here would mean this backend refusing logins the
 * legacy service still honours. Flagged rather than fixed.
 */
async function findCredential(loginName) {
  try {
    const [[legacyRow]] = await pool.query(
      `SELECT cu.id             AS login_id,
              cu.fk_client_id   AS client_id,
              cu.user_name      AS login_name,
              cu.password       AS login_password,
              cr.role_name      AS role_name,
              c.client_name     AS client_name
         FROM tbl_client_user cu
         LEFT JOIN tbl_client_role cr ON cr.role_id  = cu.fk_role_id
         LEFT JOIN tbl_client      c  ON c.client_id = cu.fk_client_id
        WHERE cu.user_name = ?
        LIMIT 1`,
      [loginName]
    );
    if (legacyRow) return { ...legacyRow, source: 'tbl_client_user' };
  } catch (err) {
    // A deploy without the legacy tables must fall through to the store this
    // backend owns, not 500 every integration request.
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }

  // Pull client_name in the same query — Decathlon-only branches in
  // /v1/easyfixers/availability-status-check gate on the literal name.
  const [[row]] = await pool.query(
    `SELECT cw.client_login_id AS login_id, cw.client_id, cw.login_name,
            cw.login_password, c.client_name
       FROM tbl_client_website cw
       LEFT JOIN tbl_client c ON c.client_id = cw.client_id
      WHERE cw.login_name = ? AND cw.status = 1
      LIMIT 1`,
    [loginName]
  );
  return row ? { ...row, role_name: null, source: 'tbl_client_website' } : null;
}

/*
 * The caller's LEGACY role name, or null.
 *
 * ─── Why this needs its own lookup ───────────────────────────────────────
 *
 * This runs ONLY for the tbl_client_website fallback. A credential resolved
 * from tbl_client_user already carried its role on the same row (see the ??
 * at the call site), because legacy read both from that one table.
 *
 * tbl_client_website has no role column, and the role decides which response
 * shape GET /v1/services returns — "website" gets the nested category tree,
 * "client" gets a flat list. Partners parse one or the other, so for a
 * fallback credential the role has to be recovered from outside the table it
 * authenticated against.
 *
 * Matched on login_name = user_name ONLY — deliberately not falling back to
 * the client id. Legacy authenticated against tbl_client_user by username, so
 * the username IS the principal whose role decided the response shape. A
 * client-id match would borrow some other login's role, and one client can
 * hold several logins with different ones.
 *
 * Measured against QA (2026-08-14): of 250+ enabled logins in
 * tbl_client_website, exactly two have a matching tbl_client_user row —
 * `Decathlon` and `retail`, both role "website". That is expected rather than
 * alarming: legacy could only ever authenticate logins present in
 * tbl_client_user, so those two are the entire historical /v1 population.
 * Every other login resolves to null and therefore takes the documented
 * default shape, which is correct for a caller with no legacy expectation.
 *
 * Returns null — never throws — when the legacy tables are absent (a deploy
 * that never had them) or nothing matches. Callers decide the default; a
 * missing role must not be able to 500 an endpoint that only needs it to
 * pick a JSON shape.
 */
async function resolveLegacyRole(loginName) {
  try {
    const [[row]] = await pool.query(
      `SELECT cr.role_name
         FROM tbl_client_user cu
         JOIN tbl_client_role cr ON cr.role_id = cu.fk_role_id
        WHERE cu.user_name = ?
        LIMIT 1`,
      [loginName]
    );
    return row?.role_name || null;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return null;
    throw err;
  }
}
