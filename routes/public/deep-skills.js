/*
 * Public deep-skill image resolver (2026-06-11).
 *
 * Mounted at GET /api/public/deep-skills/:id/image-url.
 *
 * WHY this exists alongside the admin + shared endpoints:
 *   - /api/admin/deep-skills/:id/image-url       → admin JWT only
 *   - /api/shared/deep-skills/:id/image-url      → any modern EasyFix JWT
 *   - /api/public/deep-skills/:id/image-url      → THIS — NO AUTH
 *
 * The legacy Java CRM, legacy Client Dashboard, legacy Mobile app, and any
 * other off-platform consumer can't present a modern EasyFix JWT (they sign
 * with the legacy `"esyfixsecret"`). Rather than ship a multi-secret
 * verifier in middleware/auth.js — which would expand the attack surface of
 * every modern surface for the sake of one image-resolution endpoint — we
 * publish the data as truly-public on a dedicated path.
 *
 * SECURITY POSTURE:
 *   - The endpoint returns ONLY a short-TTL presigned URL for a deep-skill
 *     image. It does NOT reveal any other deep-skill metadata.
 *   - Deep-skill images are non-sensitive product photography (skill
 *     thumbnails, not PII or business data). They were always intended to
 *     be embeddable in third-party surfaces.
 *   - Skill IDs are small integers; an attacker could enumerate the
 *     entire image set, but the attack value is near-zero — same as
 *     calling the listing endpoint on the legacy CRM.
 *   - The presigned URL itself has a 1-hour TTL (s3-storage default), so a
 *     leaked URL goes stale quickly.
 *
 * Response shape mirrors the admin / shared endpoints exactly:
 *   200 { success: true, data: { image: <key>, url: <presigned|null> } }
 *   400 if :id isn't a positive integer
 *   404 if the deep_skill row doesn't exist
 *
 * For a logged-in consumer that has a modern EasyFix JWT, /api/shared/*
 * is the better choice — it stays auditable behind the JWT-verification
 * log line. /api/public/* is for the legacy / cross-product cases where
 * carrying a token isn't feasible.
 */

const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const ds = require('../../services/deep-skill.service');
const { modernOk, modernError } = require('../../utils/response');

const idParam = Joi.object({
  id: Joi.number().integer().positive().required(),
});

/*
 * Simple in-memory per-IP token-bucket rate limit (2026-06-11).
 *
 * 100 requests / 60 seconds / IP. Chose an inline implementation over
 * `express-rate-limit` to avoid a new dependency for one endpoint —
 * the project doesn't currently use that package and the rate-limit
 * surface here is a single route.
 *
 * The window slides per IP: each request appends a timestamp to that
 * IP's bucket and prunes any timestamps older than the window. If the
 * post-prune bucket size exceeds the cap, the request is rejected
 * with 429. Single-process — multi-instance deploys would want a
 * Redis-backed limiter; not required for this endpoint's traffic.
 *
 * IPs are sourced from `req.ip` which respects `app.set('trust proxy', …)`
 * if configured upstream; otherwise it's the direct socket IP. Either
 * is correct for limiting purposes.
 */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 100;
const rateLimitBuckets = new Map();

function rateLimitByIp(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const bucket = rateLimitBuckets.get(ip) || [];
  // Prune expired timestamps in place.
  let i = 0;
  while (i < bucket.length && bucket[i] <= cutoff) i += 1;
  const pruned = i > 0 ? bucket.slice(i) : bucket;
  if (pruned.length >= RATE_LIMIT_MAX) {
    res.setHeader('Retry-After', Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));
    return modernError(res, 429, 'Too many requests — slow down');
  }
  pruned.push(now);
  rateLimitBuckets.set(ip, pruned);
  next();
}

/*
 * CDN / browser cache headers (2026-06-11).
 *
 * Deep-skill images change a few times a month at most. A short
 * `max-age` (5 minutes) lets a CDN absorb most repeat fetches without
 * caching long enough to outlive the catalog cache invalidation hook
 * (which also runs on a 5-minute window). `stale-while-revalidate`
 * lets the CDN serve stale immediately + revalidate in the background
 * — operators see fresh data within a few minutes of a catalog
 * mutation even if the CDN is between them and the origin.
 */
function setCdnCacheHeaders(_req, res, next) {
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
  next();
}

router.get('/:id/image-url',
  rateLimitByIp,
  setCdnCacheHeaders,
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      const data = await ds.getImageUrl(req.params.id);
      modernOk(res, data);
    } catch (e) {
      if (e?.status && e.status >= 400 && e.status < 500) {
        return modernError(res, e.status, e.message);
      }
      next(e);
    }
  },
);

module.exports = router;
