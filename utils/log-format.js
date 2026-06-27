/*
 * Shared log formatting — the contextual line shape used by BOTH the per-request
 * access log (middleware/http-log.js) and request-scoped app logs (logger.js):
 *
 *   [HH:MM:SS] [reqId] [Surface]  identity              → [LEVEL]  message
 *
 * Columns are fixed-width (timestamp + reqId + surface tag + identity all padded)
 * so the `→ [LEVEL]` marker — and the message after it — start at the SAME column
 * on every line, whatever the surface or identity length. `reqId` is a 4-hex
 * per-request token (utils/request-context.js) so the lines of ONE request can be
 * grouped even when concurrent requests from the same tech/user interleave.
 *
 *   Surface  = the calling frontend / principal (Mobile / CRM / Client / API …).
 *   identity = tech mobile number (efr_no) or the logged-in user's email.
 *   LEVEL    = INFO / WARN / ERROR (/ DEBUG) — severity at a glance.
 */
const isTTY = process.stdout.isTTY;
const ANSI = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const paint = (color, s, { bold = true } = {}) =>
  isTTY ? `${ANSI[color]}${bold ? ANSI.bold : ''}${s}${ANSI.reset}` : String(s);

const stamp = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

// ── Surface: which frontend/principal the request came from ──────────────────
// Actor-type wins (a tech bearer on /api/shared resolves to a synthetic req.user
// with __principal:'mobile', so check that), path is the fallback for guests.
const SURFACE_COLOR = {
  Mobile: 'cyan', CRM: 'blue', Client: 'magenta', API: 'yellow',
  Auth: 'gray', Public: 'gray', Webhook: 'magenta', Shared: 'gray', Core: 'gray',
};
function surfaceOf(req) {
  if (!req) return 'Core';
  if (req.tech) return 'Mobile';
  if (req.spoc) return 'Client';
  if (req.user) {
    if (req.user.__principal === 'mobile') return 'Mobile';
    if (req.user.__principal === 'client') return 'Client';
    return 'CRM';
  }
  if (req.integrationClient) return 'API';
  const p = req.originalUrl || '';
  if (p.startsWith('/api/auth')) return 'Auth';
  if (p.startsWith('/api/public')) return 'Public';
  if (p.startsWith('/api/webhook')) return 'Webhook';
  if (p.startsWith('/api/mobile')) return 'Mobile';
  if (p.startsWith('/api/admin')) return 'CRM';
  if (p.startsWith('/api/client')) return 'Client';
  if (p.startsWith('/api/shared')) return 'Shared';
  return 'Core';
}

// ── Identity: who's logged in ────────────────────────────────────────────────
function identityOf(req) {
  if (!req) return 'system';
  if (req.tech && req.tech.efr_no) return String(req.tech.efr_no); // efr_no = mobile
  if (req.user && req.user.official_email) return req.user.official_email;
  if (req.spoc && req.spoc.contact_email) return req.spoc.contact_email;
  if (req.integrationClient && req.integrationClient.loginName) {
    return `api:${req.integrationClient.loginName}`;
  }
  return 'guest';
}

const LEVEL_COLOR = { INFO: 'green', WARN: 'yellow', ERROR: 'red', DEBUG: 'gray' };
function levelFromStatus(status) {
  if (status >= 500) return 'ERROR';
  if (status >= 400) return 'WARN';
  return 'INFO';
}

// HTTP method, tinted + padded — shared by the access line and the per-request
// header line (logger.js) so an endpoint reads the same in both places.
const METHOD_COLOR = {
  GET: 'cyan', POST: 'green', PATCH: 'yellow', PUT: 'yellow',
  DELETE: 'red', OPTIONS: 'gray',
};
function methodTag(method) {
  return paint(METHOD_COLOR[method] || 'gray', String(method).padEnd(6));
}

const SURFACE_W = 9; //  '[Webhook]'
const IDENTITY_W = 24; // long enough for typical emails; longer just overflows
const LEVEL_W = 7; //    '[ERROR]'

// Build one fully-formatted, coloured context line. Plain text is padded BEFORE
// colouring so ANSI escape codes never throw off column alignment.
function contextLine(req, level, message) {
  const ts = paint('gray', `[${stamp()}]`, { bold: false });
  const rid = paint('magenta', `[${(req && req.reqId) || '····'}]`, { bold: false });
  const surface = surfaceOf(req);
  const tag = paint(SURFACE_COLOR[surface] || 'gray', `[${surface}]`.padEnd(SURFACE_W));
  const id = paint('dim', String(identityOf(req)).padEnd(IDENTITY_W), { bold: false });
  const arrow = paint('gray', '→', { bold: false });
  const lvl = paint(LEVEL_COLOR[level] || 'gray', `[${level}]`.padEnd(LEVEL_W));
  return `${ts} ${rid} ${tag} ${id} ${arrow} ${lvl} ${message}`;
}

module.exports = { paint, ANSI, surfaceOf, identityOf, levelFromStatus, methodTag, contextLine, stamp };
