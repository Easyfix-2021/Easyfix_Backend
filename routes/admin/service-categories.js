const router = require('express').Router();
const Joi    = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const svc = require('../../services/service-category.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
/*
 * Deep-skill catalog cache invalidation (2026-06-11). The public
 * profile-update form bundles the full Category → Type → Skill →
 * Option tree into its prefill response with a 5-minute cache. Adding
 * / renaming / deactivating a Service Category changes that tree's
 * top-level display so the cache must be dropped on each successful
 * mutation here — same pattern applied to routes/admin/deep-skills.js
 * and routes/admin/service-types.js.
 */
const { invalidateCatalogCaches } = require('../../services/easyfixer-profile-update-link.service');
// Short-TTL lookup cache (utils/ttl-cache.js) backs /shared/lookup/service-categories
// under keys lookup:service-categories:inc=*. invalidateCatalogCaches() above only
// drops the deep-skill tree cache, NOT these — so a category deactivation/rename
// would keep serving the old list. Drop the whole family on every mutation.
const { clearPrefix } = require('../../utils/ttl-cache');
const SERVICE_CATG_LOOKUP_PREFIX = 'lookup:service-categories:';

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  q:               Joi.string().allow('', null).optional(),
  includeInactive: Joi.boolean().default(false),
  limit:           Joi.number().integer().min(1).max(1000).default(200),
  offset:          Joi.number().integer().min(0).default(0),
  sortBy:          Joi.string().valid(...Object.keys(svc.SORTABLE_COLUMNS)).default('service_catg_name'),
  sortDir:         Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

// Legacy parity (addEditServicesCategory.vm + validate-servicecategory.js):
// BOTH name and description are required with minlength 2. On create we mirror
// that. On partial update either may be omitted, but a supplied value must
// still satisfy min 2 (service layer rejects a blank).
const createBody = Joi.object({
  service_catg_name: Joi.string().trim().min(2).max(200).required(),
  service_catg_desc: Joi.string().trim().min(2).max(500).required(),
});

const updateBody = Joi.object({
  service_catg_name: Joi.string().trim().min(2).max(200).optional(),
  service_catg_desc: Joi.string().trim().min(2).max(500).optional(),
  is_active:         Joi.boolean().optional(),
}).min(1);

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('List service categories · q=' + (req.query.q || '') + ' includeInactive=' + req.query.includeInactive + ' limit=' + req.query.limit + ' offset=' + req.query.offset);
    modernOk(res, await svc.listCategories(req.query));
  } catch (e) { logger.error('List service categories failed · ' + e.message); next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Get service category · id=' + req.params.id);
    const row = await svc.getCategoryById(Number(req.params.id));
    if (!row) {
      logger.warn('Service category not found · id=' + req.params.id);
      return modernError(res, 404, 'Service Category not found');
    }
    modernOk(res, row);
  } catch (e) { logger.error('Get service category failed · id=' + req.params.id + ' · ' + e.message); next(e); }
});

router.post('/', roleByName(['Admin']), validate(createBody), async (req, res, next) => {
  try {
    logger.info('Create service category · name=' + req.body.service_catg_name);
    const created = await svc.createCategory(req.body);
    invalidateCatalogCaches();
    clearPrefix(SERVICE_CATG_LOOKUP_PREFIX);
    logger.info('Service category created · id=' + (created && created.service_catg_id));
    res.status(201); modernOk(res, created, 'Service Category added');
  } catch (e) { if (e.status) { logger.warn('Create service category rejected · status=' + e.status + ' · ' + e.message); return modernError(res, e.status, e.message); } logger.error('Create service category failed · ' + e.message); next(e); }
});

router.patch('/:id', roleByName(['Admin']), validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    logger.info('Update service category · id=' + req.params.id + ' fields=' + Object.keys(req.body).join(','));
    const updated = await svc.updateCategory(Number(req.params.id), req.body);
    if (!updated) {
      logger.warn('Service category not found for update · id=' + req.params.id);
      return modernError(res, 404, 'Service Category not found');
    }
    invalidateCatalogCaches();
    clearPrefix(SERVICE_CATG_LOOKUP_PREFIX);
    logger.info('Service category updated · id=' + req.params.id);
    modernOk(res, updated, 'Service Category updated');
  } catch (e) { if (e.status) { logger.warn('Update service category rejected · id=' + req.params.id + ' · status=' + e.status + ' · ' + e.message); return modernError(res, e.status, e.message); } logger.error('Update service category failed · id=' + req.params.id + ' · ' + e.message); next(e); }
});

// DELETE = legacy "trash" (status=3). Matches the legacy /addDeleteServiceCatg
// action and the Manage Service Type sibling. The Active toggle (status 0↔1)
// is handled via PATCH { is_active }, not here.
router.delete('/:id', roleByName(['Admin']), validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Delete service category · id=' + req.params.id);
    const ok = await svc.deleteCategory(Number(req.params.id));
    if (!ok) {
      logger.warn('Service category not found for delete · id=' + req.params.id);
      return modernError(res, 404, 'Service Category not found');
    }
    invalidateCatalogCaches();
    clearPrefix(SERVICE_CATG_LOOKUP_PREFIX);
    logger.info('Service category deleted · id=' + req.params.id);
    modernOk(res, { deleted: true });
  } catch (e) { if (e.status) { logger.warn('Delete service category rejected · id=' + req.params.id + ' · status=' + e.status + ' · ' + e.message); return modernError(res, e.status, e.message); } logger.error('Delete service category failed · id=' + req.params.id + ' · ' + e.message); next(e); }
});

module.exports = router;
