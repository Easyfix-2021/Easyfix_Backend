const logger = require('../logger');
const pushDelivery = require('./push-delivery.service');

/*
 * Notice push — fans out an FCM data-push to every verified-active
 * technician whenever a notice targeting the 'technician' surface
 * transitions to `published` (publish-now; scheduled/future notices are
 * not pushed here — see notice.service.js). The RN app's bell screen
 * listens for a push whose data payload is { type: "notice" } and can
 * deep-link / refetch its active-notice feed on receipt.
 *
 * Recipient resolution + the send loop live in push-delivery.service.js (the
 * one shared delivery layer). Notice historically does NOT prune dead tokens
 * on a broadcast, so it passes prune:false — the per-tech offer/registration
 * pushes carry the prune responsibility instead.
 *
 * Best-effort by contract: swallows ALL its own errors and resolves — a push
 * failure must NEVER break publishing a notice.
 */

// Cap the fan-out so a runaway/misconfigured publish can't open an unbounded
// number of FCM sockets in one tick.
const MAX_RECIPIENTS = 5000;
// Send in bounded chunks so a large fan-out doesn't open thousands of sockets
// at once — each chunk's sends run concurrently, chunks serially.
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

    logger.info('Push notice to technicians · noticeId=' + notice.notice_id);
    const recipients = await pushDelivery.resolveVerifiedTechnicianTokens({ limit: MAX_RECIPIENTS });
    if (!recipients.length) {
      logger.info({ noticeId: notice.notice_id }, 'notice-push: no device tokens — skipping');
      return { delivered: false, reason: 'no tokens', recipients: 0 };
    }

    const title = notice.title || 'EasyFix';
    const body = bodyExcerpt(notice.body);
    // `screen:'notices'` is what the new Expo app's tap router matches (→ /notices);
    // `type`/`noticeId` are kept for foreground handlers + any future per-notice link.
    // (The old Flutter app has no notices screen, so it shows the notification only.)
    const data = { type: 'notice', screen: 'notices', noticeId: String(notice.notice_id) };

    const r = await pushDelivery.deliver(
      recipients,
      { title, body, data },
      { concurrency: CHUNK_SIZE, prune: false, unit: 'recipients', label: `notice · noticeId=${notice.notice_id}` },
    );
    return { delivered: r.delivered, deliveredCount: r.deliveredCount, recipients: r.tokenCount };
  } catch (e) {
    // Absolute backstop — called best-effort from notice publish/create
    // and must never throw into the caller.
    logger.warn({ noticeId: notice && notice.notice_id, err: e.message }, 'notice-push: push failed (swallowed)');
    return { delivered: false, error: e.message };
  }
}

module.exports = {
  pushNoticeToTechnicians,
  // Back-compat shim: preserves the historical string[] return shape.
  resolveRecipientTokens: async () =>
    (await pushDelivery.resolveVerifiedTechnicianTokens({ limit: MAX_RECIPIENTS })).map((r) => r.token),
};
