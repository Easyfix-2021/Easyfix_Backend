const jwt = require('jsonwebtoken');
const logger = require('../logger');

/*
 * Push notifications via Firebase Cloud Messaging — HTTP v1 API.
 *
 * Migrated off the deprecated legacy /fcm/send (static `Key=` auth, which Google
 * has shut down) to:
 *   POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send
 *   Authorization: Bearer <short-lived OAuth2 access token>
 * The access token is minted from a service account (RS256-signed JWT exchanged
 * at oauth2.googleapis.com/token) and cached for its ~1h lifetime.
 *
 * FCM REGISTRATION TOKENS ARE UNCHANGED across the legacy and v1 APIs, so existing
 * Android/iOS devices need no change — only this server-side sender moves to v1.
 *
 * Config (service-account JSON fields, via env):
 *   FCM_PROJECT_ID    — Firebase project id
 *   FCM_CLIENT_EMAIL  — service account client_email
 *   FCM_PRIVATE_KEY   — service account private_key (newlines may be \n-escaped)
 *
 * NOTIFICATIONS_DISABLE + TEST_MODE (TEST_EMAILS|TEST_MOBILE → TEST_FCM_TOKEN)
 * behaviour, the return shape ({ delivered, deadToken, providerResponse, … }),
 * and the public sendPush() signature are all preserved from the legacy version.
 *
 * LOUD/ALERTING STYLE (2026-07-29, OPTIONAL + OPT-IN): sendPush() also accepts
 * { androidChannelId, sound, iosSound, interruptionLevel }. Passing ANY of them
 * attaches an `android.notification` block + an `apns` block so the push rings
 * on a dedicated high-importance channel instead of arriving as a silent chirp.
 * Passing NONE of them emits the payload EXACTLY as it always has — same keys,
 * same order, no undefined keys — so the five other push senders (attendance
 * reminder, notice publish, registration status, validate-flows test, admin
 * notification) are byte-for-byte unchanged. The gate is deliberately "did the
 * caller opt in", not a flag read, so this module stays flag-agnostic.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

// Vibration pattern for an opted-in loud push: [delay, vibrate, sleep, vibrate].
// FCM v1 wants protobuf Durations ("0.5s"), not milliseconds. Two firm pulses
// read as "act on me now" without becoming an alarm. `default_vibrate_timings`
// is left unset (proto default false), which is what makes this pattern apply.
const LOUD_VIBRATE_TIMINGS = ['0s', '0.5s', '0.3s', '0.5s'];

function disabled() {
  return String(process.env.NOTIFICATIONS_DISABLE).toLowerCase() === 'true';
}

function privateKey() {
  // Env-stored PEMs usually have their newlines escaped as literal "\n".
  return (process.env.FCM_PRIVATE_KEY || '').replace(/\\n/g, '\n');
}

function configured() {
  return !!(process.env.FCM_PROJECT_ID && process.env.FCM_CLIENT_EMAIL && privateKey());
}

// Cached OAuth2 access token (≈1h TTL); refreshed when within 60s of expiry.
let cachedToken = null; // { token, exp } — exp in epoch seconds

// Latches after the first "not configured" warning so a misconfigured deploy
// surfaces the cause once (not on every push attempt).
let warnedUnconfigured = false;

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp > now + 60) return cachedToken.token;

  const assertion = jwt.sign(
    { iss: process.env.FCM_CLIENT_EMAIL, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
    privateKey(),
    { algorithm: 'RS256' },
  );
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`OAuth token mint failed (${res.status}): ${JSON.stringify(json).slice(0, 160)}`);
  }
  cachedToken = { token: json.access_token, exp: now + (json.expires_in || 3600) };
  return cachedToken.token;
}

/*
 * Build the FCM v1 request body. Extracted from sendPush() as a PURE function
 * so the exact emitted shape can be characterization-tested without a network
 * call or service-account env (see tests/fcm-push-payload.test.js) — the whole
 * point of the loud-alert work is that the DEFAULT payload never drifts.
 *
 * Without any of { androidChannelId, sound, interruptionLevel } the returned
 * object is exactly the four-key message it has always been. With them, the
 * android.notification + apns blocks are ATTACHED (mutated on) afterwards
 * rather than spread conditionally into the literal, so the default path can
 * never gain an `undefined` key.
 */
