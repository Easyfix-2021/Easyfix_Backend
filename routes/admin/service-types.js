const router = require('express').Router();
const Joi    = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const svc = require('../../services/service-type.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
/*
 * Deep-skill catalog cache invalidation (2026-06-11). Mirrors the
 * pattern from routes/admin/deep-skills.js + routes/admin/service-categories.js
 * — see the docblock there for rationale. Type-level mutations also
 * change the tree's display so the cache must drop.
 */
const { invalidateCatalogCaches } = require('../../services/easyfixer-profile-update-link.service');
// Short-TTL lookup cache (utils/ttl-cache.js) backs /shared/lookup/service-types,
// which feeds the active-only Service Type dropdowns (e.g. Manage Deep Skills).
// Those keys (lookup:service-types:cat=*:inc=*) are NOT touched by the catalog
// cache above, so a deactivation would keep serving the old type until TTL.
// Drop the whole family on every type mutation so the dropdown reflects it now.
const { clearPrefix } = require('../../utils/ttl-cache');
const SERVICE_TYPE_LOOKUP_PREFIX = 'lookup:service-types:';

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
  // Required for strict legacy parity (the legacy form marks Desc with a *).
  service_type_desc:        Joi.string().trim().min(1).max(500).required(),
  service_catg_id:          Joi.number().integer().positive().required(),
  display:                  Joi.number().integer().valid(0, 1, 2).default(1),
  service_type_tools:       Joi.string().allow('', null).optional(),
  service_type_tool_names:  Joi.string().allow('', null).optional(),
  service_type_image:       Joi.string().trim().max(255).allow('', null).optional(),
});

const updateBody = Joi.object({
  service_type_name:        Joi.string().trim().min(2).max(200).optional(),
  // Optional on PATCH (partial update), but cannot be blanked once set.
  service_type_desc:        Joi.string().trim().min(1).max(500).optional(),
  service_catg_id:          Joi.number().integer().positive().optional(),
  display:                  Joi.number().integer().valid(0, 1, 2).optional(),
  service_type_tools:       Joi.string().allow('', null).optional(),
  service_type_tool_names:  Joi.string().allow('', null).optional(),
  service_type_image:       Joi.string().trim().max(255).allow('', null).optional(),
  is_active:                Joi.boolean().optional(),
}).min(1);

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('List service types · q=' + (req.query.q || '') + ' categoryId=' + (req.query.categoryId || '') + ' includeInactive=' + req.query.includeInactive + ' limit=' + req.query.limit + ' offset=' + req.query.offset);
    modernOk(res, await svc.listTypes(req.query));
  } catch (e) { logger.error('List service types failed · ' + e.message); next(e); }
});
router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Get service type · id=' + req.params.id);
    const row = await svc.getTypeById(Number(req.params.id));
    if (!row) {
      logger.warn('Service type not found · id=' + req.params.id);
      return modernError(res, 404, 'Service Type not found');
    }
    modernOk(res, row);
  } catch (e) { logger.error('Get service type failed · id=' + req.params.id + ' · ' + e.message); next(e); }
});
router.post('/', roleByName(['Admin']), validate(createBody), async (req, res, next) => {
  try {
    logger.info('Create service type · name=' + req.body.service_type_name + ' categoryId=' + req.body.service_catg_id);
    const created = await svc.createType(req.body);
    invalidateCatalogCaches();
    clearPrefix(SERVICE_TYPE_LOOKUP_PREFIX);
    logger.info('Service type created · id=' + (created && created.service_type_id));
    res.status(201); modernOk(res, created, 'Service Type added');
  }
  catch (e) { if (e.status) { logger.warn('Create service type rejected · status=' + e.status + ' · ' + e.message); return modernError(res, e.status, e.message); } logger.error('Create service type failed · ' + e.message); next(e); }
});
router.patch('/:id', roleByName(['Admin']), validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    logger.info('Update service type · id=' + req.params.id + ' fields=' + Object.keys(req.body).join(','));
    const updated = await svc.updateType(Number(req.params.id), req.body);
    if (!updated) {
      logger.warn('Service type not found for update · id=' + req.params.id);
      return modernError(res, 404, 'Service Type not found');
    }
    invalidateCatalogCaches();
    clearPrefix(SERVICE_TYPE_LOOKUP_PREFIX);
    logger.info('Service type updated · id=' + req.params.id);
    modernOk(res, updated, 'Service Type updated');
  } catch (e) { if (e.status) { logger.warn('Update service type rejected · id=' + req.params.id + ' · status=' + e.status + ' · ' + e.message); return modernError(res, e.status, e.message); } logger.error('Update service type failed · id=' + req.params.id + ' · ' + e.message); next(e); }
});
router.delete('/:id', roleByName(['Admin']), validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Delete service type · id=' + req.params.id);
    const ok = await svc.deleteType(Number(req.params.id));
    if (!ok) {
      logger.warn('Service type not found for delete · id=' + req.params.id);
      return modernError(res, 404, 'Service Type not found');
    }
    invalidateCatalogCaches();
    clearPrefix(SERVICE_TYPE_LOOKUP_PREFIX);
    logger.info('Service type deleted · id=' + req.params.id);
    modernOk(res, { deleted: true });
  } catch (e) { if (e.status) { logger.warn('Delete service type rejected · id=' + req.params.id + ' · status=' + e.status + ' · ' + e.message); return modernError(res, e.status, e.message); } logger.error('Delete service type failed · id=' + req.params.id + ' · ' + e.message); next(e); }
});

module.exports = router;
