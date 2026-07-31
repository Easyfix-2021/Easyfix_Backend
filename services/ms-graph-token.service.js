const logger = require('../logger');

/*
 * Shared Microsoft Graph client-credentials token + a thin request helper.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * The client-credentials token acquisition used to live inside
 * services/email.service.js as a private `fetchGraphToken()`. A second Graph
 * consumer landed (services/entra-provisioning.service.js — mailbox creation +
 * the OTP mailbox-existence pre-check), and duplicating the token flow would
 * have meant two independent caches minting two tokens against the same app
 * registration and two places to fix when a secret rotates. The helper was
 * therefore EXTRACTED here verbatim: same env vars, same 2-minute expiry
 * buffer, same error text. email.service.js now delegates to it, so its
 * observable behaviour is unchanged.
 *
 * ONE app registration serves every Graph call this backend makes:
 *   MS_GRAPH_TENANT_ID       — Azure AD directory (tenant) ID
 *   MS_GRAPH_CLIENT_ID       — App registration (client) ID
 *   MS_GRAPH_CLIENT_SECRET   — App registration client secret
 *
 * The APPLICATION permissions that app needs, per feature:
 *   Mail.Send             — services/email.service.js (already granted)
 *   User.ReadWrite.All    — create the Entra account, POST assignLicense, and
 *                           the GET /users/{upn} existence pre-check
 *   Organization.Read.All — GET /subscribedSkus to pick a licence SKU
 * See docs/ENTRA_PROVISIONING.md for the exact portal click-path.
 *
 * Because the scope is `.default` (all consented app permissions), a token
 * minted for sendMail is the SAME token used for the directory calls — no
 * second cache, no per-feature scope juggling. If a directory call comes back
 * 403 it means admin consent for that permission has not been granted yet; the
 * token itself is fine, so we must NOT invalidate the cache on 403 (only 401,
 * which is a genuinely rejected/expired token).
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Default per-request timeout. Graph directory writes are normally <1s; the
// generous ceiling exists so a hung TLS connection can never pin an Express
// worker (Add User awaits provisioning to report its outcome).
const DEFAULT_TIMEOUT_MS = Number(process.env.MS_GRAPH_TIMEOUT_MS || 15000);

// Token cache: module-singleton, shared by every Graph caller in the process.
// Rotates when within 2 min of expiry.
let cachedToken = null; // { token: string, expiresAt: number (ms epoch) }

/**
 * Mint (or reuse) an application-permission Graph bearer.
 * Throws when the three MS_GRAPH_* env vars are not configured, or when the
 * token endpoint answers non-2xx. Identical contract to the private
 * fetchGraphToken() this replaced.
 */
async function getGraphToken() {
  const tenantId     = process.env.MS_GRAPH_TENANT_ID;
  const clientId     = process.env.MS_GRAPH_CLIENT_ID;
  const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('MS_GRAPH_TENANT_ID / MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET not configured');
  }

  // Reuse cached token if >2 min remaining. Two-minute buffer avoids racing
  // a token that Graph would accept-then-reject in the middle of a long send.
  if (cachedToken && cachedToken.expiresAt - Date.now() > 120_000) {
    return cachedToken.token;
  }

  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         'https://graph.microsoft.com/.default',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Graph token fetch failed ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  cachedToken = {
    token:     data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) * 1000),
  };
  return cachedToken.token;
}

/**
 * Drop the cached token so the next call re-mints. Call this ONLY on a 401 —
 * it covers the case where the app secret was rotated while this process held
 * a live token. A 403 is a missing-consent problem, not a bad token, and
 * invalidating on 403 would just hammer the token endpoint.
 */
function invalidateGraphToken() {
  cachedToken = null;
}

/*
 * Graph stamps every response with a correlation id. Microsoft support asks
 * for it first when you open a ticket, so we surface it on every failure.
 * Header names differ by endpoint/age, hence the fallback chain; the body's
 * innerError also carries one on directory errors.
 */
function requestIdFrom(res, parsedBody) {
  const h = res && res.headers;
  const fromHeader = h && (h.get('request-id') || h.get('client-request-id') || h.get('x-ms-request-id'));
  if (fromHeader) return fromHeader;
  const inner = parsedBody && parsedBody.error && parsedBody.error.innerError;
  if (inner) return inner['request-id'] || inner.requestId || inner['client-request-id'] || null;
  return null;
}

/**
 * One Graph call. Returns a plain descriptor instead of throwing on HTTP
 * errors, because every caller here is fail-soft and needs the status code to
 * decide (404 = absent, 403 = consent missing, 429 = throttled …).
 *
 *   → { ok, status, json, text, requestId }
 *   → { ok: false, status: 0, networkError: '…' }   on timeout / DNS / TLS
 *
 * A 401 self-heals the token cache so the caller's retry (or the next caller)
 * mints a fresh bearer.
 */
async function graphRequest(path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, headers } = {}) {
  let token;
  try {
    token = await getGraphToken();
  } catch (e) {
    return { ok: false, status: 0, networkError: e.message, json: null, text: '', requestId: null };
  }

  const url = /^https?:\/\//.test(path) ? path : `${GRAPH_BASE}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(headers || {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // AbortSignal.timeout throws a DOMException('TimeoutError'); DNS/TLS throw
    // TypeError. Either way it is a transport failure, not a Graph verdict.
    return { ok: false, status: 0, networkError: e.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : e.message, json: null, text: '', requestId: null };
  }

  if (res.status === 401) invalidateGraphToken();

  const text = await res.text().catch(() => '');
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { /* Graph returned non-JSON (e.g. empty 204) */ } }

  return {
    ok: res.ok,
    status: res.status,
    json,
    text,
    requestId: requestIdFrom(res, json),
  };
}

module.exports = {
  getGraphToken,
  invalidateGraphToken,
  graphRequest,
  GRAPH_BASE,
  DEFAULT_TIMEOUT_MS,
};
