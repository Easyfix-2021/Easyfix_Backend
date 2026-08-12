const { pool } = require('../db');
const logger = require('../logger');
const fcmService = require('./fcm.service');
const { MAX_OFFER_RECIPIENTS } = require('./job-offer-persistence.service');

/*
 * Push delivery — THE single token-resolve + fan-out + dead-token-prune layer.
 *
 * Consolidates logic that was cloned across job-offer-push, registration-status-push,
 * notice-push, and attendance-reminder-cron. Those services now only build their
 * message (title/body/data) and delegate the mechanical delivery here, so token
 * routing, the FCM send loop, and dead-token pruning live in ONE place.
 *
 * Token routing (per the dual-source contract every consumer already used):
 *   1. tbl_easyfixer_app.device_id  — the CANONICAL per-technician push target
 *      (one row per tech; legacy EasyFix_API targeted exactly this column).
 *   2. device_info.fire_base_token (is_logged_in='1', user_id = efr_id) — the
 *      token THIS Node backend writes on verify-otp / POST /mobile/device.
 *   Reading both keeps fan-out correct while some rows carry only one of them.
 *
 * Best-effort by contract: every function here swallows its own DB errors and
 * resolves — a push failure must NEVER break the request/write that triggered it.
 */

// Default cap for a bulk fan-out so a runaway publish can't open an unbounded
// number of FCM sockets in one tick.
const DEFAULT_RECIPIENT_LIMIT = 5000;
// Targeted offer fan-out is intentionally much smaller than a broadcast. This
// keeps the IN lists, token result set, and subsequent FCM work bounded by the
// same 50-technician ceiling enforced by the offer mutation.
const MAX_TARGETED_EFR_IDS = MAX_OFFER_RECIPIENTS;

function normalizeTargetEfrIds(efrIds) {
  if (!Array.isArray(efrIds)) return [];
  return Array.from(new Set(
    efrIds
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  )).sort((a, b) => a - b);
}

/*
 * Resolve tokens for an arbitrary bounded technician-id set with exactly two
 * set-based lookups (one per token store), independent of recipient count.
 * Either lookup may fail without discarding tokens returned by the other.
 * Tokens are globally deduped and retain the lowest matching efrId so dead-token
 * pruning stays safely scoped and deterministic even if stores contain drift.
 */
async function resolveTokensForEfrs(efrIds) {
  const ids = normalizeTargetEfrIds(efrIds);
  if (!ids.length) return [];
  if (ids.length > MAX_TARGETED_EFR_IDS) {
    logger.warn(
      { recipientCount: ids.length, limit: MAX_TARGETED_EFR_IDS },
      'push-delivery: targeted token lookup exceeds recipient limit',
    );
    return [];
  }

  const placeholders = ids.map(() => '?').join(', ');
  const appLookup = pool
    .query(
      `SELECT efr_id AS efrId, device_id AS token
         FROM tbl_easyfixer_app
        WHERE efr_id IN (${placeholders})
          AND device_id IS NOT NULL`,
      ids,
    )
    .then(([rows]) => rows)
    .catch((e) => {
      logger.warn({ err: e.message }, 'push-delivery: tbl_easyfixer_app bulk token lookup failed');
      return [];
    });
  const deviceLookup = pool
    .query(
      `SELECT user_id AS efrId, fire_base_token AS token
         FROM device_info
        WHERE user_id IN (${placeholders})
          AND is_logged_in = '1'
          AND fire_base_token IS NOT NULL`,
      ids,
    )
    .then(([rows]) => rows)
    .catch((e) => {
      logger.warn({ err: e.message }, 'push-delivery: device_info bulk token lookup failed');
      return [];
    });

  const [appRows, deviceRows] = await Promise.all([appLookup, deviceLookup]);
  const requestedIds = new Set(ids);
  const byToken = new Map();
  for (const row of [...appRows, ...deviceRows]) {
    const efrId = Number(row && row.efrId);
    const token = row && row.token ? String(row.token).trim() : '';
    if (!requestedIds.has(efrId) || !token) continue;
    const existing = byToken.get(token);
    if (!existing || efrId < existing.efrId) byToken.set(token, { efrId, token });
  }

  const recipients = Array.from(byToken.values()).sort(
    (a, b) => a.efrId - b.efrId || a.token.localeCompare(b.token),
  );
  logger.info(`Resolved ${recipients.length} targeted device token(s) for ${ids.length} technician(s)`);
  return recipients;
}

/*
 * Resolve the FCM tokens for ONE technician. Returns a deduped array of
 * non-empty token strings (union of both stores). Never throws — on a DB
 * error it logs and returns whatever was gathered (possibly []).
 */
async function resolveTokensForEfr(efrId) {
  const recipients = await resolveTokensForEfrs([efrId]);
  const tokens = recipients.map((recipient) => recipient.token);
  logger.info('Resolve FCM tokens · efr=' + efrId + ' → ' + tokens.length);
  return tokens;
}

/*
 * Resolve one FCM token PER verified-active technician in ONE query — the bulk
 * fan-out set (notice publish, attendance sweep). COALESCEs the canonical
 * tbl_easyfixer_app.device_id ahead of the newest active device_info token, so
 * at most one token per tech. Returns [{ efrId, token }] deduped by token, so
 * callers that want pruning still know which tech a dead token belongs to.
 * Never throws — on a DB error logs + returns [].
 */
