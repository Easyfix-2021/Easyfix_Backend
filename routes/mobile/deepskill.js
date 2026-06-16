const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const deepSkillMobile = require('../../services/mobile-deepskill.service');

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
      const data = await deepSkillMobile.getHierarchy(
        req.tech.efr_id,
        Number(req.params.categoryId),
      );
      modernOk(res, data);
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
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
      const result = await deepSkillMobile.applySkills(req.tech.efr_id, req.body);
      modernOk(res, result);
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

module.exports = router;
