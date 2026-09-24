const Joi = require('joi');

// Accept either an email or an Indian mobile number (10 digits).
const identifierSchema = Joi.alternatives().try(
  Joi.string().email(),
  Joi.string().pattern(/^[0-9]{10}$/)
);

const loginOtpRequest = Joi.object({
  identifier: identifierSchema.required().messages({
    'alternatives.match': 'identifier must be a valid email or 10-digit mobile number',
  }),
});

const verifyOtpRequest = Joi.object({
  identifier: identifierSchema.required(),
  otp: Joi.alternatives().try(
    Joi.number().integer().min(0).max(9999),
    Joi.string().pattern(/^[0-9]{4}$/)
  ).required(),
});

module.exports = { loginOtpRequest, verifyOtpRequest };
