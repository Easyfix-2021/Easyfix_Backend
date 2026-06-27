/*
 * /api/mobile/email/* — technician email exist-check + verification-link flow.
 *
 * Auth: requireTechAuth is applied UPSTREAM in routes/mobile/index.js (this
 * sub-router mounts after it), so req.tech.efr_id / req.tech.efr_email are
 * always present here — do NOT re-apply the guard. Every handler scopes to
 * req.tech.efr_id; no caller-supplied efr_id is ever trusted.
 *
 *   GET  /exists?email=        → { exists }   collision vs another technician
 *   POST /send-verification    → { sent:true } mail a 24h tokenised link
 *   GET  /status               → { verified } app polls this every 30s
 *
 * Modern response envelope ({ success, data }) — mobile group contract.
 */

const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const logger = require('../../logger');
const { modernOk } = require('../../utils/response');
const emailVerify = require('../../services/mobile-email-verify.service');

// GET /exists?email= — is this email already used by ANOTHER technician?
router.get(
  '/exists',
  validate(Joi.object({ email: Joi.string().trim().email().max(255).required() }), 'query'),
  async (req, res, next) => {
    try {
      logger.info('Check email collision against other technicians');
      const result = await emailVerify.checkEmailExists(req.tech.efr_id, req.query.email);
      logger.info('Email collision check · exists=' + (result && result.exists));
      modernOk(res, result);
    } catch (e) { next(e); }
  },
);

// POST /send-verification { email } — mail a tokenised verification link.
router.post(
  '/send-verification',
  validate(Joi.object({ email: Joi.string().trim().email().max(255).required() })),
  async (req, res, next) => {
    try {
      // Origin is the fallback base for the public link when PUBLIC_API_BASE_URL
      // is unset — protocol + host of the inbound request.
      const origin = `${req.protocol}://${req.get('host')}`;
      logger.info('Send email verification link');
      const result = await emailVerify.sendVerification(req.tech.efr_id, req.body.email, { origin });
      logger.info('Email verification link sent · sent=' + (result && result.sent));
      modernOk(res, result);
    } catch (e) { next(e); }
  },
);

// GET /status — current is_email_verified flag for the authed technician.
router.get('/status', async (req, res, next) => {
  try {
    logger.info('Poll email verification status');
    const result = await emailVerify.getStatus(req.tech.efr_id);
    logger.info('Email verification status · verified=' + (result && result.verified));
    modernOk(res, result);
  } catch (e) { next(e); }
});

module.exports = router;
