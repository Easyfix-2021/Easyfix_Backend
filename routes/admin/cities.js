const router = require('express').Router();
const Joi    = require('joi');

const validate = require('../../middleware/validate');
const city     = require('../../services/city.service');
const { modernOk, modernError } = require('../../utils/response');
const logger   = require('../../logger');

// ─── Validators ──────────────────────────────────────────────────────
const idParam = Joi.object({ cityId: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  q:               Joi.string().allow('', null).optional(),
  stateId:         Joi.number().integer().positive().optional(),
  // Show only cities a technician created on the fly (created_by_type=technician).
  createdByTech:   Joi.boolean().default(false),
  includeInactive: Joi.boolean().default(false),
  limit:           Joi.number().integer().min(1).max(1000).default(200),
  offset:          Joi.number().integer().min(0).default(0),
  // Whitelist comes from the service layer so the two stay in lockstep —
  // adding a new sortable column requires touching exactly one place.
  sortBy:          Joi.string().valid(...Object.keys(city.SORTABLE_COLUMNS)).default('city_name'),
  sortDir:         Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

const createBody = Joi.object({
  city_name:         Joi.string().trim().min(2).max(100).required(),
  state_id:          Joi.number().integer().positive().required(),
  district:          Joi.string().trim().max(100).allow('', null).optional(),
  tier:              Joi.string().trim().max(20).allow('', null).optional(),
  reference_pincode: Joi.string().trim().pattern(/^\d{6}$/).allow('', null).optional(),
});

const updateBody = Joi.object({
  city_name:         Joi.string().trim().min(2).max(100).optional(),
  state_id:          Joi.number().integer().positive().optional(),
  district:          Joi.string().trim().max(100).allow('', null).optional(),
  tier:              Joi.string().trim().max(20).allow('', null).optional(),
  reference_pincode: Joi.string().trim().pattern(/^\d{6}$/).allow('', null).optional(),
  is_active:         Joi.boolean().optional(),
}).min(1);

// ─── READ ────────────────────────────────────────────────────────────
router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('List cities · q=' + (req.query.q || '') + ' stateId=' + (req.query.stateId || '') + ' includeInactive=' + req.query.includeInactive + ' limit=' + req.query.limit + ' offset=' + req.query.offset);
    const data = await city.listCities(req.query);
    logger.info('Returning ' + (data.items ? data.items.length : (Array.isArray(data) ? data.length : 0)) + ' cities');
    modernOk(res, data);
  } catch (e) { next(e); }
});

router.get('/:cityId', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Get city · id=' + req.params.cityId);
    const row = await city.getCityById(Number(req.params.cityId));
    if (!row) logger.warn('City not found · id=' + req.params.cityId);
    if (!row) return modernError(res, 404, 'City not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});

// ─── WRITE ───────────────────────────────────────────────────────────
router.post('/', validate(createBody), async (req, res, next) => {
  try {
    logger.info('Create city · name=' + req.body.city_name + ' stateId=' + req.body.state_id);
    const created = await city.createCity(req.body);
    logger.info('City created · id=' + (created && created.city_id));
    res.status(201);
    modernOk(res, created, 'City added');
  } catch (e) {
    if (e.status) logger.warn('Create city failed · ' + e.message);
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.patch('/:cityId',
  validate(idParam, 'params'),
  validate(updateBody),
  async (req, res, next) => {
    try {
      logger.info('Update city · id=' + req.params.cityId + ' fields=' + Object.keys(req.body).join(','));
      const updated = await city.updateCity(Number(req.params.cityId), req.body);
      if (!updated) logger.warn('City not found · id=' + req.params.cityId);
      if (!updated) return modernError(res, 404, 'City not found');
      logger.info('City updated · id=' + req.params.cityId);
      modernOk(res, updated, 'City updated');
    } catch (e) {
      if (e.status) logger.warn('Update city failed · ' + e.message);
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  }
);

router.delete('/:cityId', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Deactivate city · id=' + req.params.cityId);
    const ok = await city.deactivateCity(Number(req.params.cityId));
    if (!ok) logger.warn('City not found · id=' + req.params.cityId);
    if (!ok) return modernError(res, 404, 'City not found');
    logger.info('City deactivated · id=' + req.params.cityId);
    modernOk(res, { deactivated: true });
  } catch (e) { next(e); }
});

module.exports = router;
