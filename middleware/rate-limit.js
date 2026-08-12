/*
 * Simple in-memory rate limiter (per-process). Phase 14 scaffolding.
 * For multi-instance production: swap the Map for a Redis store.
 * Expired entries are swept lazily, at most once per windowMs, to keep
 * the Map from growing unbounded on IP-keyed public surfaces.
 *
 * Usage:
 *   const { rateLimit } = require('./middleware/rate-limit');
 *   router.use('/api/integration', rateLimit({ windowMs: 60_000, max: 600, key: (req) => req.integrationClient?.id }));
 */

const { modernError } = require('../utils/response');

function rateLimit({ windowMs = 60_000, max = 600, key = (req) => req.ip } = {}) {
  const hits = new Map(); // key → { count, resetAt }
  let lastSweep = Date.now();
  return (req, res, next) => {
    const k = String(key(req) || 'anon');
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      lastSweep = now;
      for (const [mk, mv] of hits) {
        if (now > mv.resetAt) hits.delete(mk);
      }
    }
    const entry = hits.get(k);
    if (!entry || now > entry.resetAt) {
      hits.set(k, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return modernError(res, 429, 'rate limit exceeded');
    }
    entry.count++;
    next();
  };
}

/*
 * ── failureBreaker — a limiter that charges only for REFUSALS ─────────────
 *
 * rateLimit() above counts every request on the way in, which is right for a
 * budgeted action but wrong for an inbound provider webhook: the moment the
 * provider is configured correctly, a genuine burst of customer replies is
 * exactly the traffic we want, and a plain limiter would start dropping it.
 * What actually needs bounding is the FAILING case — a provider (or a prober)
 * hammering an endpoint it cannot authenticate to.
 *
 * So the budget is spent only by refusals, and a single success clears it. That
 * makes it a circuit breaker rather than a throttle: it opens on repeated
 * failure, and correct traffic can never trip it no matter the volume.
 *
 * ⚠ IT SUPPRESSES LOGS, AND THAT IS HALF THE POINT. A retry-storm against a
 * misconfigured secret costs little CPU per request — the real damage is a WARN
 * per attempt, indefinitely, burying every other line in the log and inflating
 * ingest. While open it emits ONE line per window carrying the suppressed count,
 * so the incident is still visible and still countable, just not shouted.
 *
 * The 429 + Retry-After matters too: a well-behaved provider backs off when told
 * to, so answering 429 rather than 401 reduces the load at its source rather
 * than absorbing it. (Per-process, like rateLimit — with several replicas each
 * holds its own view, which is fine for a backstop and would need Redis to be
 * exact.)
 *
 * Usage:
 *   const breaker = failureBreaker({ windowMs: 60_000, maxFailures: 20 });
 *   router.post('/hook', breaker.guard, (req, res) => {
 *     if (!authOk(req)) { breaker.recordFailure(req); return refuse(res); }
 *     breaker.recordSuccess(req);
 *     ...
 *   });
 */
function failureBreaker({
  windowMs = 60_000,
  maxFailures = 20,
  key = (req) => req.ip,
  onOpen = null,      // (info) => void — called ONCE per window, for the log
} = {}) {
  const state = new Map(); // key → { failures, resetAt, suppressed, announced }
  let lastSweep = Date.now();

  const sweep = (now) => {
    if (now - lastSweep <= windowMs) return;
    lastSweep = now;
    for (const [k, v] of state) if (now > v.resetAt) state.delete(k);
  };

  const entryFor = (k, now) => {
    const e = state.get(k);
    if (e && now <= e.resetAt) return e;
    const fresh = { failures: 0, resetAt: now + windowMs, suppressed: 0, announced: false };
    state.set(k, fresh);
    return fresh;
  };

  return {
    /** Express middleware: short-circuits with 429 while the breaker is open. */
    guard(req, res, next) {
      const now = Date.now();
      sweep(now);
      const e = state.get(String(key(req) || 'anon'));
      if (!e || now > e.resetAt || e.failures < maxFailures) return next();
      e.suppressed++;
      res.setHeader('Retry-After', Math.ceil((e.resetAt - now) / 1000));
      return modernError(res, 429, 'too many failed attempts — retry later');
    },

    /**
     * Charge one refusal. Returns true the FIRST time the breaker opens in a
     * window, so the caller can log the transition exactly once.
     */
    recordFailure(req) {
      const now = Date.now();
      const k = String(key(req) || 'anon');
      const e = entryFor(k, now);
      e.failures++;
      if (e.failures >= maxFailures && !e.announced) {
        e.announced = true;
        if (onOpen) {
          onOpen({ key: k, failures: e.failures, windowMs, retryAfterSec: Math.ceil((e.resetAt - now) / 1000) });
        }
        return true;
      }
      return false;
    },

    /*
     * One authenticated request proves the sender is legitimate, so the budget
     * is returned in full rather than decremented. Anything less would leave a
     * correctly-configured provider serving out a penalty it no longer deserves.
     */
    recordSuccess(req) { state.delete(String(key(req) || 'anon')); },

    /** Test/diagnostic seam only. */
    __state: state,
  };
}

module.exports = { rateLimit, failureBreaker };
