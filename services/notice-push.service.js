const { pool } = require('../db');
const logger = require('../logger');
const fcmService = require('./fcm.service');

/*
 * Notice push — fans out an FCM data-push to every verified-active
 * technician whenever a notice targeting the 'technician' surface
 * transitions to `published` (publish-now; scheduled/future notices are
 * not pushed here — see notice.service.js). The RN app's bell screen
 * listens for a push whose data payload is { type: "notice" } and can
 * deep-link / refetch its active-notice feed on receipt.
 *
 * Token resolution mirrors registration-status-push.service.js — TWO
 * sources, unioned + deduped per technician:
 *   1. tbl_easyfixer_app.device_id — the CANONICAL per-technician push
 *      target (one row per tech).
 *   2. device_info.fire_base_token (is_logged_in='1') — the token THIS
 *      Node backend writes on verify-otp / POST /mobile/device, keyed by
 *      user_id = efr_id for technicians.
 *
 * Recipient set = tbl_easyfixer WHERE efr_status=1 AND
 * COALESCE(is_technician_verified,0)=1 — the same predicate
 * notice.service.getSurfaceReachMap() uses for the 'technician' surface.
 *
 * Best-effort by contract: the single public function swallows ALL its
 * own errors and resolves — a push failure must NEVER break publishing a
 * notice or the HTTP response that triggered it.
 */

// Cap the fan-out so a runaway/misconfigured publish can't open an
// unbounded number of FCM sockets in one tick. Technicians number in the
// low thousands today; this guards the pathological case.
const MAX_RECIPIENTS = 5000;
// Send in bounded chunks so a large fan-out doesn't open thousands of
// sockets at once — each chunk's sends run concurrently, chunks serially.
const CHUNK_SIZE = 10;
const BODY_MAX_CHARS = 140;

/*
 * Reduce a stored notice body to a short, plain-text push excerpt.
 * Notice bodies are author-entered rich-ish text; strip any tags,
 * collapse whitespace, and trim to ~140 chars with an ellipsis.
 */
function bodyExcerpt(raw) {
  if (!raw) return '';
  const plain = String(raw)
    .replace(/<[^>]*>/g, ' ')   // drop any HTML tags
    .replace(/\s+/g, ' ')       // collapse whitespace/newlines
    .trim();
  if (plain.length <= BODY_MAX_CHARS) return plain;
  return `${plain.slice(0, BODY_MAX_CHARS - 1).trimEnd()}…`;
}

/*
 * Resolve every recipient's FCM token in ONE query. We LEFT JOIN both
 * token stores onto the verified-active technician set and COALESCE the
 * canonical tbl_easyfixer_app.device_id ahead of the latest active
 * device_info.fire_base_token. A correlated subquery picks the newest
 * logged-in device_info token per technician so we union at most one
 * fallback token per row. Tokens are deduped + emptied-skipped in JS.
 *
 * Never throws — on any DB error logs + returns [].
 */
async function resolveRecipientTokens() {
  try {
    const [rows] = await pool.query(
      `SELECT COALESCE(
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
      [MAX_RECIPIENTS],
    );
    const tokens = new Set();
    for (const r of rows) {
      const t = r.token ? String(r.token).trim() : '';
      if (t) tokens.add(t);
    }
    return Array.from(tokens);
  } catch (e) {
    logger.warn({ err: e.message }, 'notice-push: recipient token resolution failed');
    return [];
  }
}

/*
 * Push a published notice to all verified-active technicians. Accepts the
 * full notice row (as returned by notice.service.getNoticeById) — needs
 * `notice_id`, `title`, `body`. Fire-and-forget: returns a summary
 * object, never rejects.
 */
async function pushNoticeToTechnicians(notice) {
  try {
    if (!notice || notice.notice_id == null) {
      return { delivered: false, reason: 'no notice' };
    }

    const tokens = await resolveRecipientTokens();
    if (!tokens.length) {
      logger.info({ noticeId: notice.notice_id }, 'notice-push: no device tokens — skipping');
      return { delivered: false, reason: 'no tokens', recipients: 0 };
    }

    const title = notice.title || 'EasyFix';
    const body = bodyExcerpt(notice.body);
    const data = { type: 'notice', noticeId: String(notice.notice_id) };

    let delivered = 0;
    // Bounded concurrency — process tokens in fixed-size chunks; the
    // sends within a chunk run together, chunks run one after another.
    for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
      const chunk = tokens.slice(i, i + CHUNK_SIZE);
      const results = await Promise.all(
        chunk.map((token) => fcmService
          .sendPush({ token, title, body, data })
          .catch((e) => ({ delivered: false, error: e.message }))),
      );
      delivered += results.filter((r) => r && r.delivered).length;
    }

    logger.push(`notice · noticeId=${notice.notice_id} · ${delivered}/${tokens.length} recipients`);
    return { delivered: delivered > 0, deliveredCount: delivered, recipients: tokens.length };
  } catch (e) {
    // Absolute backstop — called best-effort from notice publish/create
    // and must never throw into the caller.
    logger.warn({ noticeId: notice && notice.notice_id, err: e.message }, 'notice-push: push failed (swallowed)');
    return { delivered: false, error: e.message };
  }
}

module.exports = {
  pushNoticeToTechnicians,
  resolveRecipientTokens,
};
