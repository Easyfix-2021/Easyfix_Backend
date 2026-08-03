const { modernError } = require('../utils/response');
const logger = require('../logger');

/*
 * Maintenance gate — parks incoming API traffic while a destructive maintenance
 * operation runs INSIDE this process.
 *
 * WHY THIS EXISTS: the QA database refresh (services/qa-db-refresh.service.js)
 * drops and reloads the schema this very process is connected to. The obvious
 * design — "stop the backend container, restore, start it" — is impossible from
 * a job running INSIDE that container: stopping the container kills the job
 * mid-restore, leaving QA with a half-loaded schema and nobody to send the
 * failure email. This gate is the in-process equivalent: it achieves the real
 * intent (no application traffic touches a half-restored database) without the
 * process having to destroy itself.
 *
 * `/api/health` IS DELIBERATELY EXEMPT and this is load-bearing, not a nicety.
 * The Dockerfile declares HEALTHCHECK against /api/health every 30s with 3
 * retries; answering 503 there would mark the container unhealthy and Docker
 * would restart it — killing the very restore this gate exists to protect. The
 * health route is JWT-free and DB-free, so it stays honest during the window.
 *
 * We deliberately do NOT close the DB pool during maintenance. A mysql2 pool
 * cannot be reopened after end() (db.js closePool is for shutdown only), so
 * draining it would leave the process needing a restart to serve again. Pooled
 * connections simply error while the schema is gone and mysql2 replaces them.
 */

// Module-level so the whole process shares one view. Single-container QA — there
// is no cross-replica coordination to do, and none is needed: the job that sets
// this flag is the same process that serves the traffic being gated.
let _active = false;
let _reason = null;
let _since = null;

function begin(reason) {
  _active = true;
  _reason = String(reason || 'maintenance');
  _since = Date.now();
  logger.warn(`Maintenance mode ON — API traffic will be refused with 503 · reason=${_reason}`);
}

function end() {
  if (!_active) return;
  const heldMs = _since ? Date.now() - _since : 0;
  _active = false;
  _reason = null;
  _since = null;
  logger.info(`Maintenance mode OFF — API traffic resumed after ${heldMs} ms`);
}

function isActive() {
  return _active;
}

function status() {
  return { active: _active, reason: _reason, since: _since ? new Date(_since).toISOString() : null };
}

/*
 * Express middleware. Mount AFTER the request-context middleware so the refusals
 * still carry the contextual log line, and BEFORE the route stack so no handler
 * can touch the database mid-restore.
 *
 * 503 + Retry-After is the correct shape here: the service is temporarily
 * unavailable and WILL return, which is exactly what a client (or a mobile app
 * retry) should be told. Never 500 — nothing has failed.
 */
function maintenance(req, res, next) {
  if (!_active) return next();
  // The container's own healthcheck must keep succeeding — see the header note.
  if (req.path === '/health' || req.originalUrl.startsWith('/api/health')) return next();
  res.set('Retry-After', '120');
  return modernError(res, 503, `EasyFix is briefly unavailable — ${_reason || 'maintenance'} in progress. Please retry shortly.`);
}

module.exports = { maintenance, begin, end, isActive, status };
