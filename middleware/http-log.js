const logger = require('../logger');

/*
 * Per HTTP request, sharing the contextual format with app logs (see
 * utils/log-format.js). Two shapes depending on whether the request emitted
 * app logs:
 *
 *   NO app logs → one full standalone line:
 *     [12:34:56] [Mobile]  9310992052  → [INFO]  GET    /api/mobile/team  304 (310 ms)
 *     [12:34:59] [CRM]     harshit@…   → [ERROR] POST   /api/admin/jobs  500 (1204 ms) · server error
 *
 *   WITH app logs → the logger prints a METHOD-path HEADER on the first app log
 *   (so the endpoint heads its group), then the access line collapses to a
 *   compact `↳ <status> (<ms>)` outcome at the bottom:
 *     [12:34:56] [Mobile]  9310992052  → [INFO]  GET    /api/mobile/earnings?from=…&to=…
 *     [12:34:56] [Mobile]  9310992052  → [INFO]  Earnings requested · …
 *     [12:34:56] [Mobile]  9310992052  → [INFO]  Returning 0 earning record(s) · …
 *     [12:34:56] [Mobile]  9310992052  → [INFO]  ↳ 200 (167 ms)
 *
 * LEVEL by status class: 2xx/3xx INFO · 4xx WARN · 5xx ERROR.
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

const { levelFromStatus, contextLine, methodTag, redactUrl } = require('../utils/log-format');

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
  // Redact identity-shaped values (Aadhaar / PAN / mobile / magic-link token)
  // ONCE at capture, so every downstream use below is safe by construction.
  // Numeric surrogate ids are left intact, so the route-matching checks below
  // (job location pings, AI-calling polls) are unaffected.
  const path = redactUrl(req.originalUrl);

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

    // High-frequency location telemetry (POST /jobs/:id/location — one ping every
    // few seconds per active job, across many technicians) would flood the log.
    // Keep SUCCESSFUL pings at debug so everyday logs stay readable; failures
    // (4xx/5xx) fall through to the normal warn/error path below.
    if (status < 400 && req.method === 'POST' && /\/jobs\/\d+\/location(?:[/?]|$)/.test(path)) {
      logger.debug(`${status} POST ${path} (${duration} ms)`);
      return;
    }

    // AI-calling status poll (GET /api/admin/validate/ai-calling/<id|flows>) — the
    // UI polls every few seconds while a call is live. Keep SUCCESSFUL polls at
    // debug so the call's real start/answer/end/error lines stay readable;
    // failures (4xx/5xx) fall through to the normal warn/error path below.
    if (status < 400 && req.method === 'GET' && /\/admin\/validate\/ai-calling\//.test(path)) {
      logger.debug(`${status} GET ${path} (${duration} ms)`);
      return;
    }

    // Access line, same `[time] [surface] identity → [LEVEL] …` shape as app
    // logs. If the request emitted app logs, the logger already printed a header
    // (METHOD path) ABOVE them, so here we only need the compact outcome
    // `↳ <status> (<ms>)`. Otherwise we print the full standalone line.
    // LEVEL follows the status class (2xx/3xx INFO · 4xx WARN · 5xx ERROR).
    const level = levelFromStatus(status);
    const hint = hintFor(res, status);
    const summary = req._logHeaderEmitted
      ? `↳ ${status} (${duration} ms)${hint}`
      : `${methodTag(req.method)} ${path}  ${status} (${duration} ms)${hint}`;
    logger.http(contextLine(req, level, summary));
  });

  next();
};
