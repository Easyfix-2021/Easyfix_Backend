const logger = require('../logger');
const { getGraphToken, invalidateGraphToken } = require('./ms-graph-token.service');

/*
 * Email via Microsoft Graph API — application-permission sendMail
 * (client-credentials OAuth2 flow). Replaced the Gmail-SMTP nodemailer
 * implementation on 2026-04-20 to consolidate on the existing Azure AD
 * tenant Easyfix already uses for Microsoft 365 mail.
 *
 * Required env (add to .env):
 *   MS_GRAPH_TENANT_ID       — Azure AD directory (tenant) ID
 *   MS_GRAPH_CLIENT_ID       — App registration client ID
 *   MS_GRAPH_CLIENT_SECRET   — App registration client secret
 *   MS_GRAPH_SENDER_EMAIL    — Mailbox to send from (must have Mail.Send
 *                              application permission granted + admin-consented
 *                              in Azure AD). Defaults to ithelpdesk@easyfix.in.
 *
 * Flow per send():
 *   1. Get a bearer from services/ms-graph-token.service.js — the SHARED
 *      client-credentials token cache (this file used to own a private copy;
 *      it was extracted so the Entra provisioning service can reuse it rather
 *      than mint a second token against the same app registration). Same env
 *      vars, same 2-minute expiry buffer, same error text as before.
 *   2. POST https://graph.microsoft.com/v1.0/users/{sender}/sendMail with the
 *      message envelope. Graph responds 202 Accepted on success — there's no
 *      SMTP-equivalent messageId returned; Graph logs the send server-side.
 *
 * ⚠ 202 ACCEPTED IS NOT DELIVERY. See the return-shape note on send() below.
 *
 * Kept contract:
 *   send({ to, subject, text, html, cc, bcc, category })
 *     → { accepted, deliveryConfirmed, delivered (alias of accepted), … }
 * — callers (notification-orchestrator, auth OTP delivery, deploy workflow,
 *   auto-assign failure notification) are unchanged.
 *
 * Preserved behaviours (same as the old SMTP implementation):
 *   - NOTIFICATIONS_DISABLE env short-circuits sends (dev safety on QA data).
 *   - TEST_EMAILS redirect — every outbound email lands in the test list
 *     instead of real customers during non-production work; cc/bcc dropped.
 *   - Test-mode banner injected at the top of the body (not the subject —
 *     subject stays clean for deliverability testing).
 *   - transactional-category extra header (x-auto-submitted).
 *   - Plain-text fallback wrapped into an HTML paragraph when only `text` is supplied.
 *
 * The previous nodemailer / Gmail-SMTP implementation lives at the bottom of
 * this file inside a commented block — un-comment + swap if Graph is down.
 */

function disabled() {
  return String(process.env.NOTIFICATIONS_DISABLE).toLowerCase() === 'true';
}

/*
 * Token acquisition now lives in services/ms-graph-token.service.js so the
 * Entra provisioning service shares ONE cache with this file. Kept as a
 * one-line delegate rather than inlining getGraphToken() at the call site so
 * the flow reads the same as it did before the extraction.
 */
async function fetchGraphToken() {
  return getGraphToken();
}

/*
 * Convert a SMTP-style recipient (string, array, or CSV) into Graph's
 * `{ emailAddress: { address: "..." } }` shape.
 */
function toRecipientArray(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : String(input).split(',').map((s) => s.trim()).filter(Boolean);
  return arr.map((addr) => ({ emailAddress: { address: addr } }));
}

