const logger = require('../logger');

/*
 * WhatsApp delivery via Gallabox.
 *
 * NOTE (2026-06-03): general lifecycle notifications were migrated to
 * services/meta.whatsapp.service.js, BUT the customer Order-Confirmation
 * flow (job-magic-link.service.js → template `confirm_order`) deliberately
 * stays on Gallabox, and the new CONVERSATIONAL order-confirmation engine
 * (services/whatsapp-conversation.service.js) is built on Gallabox too —
 * it needs interactive buttons / free-text session messages / location
 * requests and an inbound webhook, which we run through the BSP. So this
 * module is NOT stale: it now exposes template + interactive + text +
 * location senders plus an inbound-media fetch.
 *
 * ─────────────────────────────────────────────────────────────────────
 *
 * WhatsApp delivery via Gallabox template API.
 * Legacy contract replicated from ACD_APIs/.../WhatsNotificationUtil.java:
 *   POST https://server.gallabox.com/devapi/messages/whatsapp
 *   Headers:
 *     apiKey: <GALLABOX_API_KEY>
 *     apiSecret: <GALLABOX_API_SECRET>
 *     Content-Type: application/json
 *   Body:
 *   {
 *     "channelId": "<GALLABOX_CHANNEL_ID>",
 *     "channelType": "whatsapp",
 *     "recipient": { "name": "...", "phone": "91XXXXXXXXXX" },
 *     "whatsapp": {
 *       "type": "template",
 *       "template": {
 *         "templateName": "...",          // pre-approved Gallabox template
 *         "bodyValues":   { ... },
 *         "headerValues": { ... },         // optional
 *         "buttonValues": [ ... ]          // optional
 *       }
 *     }
 *   }
 *
 * Phone numbers are always "91" + 10-digit mobile (India). Templates must
 * be pre-approved in Gallabox — new ones can't be sent freeform.
 */

function disabled() {
  return String(process.env.NOTIFICATIONS_DISABLE).toLowerCase() === 'true';
}

function normaliseIndianPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return null;
}

