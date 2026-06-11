/*
 * /api/public/easyfixer-profile-update/* — token-authed easyfixer self-serve
 * profile-update flow.
 *
 * Security model (mirrors routes/public/job-completion.js):
 *   (a) NO admin auth at this mount. The parent router (routes/public/index.js)
 *       sits ahead of any global requireAuth, and we deliberately keep it that
 *       way so the easyfixer can land here from a plain WhatsApp tap.
 *   (b) Token-only contract. Every endpoint extracts `token` from the QUERY
 *       string (?token=…) and runs verifyEasyfixerProfileToken() to extract
 *       the efrId. The efrId is then pinned to all subsequent SQL — there is
 *       no body/query/param path that lets a caller address a different
 *       easyfixer than the one the token was minted for.
 *   (c) Time-bound expiry only. Unlike a job (which transitions out of
 *       status=9 to invalidate the link), an easyfixer profile is always
 *       editable, so there is no equivalent state gate.
 *
 * All responses use the modern `{success, data, error}` shape via utils/response.
 */

const router = require('express').Router();
const Joi = require('joi');

const { pool } = require('../../db');
const { verifyEasyfixerProfileToken } = require('../../utils/jwt');
const profileUpdateLink = require('../../services/easyfixer-profile-update-link.service');
const { modernOk, modernError } = require('../../utils/response');
const validate = require('../../middleware/validate');
const logger = require('../../logger');

// ─── Joi schemas ────────────────────────────────────────────────────
// Query schema — both endpoints take `?token=<jwt>`. JWTs are dot-separated
// base64url strings; we keep the validator loose-but-bounded (1–4000 chars,
// must contain dots) so a malformed token is rejected here rather than 401'd
// inside verifyEasyfixerProfileToken — clearer error surface for the FE.
const tokenQuery = Joi.object({
  token: Joi.string().min(1).max(4000).pattern(/\./).required(),
}).unknown(true);

// Body schema for PUT /save. All three sub-payloads are OPTIONAL so the
// operator can submit partial updates — e.g. just the deep-skill items
// without touching basic fields. min(1) ensures at least one block was
// supplied (an empty body is meaningless and should 400 rather than
// silently no-op).
const basicSchema = Joi.object({
  first_name:     Joi.string().max(120).allow('', null),
  last_name:      Joi.string().max(120).allow('', null),
  email:          Joi.string().email({ tlds: { allow: false } }).max(255).allow('', null),
  alt_no:         Joi.string().max(20).allow('', null),
  date_of_birth:  Joi.alternatives().try(Joi.date(), Joi.string().allow('', null)),
  // Marital status is a free-form string in the legacy column; we cap it.
  marital_status: Joi.string().max(40).allow('', null),
  children_count: Joi.number().integer().min(0).max(20).allow(null),
  about_yourself: Joi.string().max(2000).allow('', null),
  hobbies:        Joi.string().max(2000).allow('', null),
}).min(1);

const deepSkillItemSchema = Joi.object({
  category_id:     Joi.number().integer().positive().required(),
  service_type_id: Joi.number().integer().positive().required(),
  deep_skill_id:   Joi.number().integer().positive().required(),
  option_id:       Joi.number().integer().positive().required(),
});

// Query schema for GET /pincodes — token plus an optional search term `q`
// (empty allowed → returns top-N recent pincodes) and a result-cap `limit`.
// Caps mirror the service-side clamp (1–200) so an out-of-range value 400s
// at the edge rather than silently coercing inside the service.
const pincodeSearchQuery = Joi.object({
  token: Joi.string().min(1).max(4000).pattern(/\./).required(),
  q:     Joi.string().allow('').max(50).default(''),
  limit: Joi.number().integer().min(1).max(200).default(50),
}).unknown(true);

const saveBody = Joi.object({
  basic:                   basicSchema.optional(),
  // The CAP matches the optionMappingsBody validator in
  // validators/easyfixer.validator.js (500) so the public surface can't
  // bypass that cap.
  deep_skill_items:        Joi.array().items(deepSkillItemSchema).max(500).optional(),
  // 2000 matches serviceablePincodesBody's cap.
  serviceable_pincode_ids: Joi.array()
    .items(Joi.number().integer().positive())
    .max(2000)
    .optional(),
}).min(1);

// Centralised error mapper. verifyEasyfixerProfileToken throws Error
// instances with a `status` property; fetchPrefill / sendForEasyfixer /
// acceptSubmission do the same. Anything without a `status` is treated
// as an unexpected server error and forwarded to the global handler.
function mapKnownError(res, next, e) {
  if (e && typeof e.status === 'number') {
    return modernError(res, e.status, e.message || 'request failed');
  }
  return next(e);
}

/**
 * Helper: verify the token in `req.query.token` and return the efrId.
 * Throws an Error with `status: 401` on any failure — the mapper above
 * translates that to a 401 modernError with the spec-mandated message
 * 'invalid or expired link' (which is the message
 * verifyEasyfixerProfileToken sets).
 */
function verifyTokenFromQuery(req) {
  const token = req.query && req.query.token;
  if (!token) {
    const e = new Error('invalid or expired link');
    e.status = 401;
    throw e;
  }
  return verifyEasyfixerProfileToken(token);
}

// ─── GET /prefill?token=<jwt> ───────────────────────────────────────
router.get(
  '/prefill',
  validate(tokenQuery, 'query'),
  async (req, res, next) => {
    try {
      const efrId = verifyTokenFromQuery(req);
      const payload = await profileUpdateLink.fetchPrefill(efrId, pool);
      logger.info({ efrId }, 'easyfixer-profile-update: prefill served');
      return modernOk(res, payload);
    } catch (e) {
      return mapKnownError(res, next, e);
    }
  },
);

// ─── PUT /save?token=<jwt> ──────────────────────────────────────────
router.put(
  '/save',
  validate(tokenQuery, 'query'),
  validate(saveBody, 'body'),
  async (req, res, next) => {
    try {
      const efrId = verifyTokenFromQuery(req);
      const result = await profileUpdateLink.acceptSubmission(efrId, req.body, pool);
      logger.info({ efrId }, 'easyfixer-profile-update: profile saved');
      return modernOk(res, result, 'Profile updated');
    } catch (e) {
      return mapKnownError(res, next, e);
    }
  },
);

// ─── GET /pincodes?token=<jwt>&q=…&limit=… ──────────────────────────
// Lazy pincode lookup for the public profile-update form. The full
// ~155k-row tbl_pincode is too large to bundle into the prefill payload,
// so the FE calls this on every debounced search-as-you-type input.
//
// We re-verify the token on every call (same `verifyTokenFromQuery` helper
// used by /prefill + /save) — there's no token caching on the BE side.
router.get(
  '/pincodes',
  validate(pincodeSearchQuery, 'query'),
  async (req, res, next) => {
    try {
      // Token verification only — we don't actually need the efrId here
      // (pincode catalog is the same for every easyfixer) but the call still
      // gates access to authenticated link holders.
      verifyTokenFromQuery(req);
      const q     = req.query.q || '';
      const limit = Number(req.query.limit) || 50;
      const items = await profileUpdateLink.searchPincodes(q, limit, pool);
      logger.info({ q, limit, count: items.length }, 'easyfixer-profile-update: pincode search');
      return modernOk(res, { items });
    } catch (e) {
      return mapKnownError(res, next, e);
    }
  },
);

module.exports = router;
