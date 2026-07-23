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
const { getProperty } = require('./properties.service');

/*
 * OTP delivery with channel-preference fallback.
 *
 * Rules (from product ask):
 *   - If the user logged in WITH A MOBILE NUMBER:
 *       1. Try the PRIMARY channel — `login.otp.channel` in easyfix_properties
 *          ('whatsapp' default | 'sms'), admin-switchable from Admin Actions.
 *       2. On failure, fall back to the OTHER channel. The property reorders the
 *          two; it never removes one, so no setting can strand a user.
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
 * PRIMARY channel for a MOBILE-identifier OTP — `login.otp.channel` in
 * easyfix_properties, switchable by an admin from Setting → Admin Actions with
 * no redeploy (the POST flushes the property cache, so it takes effect at once).
 *
 * It chooses the ORDER, never the set: the other channel always remains the
 * fallback. That is deliberate — OTP delivery is the only way into the product,
 * so a config flip must never be able to leave a user with no route in. Picking
 * 'sms' means "try SMS first, fall back to WhatsApp", not "SMS only".
 *
 * Absent / unrecognised ⇒ 'whatsapp', which is both the historical behaviour and
 * the safe default, so a missing property (or a pre-migration host) changes
 * nothing. EMAIL-identifier logins are unaffected — that path is Email → WhatsApp
 * and has no SMS leg to reorder.
 *
 * NOTE: OTP_DUAL_CHANNEL_MOBILE=true sends BOTH channels in parallel and so
 * outranks this setting entirely — there is no "first" when both fire at once.
 */
const CHANNEL_WHATSAPP = 'whatsapp';
const CHANNEL_SMS = 'sms';
const CHANNELS = [CHANNEL_WHATSAPP, CHANNEL_SMS];

function normaliseChannel(v) {
  return String(v ?? '').trim().toLowerCase();
}
function isValidChannel(v) {
  return CHANNELS.includes(normaliseChannel(v));
}
function otpChannel() {
  const v = normaliseChannel(getProperty('login.otp.channel'));
  return v === CHANNEL_SMS ? CHANNEL_SMS : CHANNEL_WHATSAPP;
}

/*
 * DUAL-CHANNEL send — `login.otp.dual.channel`, the property form of the old
 * OTP_DUAL_CHANNEL_MOBILE env var. When on, WhatsApp AND SMS both fire in
 * parallel and the user takes whichever lands first.
 *
 * Why it exists: Gallabox returns ACCEPTED the instant it QUEUES a message and
 * exposes no delivery-status API. If the template is registered with Gallabox
 * but not fully Meta-approved, Gallabox reports success while the user's phone
 * never buzzes — and because the SMS fallback only fires on a reported FAILURE,
 * SMS never runs and the user is silently locked out. Dual-channel converts that
 * silent lockout into a redundant second message.
 *
 * Precedence — property WINS, env is a transitional fallback:
 *   recognised property value ('true'/'false')  → use it
 *   otherwise                                   → OTP_DUAL_CHANNEL_MOBILE
 *   otherwise                                   → false
 * The env fallback is deliberate and temporary. Seeding the property outright
 * would silently flip any host currently running OTP_DUAL_CHANNEL_MOBILE=true
 * back to single-channel, so the property is left UNSEEDED and only starts
 * winning once an admin actually sets it from Admin Actions. Once every host has
 * the property set, drop the env read (and the var) — see the migration notes.
 */
function dualChannelEnabled() {
  const raw = getProperty('login.otp.dual.channel');
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return String(process.env.OTP_DUAL_CHANNEL_MOBILE || 'false').toLowerCase() === 'true';
}

// True when the stored property (not the env fallback) is what's in force —
// lets the Admin Actions card say whether it is showing a real setting or an
// inherited env default it has not taken ownership of yet.
function dualChannelFromProperty() {
  const v = String(getProperty('login.otp.dual.channel') ?? '').trim().toLowerCase();
  return v === 'true' || v === 'false';
}

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
  /*
   * Log the RESOLVED plan, not just the identifier type. Per-attempt outcomes
   * were already logged, but nothing recorded which channel was actually CHOSEN
   * — so after switching login.otp.channel there was no way to confirm from the
   * logs that the new order took effect in production. `dual=` is included
   * because dual-channel outranks the ordering entirely.
   */
  if (identifierIsEmail) {
    logger.info('Deliver OTP · context=' + contextLabel + ' · via=email · plan=email→whatsapp');
  } else {
    const dualNow = dualChannelEnabled();
    const primaryNow = otpChannel();
    const fallbackNow = primaryNow === CHANNEL_WHATSAPP ? CHANNEL_SMS : CHANNEL_WHATSAPP;
    logger.info(
      'Deliver OTP · context=' + contextLabel + ' · via=mobile · dual=' + dualNow
      + ' · plan=' + (dualNow ? 'whatsapp+sms (parallel)' : primaryNow + '→' + fallbackNow),
    );
  }

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
  //   Dual-channel (see dualChannelEnabled) sends BOTH WhatsApp and SMS in
  //   parallel. User gets whichever arrives first (and the other as redundant).
  //   Once the WhatsApp template is confirmed reliably delivering, switch it off
  //   from Admin Actions and we revert to single-channel fallback — it is now a
  //   DB property, so that no longer needs a redeploy during an incident.
  const mobileTarget = mobile || identifier;
  const dual = dualChannelEnabled();

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

  /*
   * Single-channel path, ORDERED by `login.otp.channel` (see otpChannel()).
   * The two legs are otherwise identical, so we pick primary/fallback rather
   * than duplicating the attempt-then-fallback block per channel — that way a
   * future third channel is one array entry, not another copy of this logic.
   */
  const primary = otpChannel();
  const fallback = primary === CHANNEL_WHATSAPP ? CHANNEL_SMS : CHANNEL_WHATSAPP;
  const send = {
    [CHANNEL_WHATSAPP]: () => tryWhatsApp({ mobile: mobileTarget, name, otp }),
    [CHANNEL_SMS]: () => trySms({ mobile: mobileTarget, otp }),
  };

  const a1 = await send[primary]();
  attempts.push({ channel: primary, ...a1 });
  logger.info(`${contextLabel} OTP ${primary} attempt: ${a1.delivered ? 'delivered' : 'failed'}${a1.error ? ` (${a1.error})` : ''}`);
  if (a1.delivered || a1.disabled) return { attempts, finalDelivered: !!a1.delivered, primaryChannel: primary };

  const a2 = await send[fallback]();
  attempts.push({ channel: fallback, ...a2, fallback: true });
  logger.warn(`${contextLabel} OTP ${primary} failed — falling back to ${fallback}${a2.delivered ? ' (ok)' : ` (${a2.error || 'failed'})`}`);
  return { attempts, finalDelivered: !!a2.delivered, primaryChannel: primary };
}

module.exports = {
  deliverOtp,
  // Exported for the Admin Action route (read + validate the stored channel).
  otpChannel, isValidChannel, normaliseChannel, CHANNELS, CHANNEL_WHATSAPP, CHANNEL_SMS,
  dualChannelEnabled, dualChannelFromProperty,
};
