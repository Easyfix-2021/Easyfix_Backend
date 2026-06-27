const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const registration = require('../../services/mobile-registration.service');
const logger = require('../../logger');

/*
 * /api/mobile/registration/* — Technician onboarding gate machine.
 *
 * Collapses the legacy `users/{id}` + `profile-final-submission-status`
 * polls into a single derived status the RN app drives its onboarding
 * stepper from, plus the personal-details + language writes the early
 * steps need.
 *
 * NOTE: PATCH /language is mounted on this sub-router as `/language`,
 * which resolves to `/api/mobile/registration/language` (the language
 * setter is part of the onboarding flow). See the mount line reported
 * for routes/mobile/index.js.
 *
 * Auth: requireTechAuth is applied upstream in routes/mobile/index.js
 * before this router is mounted, so req.tech is guaranteed populated.
 * Technician is always implicit (req.tech.efr_id).
 */

// GET /registration/status — derived onboarding status + flags.
router.get('/status', async (req, res, next) => {
  try {
    logger.info('Onboarding status requested');
    modernOk(res, await registration.getStatus(req.tech.efr_id));
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

// GET /registration/remaining — labels of the still-missing profile fields.
router.get('/remaining', async (req, res, next) => {
  try {
    logger.info('Remaining profile fields requested');
    modernOk(res, await registration.getRemaining(req.tech.efr_id));
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

// POST /registration/personal-details — initial personal-details save.
router.post(
  '/personal-details',
  validate(Joi.object({
    name:         Joi.string().trim().min(1).max(150).required(),
    pincode:      Joi.string().trim().pattern(/^[0-9]{6}$/).required(),
    city:         Joi.string().trim().max(100).optional(),
    state:        Joi.string().trim().max(100).optional(),
    addressLine1: Joi.string().trim().max(255).optional(),
    addressLine2: Joi.string().trim().max(255).optional(),
  })),
  async (req, res, next) => {
    try {
      logger.info(`Save personal details · pincode=${req.body.pincode}`);
      modernOk(res, await registration.savePersonalDetails(req.tech.efr_id, req.body));
      logger.info('Personal details saved');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

// PATCH /language — persist the technician's preferred language (English NAME).
router.patch(
  '/language',
  validate(Joi.object({
    language: Joi.string().trim().min(1).max(50).required(),
  })),
  async (req, res, next) => {
    try {
      logger.info(`Set language · ${req.body.language}`);
      modernOk(res, await registration.setLanguage(req.tech.efr_id, req.body.language));
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

module.exports = router;