/*
 * RETURN SHAPE — read this before writing a caller.
 *
 *   accepted           true  ⇔ Graph answered 202 Accepted: the message is
 *                      QUEUED in the tenant's outbound pipeline. That is the
 *                      strongest signal this API can ever give us.
 *   deliveryConfirmed  ALWAYS false on the success path. Graph exposes no
 *                      delivery receipt and does NOT validate the recipient
 *                      mailbox before accepting, so a send to an address that
 *                      does not exist still returns 202 and bounces
 *                      asynchronously — the NDR lands in the SENDER mailbox
 *                      (MS_GRAPH_SENDER_EMAIL), which no CRM surface reads.
 *                      The field exists so callers can never write
 *                      `if (r.delivered)` and believe they proved receipt; if
 *                      a real delivery-report integration ever lands, this is
 *                      the field it sets.
 *   delivered          BACKWARD-COMPAT ALIAS of `accepted`, kept because ~15
 *                      call sites across routes/ and services/ already read it
 *                      (and the SMS / WhatsApp / push services expose the same
 *                      key, so renaming it here alone would fragment the
 *                      cross-channel shape). IT MEANS "ACCEPTED FOR DELIVERY",
 *                      NOT "RECEIVED". Anything that must not be fooled by a
 *                      dead mailbox — OTP delivery above all — has to check
 *                      reachability itself: see the mailbox-existence
 *                      pre-check in services/otp-delivery.service.js.
 */
async function send({ to, subject, text, html, cc, bcc, category, attachments }) {
  const originalTo = to;
  logger.info('Send email · subject="' + subject + '"' + (category ? ' · category=' + category : '') + (Array.isArray(attachments) && attachments.length ? ' · attachments=' + attachments.length : ''));
  if (!to)             return { accepted: false, delivered: false, deliveryConfirmed: false, error: 'to is required' };
  if (!subject)        return { accepted: false, delivered: false, deliveryConfirmed: false, error: 'subject is required' };
  if (!text && !html)  return { accepted: false, delivered: false, deliveryConfirmed: false, error: 'text or html body required' };

  if (disabled()) {
    logger.test(`Email suppressed (NOTIFICATIONS_DISABLE) · to=${to} · subject="${subject}"`);
    return { accepted: false, delivered: false, deliveryConfirmed: false, disabled: true };
  }

  // ── TEST-MODE INTERCEPTION (last point before Graph dispatch) ──
  let redirected = false;
  if (process.env.TEST_EMAILS) {
    const testList = process.env.TEST_EMAILS.split(',').map((s) => s.trim()).filter(Boolean);
    if (testList.length) {
      to = testList;
      cc = undefined;   // drop cc/bcc — test mode doesn't replicate extra recipients
      bcc = undefined;
      redirected = true;
      logger.test(`Email redirected from "${originalTo}" → "${to.join(',')}" (TEST_EMAILS) · cc/bcc dropped`);
    }
  }

  // Body composition — HTML takes priority. Plain text is wrapped into an
  // HTML paragraph if no html was supplied, so Graph always gets a usable
  // HTML body and rendering stays consistent across client mail apps.
  const testBanner = redirected
    ? `[Test redirect — originally addressed to ${Array.isArray(originalTo) ? originalTo.join(', ') : originalTo}]`
    : null;
  const htmlBody = html || (text
    ? `<p>${String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')}</p>`
    : undefined);
  const finalHtml = testBanner && htmlBody
    ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:8px 12px;margin:0 0 12px 0;font-family:sans-serif;font-size:12px;color:#92400e;">${testBanner}</div>${htmlBody}`
    : htmlBody;
  const finalText = testBanner && text ? `${testBanner}\n\n${text}` : text;

  try {
    const token  = await fetchGraphToken();
    const sender = process.env.MS_GRAPH_SENDER_EMAIL || 'ithelpdesk@easyfix.in';

    /*
     * Graph requires body as { contentType: 'HTML'|'Text', content: string }.
     * Prefer HTML (better rendering + more deliverability signals); fall back
     * to Text only when there's no html path (shouldn't happen thanks to the
     * auto-wrap above, but defence-in-depth).
     */
    const bodyContentType = finalHtml ? 'HTML' : 'Text';
    const bodyContent     = finalHtml || finalText || '';

    /*
     * `internetMessageHeaders` — Graph only accepts custom headers prefixed
     * `x-`. Mirrors the deliverability headers the old SMTP flow set.
     * Can't set List-Unsubscribe here (reserved header in Graph), but since
     * Graph-sent mail goes through the tenant's outbound M365 pipeline it's
     * already covered by DKIM/SPF/DMARC at the platform level — List-Unsub
     * is less critical than it was for raw SMTP.
     */
    const internetMessageHeaders = [
      { name: 'x-entity-ref-id', value: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}` },
      { name: 'x-mailer',        value: 'EasyFix-Backend/1.0' },
    ];
    if (category === 'transactional') {
      internetMessageHeaders.push({ name: 'x-auto-submitted', value: 'auto-generated' });
    }

    const message = {
      subject,
      body: { contentType: bodyContentType, content: bodyContent },
      toRecipients:  toRecipientArray(to),
      ccRecipients:  toRecipientArray(cc),
      bccRecipients: toRecipientArray(bcc),
      internetMessageHeaders,
    };

    // Graph attachments: each one is a fileAttachment with base64 contentBytes.
    // Buffer.from() handles both Buffer inputs (from a PassThrough sink) and
    // raw string content; the contentType defaults to application/octet-stream.
    if (Array.isArray(attachments) && attachments.length > 0) {
      message.attachments = attachments.map((a) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.filename || a.name || 'attachment',
        contentType: a.contentType || a.mimeType || 'application/octet-stream',
        contentBytes: (Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content)).toString('base64'),
      }));
    }

    const graphUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`;
    const res = await fetch(graphUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    });

    /*
     * Graph returns 202 Accepted with an empty body on success.
     *
     * 202 = QUEUED, NOT DELIVERED. Graph performs no recipient-existence check
     * before accepting, so this branch is also what a send to a mailbox that
     * was never created looks like. `queuedForDelivery` says exactly what we
     * know; `delivered` is the legacy alias (see the return-shape note above).
     */
    if (res.status === 202) {
      const who = Array.isArray(to) ? to.join(',') : to;
      logger.info('Email accepted by Graph (202 — queued, delivery NOT confirmed) · subject="' + subject + '"' + (redirected ? ' · redirected (TEST_EMAILS)' : ''));
      logger.email(`queued for ${who} · "${subject}"${redirected ? ` · was "${originalTo}"` : ''}`);
      return {
        accepted: true,
        queuedForDelivery: true,
        // Graph gives us no delivery receipt, ever. Never flip this to true
        // from an HTTP status code.
        deliveryConfirmed: false,
        delivered: true, // alias of `accepted` — "accepted for delivery"
        // No messageId on Graph — tenant Sent-Items folder is the audit trail.
        messageId: null,
        redirected,
        intendedTo: redirected ? originalTo : undefined,
      };
    }

    // Non-202 → failure. Invalidate the shared token cache on 401 so the next
    // send refetches — covers the edge case where the app secret was rotated
    // while this process had a live cached token.
    if (res.status === 401) invalidateGraphToken();

    const errText = await res.text();
    let parsedErr = errText;
    try { parsedErr = JSON.parse(errText)?.error?.message || errText; } catch { /* plain text */ }
    throw new Error(`Graph sendMail ${res.status}: ${String(parsedErr).slice(0, 300)}`);
  } catch (err) {
    logger.error(`Email error · to=${to} · ${err.message}`);
    return { accepted: false, delivered: false, deliveryConfirmed: false, error: err.message };
  }
}

