const logger = require('../logger');

/*
 * WhatsApp delivery via Meta's Cloud API (direct — no BSP middleman).
 *
 * Replaces the Gallabox path (services/gallabox.whatsapp.service.js, now
 * stale) as the primary WhatsApp sender. All three previous Gallabox
 * dependents — notification-orchestrator, otp-delivery, the admin
 * /notifications/test route — point here as of 2026-05-21.
 *
 * Endpoint:
 *   POST https://graph.facebook.com/<API_VERSION>/<PHONE_NUMBER_ID>/messages
 *   Authorization: Bearer <ACCESS_TOKEN>
 *   Content-Type: application/json
 *   Body:
 *   {
 *     "messaging_product": "whatsapp",
 *     "to": "91XXXXXXXXXX",
 *     "type": "template",
 *     "template": {
 *       "name": "<templateName>",
 *       "language": { "code": "en" },
 *       "components": [
 *         { "type": "header", "parameters": [ {type:"text", text:"..."} ] },  // optional
 *         { "type": "body",   "parameters": [ {type:"text", text:"v1"}, ... ] }
 *       ]
 *     }
 *   }
 *
 * Caller contract — template-agnostic so any future flow can drop in:
 *   sendTemplate({
 *     to: '9999999999',                    // 10-digit or 91-prefixed; normalised
 *     templateName: 'order_confirmed',     // Meta-approved name (case-sensitive)
 *     variables: { 1: 'Pune', 2: 'Treadmill', 3: '21-May-2026 11:00' },
 *     headerVariables: { 1: 'JOB-385703' },// optional, same shape
 *     languageCode: 'en',                  // optional; falls back to env, then 'en'
 *     recipientName: 'Ramesh',             // accepted for log parity; not sent
 *   })
 *
 * The keys in `variables` correspond 1:1 with Meta's `{{1}} {{2}} …` body
 * placeholders. We sort numerically before flattening, so callers can pass
 * keys out of order (a JSON object's iteration order is "insertion order
 * for string keys that look like integers starting at 0/1" which is close
 * to safe — explicit sort makes it strict).
 *
 * Env vars (filled into .env):
 *   META_WHATSAPP_PHONE_NUMBER_ID       — Meta "Phone Number ID" (numeric)
 *   META_WHATSAPP_BUSINESS_ACCOUNT_ID   — WABA id (not needed for send, retained for media APIs)
 *   META_WHATSAPP_ACCESS_TOKEN          — System User permanent token
 *   META_WHATSAPP_API_VERSION           — defaults to v20.0
 *   META_WHATSAPP_DEFAULT_LANG          — defaults to 'en'
 */

function disabled() {
  return String(process.env.NOTIFICATIONS_DISABLE).toLowerCase() === 'true';
}

function normaliseIndianPhone(raw) {
  // Same rules as gallabox.whatsapp.service.js — duplicated rather than
  // imported because the moment the Gallabox file is deleted, this needs
  // to stand alone without dangling cross-file dependencies.
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return null;
}

function toTextParams(map) {
  // Accept { 1: 'a', 2: 'b' } OR { '1': 'a', '2': 'b' }. Sort numerically.
  // Coerce non-string values to strings; Meta rejects non-strings outright.
  // Empty string is permitted (some templates have optional slots) — `null`
  // and `undefined` get swapped to '' so the array length always matches
  // the template's variable count.
  if (!map || typeof map !== 'object') return [];
  const keys = Object.keys(map).sort((a, b) => Number(a) - Number(b));
  return keys.map((k) => ({ type: 'text', text: String(map[k] ?? '') }));
}

async function sendTemplate({
  to, templateName,
  variables = {},
  headerVariables,
  languageCode,
  recipientName,            // accepted for log-shape parity with Gallabox call sites; not sent
}) {
  void recipientName;       // intentional no-op so unused-var linters stay quiet
  logger.info('Send WhatsApp template · template=' + templateName);
  const originalPhone = normaliseIndianPhone(to);
  if (!originalPhone) return { delivered: false, error: `invalid phone "${to}"` };
  if (!templateName) return { delivered: false, error: 'templateName required' };

  if (disabled()) {
    logger.test(`WhatsApp (meta) suppressed (NOTIFICATIONS_DISABLE) · to=${originalPhone} · template=${templateName}`);
    return { delivered: false, disabled: true };
  }

  const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.META_WHATSAPP_ACCESS_TOKEN;
  const apiVersion    = process.env.META_WHATSAPP_API_VERSION || 'v20.0';
  const lang          = languageCode || process.env.META_WHATSAPP_DEFAULT_LANG || 'en';
  if (!phoneNumberId || !accessToken) {
    logger.warn('WhatsApp send aborted · Meta credentials not configured · template=' + templateName);
    return {
      delivered: false,
      error: 'META_WHATSAPP_PHONE_NUMBER_ID / META_WHATSAPP_ACCESS_TOKEN not configured',
    };
  }

  // ── TEST-MODE INTERCEPTION (last point before provider call) ──
  // Mirrors the redirect pattern used by sms / email / gallabox so that
  // QA-mode TEST_MOBILE intercepts every channel uniformly.
  let phone = originalPhone;
  let redirected = false;
  if (process.env.TEST_MOBILE) {
    const test = normaliseIndianPhone(process.env.TEST_MOBILE);
    if (test) { phone = test; redirected = true; }
  }
  if (redirected) {
    logger.test(`WhatsApp (meta) redirected from ${originalPhone} → ${phone} (TEST_MOBILE) · template=${templateName}`);
  }

  // Build components only for sections that actually have values, so we
  // don't send an empty header block (Meta rejects empty parameters[]).
  const components = [];
  const headerParams = toTextParams(headerVariables);
  if (headerParams.length) components.push({ type: 'header', parameters: headerParams });
  const bodyParams = toTextParams(variables);
  if (bodyParams.length)   components.push({ type: 'body',   parameters: bodyParams });

  const body = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: lang },
      ...(components.length ? { components } : {}),
    },
  };

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const delivered = res.ok;
    // Meta returns `{ messages: [{ id: "wamid…" }] }` on success — pull
    // the id so logs can be matched against Meta's delivery webhooks
    // later. Wrap the JSON.parse so a non-JSON error body doesn't throw.
    let messageId;
    try { messageId = JSON.parse(text)?.messages?.[0]?.id; } catch { /* leave undefined */ }
    const who = redirected ? `${phone} (was ${originalPhone})` : phone;
    if (delivered) logger.whatsapp(`meta sent to ${who} · template=${templateName}${messageId ? ` · id=${messageId}` : ''}`);
    else           logger.warn(`WhatsApp (meta) rejected · to=${who} · template=${templateName} · status=${res.status} · ${text.slice(0, 200)}`);
    return {
      delivered,
      providerResponse: text,
      httpStatus: res.status,
      messageId,
      redirected,
      intendedTo: redirected ? originalPhone : undefined,
    };
  } catch (err) {
    logger.error(`WhatsApp (meta) error · to=${phone} · template=${templateName} · ${err.message}`);
    return { delivered: false, error: err.message };
  }
}

module.exports = { sendTemplate, normaliseIndianPhone };