async function sendTemplate({
  to, recipientName,
  templateName, bodyValues = {}, headerValues, buttonValues,
  bypassTestRedirect = false,
}) {
  const originalPhone = normaliseIndianPhone(to);
  if (!originalPhone) return { delivered: false, error: `invalid phone "${to}"` };
  if (!templateName) return { delivered: false, error: 'templateName required' };

  if (disabled()) {
    logger.test(`WhatsApp suppressed (NOTIFICATIONS_DISABLE) · to=${originalPhone} · template=${templateName}`);
    return { delivered: false, disabled: true };
  }

  const apiKey    = process.env.GALLABOX_API_KEY;
  const apiSecret = process.env.GALLABOX_API_SECRET;
  const channelId = process.env.GALLABOX_CHANNEL_ID;
  const url       = process.env.GALLABOX_URL || 'https://server.gallabox.com/devapi/messages/whatsapp';
  if (!apiKey || !apiSecret || !channelId) {
    return { delivered: false, error: 'GALLABOX_API_KEY / API_SECRET / CHANNEL_ID not configured' };
  }

  // ── TEST-MODE INTERCEPTION (last point before Gallabox call) ──
  // `bypassTestRedirect` is set ONLY by the Scheduled Jobs → Test flow, so an
  // operator's typed number is honoured on every env. Every other send keeps
  // the TEST_MOBILE safety redirect (which has no NODE_ENV gate by design).
  let phone = originalPhone;
  let redirected = false;
  if (!bypassTestRedirect && process.env.TEST_MOBILE) {
    const test = normaliseIndianPhone(process.env.TEST_MOBILE);
    if (test) { phone = test; redirected = true; }
  }
  if (redirected) {
    logger.test(`WhatsApp redirected from ${originalPhone} → ${phone} (TEST_MOBILE) · template=${templateName}`);
  }

  const template = { templateName, bodyValues };
  if (headerValues) template.headerValues = headerValues;
  if (buttonValues) template.buttonValues = buttonValues;

  const body = {
    channelId,
    channelType: 'whatsapp',
    recipient: { name: recipientName || '', phone },
    whatsapp: { type: 'template', template },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { apiKey, apiSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const delivered = res.ok;
    const who = redirected ? `${phone} (was ${originalPhone})` : phone;
    if (delivered) logger.whatsapp(`sent to ${who} · template=${templateName}`);
    else           logger.warn(`WhatsApp rejected · to=${who} · template=${templateName} · status=${res.status} · ${text.slice(0, 120)}`);
    return { delivered, providerResponse: text, httpStatus: res.status, redirected, intendedTo: redirected ? originalPhone : undefined };
  } catch (err) {
    logger.error(`WhatsApp error · to=${phone} · template=${templateName} · ${err.message}`);
    return { delivered: false, error: err.message };
  }
}

/*
 * Shared low-level sender for the NON-template message types used by the
 * conversational flow (interactive buttons, free-form session text, location
 * request). Mirrors sendTemplate's guards exactly: NOTIFICATIONS_DISABLE
 * short-circuit + TEST_MOBILE redirect + creds check + the same Gallabox
 * envelope. `whatsapp` is the provider-specific message object (everything
 * under the top-level `whatsapp` key).
 *
 * IMPORTANT: free-form / interactive messages are only deliverable INSIDE the
 * 24h customer-service window (i.e. after the customer has messaged us). The
 * caller (state machine) only sends these in response to an inbound message,
 * so the window is always open. The first business-initiated message must be a
 * pre-approved template (use sendTemplate).
 *
 * Gallabox interactive/text payload shapes mirror Meta's Cloud API and should
 * be confirmed against the Gallabox API docs / dashboard during rollout.
 */
async function sendWhatsappMessage({ to, recipientName, whatsapp, label, bypassTestRedirect = false }) {
  const originalPhone = normaliseIndianPhone(to);
  if (!originalPhone) return { delivered: false, error: `invalid phone "${to}"` };
  if (!whatsapp || !whatsapp.type) return { delivered: false, error: 'whatsapp message payload required' };

  if (disabled()) {
    logger.test(`WhatsApp suppressed (NOTIFICATIONS_DISABLE) · to=${originalPhone} · ${label || whatsapp.type}`);
    return { delivered: false, disabled: true };
  }

  const apiKey    = process.env.GALLABOX_API_KEY;
  const apiSecret = process.env.GALLABOX_API_SECRET;
  const channelId = process.env.GALLABOX_CHANNEL_ID;
  const url       = process.env.GALLABOX_URL || 'https://server.gallabox.com/devapi/messages/whatsapp';
  if (!apiKey || !apiSecret || !channelId) {
    return { delivered: false, error: 'GALLABOX_API_KEY / API_SECRET / CHANNEL_ID not configured' };
  }

  let phone = originalPhone;
  let redirected = false;
  if (!bypassTestRedirect && process.env.TEST_MOBILE) {
    const test = normaliseIndianPhone(process.env.TEST_MOBILE);
    if (test) { phone = test; redirected = true; }
  }
  if (redirected) {
    logger.test(`WhatsApp redirected from ${originalPhone} → ${phone} (TEST_MOBILE) · ${label || whatsapp.type}`);
  }

  const body = {
    channelId,
    channelType: 'whatsapp',
    recipient: { name: recipientName || '', phone },
    whatsapp,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { apiKey, apiSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const delivered = res.ok;
    const who = redirected ? `${phone} (was ${originalPhone})` : phone;
    if (delivered) logger.whatsapp(`sent to ${who} · ${label || whatsapp.type}`);
    else           logger.warn(`WhatsApp rejected · to=${who} · ${label || whatsapp.type} · status=${res.status} · ${text.slice(0, 120)}`);
    return { delivered, providerResponse: text, httpStatus: res.status, redirected, intendedTo: redirected ? originalPhone : undefined };
  } catch (err) {
    logger.error(`WhatsApp error · to=${phone} · ${label || whatsapp.type} · ${err.message}`);
    return { delivered: false, error: err.message };
  }
}

// Free-form session text (24h window). Used for prompts/confirmations.
function sendText({ to, recipientName, body, bypassTestRedirect = false }) {
  return sendWhatsappMessage({
    to, recipientName, label: 'text', bypassTestRedirect,
    whatsapp: { type: 'text', text: { body: String(body || '') } },
  });
}

// Interactive reply buttons (max 3). `buttons` = [{ id, title }]. WhatsApp
// caps title at 20 chars — we hard-trim so a long label can't get the whole
// message rejected.
function sendButtons({ to, recipientName, body, buttons = [] }) {
  const replyButtons = buttons.slice(0, 3).map((b) => ({
    type: 'reply',
    reply: { id: String(b.id), title: String(b.title || '').slice(0, 20) },
  }));
  return sendWhatsappMessage({
    to, recipientName, label: 'interactive.button',
    whatsapp: {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: String(body || '') },
        action: { buttons: replyButtons },
      },
    },
  });
}

// Location-request interactive message — renders a "Send location" button in
// WhatsApp; the customer's reply arrives as an inbound `location` message.
function sendLocationRequest({ to, recipientName, body }) {
  return sendWhatsappMessage({
    to, recipientName, label: 'interactive.location_request',
    whatsapp: {
      type: 'interactive',
      interactive: {
        type: 'location_request_message',
        body: { text: String(body || '') },
        action: { name: 'send_location' },
      },
    },
  });
}

/*
 * Download an inbound media item (photo/video the customer sent) → buffer +
 * contentType, for re-upload to S3. Gallabox inbound webhooks deliver media as
 * a hosted `url` (preferred) and/or a provider `mediaId`; the exact field is
 * confirmed at rollout. We support a direct hosted URL here (auth headers are
 * sent in case the URL is gated). Returns { buffer, contentType } or
 * { error }.
 */
async function fetchInboundMedia({ url }) {
  if (!url) return { error: 'media url required' };
  try {
    const headers = {};
    if (process.env.GALLABOX_API_KEY)    headers.apiKey = process.env.GALLABOX_API_KEY;
    if (process.env.GALLABOX_API_SECRET) headers.apiSecret = process.env.GALLABOX_API_SECRET;
    const res = await fetch(url, { headers });
    if (!res.ok) return { error: `media fetch failed: HTTP ${res.status}` };
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = {
  sendTemplate,
  sendText,
  sendButtons,
  sendLocationRequest,
  fetchInboundMedia,
  normaliseIndianPhone,
};
