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

// The BE's own host — needed because Swagger UI at /api/docs calls back
// into /api/* via fetch, which always attaches an Origin header. Browsers
// then run the CORS allowlist even on same-origin requests when the JS
// is the one initiating. Defaulting this to `http://localhost:${PORT}`
// makes the Quick Login button work out-of-the-box on local dev.
//
// Override via env `SELF_URL` (comma-separated for multiple — e.g. when
// the BE is reachable as both `localhost:5100` AND `127.0.0.1:5100` from
// the same Swagger UI page).
const PORT = process.env.PORT || 5100;

const allowedOrigins = [
  ...splitOrigins(process.env.CRM_URL    || 'http://localhost:5180'),
  ...splitOrigins(process.env.CLIENT_URL || 'http://localhost:5181'),
  ...splitOrigins(process.env.SELF_URL   || `http://localhost:${PORT},http://127.0.0.1:${PORT}`),
];

module.exports = cors({
  origin(origin, callback) {
    // Same-origin / curl / health probes (no Origin header) are allowed.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});