module.exports = { send };

/*
 * ════════════════════════════════════════════════════════════════════════
 *  ARCHIVED: Gmail SMTP via nodemailer (active until 2026-04-20).
 *  To revert — swap the Graph-based send() above with the block below:
 *    1. `npm i nodemailer` (if removed from package.json)
 *    2. `const nodemailer = require('nodemailer');` at the top of this file
 *    3. Replace the Graph `send()` implementation with the one in this
 *       comment block. `fetchGraphToken`, `toRecipientArray`, and the token
 *       cache become unused — delete or keep for posterity.
 *    4. Set SMTP_USER / SMTP_PASSWORD (Gmail App Password, not login pw) +
 *       optional SMTP_HOST / SMTP_PORT / SMTP_FROM_NAME / SMTP_REPLY_TO in .env.
 * ════════════════════════════════════════════════════════════════════════
 *
 * let transporter = null;
 *
 * function buildTransporter() {
 *   const host = process.env.SMTP_HOST || 'smtp.gmail.com';
 *   const port = Number(process.env.SMTP_PORT || 587);
 *   const user = process.env.SMTP_USER;
 *   const pass = process.env.SMTP_PASSWORD;
 *   if (!user || !pass) throw new Error('SMTP_USER / SMTP_PASSWORD not configured');
 *   return nodemailer.createTransport({
 *     host, port, secure: false,
 *     auth: { user, pass },
 *   });
 * }
 *
 * async function send({ to, subject, text, html, cc, bcc, category }) {
 *   const originalTo = to;
 *   const originalCc = cc;
 *   const originalBcc = bcc;
 *   if (!to) return { delivered: false, error: 'to is required' };
 *   if (!subject) return { delivered: false, error: 'subject is required' };
 *   if (!text && !html) return { delivered: false, error: 'text or html body required' };
 *
 *   if (disabled()) {
 *     logger.test(`Email suppressed (NOTIFICATIONS_DISABLE) · to=${to} · subject="${subject}"`);
 *     return { delivered: false, disabled: true };
 *   }
 *
 *   let redirected = false;
 *   if (process.env.TEST_EMAILS) {
 *     const testList = process.env.TEST_EMAILS.split(',').map((s) => s.trim()).filter(Boolean);
 *     if (testList.length) {
 *       to = testList;
 *       cc = undefined;
 *       bcc = undefined;
 *       redirected = true;
 *       logger.test(`Email redirected from "${originalTo}" → "${to.join(',')}" (TEST_EMAILS) · cc/bcc dropped`);
 *     }
 *   }
 *
 *   try {
 *     if (!transporter) transporter = buildTransporter();
 *     const finalSubject = subject;
 *     const testBanner = redirected
 *       ? `[Test redirect — originally addressed to ${Array.isArray(originalTo) ? originalTo.join(', ') : originalTo}]`
 *       : null;
 *     const fromAddress = process.env.SMTP_USER;
 *     const fromName    = process.env.SMTP_FROM_NAME || 'EasyFix';
 *     const replyTo     = process.env.SMTP_REPLY_TO || fromAddress;
 *     const htmlBody    = html || (text
 *       ? `<p>${String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')}</p>`
 *       : undefined);
 *     const finalText = testBanner && text ? `${testBanner}\n\n${text}` : text;
 *     const finalHtml = testBanner && htmlBody
 *       ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:8px 12px;margin:0 0 12px 0;font-family:sans-serif;font-size:12px;color:#92400e;">${testBanner}</div>${htmlBody}`
 *       : htmlBody;
 *     const extraHeaders = {
 *       'X-Entity-Ref-ID': `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
 *       'X-Mailer': 'EasyFix-Backend/1.0',
 *       ...(category === 'transactional' ? {
 *         'X-Priority': '3',
 *         'Auto-Submitted': 'auto-generated',
 *         'List-Unsubscribe': `<mailto:${replyTo}?subject=unsubscribe>`,
 *         'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
 *       } : {}),
 *     };
 *
 *     const info = await transporter.sendMail({
 *       from: `${fromName} <${fromAddress}>`,
 *       to: Array.isArray(to) ? to.join(',') : to,
 *       replyTo,
 *       subject: finalSubject,
 *       text: finalText,
 *       html: finalHtml,
 *       headers: extraHeaders,
 *       cc: cc ? (Array.isArray(cc) ? cc.join(',') : cc) : undefined,
 *       bcc: bcc ? (Array.isArray(bcc) ? bcc.join(',') : bcc) : undefined,
 *     });
 *     const who = Array.isArray(to) ? to.join(',') : to;
 *     logger.email(`sent to ${who} · "${finalSubject}"${redirected ? ` · was "${originalTo}"` : ''}`);
 *     return { delivered: true, messageId: info.messageId, response: info.response, redirected, intendedTo: redirected ? originalTo : undefined };
 *   } catch (err) {
 *     logger.error(`Email error · to=${to} · ${err.message}`);
 *     return { delivered: false, error: err.message };
 *   }
 * }
 */
