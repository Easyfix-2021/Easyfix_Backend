const logger = require('../logger');
const smsService = require('./sms.service');
const emailService = require('./email.service');
// WhatsApp provider is switchable via WHATSAPP_PROVIDER: default 'gallabox' for
// now; set it to 'meta' once the Meta Cloud API OTP template is fully approved.
const whatsappService =
  String(process.env.WHATSAPP_PROVIDER || 'gallabox').toLowerCase() === 'meta'
    ? require('./meta.whatsapp.service')
    : require('./gallabox.whatsapp.service');
const smsTemplate = require('./sms-template.service');

/*
 * OTP delivery with channel-preference fallback.
 *
 * Rules (from product ask):
 *   - If the user logged in WITH A MOBILE NUMBER:
 *       1. Try WhatsApp first (Gallabox template).
 *       2. On failure, fall back to SMS.
 *   - If the user logged in WITH AN EMAIL:
 *       1. Try Email first (Gmail SMTP).
 *       2. On failure, fall back to WhatsApp (if user has a mobile on file).
 *
 * Any failure = provider returned delivered:false OR threw. Each hop's outcome
 * is logged so ops can see "WA failed → fell back to SMS → OK" in one glance.
 *
 * Gallabox requires a pre-approved template for OTP. Template name is configurable
 * via env WHATSAPP_OTP_TEMPLATE (default 'login_otp'). If the template is missing
 * in Gallabox, the first attempt fails and the fallback kicks in — graceful.
 */

const WA_TEMPLATE = process.env.WHATSAPP_OTP_TEMPLATE || 'login_otp';

/*
 * DLT-approved fallback if the template table is unreachable. Intentionally
 * matches the legacy `mobileLoginOtp` row in tbl_sms_transational_meta so
 * any operator-level matching has a chance of passing. Still prefer the DB
 * row — it's the source of truth and gets updated when DLT registrations change.
 */
const FALLBACK_OTP_SMS = (otp) => `Dear Customer, Your OTP for login to the account is ${otp} - Team EasyFix`;

async function buildOtpSmsBody(otp) {
  try {
    const tmpl = await smsTemplate.getTemplate('mobileLoginOtp');
    const body = smsTemplate.fill(tmpl, [otp]);
    if (body) return body;
  } catch (e) {
    logger.warn(`SMS template lookup failed — using inline fallback · ${e.message}`);
  }
  return FALLBACK_OTP_SMS(otp);
}

function buildOtpEmailText(otp) {
  // Plain-text alternative for clients that block HTML. Kept terse — long text
  // blasts full of keywords look more spam-like than short, utility-style copy.
  return [
    'Hello,',
    '',
    `Your EasyFix sign-in code is: ${otp}`,
    '',
    'The code is valid for 5 minutes. If you did not request it, you can safely ignore this email.',
    '',
    '— Team EasyFix',
  ].join('\n');
}

