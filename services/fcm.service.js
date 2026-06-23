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
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

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

async function sendPush({ token, title, body, data = {} }) {
  const originalToken = token;
  if (!token) return { delivered: false, error: 'token required' };
  if (!title && !body) return { delivered: false, error: 'title or body required' };

  if (disabled()) {
    logger.test(`Push suppressed (NOTIFICATIONS_DISABLE) · token=${token.slice(0, 12)}… · "${title}"`);
    return { delivered: false, disabled: true };
  }
  if (!configured()) return { delivered: false, error: 'FCM v1 not configured' };

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

module.exports = { sendPush };