async function resolveVerifiedTechnicianTokens({ limit = DEFAULT_RECIPIENT_LIMIT } = {}) {
  try {
    const [rows] = await pool.query(
      `SELECT e.efr_id AS efrId,
              COALESCE(
                a.device_id,
                (SELECT di.fire_base_token
                   FROM device_info di
                  WHERE di.user_id = e.efr_id
                    AND di.is_logged_in = '1'
                    AND di.fire_base_token IS NOT NULL
                  ORDER BY di.id DESC
                  LIMIT 1)
              ) AS token
         FROM tbl_easyfixer e
         LEFT JOIN tbl_easyfixer_app a ON a.efr_id = e.efr_id
        WHERE e.efr_status = 1
          AND COALESCE(e.is_technician_verified, 0) = 1
        LIMIT ?`,
      [limit],
    );
    const seen = new Set();
    const recipients = [];
    for (const r of rows) {
      const t = r.token ? String(r.token).trim() : '';
      if (!t || seen.has(t)) continue;
      seen.add(t);
      recipients.push({ efrId: r.efrId, token: t });
    }
    logger.info('Resolved ' + recipients.length + ' device tokens for verified-technician fan-out');
    return recipients;
  } catch (e) {
    logger.warn({ err: e.message }, 'push-delivery: verified-technician token resolution failed');
    return [];
  }
}

/*
 * Clear a token FCM reported as permanently dead (404 / UNREGISTERED) from BOTH
 * token stores so fan-out stops targeting it. Scoped to the technician so it
 * never touches another user's rows. `channel` only labels the log line so each
 * caller's prune trail stays greppable. Best-effort — never throws.
 */
async function pruneDeadToken(efrId, token, channel = 'push') {
  if (!efrId || !token) return;
  try {
    await pool.query(
      "UPDATE device_info SET fire_base_token = NULL, is_logged_in = '0' WHERE user_id = ? AND fire_base_token = ?",
      [efrId, token],
    );
    await pool.query(
      'UPDATE tbl_easyfixer_app SET device_id = NULL WHERE efr_id = ? AND device_id = ?',
      [efrId, token],
    );
    logger.push(`${channel} · pruned dead token · efr=${efrId}`);
  } catch (e) {
    logger.warn({ efrId, err: e.message }, 'push-delivery: dead-token prune failed');
  }
}

/*
 * Fan a single message out to a set of recipients.
 *   recipients : [{ efrId, token }]  (efrId null/absent => that token is never pruned)
 *   message    : { title, body, data }  (passed straight to fcmService.sendPush)
 *                PLUS the OPTIONAL loud/alerting style fields
 *                { androidChannelId, sound, iosSound, interruptionLevel } — extra
 *                fields on the SAME object, so no caller's signature changed and
 *                a caller that omits them gets the exact payload it always got.
 *   opts:
 *     concurrency : max sends in flight per batch (Infinity => one Promise.all).
 *                   Notice uses 10 (bounded chunks, chunks serial); per-tech
 *                   pushes use Infinity (a tech has very few tokens).
 *     prune       : prune FCM-reported dead tokens (default true). Notice sets
 *                   false to preserve its historical no-prune behavior.
 *     channel     : label for the prune log line.
 *     label/unit  : when label is set, emit one `logger.push(`${label} · d/n ${unit}`)`
 *                   summary — mirrors each caller's existing delivery log line.
 * Returns { delivered, deliveredCount, tokenCount }. Never throws.
 */
async function deliver(recipients, message, opts = {}) {
  const { concurrency = Infinity, prune = true, channel = 'push', label, unit = 'devices' } = opts;
  const list = Array.isArray(recipients) ? recipients.filter((r) => r && r.token) : [];
  const chunkSize = Number.isFinite(concurrency) && concurrency > 0 ? concurrency : (list.length || 1);

  // Optional loud/alerting style, forwarded verbatim to fcm.service. Collected
  // ONCE (not per token) and only for keys the caller actually set, so a normal
  // message spreads nothing and its FCM payload is unchanged.
  const alertStyle = {};
  if (message.androidChannelId)  alertStyle.androidChannelId  = message.androidChannelId;
  if (message.sound)             alertStyle.sound             = message.sound;
  if (message.iosSound)          alertStyle.iosSound          = message.iosSound;
  if (message.interruptionLevel) alertStyle.interruptionLevel = message.interruptionLevel;

  let deliveredCount = 0;
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const results = await Promise.all(
      chunk.map(async ({ efrId, token }) => {
        const r = await fcmService
          .sendPush({ token, title: message.title, body: message.body, data: message.data, ...alertStyle })
          .catch((e) => ({ delivered: false, error: e.message }));
        // Skip the prune when the send was redirected to a test device — the dead
        // signal is about the test token, not the real one.
        if (prune && efrId && r && r.deadToken && !r.redirected) {
          await pruneDeadToken(efrId, token, channel);
        }
        return r;
      }),
    );
    deliveredCount += results.filter((r) => r && r.delivered).length;
  }

  if (label) logger.push(`${label} · ${deliveredCount}/${list.length} ${unit}`);
  return { delivered: deliveredCount > 0, deliveredCount, tokenCount: list.length };
}

/*
 * Convenience: resolve ONE technician's tokens and deliver to all of them.
 * Returns deliver()'s shape, or { delivered:false, tokenCount:0, reason:'no tokens' }
 * when the tech has no device tokens (so callers can short-circuit exactly as before).
 */
async function deliverToEfr(efrId, message, opts = {}) {
  const tokens = await resolveTokensForEfr(efrId);
  if (!tokens.length) return { delivered: false, deliveredCount: 0, tokenCount: 0, reason: 'no tokens' };
  const recipients = tokens.map((token) => ({ efrId, token }));
  return deliver(recipients, message, opts);
}

module.exports = {
  MAX_TARGETED_EFR_IDS,
  normalizeTargetEfrIds,
  resolveTokensForEfrs,
  resolveTokensForEfr,
  resolveVerifiedTechnicianTokens,
  pruneDeadToken,
  deliver,
  deliverToEfr,
};