function buildOtpEmailHtml(otp) {
  // Deliverability notes:
  //  - Branded HTML (not just wrapped text) looks like a real transactional mail
  //    rather than a script output — weighted positively by Gmail/Outlook filters.
  //  - OTP shown in a styled box is recognisable to spam engines as a sign-in
  //    code pattern, which many filters whitelist rather than flag.
  //  - We avoid "OTP" and "One-Time Password" anywhere except the code itself;
  //    "sign-in code" / "verification code" are less spammy in current classifiers.
  //  - No external images or tracking pixels — anything loaded from a 3rd party
  //    triggers extra scrutiny for a first-time sender.
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>EasyFix sign-in code</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
          <tr><td style="padding:28px 32px 16px 32px;border-bottom:1px solid #e5e7eb;">
            <div style="font-size:20px;font-weight:700;color:#0ea5e9;letter-spacing:-0.2px;">EasyFix</div>
          </td></tr>
          <tr><td style="padding:28px 32px 8px 32px;">
            <div style="font-size:15px;color:#374151;margin:0 0 16px 0;">Hello,</div>
            <div style="font-size:15px;color:#374151;margin:0 0 20px 0;">
              Use the code below to finish signing in to your EasyFix account.
            </div>
            <div style="font-size:32px;font-weight:700;letter-spacing:8px;text-align:center;color:#0f172a;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:20px 0;margin:0 0 20px 0;font-family:'SF Mono',Consolas,Menlo,monospace;">
              ${otp}
            </div>
            <div style="font-size:13px;color:#6b7280;line-height:1.5;margin:0 0 8px 0;">
              This code is valid for 5 minutes. If you did not request it, you can safely ignore this email — your account stays secure.
            </div>
          </td></tr>
          <tr><td style="padding:16px 32px 24px 32px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
            Team EasyFix · This is an automated message, please do not reply.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

async function tryWhatsApp({ mobile, name, otp }) {
  if (!mobile) return { delivered: false, skipped: 'no mobile' };
  try {
    // Meta Cloud API uses positional placeholders ({{1}}, {{2}}, …) — there's
    // no named-key option, so the OTP must land at position 1. The template
    // referenced by WA_TEMPLATE needs to be approved under our own WABA with
    // a single body variable. If you re-add named templates later, you'll
    // need to also re-pass the named key — Meta does not support it.
    return await whatsappService.sendTemplate({
      to: mobile,
      recipientName: name || '',
      templateName: WA_TEMPLATE,
      // Pass BOTH shapes so either provider works: Meta reads `variables`
      // (positional {{1}}); Gallabox reads `bodyValues` (named "1"). Each
      // service destructures only the key it needs and ignores the other.
      variables: { 1: String(otp) },
      bodyValues: { 1: String(otp) },
    });
  } catch (e) { return { delivered: false, error: e.message }; }
}

async function trySms({ mobile, otp }) {
  if (!mobile) return { delivered: false, skipped: 'no mobile' };
  try {
    const message = await buildOtpSmsBody(otp);
    return await smsService.send({ to: mobile, message });
  } catch (e) { return { delivered: false, error: e.message }; }
}

async function tryEmail({ email, otp }) {
  if (!email) return { delivered: false, skipped: 'no email' };
  try {
    return await emailService.send({
      to: email,
      // "sign-in code" is less spam-triggering than "OTP" / "password" / "verify".
      subject: 'Your EasyFix sign-in code',
      text: buildOtpEmailText(otp),
      html: buildOtpEmailHtml(otp),
      category: 'transactional',
    });
  } catch (e) { return { delivered: false, error: e.message }; }
}

/**
 * Deliver an OTP with channel preference based on how the user identified.
 *
 * @param {Object} args
 * @param {string} args.identifier   — what user typed (email OR 10-digit mobile)
 * @param {string|null} args.email   — user's email on file
 * @param {string|null} args.mobile  — user's mobile on file
 * @param {string|null} args.name    — user's display name (for WA recipientName)
 * @param {number}     args.otp      — the OTP digits
 * @param {string}     args.contextLabel — 'staff' | 'spoc' | 'technician' (for logs)
 */
async function deliverOtp({ identifier, email, mobile, name, otp, contextLabel = 'login' }) {
  const identifierIsEmail = /@/.test(String(identifier || ''));
  const attempts = [];
  logger.info('Deliver OTP · context=' + contextLabel + ' via=' + (identifierIsEmail ? 'email' : 'mobile'));

  if (identifierIsEmail) {
    // Primary: Email → Fallback: WhatsApp
    const a1 = await tryEmail({ email, otp });
    attempts.push({ channel: 'email', ...a1 });
    logger.info(`${contextLabel} OTP email attempt: ${a1.delivered ? 'delivered' : 'failed'}${a1.error ? ` (${a1.error})` : ''}`);
    if (a1.delivered || a1.disabled) return { attempts, finalDelivered: !!a1.delivered, primaryChannel: 'email' };

    const a2 = await tryWhatsApp({ mobile, name, otp });
    attempts.push({ channel: 'whatsapp', ...a2, fallback: true });
    logger.warn(`${contextLabel} OTP email failed — falling back to WhatsApp${a2.delivered ? ' (ok)' : ` (${a2.error || 'failed'})`}`);
    return { attempts, finalDelivered: !!a2.delivered, primaryChannel: 'email' };
  }

  // identifier is a mobile.
  //
  // Why we can fan out instead of pure WA→SMS fallback:
  //   Gallabox's API returns `ACCEPTED` the instant it queues a message, but
  //   gives us NO delivery-status API to tell whether WhatsApp/Meta actually
  //   delivered it. If the template is registered in Gallabox but not fully
  //   Meta-approved (common during initial setup), Gallabox says "delivered"
  //   while the user never sees a WhatsApp message. With fallback-only, SMS
  //   never runs in that scenario — the user is silently locked out.
  //
  //   `OTP_DUAL_CHANNEL_MOBILE=true` sends BOTH WhatsApp and SMS in parallel.
  //   User gets whichever arrives first (and the other as redundant). Once
  //   WhatsApp template is confirmed reliably delivering, flip this off and
  //   we revert to single-channel fallback.
  const mobileTarget = mobile || identifier;
  const dual = String(process.env.OTP_DUAL_CHANNEL_MOBILE || 'false').toLowerCase() === 'true';

  if (dual) {
    const [a1, a2] = await Promise.all([
      tryWhatsApp({ mobile: mobileTarget, name, otp }),
      trySms({ mobile: mobileTarget, otp }),
    ]);
    attempts.push({ channel: 'whatsapp', ...a1 });
    attempts.push({ channel: 'sms', ...a2, parallel: true });
    logger.info(`${contextLabel} OTP dual-send · WhatsApp=${a1.delivered ? 'ok' : 'fail'} · SMS=${a2.delivered ? 'ok' : 'fail'}`);
    return { attempts, finalDelivered: !!(a1.delivered || a2.delivered), primaryChannel: 'whatsapp+sms' };
  }

  const a1 = await tryWhatsApp({ mobile: mobileTarget, name, otp });
  attempts.push({ channel: 'whatsapp', ...a1 });
  logger.info(`${contextLabel} OTP WhatsApp attempt: ${a1.delivered ? 'delivered' : 'failed'}${a1.error ? ` (${a1.error})` : ''}`);
  if (a1.delivered || a1.disabled) return { attempts, finalDelivered: !!a1.delivered, primaryChannel: 'whatsapp' };

  const a2 = await trySms({ mobile: mobileTarget, otp });
  attempts.push({ channel: 'sms', ...a2, fallback: true });
  logger.warn(`${contextLabel} OTP WhatsApp failed — falling back to SMS${a2.delivered ? ' (ok)' : ` (${a2.error || 'failed'})`}`);
  return { attempts, finalDelivered: !!a2.delivered, primaryChannel: 'whatsapp' };
}

module.exports = { deliverOtp };
