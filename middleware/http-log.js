const logger = require('../logger');

/*
 * One line per HTTP request, in plain English, with emoji signals.
 *
 * Format:
 *   12:34:56  ✓  200 GET    /api/auth/me         (6 ms) · harshit@channelplay.in
 *   12:34:57  🔒 401 POST   /api/auth/verify-otp (24 ms) · guest · authentication required
 *   12:34:58  🛑 429 GET    /api/integration/v1/services (0 ms) · api:decathlon · rate limit
 *   12:34:59  💥 500 POST   /api/admin/jobs      (1204 ms) · harshit@channelplay.in · server error
 *
 * Icons by status class:
 *   2xx ✓ (green)    3xx ↪ (magenta)    4xx generic ⚠
 *   401/403 🔒       404 ⚠              429 🛑       5xx 💥
 *
 * Method is tinted so the eye can find it fast:
 *   GET cyan · POST green · PATCH/PUT yellow · DELETE red · OPTIONS gray
 *
 * CORS preflight (OPTIONS 2xx) is suppressed UNCONDITIONALLY by default —
 * automatic browser-level traffic with no application semantic and the
 * loudest source of dev-log noise (every actual request gets a paired
 * OPTIONS line on a different-origin frontend). To re-enable for
 * debugging a CORS misconfiguration set `LOG_OPTIONS=true` in the env;
 * a `LOG_LEVEL=debug` env alone is no longer enough (that gate was the
 * old behaviour and still leaked OPTIONS when devs had debug on for
 * other reasons).
 */

const isTTY = process.stdout.isTTY;
const ANSI = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', gray: '\x1b[90m',
};
const paint = (color, s) => (isTTY ? `${ANSI[color]}${ANSI.bold}${s}${ANSI.reset}` : String(s));

const METHOD_COLOR = {
  GET: 'cyan', POST: 'green', PATCH: 'yellow', PUT: 'yellow',
  DELETE: 'red', OPTIONS: 'gray',
};

function quickHint(status) {
  if (status === 429) return ' · rate limit';
  if (status === 401) return ' · authentication required';
  if (status === 403) return ' · forbidden';
  if (status === 404) return ' · not found';
  if (status >= 500) return ' · server error';
  return '';
}

// Prefer a per-request reason stamped by the handler (res.locals.logHint, set by
// modernError/legacyError + the notFound handler) so the line says WHAT failed —
// e.g. " · Job 123 not found" / " · no matching route" — falling back to the
// generic status hint when no handler reason was recorded.
function hintFor(res, status) {
  const custom = res.locals && res.locals.logHint;
  if (custom) return ` · ${custom}`;
  return quickHint(status);
}

module.exports = function httpLog(req, res, next) {
  const started = Date.now();
  const path = req.originalUrl;

  res.on('finish', () => {
    const duration = Date.now() - started;
    const status = res.statusCode;

    if (req.method === 'OPTIONS' && status < 400) {
      // Dedicated env knob — LOG_LEVEL=debug used to enable this and
      // ended up making everyday dev logs unreadable. The new flag is
      // off by default; flip to 'true' only when chasing a CORS bug.
      if (String(process.env.LOG_OPTIONS).toLowerCase() === 'true') {
        logger.debug(`${status} OPTIONS ${path} (${duration} ms)`);
      }
      return;
    }

    const methodStr = paint(METHOD_COLOR[req.method] || 'gray', req.method.padEnd(6));
    const who =
      req.user?.official_email ||
      req.spoc?.contact_email ||
      (req.tech?.efr_no ? `tech:${req.tech.efr_no}` : null) ||
      (req.integrationClient?.loginName ? `api:${req.integrationClient.loginName}` : null) ||
      'guest';

    const sentence = `${status} ${methodStr} ${path}  (${duration} ms) · ${who}${hintFor(res, status)}`;

    if (status === 429)                        logger.rate(sentence);
    else if (status === 401 || status === 403) logger.security(sentence);
    else if (status >= 500)                    logger.error(sentence);
    else if (status >= 400)                    logger.warn(sentence);
    else if (status >= 300)                    logger.event('↪', 'magenta', sentence);
    else                                       logger.event('✓', 'green', sentence);
  });

  next();
};
