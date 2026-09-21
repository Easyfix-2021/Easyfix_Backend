/*
 * /api/public/shared-job/* — the shared-job web link's entry points.
 *
 * UNAUTHENTICATED (mounted under /api/public, ahead of requireAuth). The
 * `:token` path segment is a `job_share_link` JWT that names ONE share and
 * grants nothing on its own: these three routes only show a job summary and
 * run the OTP that turns the phone holder into a guest session. All job work
 * then goes through the ordinary /api/mobile/jobs/:id/* routes with that
 * session (see services/job-share-guest.service.js).
 *
 *   GET  /:token          → { share: { id, jobId, status, sharedByName, maskedNumber, service, area } }
 *   POST /:token/otp      → { sent, maskedNumber, resendAfterSec }
 *   POST /:token/verify   → { sessionToken, jobId, share }
 *
 * Errors carry `code` at the top level AND in details (same as the mobile
 * share lock): share_ended (410), share_not_found (404), otp_invalid /
 * otp_expired (400), otp_locked (429), otp_not_delivered (502).
 */

const router = require('express').Router();
const crypto = require('crypto');
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { rateLimit } = require('../../middleware/rate-limit');
const { modernOk } = require('../../utils/response');
const guest = require('../../services/job-share-guest.service');
const logger = require('../../logger');

// Keyed on the token itself (hashed), IP as the fallback — a link is one share.
const tokenKey = (req) => 'share-link:' + crypto.createHash('sha256')
  .update(String(req.params.token || req.ip)).digest('hex').slice(0, 32);
const readLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, key: tokenKey });
// Sending costs a WhatsApp/SMS: 5 per 10 minutes per link.
const sendLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, key: (req) => 'otp-' + tokenKey(req) });

function fail(res, next, e) {
  if (!e || !e.status) return next(e);
  const code = e.details?.code || e.code || null;
  return res.status(e.status).json({ success: false, error: e.message, code, details: e.details || { code } });
}

router.get('/:token', readLimit, async (req, res, next) => {
  try {
    return modernOk(res, await guest.peek(req.params.token));
  } catch (e) { return fail(res, next, e); }
});

router.post('/:token/otp', sendLimit, async (req, res, next) => {
  try {
    logger.info('Shared-job link · send OTP');
    return modernOk(res, await guest.sendOtp(req.params.token));
  } catch (e) { return fail(res, next, e); }
});

router.post('/:token/verify', readLimit,
  validate(Joi.object({ otp: Joi.string().trim().pattern(/^\d{4}$/).required() })),
  async (req, res, next) => {
    try {
      logger.info('Shared-job link · verify OTP');
      return modernOk(res, await guest.verifyOtp(req.params.token, req.body.otp));
    } catch (e) { return fail(res, next, e); }
  });

module.exports = router;
