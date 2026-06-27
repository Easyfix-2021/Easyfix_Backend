const logger = require('../logger');

/*
 * SMS delivery via SMSCountry.
 * Legacy contract replicated from ACD_APIs/.../SmsSender.java:
 *   POST http://smscountry.com/SMSCwebservice_Bulk.aspx
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: User=...&passwd=...&mobilenumber=...&message=...&sid=...&mtype=N&DR=N
 *
 * Dev guard: NOTIFICATIONS_DISABLE=true short-circuits to a logged-only
 * "disabled" response — nothing hits the provider. Critical when developing
 * against the QA database, where mobile numbers belong to real customers.
 */

function disabled() {
  return String(process.env.NOTIFICATIONS_DISABLE).toLowerCase() === 'true';
}

function normaliseMobile(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  // Accept 10-digit (India) or 12-digit (91-prefixed). Downstream accepts either.
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  return null;
}

// Mask a mobile for logging — keep only the last 4 digits, never log the full number.
function maskMobile(m) {
  const s = String(m || '');
  return s.length <= 4 ? '****' : '******' + s.slice(-4);
}

async function send({ to, message }) {
  const originalMobile = normaliseMobile(to);
  if (!originalMobile) {
    logger.warn('SMS send rejected, invalid mobile');
    return { delivered: false, error: `invalid mobile "${to}"` };
  }
  if (!message) {
    logger.warn('SMS send rejected, empty message · to=' + maskMobile(originalMobile));
    return { delivered: false, error: 'message is empty' };
  }
  logger.info('Sending SMS · to=' + maskMobile(originalMobile) + ' · ' + message.length + ' chars');

  if (disabled()) {
    logger.test(`SMS suppressed (NOTIFICATIONS_DISABLE) · to=${originalMobile} · ${message.length} chars`);
    return { delivered: false, disabled: true };
  }

  const username   = process.env.SMS_USERNAME;
  const password   = process.env.SMS_PASSWORD;
  const senderId   = process.env.SMS_SENDER_ID || 'EsyFix';
  if (!username || !password) {
    logger.error('SMS send aborted, SMS_USERNAME/SMS_PASSWORD not configured · to=' + maskMobile(originalMobile));
    return { delivered: false, error: 'SMS_USERNAME/SMS_PASSWORD not configured' };
  }

  // ── TEST-MODE INTERCEPTION (last point before provider call) ──
  let mobile = originalMobile;
  let redirected = false;
  if (process.env.TEST_MOBILE) {
    const test = normaliseMobile(process.env.TEST_MOBILE);
    if (test) { mobile = test; redirected = true; }
  }
  if (redirected) {
    logger.test(`SMS redirected from ${originalMobile} → ${mobile} (TEST_MOBILE)`);
  }

  const body = new URLSearchParams({
    User: username,
    passwd: password,
    mobilenumber: mobile,
    message,
    sid: senderId,
    mtype: 'N',
    DR: 'N',
  }).toString();

  try {
    const res = await fetch('http://smscountry.com/SMSCwebservice_Bulk.aspx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await res.text();
    const delivered = res.ok && !/error|fail/i.test(text);
    const who = redirected ? `${mobile} (was ${originalMobile})` : mobile;
    // Log the provider body on both paths. A 200 OK with a silent-drop message
    // (e.g. DLT mismatch) is how operator-side rejection surfaces; without this
    // line, "200 but OTP never arrived" is indistinguishable from real success.
    const providerSnippet = text.replace(/\s+/g, ' ').slice(0, 200);
    if (delivered) logger.sms(`sent to ${who} · status=${res.status} · provider="${providerSnippet}"`);
    else           logger.warn(`SMS rejected · to=${who} · status=${res.status} · provider="${providerSnippet}"`);
    return { delivered, providerResponse: text, httpStatus: res.status, redirected, intendedTo: redirected ? originalMobile : undefined };
  } catch (err) {
    logger.error(`SMS error · to=${mobile} · ${err.message}`);
    return { delivered: false, error: err.message };
  }
}

module.exports = { send, normaliseMobile };
