const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const registration = require('../../services/mobile-registration.service');
const rewards = require('../../services/rewards.service');
const logger = require('../../logger');

const workAreaSchema = Joi.object({
  // Optional so a brand-new technician can complete Work Area before Identity;
  // when present it reuses the canonical personal-details name writer.
  name: Joi.string().trim().min(1).max(150).optional(),
  homePincode: Joi.string().trim().pattern(/^[0-9]{6}$/).required(),
  pincodes: Joi.array()
    .items(Joi.string().trim().pattern(/^[0-9]{6}$/))
    .min(1)
    .max(50)
    .unique()
    .required(),
}).custom((value, helpers) => (
  value.pincodes.includes(value.homePincode) ? value : helpers.error('any.invalid')
)).messages({
  'any.invalid': 'homePincode must be included in pincodes',
});

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
    // Auth has already resolved the effective lifecycle, including the
    // overdue-training capability overlay. Reuse that request-scoped snapshot
    // so this endpoint neither re-queries LMS nor re-implements the overlay.
    modernOk(res, await registration.getStatus(req.tech.efr_id, req.tech.lifecycle));
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
    // Optional device GPS captured at submit (foreground fix). Accepted
    // independently — a partial/absent pair just falls back to the pincode
    // centroid downstream; it must never 400 the submit.
    latitude:     Joi.number().min(-90).max(90).optional(),
    longitude:    Joi.number().min(-180).max(180).optional(),
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

// PUT /registration/work-area — one replay-safe contract for the complete
// profile card. Home location and the full serviceable set commit together;
// finalization is derived after commit and no-ops until the other profile gates
// are complete. Name is additive/optional so profile cards remain order-free.
// The body is deliberately bounded for offline queue/storage and
// for the pincode catalogue IN predicates used by the transaction.
router.put(
  '/work-area',
  validate(workAreaSchema),
  async (req, res, next) => {
    try {
      logger.info(`Save work area · count=${req.body.pincodes.length}`);
      const result = await registration.saveWorkArea(req.tech.efr_id, req.body);
      await rewards.qualifyReferralAfterProfileMutation(req.tech.efr_id, { source: 'work-area' });
      modernOk(res, result);
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

// POST /registration/finalize — server-owned Gate-1 convergence. The app calls
// this after order-independent profile-card saves. Missing cards return 200
// with pending/missing; transient failures still fail so the durable operation
// retries. The app never chooses a lifecycle target.
router.post('/finalize', async (req, res, next) => {
  try {
    logger.info('Onboarding Gate 1 finalization requested');
    const result = await registration.finalizeGate1IfReady(req.tech.efr_id);
    // Finalize is a replay-safe convergence endpoint and therefore a useful
    // retry point if an earlier profile-card save committed while the reward
    // qualification check could not reach the database. Qualification itself
    // remains idempotent and fail-soft.
    await rewards.qualifyReferralAfterProfileMutation(req.tech.efr_id, {
      source: 'registration-finalize',
    });
    modernOk(res, result);
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message, e.details);
    next(e);
  }
});

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
