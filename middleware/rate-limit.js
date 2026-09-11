/*
 * Simple in-memory rate limiter (per-process). Phase 14 scaffolding.
 * Where a ceiling must hold across containers (the public login routes), use
 * services/attempt-window.service.js sharedRateLimit — same options, counted
 * in tbl_attempt_window.
 * Expired entries are swept lazily, at most once per windowMs, to keep
 * the Map from growing unbounded on IP-keyed public surfaces.
 *
 * Usage:
 *   const { rateLimit } = require('./middleware/rate-limit');
 *   router.use('/api/integration', rateLimit({ windowMs: 60_000, max: 600, key: (req) => req.integrationClient?.id }));
 */

const { modernError } = require('../utils/response');

// `message` is what the user reads — the login screens show `error` verbatim.
function rateLimit({ windowMs = 60_000, max = 600, key = (req) => req.ip, message = 'rate limit exceeded' } = {}) {
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
      return modernError(res, 429, message);
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

/*
 * ── attemptWindow — "N wrong codes per window", for codes with no DB counter ─
 *
 * The same rule as the OTP guess cap (services/otp-attempts.service.js: 5 per
 * 30 minutes, counted from the first attempt, lifting by itself, cleared by a
 * right answer) for codes stored where there is no otp_details row to count on:
 * the checkout PIN (tbl_job.otp) and the profile/bank-change OTP
 * (tbl_easyfixer). Neither table is ours to alter.
 *
 * CLAIM BEFORE COMPARE, like the SQL version. claim() counts the attempt and
 * refuses a full window in one synchronous step; call it with NO await between
 * it and the compare, and a burst of parallel guesses cannot overshoot — Node
 * runs each claim to completion before the next. Then clear() on a right
 * answer, or read state() after a wrong one for what to tell the user.
 *
 * Per-process, like rateLimit: a restart forgets it, and with several replicas
 * each counts on its own (a ceiling of N × replicas).
 */
function attemptWindow({ max = 5, windowMs = 30 * 60_000 } = {}) {
  const windows = new Map(); // key → { count, startedAt }
  let lastSweep = Date.now();
  const live = (k, now) => {
    if (now - lastSweep > windowMs) {
      lastSweep = now;
      for (const [mk, mv] of windows) if (now - mv.startedAt >= windowMs) windows.delete(mk);
    }
    const w = windows.get(k);
    return w && now - w.startedAt < windowMs ? w : null;
  };
  const view = (w, now) => {
    const used = w ? w.count : 0;
    const locked = used >= max;
    return {
      locked,
      attemptsRemaining: Math.max(0, max - used),
      // Rounded UP and never 0: "try again in 0 minutes" while refusing reads as broken.
      retryAfterMinutes: locked ? Math.max(1, Math.ceil((w.startedAt + windowMs - now) / 60_000)) : null,
    };
  };
  const GRANTED = Object.freeze({ locked: false, attemptsRemaining: null, retryAfterMinutes: null });
  return {
    /** Count one attempt. `locked: true` → the window is full: refuse WITHOUT comparing. */
    claim(key) {
      const k = String(key), now = Date.now();
      const w = live(k, now);
      if (!w) { windows.set(k, { count: 1, startedAt: now }); return GRANTED; }
      if (w.count >= max) return view(w, now);
      w.count += 1;
      return GRANTED;
    },
    state(key) { const now = Date.now(); return view(live(String(key), now), now); },
    clear(key) { windows.delete(String(key)); },
  };
}

module.exports = { rateLimit, failureBreaker, attemptWindow };
