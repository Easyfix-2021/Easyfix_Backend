const router = require('express').Router();
const crypto = require('crypto');
const logger = require('../../logger');
const { modernOk, modernError } = require('../../utils/response');
const { pool } = require('../../db');
const convo = require('../../services/whatsapp-conversation.service');

/*
 * Inbound WhatsApp webhook (Gallabox → us) for the conversational
 * order-confirmation flow. Mounted at /api/webhook/whatsapp.
 *
 * Security: a shared secret (GALLABOX_WEBHOOK_SECRET) is required on every
 * request — accepted via the `x-webhook-secret` header OR `?secret=` query
 * (Gallabox lets you configure a custom header on the webhook). No JWT — this
 * is a provider→server callback. If the secret is unset we FAIL CLOSED (reject)
 * so a half-configured deploy can't accept spoofed inbound traffic.
 *
 * We always reply 200 once the secret checks out (even when we don't act on a
 * message) so the provider doesn't retry-storm; real processing errors are
 * logged server-side, not surfaced to the BSP.
 *
 * NOTE: the exact Gallabox inbound payload shape must be confirmed against the
 * Gallabox dashboard/docs at rollout. normaliseInbound() is intentionally
 * tolerant of several likely field paths so we can adapt without a rewrite.
 */

function secretOk(req) {
  /*
   * TRIM BOTH SIDES. This is a value a human pastes into a .env file on one
   * host and into a provider dashboard on another, and both routinely pick up a
   * trailing newline or space that is invisible in every window you would look
   * at. Untrimmed, that produces `bad secret, refused` on a secret that reads as
   * identical in both places — an hour of debugging for a character nobody can
   * see. Trimming cannot weaken the check: surrounding whitespace carries no
   * entropy, and the comparison stays constant-time on the trimmed bytes.
   */
  const expected = String(process.env.GALLABOX_WEBHOOK_SECRET || '').trim();
  // Fail closed on an UNSET secret — a half-configured deploy must not accept
  // spoofed inbound traffic. (This is why a blank env var rejects every inbound
  // no matter how correctly the provider is configured.)
  if (!expected) return false;
  const got = String(req.get('x-webhook-secret') || req.query.secret || '').trim();
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Best-effort normaliser: Gallabox wraps the WhatsApp message in an event
// envelope. We probe the common locations for each field.
function normaliseInbound(body) {
  if (!body || typeof body !== 'object') return null;
  const p = body.payload || body.message || body.data || body;
  const wa = p.whatsapp || p;

  const from = p.from || p.sender || p.phone || p.mobile || wa.from || null;
  const messageId = p.id || p.messageId || wa.id || p.whatsappMessageId || null;
  const rawType = (p.type || wa.type || '').toString().toLowerCase();

  // Interactive button reply — id is the stable thing we keyed our buttons on.
  //
  // TEMPLATE quick replies (the `customer_interactive_msg` confirm/reschedule/
  // not-required buttons) are matched by Gallabox/Meta on the PAYLOAD string, and
  // different envelope shapes surface it as `payload`, `id` or the button
  // `title`/`text`. Probe all of them — whatsapp-conversation.service's
  // matchTemplateChoice() normalises case/whitespace and also accepts the raw
  // text, so any of these resolves to the right branch.
  const interactive = p.interactive || wa.interactive || null;
  const buttonReply = interactive?.button_reply || interactive?.reply || p.button || null;
  const buttonId = buttonReply?.id
    || buttonReply?.payload
    || buttonReply?.title
    || buttonReply?.text
    || p.buttonId
    || p.payload?.id
    || null;

  // Location
  const loc = p.location || wa.location || null;
  const lat = loc?.latitude ?? loc?.lat ?? null;
  const lng = loc?.longitude ?? loc?.lng ?? null;

  // Media (image/video) — Gallabox typically gives a hosted url.
  const mediaObj = p.image || p.video || p.media || wa.image || wa.video || null;
  const mediaUrl = mediaObj?.url || mediaObj?.link || mediaObj?.mediaUrl || null;

  // Text
  const text = (p.text && (p.text.body || p.text)) || p.body || wa.text?.body || null;

  let type = 'unknown';
  if (buttonId) type = 'button';
  else if (lat != null && lng != null) type = 'location';
  else if (rawType === 'image' || (mediaObj && /image/i.test(mediaObj.mime || mediaObj.contentType || ''))) type = 'image';
  else if (rawType === 'video' || (mediaObj && /video/i.test(mediaObj.mime || mediaObj.contentType || ''))) type = 'video';
  else if (text) type = 'text';

  if (!from) return null;
  return {
    from,
    messageId,
    type,
    text: text || null,
    buttonId: buttonId || null,
    location: (lat != null && lng != null) ? { lat: Number(lat), lng: Number(lng) } : null,
    media: mediaUrl ? { url: mediaUrl, kind: type } : null,
  };
}

// Delivery-STATUS callback normaliser. Distinct from normaliseInbound (which
// only understands CUSTOMER messages and returns null for a status callback).
//
// LOAD OPTIMISATION: we recognise ONLY the FAILURE states (failed/undelivered).
// WhatsApp fires a status callback for EVERY message transition
// (sent → delivered → read), so acting on all of them would mean 3+ DB writes
// per message for ZERO UI benefit — the only surface is the "Delivery Failed"
// chip. Non-failure callbacks return null here and fall through to the cheap
// "not actionable, ignored" path (no DB touch). So only genuinely-failed sends
// ever hit the (indexed) UPDATE — the write path stays near-zero. delivery_status
// is optimistically seeded 'sent' at dispatch, so "no failure callback" already
// reads as sent. Field-probing is tolerant of the envelope shape.
const DELIVERY_FAILURE_STATES = new Set(['failed', 'undelivered']);
function normaliseStatus(body) {
  if (!body || typeof body !== 'object') return null;
  const p = body.payload || body.data || body.message || body;
  const s = String(p.status || p.deliveryStatus || p.event || '').toLowerCase();
  if (!DELIVERY_FAILURE_STATES.has(s)) return null;
  const msgId = p.whatsappMessageId || p.messageId || p.id || p.channelMessageId || null;
  if (!msgId) return null;
  const errObj = p.failedReason || p.error || (Array.isArray(p.errors) ? p.errors[0] : null) || null;
  const reason = errObj
    ? String(errObj.message || errObj.title || errObj.reason || errObj.code || '').slice(0, 255)
    : null;
  return { msgId, status: s, reason };
}

// Optional GET verify handshake (some BSPs ping the URL with the secret).
router.get('/whatsapp', (req, res) => {
  if (!secretOk(req)) { logger.warn('WhatsApp verify handshake · bad secret, refused'); return modernError(res, 401, 'unauthorized'); }
  logger.info('WhatsApp verify handshake · ok');
  return modernOk(res, { ok: true });
});

router.post('/whatsapp', async (req, res) => {
  if (!secretOk(req)) { logger.warn('WhatsApp inbound webhook · bad secret, refused'); return modernError(res, 401, 'unauthorized'); }

  // Delivery-status callback FIRST — these were previously swallowed by the
  // "not actionable" branch below. Reflect the real WhatsApp outcome onto the
  // job (keyed by the provider msg id we stamped at send time). Unmatched id →
  // affectedRows 0, benign (covers non-magic-link sends). Always 200 so the BSP
  // doesn't retry-storm. Column-tolerant: pre-migration deploys just log + skip.
  const statusCb = normaliseStatus(req.body);
  if (statusCb) {
    try {
      const [r] = await pool.query(
        `UPDATE tbl_job SET magic_link_delivery_status = ?, magic_link_delivery_reason = ?
          WHERE magic_link_provider_msg_id = ?`,
        [statusCb.status, statusCb.reason, statusCb.msgId],
      );
      logger.info('WhatsApp status callback · status=' + statusCb.status + ' msgId=' + statusCb.msgId + ' matchedJobs=' + (r && r.affectedRows != null ? r.affectedRows : 0));
    } catch (err) {
      logger.warn({ err: err && err.message }, 'whatsapp status callback update failed (pre-migration columns?)');
    }
    return modernOk(res, { received: true, status: statusCb.status });
  }

  const inbound = normaliseInbound(req.body);
  if (!inbound) {
    /*
     * Not a customer message we can act on (status callback, unparseable, …).
     *
     * LOG THE SHAPE, NOT JUST THE FACT. This used to log one bare line, which
     * made three very different failures indistinguishable from the outside:
     *   (a) Gallabox never called us at all — no log line exists
     *   (b) it called us and normaliseInbound could not find the fields
     *   (c) the secret was wrong — that one at least says so
     * The header of this file admits the inbound envelope was never confirmed
     * against a real Gallabox payload, so (b) is a live possibility every time a
     * customer taps a button and nothing happens. Logging the KEY PATHS turns
     * the next tap into the answer.
     *
     * Keys only — never values. An inbound WhatsApp body carries the customer's
     * phone number and message text, and this log line is not the place for it.
     */
    const shape = (o, depth = 0) => {
      if (!o || typeof o !== 'object' || depth > 2) return undefined;
      const out = {};
      for (const k of Object.keys(o).slice(0, 25)) {
        const v = o[k];
        out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? (shape(v, depth + 1) || '{…}') : typeof v;
      }
      return out;
    };
    logger.warn({ bodyShape: shape(req.body) },
      'WhatsApp inbound · UNPARSEABLE — normaliseInbound found no actionable fields. '
      + 'Compare the key paths above with normaliseInbound() and widen the probes.');
    return modernOk(res, { received: true, handled: false });
  }

  logger.info('WhatsApp inbound · type=' + inbound.type
    + ' messageId=' + (inbound.messageId || 'n/a')
    // The button payload IS the routing key for the template quick replies, and
    // a mismatch here is the difference between the reschedule branch and
    // nothing at all. It is not PII — it is one of three fixed constants.
    + (inbound.buttonId ? ' buttonId="' + String(inbound.buttonId).slice(0, 60) + '"' : ''));
  try {
    const result = await convo.handleInbound(inbound, pool);
    const handled = result && result.handled;
    /*
     * NOT-HANDLED is a WARN with the reason. `handled:false` means the customer
     * tapped or typed something and we did nothing — no_active_conversation,
     * expired, duplicate, or an unmatched payload. At INFO it read the same as
     * success and told you nothing about which.
     */
    if (handled) {
      logger.info('WhatsApp inbound handled · type=' + inbound.type);
    } else {
      logger.warn('WhatsApp inbound NOT handled · type=' + inbound.type
        + ' reason=' + ((result && result.reason) || 'unknown')
        + (inbound.buttonId ? ' buttonId="' + String(inbound.buttonId).slice(0, 60) + '"' : ''));
    }
    return modernOk(res, { received: true, ...result });
  } catch (err) {
    logger.error({ err: err && err.message }, 'whatsapp inbound webhook failed');
    // Still 200 — we logged it; don't invite a provider retry storm.
    return modernOk(res, { received: true, handled: false, error: 'internal' });
  }
});

module.exports = router;
