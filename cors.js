const cors = require('cors');

// Each *_URL env var may be a single origin OR a comma-separated list.
// Examples:
//   CLIENT_URL=http://localhost:5181
//   CLIENT_URL=http://localhost:5181,http://10.30.2.30:5181,https://corporates.qa.easyfix.in
// Lets one VM serve dev + IP + domain requests without a code change.
function splitOrigins(s) {
  return String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

const PORT = process.env.PORT || 5100;

// Explicit cross-origin allowlist — frontends hosted on a DIFFERENT host
// than the backend. CRM_URL and CLIENT_URL are different hostnames in
// every environment, so they need env-configured overrides.
const allowedOrigins = [
  ...splitOrigins(process.env.CRM_URL    || 'http://localhost:5180'),
  ...splitOrigins(process.env.CLIENT_URL || 'http://localhost:5181'),
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

  // Explicit allowlist match (cross-origin FE hosts: CRM_URL, CLIENT_URL).
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
