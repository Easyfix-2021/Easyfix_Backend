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
  const expected = process.env.GALLABOX_WEBHOOK_SECRET;
  if (!expected) return false; // fail closed
  const got = req.get('x-webhook-secret') || req.query.secret || '';
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(expected));
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
  const interactive = p.interactive || wa.interactive || null;
  const buttonReply = interactive?.button_reply || interactive?.reply || p.button || null;
  const buttonId = buttonReply?.id || p.buttonId || p.payload?.id || null;

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
  else if (rawType === 'image') type = 'image';
  else if (rawType === 'video') type = 'video';
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

// Optional GET verify handshake (some BSPs ping the URL with the secret).
router.get('/whatsapp', (req, res) => {
  if (!secretOk(req)) return modernError(res, 401, 'unauthorized');
  return modernOk(res, { ok: true });
});

router.post('/whatsapp', async (req, res) => {
  if (!secretOk(req)) return modernError(res, 401, 'unauthorized');

  const inbound = normaliseInbound(req.body);
  if (!inbound) {
    // Not a customer message we can act on (status callback, unparseable, etc.).
    return modernOk(res, { received: true, handled: false });
  }

  try {
    const result = await convo.handleInbound(inbound, pool);
    return modernOk(res, { received: true, ...result });
  } catch (err) {
    logger.error({ err: err && err.message }, 'whatsapp inbound webhook failed');
    // Still 200 — we logged it; don't invite a provider retry storm.
    return modernOk(res, { received: true, handled: false, error: 'internal' });
  }
});

module.exports = router;
