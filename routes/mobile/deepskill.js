const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const logger = require('../../logger');
const { modernOk, modernError } = require('../../utils/response');
const deepSkillMobile = require('../../services/mobile-deepskill.service');
const rewards = require('../../services/rewards.service');

/*
 * /api/mobile/deepskill/* — Technician Deep-Skill selection.
 *
 * 4-level catalogue (Service Category → Service Type → Deep Skill →
 * Option) with the calling technician's current selections marked per
 * option. The technician is ALWAYS implicit (req.tech.efr_id) — no
 * technicianId is ever accepted from the client.
 *
 * Auth: requireTechAuth is applied upstream in routes/mobile/index.js
 * before this router is mounted, so req.tech is guaranteed populated.
 *
 * See services/mobile-deepskill.service.js for the SQL + the
 * tbl_efr_deepskill_mapping column-inversion handling.
 */

// GET /deepskill/hierarchy/:categoryId — full tree + isSelected per option.
router.get(
  '/hierarchy/:categoryId',
  validate(Joi.object({
    categoryId: Joi.number().integer().positive().required(),
  }), 'params'),
  async (req, res, next) => {
    try {
      logger.info('Load deep-skill hierarchy · categoryId=' + req.params.categoryId);
      const data = await deepSkillMobile.getHierarchy(
        req.tech.efr_id,
        Number(req.params.categoryId),
      );
      logger.info('Returning deep-skill hierarchy · categoryId=' + req.params.categoryId);
      modernOk(res, data);
    } catch (e) {
      if (e.status) {
        logger.warn('Load deep-skill hierarchy failed · ' + e.message);
        return modernError(res, e.status, e.message);
      }
      next(e);
    }
  },
);

// POST /deepskill/skills — diff-apply the technician's selections for one
// category. Empty selectedOptions on a deep skill deletes its mappings.
const optionId = Joi.number().integer().positive();
router.post(
  '/skills',
  validate(Joi.object({
    categoryId: Joi.number().integer().positive().required(),
    serviceTypes: Joi.array().items(Joi.object({
      serviceTypeId: Joi.number().integer().positive().required(),
      deepSkills: Joi.array().items(Joi.object({
        deepSkillId: Joi.number().integer().positive().required(),
        // Empty array is meaningful (= delete this skill's mappings).
        selectedOptions: Joi.array().items(optionId).default([]),
      })).default([]),
    })).default([]),
  })),
  async (req, res, next) => {
    try {
      logger.info('Apply deep-skill selections · categoryId=' + req.body.categoryId + ' · serviceTypes=' + (Array.isArray(req.body.serviceTypes) ? req.body.serviceTypes.length : 0));
      const result = await deepSkillMobile.applySkills(req.tech.efr_id, req.body);
      // applySkills has committed and released its pinned connection. Referral
      // qualification is fail-soft/idempotent and therefore cannot turn an
      // acknowledged offline replay into a false write failure.
      await rewards.qualifyReferralAfterProfileMutation(req.tech.efr_id, { source: 'skills' });
      logger.info('Deep-skill selections applied · categoryId=' + req.body.categoryId);
      modernOk(res, result);
    } catch (e) {
      if (e.status) {
        logger.warn('Apply deep-skill selections failed · ' + e.message);
        return modernError(res, e.status, e.message);
      }
      next(e);
    }
  },
);

module.exports = router;
