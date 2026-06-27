/**
 * services/url-shortener.service.js
 *
 * In-house URL shortener.
 *
 *   shortenUrl(longUrl, opts?, pool)  — INSERT + return { short_code, short_url }
 *   resolveCode(code, pool)           — SELECT + return { longUrl, expired } | null
 *   recordClick(code, pool)           — fire-and-forget click counter bump
 *
 * Storage:        tbl_url_shortener (see migrations/2026-05-30-url-shortener.sql)
 * Code format:    8-char base62 ([0-9A-Za-z]) by default; column allows up to 16
 *                 chars for future prefixed/namespaced codes.
 * Base URL:       SHORT_URL_BASE (preferred), falls back to MAGIC_LINK_BASE_URL.
 *                 Resolved per-call so envs can flip the host without a restart.
 *
 * Style: CommonJS, parameterised SQL, mysql2/promise. `pool` is injected
 * (consistent with services/job-magic-link.service.js + the rest of services/*).
 */

const crypto = require('crypto');
const logger = require('../logger');

/**
 * Resolve the customer-visible base URL for short links.
 *
 * SHORT_URL_BASE wins when set so ops can host short links on a
 * dedicated short-domain in future (e.g. `https://efx.in`) without
 * touching the long-URL host. Falls back to MAGIC_LINK_BASE_URL so a
 * single-host deploy "just works" without extra config — short links
 * live on the same CRM_UI domain that already serves the magic-link
 * landing page.
 */
function resolveShortBase() {
  const base = process.env.SHORT_URL_BASE || process.env.MAGIC_LINK_BASE_URL || '';
  return base.replace(/\/$/, '');
}

/**
 * Base62 alphabet — no ambiguous chars filtered (8-char keyspace is
 * 62^8 ≈ 2.18e14; collisions are astronomically unlikely even without
 * filtering 0/O/l/1).
 */
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate `length` chars of base62 from cryptographically random bytes.
 *
 * We oversample by reading ceil(length * 1.5) bytes and indexing into
 * BASE62 via modulo. Modulo bias on a 62-mod is sub-1% per char which
 * is fine for ID generation (we're not generating crypto secrets here —
 * the URL itself is unguessable enough at 62^8).
 */
function generateShortCode(length = 8) {
  const bytes = crypto.randomBytes(Math.ceil(length * 1.5));
  let out = '';
  for (let i = 0; i < length; i++) {
    out += BASE62[bytes[i] % 62];
  }
  return out;
}

/**
 * Insert a fresh short link, return its short_code + the full short URL
 * the caller should embed in user-facing surfaces (WhatsApp body, etc.).
 *
 * Collision handling: PK is the random short_code. On the vanishingly
 * rare PK collision, MySQL throws ER_DUP_ENTRY and we retry with a fresh
 * code. Cap at 5 attempts so a misconfigured DB (unique constraint on
 * the wrong column, etc.) can't burn CPU in an infinite loop.
 *
 * opts:
 *   purpose    — short string tag, e.g. 'unconfirmed_book'. Used for audit +
 *                future cleanup-by-purpose queries.
 *   expiresAt  — Date | null. NULL means never expires (resolveCode
 *                will not flag it expired).
 *   createdBy  — tbl_user.user_id of the person who triggered creation.
 *                NULL for cron-triggered rows; FK is not enforced.
 */
async function shortenUrl(longUrl, opts = {}, pool) {
  if (!longUrl || typeof longUrl !== 'string') {
    throw new Error('shortenUrl: longUrl required');
  }
  const { purpose = null, expiresAt = null, createdBy = null } = opts;
  const base = resolveShortBase();

  logger.info('Shorten URL · purpose=' + (purpose || 'none') + ' · hasExpiry=' + !!expiresAt);

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateShortCode(8);
    try {
      await pool.query(
        `INSERT INTO tbl_url_shortener
           (short_code, long_url, purpose, expires_at, fk_created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [code, longUrl, purpose, expiresAt || null, createdBy || null],
      );
      // Flow-relevant short path under /public so the WhatsApp link reads for
      // its flow (e.g. /public/profile/<code> for a profile update, not the
      // generic /book/). The /public/* prefix also lets ops VPN-gate the CRM
      // while leaving every public link reachable. Resolution itself is
      // purpose-agnostic — the prefix only drives readability + the matching FE
      // resolver route (app/public/<flow>/[code]). Old /book/<code> links keep
      // working via the next.config back-compat redirect.
      const flow = /profile/i.test(purpose || '') ? 'profile' : 'book';
      const shortPath = `/public/${flow}/${code}`;
      logger.info('Short link created · code=' + code + ' · flow=' + flow);
      return {
        short_code: code,
        short_url: base ? `${base}${shortPath}` : shortPath,
      };
    } catch (err) {
      // ER_DUP_ENTRY = 1062. Retry with a fresh code. Anything else
      // bubbles to the caller (DB down, column type mismatch, etc.).
      if (err && err.code === 'ER_DUP_ENTRY') {
        logger.warn({ attempt, code }, 'url-shortener: short_code collision — retrying');
        continue;
      }
      throw err;
    }
  }
  logger.error('Short link creation failed · exhausted retries generating unique short_code');
  throw new Error('url-shortener: exhausted retries generating a unique short_code');
}

/**
 * Look up the long URL for a short code.
 *
 * Returns `null` if no row exists (caller should 404).
 * Returns `{ longUrl, expired }` if the row exists; `expired = true`
 * when expires_at is non-null AND in the past. Computed in JS (not in
 * the SQL WHERE) so the PK lookup stays index-only — the caller
 * decides whether to redirect or render the expired-link page.
 */
async function resolveCode(code, pool) {
  logger.info('Resolve short code · code=' + code);
  const [rows] = await pool.query(
    `SELECT long_url, expires_at
       FROM tbl_url_shortener
      WHERE short_code = ?
      LIMIT 1`,
    [code],
  );
  if (!rows || rows.length === 0) {
    logger.warn('Short code not found · code=' + code);
    return null;
  }
  const row = rows[0];
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  const expired = !!(expiresAt && expiresAt.getTime() < Date.now());
  logger.info('Short code resolved · code=' + code + ' · expired=' + expired);
  return {
    longUrl: row.long_url,
    expired,
  };
}

/**
 * Bump click_count + last_clicked_at — fire-and-forget.
 *
 * Wrapped in setImmediate so the redirect response is sent before the
 * UPDATE runs; the customer's browser never waits on this write.
 * Errors are logged at debug and swallowed — we never block a
 * legitimate redirect on an analytics write failing.
 */
function recordClick(code, pool) {
  logger.info('Record short-link click · code=' + code);
  setImmediate(() => {
    pool.query(
      `UPDATE tbl_url_shortener
          SET click_count     = click_count + 1,
              last_clicked_at = NOW()
        WHERE short_code = ?`,
      [code],
    ).catch((err) => {
      logger.debug({ code, err: err && err.message }, 'url-shortener: recordClick UPDATE failed (non-fatal)');
    });
  });
}

module.exports = {
  shortenUrl,
  resolveCode,
  recordClick,
};
