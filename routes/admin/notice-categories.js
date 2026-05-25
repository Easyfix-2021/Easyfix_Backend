const router = require('express').Router();

const validate = require('../../middleware/validate');
const svc      = require('../../services/notice-category.service');
const { modernOk, modernError } = require('../../utils/response');
const {
  categoryCreate,
  categoryUpdate,
  categoryIdParam,
} = require('../../validators/notice.validator');

/*
 * Notice categories — coloured chips for the notice board.
 *
 * Listing is open to any admin user (categories drive the chip colour
 * even for users who can only READ notices). Create/update is gated
 * by the `isNoticeManage` action key, mirroring the notices routes.
 */

const Joi = require('joi');
const listQuery = Joi.object({
  includeInactive: Joi.boolean().default(false),
});

router.get(
  '/',
  validate(listQuery, 'query'),
  async (req, res, next) => {
    try {
      const items = await svc.listCategories({ includeInactive: req.query.includeInactive });
      modernOk(res, { items });
    } catch (e) { next(e); }
  },
);

router.post(
  '/',
  validate(categoryCreate),
  async (req, res, next) => {
    try {
      const row = await svc.createCategory(req.body);
      res.status(201);
      modernOk(res, row, 'Category added');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

router.patch(
  '/:categoryId',
  validate(categoryIdParam, 'params'),
  validate(categoryUpdate),
  async (req, res, next) => {
    try {
      const row = await svc.updateCategory(Number(req.params.categoryId), req.body);
      if (!row) return modernError(res, 404, 'Category not found');
      modernOk(res, row, 'Category updated');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

module.exports = router;
