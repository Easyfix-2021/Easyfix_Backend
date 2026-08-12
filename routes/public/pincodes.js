const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { rateLimit } = require('../../middleware/rate-limit');
const { modernOk, modernError } = require('../../utils/response');
const registrationProfile = require('../../services/technician-registration-profile.service');

/*
 * GET /api/public/pincodes/:pincode
 *
 * Deliberately unauthenticated: the technician login form needs city/state
 * before it has a token. It exposes only public geography catalogue labels,
 * performs no geocoding/writes, and is capped per IP. The shared resolver is a
 * single indexed query and never computes technician/zone counts.
 */
const lookupRateLimit = rateLimit({
  windowMs: 10 * 60_000,
  max: 60,
  key: (req) => `registration-pincode:${req.ip}`,
});

router.get(
  '/:pincode',
  lookupRateLimit,
  validate(Joi.object({
    pincode: Joi.string().trim().pattern(/^\d{6}$/).required(),
  }), 'params'),
  async (req, res, next) => {
    try {
      const location = await registrationProfile.resolvePincode(req.params.pincode);
      if (!location) return modernError(res, 404, 'pincode not found');
      // Catalogue mappings change rarely. Cache successes briefly to absorb
      // repeated login-form lookups; intentionally leave 404s uncached so a
      // newly seeded pincode becomes visible immediately.
      res.setHeader('Cache-Control', 'public, max-age=300');
      return modernOk(res, location);
    } catch (err) {
      if (err.status) return modernError(res, err.status, err.message);
      return next(err);
    }
  },
);

module.exports = router;
