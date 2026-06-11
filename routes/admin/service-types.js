const router = require('express').Router();
const Joi    = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const svc = require('../../services/service-type.service');
const { modernOk, modernError } = require('../../utils/response');
/*
 * Deep-skill catalog cache invalidation (2026-06-11). Mirrors the
 * pattern from routes/admin/deep-skills.js + routes/admin/service-categories.js
 * — see the docblock there for rationale. Type-level mutations also
 * change the tree's display so the cache must drop.
 */
const { invalidateCatalogCaches } = require('../../services/easyfixer-profile-update-link.service');

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  q:               Joi.string().allow('', null).optional(),
  categoryId:      Joi.number().integer().positive().optional(),
  includeInactive: Joi.boolean().default(false),
  limit:           Joi.number().integer().min(1).max(1000).default(200),
  offset:          Joi.number().integer().min(0).default(0),
  sortBy:          Joi.string().valid(...Object.keys(svc.SORTABLE_COLUMNS)).default('service_type_name'),
  sortDir:         Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

const createBody = Joi.object({
  service_type_name:        Joi.string().trim().min(2).max(200).required(),
  service_type_desc:        Joi.string().trim().max(500).allow('', null).optional(),
  service_catg_id:          Joi.number().integer().positive().required(),
  display:                  Joi.number().integer().valid(0, 1).default(1),
  service_type_tools:       Joi.string().allow('', null).optional(),
  service_type_tool_names:  Joi.string().allow('', null).optional(),
});

const updateBody = Joi.object({
  service_type_name:        Joi.string().trim().min(2).max(200).optional(),
  service_type_desc:        Joi.string().trim().max(500).allow('', null).optional(),
  service_catg_id:          Joi.number().integer().positive().optional(),
  display:                  Joi.number().integer().valid(0, 1).optional(),
  service_type_tools:       Joi.string().allow('', null).optional(),
  service_type_tool_names:  Joi.string().allow('', null).optional(),
  is_active:                Joi.boolean().optional(),
}).min(1);

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try { modernOk(res, await svc.listTypes(req.query)); } catch (e) { next(e); }
});
router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const row = await svc.getTypeById(Number(req.params.id));
    if (!row) return modernError(res, 404, 'Service Type not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});
router.post('/', roleByName(['Admin']), validate(createBody), async (req, res, next) => {
  try {
    const created = await svc.createType(req.body);
    invalidateCatalogCaches();
    res.status(201); modernOk(res, created, 'Service Type added');
  }
  catch (e) { if (e.status) return modernError(res, e.status, e.message); next(e); }
});
router.patch('/:id', roleByName(['Admin']), validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    const updated = await svc.updateType(Number(req.params.id), req.body);
    if (!updated) return modernError(res, 404, 'Service Type not found');
    invalidateCatalogCaches();
    modernOk(res, updated, 'Service Type updated');
  } catch (e) { if (e.status) return modernError(res, e.status, e.message); next(e); }
});
router.delete('/:id', roleByName(['Admin']), validate(idParam, 'params'), async (req, res, next) => {
  try {
    const ok = await svc.deactivateType(Number(req.params.id));
    if (!ok) return modernError(res, 404, 'Service Type not found');
    invalidateCatalogCaches();
    modernOk(res, { deactivated: true });
  } catch (e) { if (e.status) return modernError(res, e.status, e.message); next(e); }
});

module.exports = router;