function buildMessage({ token, title, body, data = {}, androidChannelId, sound, iosSound, interruptionLevel }) {
  // v1 requires every data value to be a string.
  const stringData = {};
  for (const [k, v] of Object.entries(data || {})) stringData[k] = v == null ? '' : String(v);

  const payload = {
    message: {
      token,
      notification: { title: title || '', body: body || '' },
      data: stringData,
      android: { priority: 'high' },
    },
  };

  // ── OPTIONAL loud/alerting style — attached ONLY when a caller opted in ──
  // Every other push sender passes none of these, so their message object is
  // byte-for-byte what it was before this option existed.
  if (androidChannelId || sound || interruptionLevel) {
    // Android: on API 26+ the CHANNEL carries importance/sound/vibration, so
    // channel_id is the load-bearing field — `sound` here is the pre-26
    // fallback and the resource name the app registers against the channel.
    const androidNotification = {};
    if (androidChannelId) androidNotification.channel_id = androidChannelId;
    if (sound) androidNotification.sound = sound;
    androidNotification.notification_priority = 'PRIORITY_MAX';
    androidNotification.vibrate_timings = LOUD_VIBRATE_TIMINGS;
    payload.message.android.notification = androidNotification;

    // iOS: apns-priority 10 = deliver immediately; `interruption-level`
    // time-sensitive is what lets the alert break through Focus/Do-Not-Disturb.
    // APNs wants the sound FILE name (with extension) while Android wants the
    // bare resource name — hence the ".wav" default instead of reusing `sound`.
    const aps = {};
    if (sound) aps.sound = iosSound || `${sound}.wav`;
    if (interruptionLevel) aps['interruption-level'] = interruptionLevel;
    payload.message.apns = { headers: { 'apns-priority': '10' }, payload: { aps } };
  }

  return payload;
}

async function sendPush({ token, title, body, data = {}, androidChannelId, sound, iosSound, interruptionLevel }) {
  const originalToken = token;
  logger.info('Send push · title="' + (title || '') + '" · dataKeys=' + Object.keys(data || {}).length);
  if (!token) return { delivered: false, error: 'token required' };
  if (!title && !body) return { delivered: false, error: 'title or body required' };

  if (disabled()) {
    logger.test(`Push suppressed (NOTIFICATIONS_DISABLE) · token=${token.slice(0, 12)}… · "${title}"`);
    return { delivered: false, disabled: true };
  }
  if (!configured()) {
    // Fail loud (once per process). The #1 silent-push cause is a deploy that
    // never received the FCM v1 service-account env vars — previously this just
    // returned not-delivered with no signal (prod incident 2026-07-02). The
    // boot-time check in server.js catches it even earlier, at startup.
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      logger.warn('Push NOT sent — FCM v1 not configured (missing FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY). Suppressing further occurrences this run.');
    }
    return { delivered: false, error: 'FCM v1 not configured' };
  }

  // ── TEST-MODE INTERCEPTION (unchanged contract from the legacy sender) ──
  let redirected = false;
  const testModeActive = !!(process.env.TEST_EMAILS || process.env.TEST_MOBILE);
  if (testModeActive) {
    if (process.env.TEST_FCM_TOKEN) {
      token = process.env.TEST_FCM_TOKEN;
      redirected = true;
      logger.test(`Push redirected from ${originalToken.slice(0, 12)}… → ${token.slice(0, 12)}… (TEST_FCM_TOKEN)`);
    } else {
      logger.test(`Push skipped · intended=${originalToken.slice(0, 12)}… · "${title}" · set TEST_FCM_TOKEN to allow`);
      return { delivered: false, testSkipped: true, intendedTo: originalToken };
    }
  }

  const payload = buildMessage({ token, title, body, data, androidChannelId, sound, iosSound, interruptionLevel });

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    logger.error(`Push auth error · ${err.message}`);
    return { delivered: false, error: err.message };
  }

  const url = `https://fcm.googleapis.com/v1/projects/${process.env.FCM_PROJECT_ID}/messages:send`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    const delivered = res.ok;
    // v1 reports a permanently-dead registration token as HTTP 404 / UNREGISTERED
    // — surface a flag so callers can prune it from their token stores.
    const deadToken = !delivered && (res.status === 404 || /UNREGISTERED|NOT_FOUND/i.test(text));
    const tail = redirected ? `${token.slice(0, 12)}… (was ${originalToken.slice(0, 12)}…)` : `${token.slice(0, 12)}…`;
    if (delivered) logger.push(`sent · token=${tail} · "${title || ''}"`);
    else           logger.warn(`Push rejected · token=${tail} · status=${res.status} · ${text.slice(0, 160)}`);
    return { delivered, deadToken, providerResponse: text, httpStatus: res.status, redirected, intendedTo: redirected ? originalToken : undefined };
  } catch (err) {
    logger.error(`Push error · token=${token.slice(0, 12)}… · ${err.message}`);
    return { delivered: false, error: err.message };
  }
}

// `buildMessage` is exported for the payload characterization test only — no
// production caller should build a message without going through sendPush().
module.exports = { sendPush, isConfigured: configured, buildMessage };
