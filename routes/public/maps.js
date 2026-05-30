/*
 * /api/public/maps/* — token-gated mirror of /api/admin/maps/* for the
 * customer-facing magic-link completion page.
 *
 * Security posture (different from /api/admin/maps/*):
 *
 *   - NO global auth middleware applies (parent `/api/public` router
 *     deliberately mounts ahead of `requireAuth` so the customer's
 *     browser, which has no Bearer token, can hit these endpoints
 *     directly from the magic link).
 *   - Each request MUST carry a `?token=` query string carrying the
 *     magic-link JWT. We call `verifyJobToken()` (time-bound expiry,
 *     default 7d) AND `requireUnconfirmedJob()` (state-bound expiry —
 *     the link stops working the moment ops confirms the order in CRM,
 *     even if the JWT is still cryptographically valid). Both layers
 *     run on every request, NOT just the page load.
 *   - Google spend is therefore gated by a verified Unconfirmed job:
 *     a stolen / forged / replayed token can't burn API credits on
 *     arbitrary Places lookups. Once the job leaves status 9 the link
 *     becomes inert.
 *   - The underlying Google calls + LRU cache live in
 *     `services/maps.service.js`, shared with the admin mount — same
 *     cache benefits both surfaces, same error-mapping logic.
 *
 * Per-token rate limit (added 2026-05-28): 60 req / 10 min keyed off
 * the verified jobId (IP fallback for unverifiable tokens — prevents
 * a single shared "anon" bucket that any caller could DoS through).
 * Limit is higher than the job-completion flow's 30/10min because
 * Places Autocomplete fires per keystroke; a customer typing a long
 * address can legitimately fire 20-30 calls in a few seconds. State-
 * bound expiry already caps abuse exposure to one unconfirmed order,
 * but Google Places charges per call so we still need a hard ceiling
 * to protect the GCP budget against a runaway / scripted token.
 */

const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const { verifyJobToken, requireUnconfirmedJob } = require('../../utils/jwt');
const { pool } = require('../../db');
const { rateLimit } = require('../../middleware/rate-limit');
const mapsService = require('../../services/maps.service');

/*
 * Per-token rate limit applied to ALL maps routes below. Key derives
 * from the verified jobId — we run verifyJobToken() inside the key
 * function (cheap, no DB hit; state check still happens in the per-
 * route verifyTokenAndState()) and fall back to IP for malformed /
 * expired tokens so a forged token can't share the unverified pool
 * with every other anonymous caller.
 */
const tokenRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  key: (req) => {
    try {
      const { jobId } = verifyJobToken(String(req.query.token || ''));
      return `job:${jobId}`;
    } catch (_e) {
      return `ip:${req.ip}`;
    }
  },
});

/*
 * Verify the magic-link token + the job's live status. Returns the
 * jobId on success; writes an HTTP error to `res` and returns null
 * on failure (so handlers can early-return without an extra try/catch
 * around the JWT decode path).
 *
 * Kept inline (not in utils/jwt.js) because we want the HTTP-layer
 * response shape coupling here, not in the JWT helper.
 */
async function verifyTokenAndState(req, res) {
  const token = req.query.token;
  if (!token) { modernError(res, 401, 'token required'); return null; }
  try {
    const { jobId } = verifyJobToken(String(token));
    await requireUnconfirmedJob(jobId, pool);
    return jobId;
  } catch (e) {
    modernError(res, e.status || 401, e.message || 'unauthorized');
    return null;
  }
}

/*
 * GET /api/public/maps/autocomplete?token=<jwt>&q=<text>
 */
router.get('/autocomplete', tokenRateLimit, validate(Joi.object({
  token: Joi.string().required(),
  q:     Joi.string().min(3).max(200).required(),
}), 'query'), async (req, res, next) => {
  if (!await verifyTokenAndState(req, res)) return;
  try {
    const out = await mapsService.autocomplete(String(req.query.q).trim());
    modernOk(res, out);
  } catch (e) {
    if (e && e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * GET /api/public/maps/geocode?token=<jwt>&place_id=… | &address=… | &latlng=…
 */
router.get('/geocode', tokenRateLimit, validate(Joi.object({
  token:    Joi.string().required(),
  place_id: Joi.string().min(5).max(300).optional(),
  address:  Joi.string().min(3).max(500).optional(),
  latlng:   Joi.string().pattern(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).optional(),
}).or('place_id', 'address', 'latlng'), 'query'), async (req, res, next) => {
  if (!await verifyTokenAndState(req, res)) return;
  try {
    const out = await mapsService.geocode({
      place_id: req.query.place_id ? String(req.query.place_id) : null,
      address:  req.query.address  ? String(req.query.address)  : null,
      latlng:   req.query.latlng   ? String(req.query.latlng)   : null,
    });
    modernOk(res, out);
  } catch (e) {
    if (e && e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * GET /api/public/maps/config?token=<jwt>
 *
 * Same runtime fallback as the admin variant — the customer page also
 * needs the public JS API key for the embedded map widget.
 */
router.get('/config', tokenRateLimit, validate(Joi.object({
  token: Joi.string().required(),
}), 'query'), async (req, res) => {
  if (!await verifyTokenAndState(req, res)) return;
  modernOk(res, { apiKey: mapsService.getConfigKey() });
});

module.exports = router;
