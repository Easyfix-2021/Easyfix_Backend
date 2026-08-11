const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const logger = require('../../logger');
const { modernOk, modernError } = require('../../utils/response');
const identity = require('../../services/mobile-identity.service');
const registration = require('../../services/mobile-registration.service');

const identityDetailsSchema = Joi.object({
  name: Joi.string().trim().min(1).max(255).optional(),
  aadhaarNumber: Joi.string().pattern(/^[0-9]{12}$/).optional(),
  aadhaar: Joi.string().pattern(/^[0-9]{12}$/).optional(),
  panNumber: Joi.string().pattern(/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/).optional(),
  pan: Joi.string().pattern(/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/).optional(),
  firstName: Joi.string().trim().max(255).optional(),
  lastName: Joi.string().trim().max(255).optional(),
  dob: Joi.string().trim().max(40).optional(),
  haveDrivingLicence: Joi.boolean().optional(),
  docs: Joi.object({
    aadhaarFront: Joi.string().trim().max(255).optional(),
    aadhaarBack: Joi.string().trim().max(255).optional(),
    pan: Joi.string().trim().max(255).optional(),
    drivingLicence: Joi.string().trim().max(255).optional(),
  }).optional(),
}).min(1);

// Protected/authenticated by routes/mobile/index.js. One bounded aggregate
// query restores identity form state without exposing another technician id.
router.get('/identity-details', async (req, res, next) => {
  try {
    return modernOk(res, await identity.getIdentityDetails(req.tech.efr_id));
  } catch (error) {
    if (error.status) return modernError(res, error.status, error.message, error.details);
    return next(error);
  }
});

// Protected/authenticated and idempotency-wrapped by routes/mobile/index.js.
router.post('/identity-details', validate(identityDetailsSchema), async (req, res, next) => {
  const efrId = req.tech.efr_id;
  try {
    const result = await identity.saveIdentityDetails(efrId, req.body, {
      finalize: registration.finalizeGate1AfterSave,
    });
    return modernOk(res, result);
  } catch (error) {
    // Never log the raw database error: ER_DUP_ENTRY includes the Aadhaar value.
    logger.warn(
      { efrId, code: error?.details?.code || error?.code || 'IDENTITY_SAVE_FAILED' },
      'Identity details save failed',
    );
    if (error.status) return modernError(res, error.status, error.message, error.details);
    return next(error);
  }
});

module.exports = router;
module.exports.identityDetailsSchema = identityDetailsSchema;
