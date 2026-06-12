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

module.exports = { rateLimit };
