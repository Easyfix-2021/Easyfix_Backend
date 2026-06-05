const cors = require('cors');

// Each *_URL env var may be a single origin OR a comma-separated list.
// Examples:
//   CLIENT_URL=http://localhost:5181
//   CLIENT_URL=http://localhost:5181,http://10.30.2.30:5181,https://corporates.qa.easyfix.in
// Lets one VM serve dev + IP + domain requests without a code change.
//
// Trailing-slash normalisation (2026-06-05). A common operator paper-cut
// is to set `CRM_URL=https://crm.easyfix.in/` (with the trailing slash
// people normally type when copying from the address bar). But browsers
// send the Origin header WITHOUT a trailing slash per RFC 6454
// (Origin = scheme :// host [: port], no path component), so a literal
// `allowedOrigins.includes(reqOrigin)` then mismatches and silently
// denies all CORS preflights — diagnosed by an opaque "Provisional
// headers are shown" in Chrome's network panel. Strip any trailing
// slashes here so the env-side value is canonicalised to the same shape
// the browser will actually send.
function splitOrigins(s) {
  return String(s || '')
    .split(',')
    .map((x) => x.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

const PORT = process.env.PORT || 5100;

// Explicit cross-origin allowlist — frontends hosted on a DIFFERENT host
// than the backend. CRM_URL, CLIENT_URL, and MOBILE_APP_URL are different
// hostnames in every environment, so they need env-configured overrides.
//
// MOBILE_APP_URL covers the Easyfix_Technician_Mobile_Application — relevant
// when the app is served as a web preview (Vite/Expo dev server) or wrapped
// in a Capacitor/Cordova shell that emits an Origin header. Native React
// Native fetches don't send Origin so they're already allow-by-default via
// the "no Origin → allow" branch below; this entry covers the web shell.
// Typical values:
//   - Local web preview:  http://localhost:5182
//   - Expo dev server:    http://localhost:8081
//   - Capacitor shell:    capacitor://localhost
//   - Ionic shell:        ionic://localhost
//   - QA web preview:     https://qa.mobile.easyfix.in
//   - Prod web preview:   https://mobile.easyfix.in
// Comma-separated for multiple (same splitOrigins behaviour as CRM_URL).
const allowedOrigins = [
  ...splitOrigins(process.env.CRM_URL        || 'http://localhost:5180'),
  ...splitOrigins(process.env.CLIENT_URL     || 'http://localhost:5181'),
  ...splitOrigins(process.env.MOBILE_APP_URL || 'http://localhost:5182,capacitor://localhost,ionic://localhost'),
  // SELF_URL is the optional override for unusual setups (e.g. when the
  // BE is reachable under multiple hostnames simultaneously beyond what
  // same-host autodetection covers). Default: empty — same-host
  // detection below handles 99% of cases automatically.
  ...splitOrigins(process.env.SELF_URL || ''),
];

/*
 * Same-host auto-allow.
 *
 * Swagger UI lives at /api/docs on the same BE that serves the API.
 * The "Quick Login" button does fetch('/api/mobile/auth/login-otp') —
 * which the browser sends with `Origin: <whatever-host-served-swagger>`.
 * On local that's http://localhost:5100; on QA https://qa.backend.easyfix.in;
 * on prod https://backend.easyfix.in. We don't want to maintain a per-env
 * allowlist for what is functionally a same-origin request.
 *
 * Strategy: parse the incoming Origin header and compare its host to
 * the request's Host header. If they match, it IS same-origin from the
 * user's browser perspective — regardless of protocol-mismatch caused
 * by reverse proxies (HTTPS at the edge → HTTP at the container).
 *
 * Protocol intentionally ignored. Behind ACA/Nginx the BE sees HTTP
 * even when the browser connected via HTTPS; matching only the host
 * avoids that false-negative.
 */
function originHost(origin) {
  try { return new URL(origin).host; }
  catch (e) { return null; }
}

// Use the `cors` library's delegate pattern (signature: `(req, callback)`)
// so we get access to the full request and can compare Origin↔Host on a
// per-request basis WITHOUT re-creating the middleware each call.
function corsDelegate(req, callback) {
  const reqOrigin = req.header('Origin');
  const baseOptions = {
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };

  // Same-origin / curl / health probes (no Origin header) — allowed.
  if (!reqOrigin) return callback(null, { ...baseOptions, origin: true });

  // Explicit allowlist match (cross-origin FE hosts: CRM_URL, CLIENT_URL,
  // MOBILE_APP_URL, plus optional SELF_URL).
  if (allowedOrigins.includes(reqOrigin)) {
    return callback(null, { ...baseOptions, origin: true });
  }

  // Same-host auto-allow: Origin's host === request's Host header. Handles
  // Swagger Quick Login on local / QA / prod without per-env config.
  const reqHost = req.get('host');
  if (reqHost && originHost(reqOrigin) === reqHost) {
    return callback(null, { ...baseOptions, origin: true });
  }

  // Deny — `origin: false` disables CORS headers so the browser rejects.
  callback(new Error(`CORS: origin ${reqOrigin} not allowed`), { ...baseOptions, origin: false });
}

module.exports = cors(corsDelegate);
