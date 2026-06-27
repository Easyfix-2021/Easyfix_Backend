const router = require('express').Router();
const Joi    = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const svc = require('../../services/rate-card-b2c.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  q:               Joi.string().allow('', null).optional(),
  serviceTypeId:   Joi.number().integer().positive().optional(),
  serviceCatgId:   Joi.number().integer().positive().optional(),
  includeInactive: Joi.boolean().default(false),
  limit:           Joi.number().integer().min(1).max(1000).default(200),
  offset:          Joi.number().integer().min(0).default(0),
  sortBy:          Joi.string().valid(...Object.keys(svc.SORTABLE_COLUMNS)).default('rrc_service_name'),
  sortDir:         Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

const createBody = Joi.object({
  rrc_service_name:   Joi.string().trim().min(1).max(200).required(),
  rrc_servicetype_id: Joi.number().integer().positive().required(),
  rrc_service_price:  Joi.number().integer().min(0).required(),
});

const updateBody = Joi.object({
  rrc_service_name:   Joi.string().trim().min(1).max(200).optional(),
  rrc_servicetype_id: Joi.number().integer().positive().optional(),
  rrc_service_price:  Joi.number().integer().min(0).optional(),
  is_active:          Joi.boolean().optional(),
}).min(1);

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('List B2C rate cards · serviceTypeId=' + (req.query.serviceTypeId ?? '-') + ' serviceCatgId=' + (req.query.serviceCatgId ?? '-') + ' includeInactive=' + req.query.includeInactive + ' limit=' + req.query.limit + ' offset=' + req.query.offset);
    const result = await svc.listRateCards(req.query);
    logger.info('Returning ' + (result?.items?.length ?? result?.length ?? 0) + ' B2C rate cards');
    modernOk(res, result);
  } catch (e) { next(e); }
});
router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Get B2C rate card · id=' + req.params.id);
    const row = await svc.getRateCardById(Number(req.params.id));
    if (!row) { logger.warn('B2C rate card not found · id=' + req.params.id); return modernError(res, 404, 'B2C Rate Card not found'); }
    modernOk(res, row);
  } catch (e) { next(e); }
});
router.post('/', roleByName(['Admin']), validate(createBody), async (req, res, next) => {
  try {
    logger.info('Create B2C rate card · name=' + req.body.rrc_service_name + ' serviceTypeId=' + req.body.rrc_servicetype_id);
    const created = await svc.createRateCard({ ...req.body, createdBy: req.user?.user_id });
    logger.info('B2C rate card created · id=' + (created?.rrc_id ?? created?.id ?? '-'));
    res.status(201); modernOk(res, created, 'B2C Rate Card added');
  } catch (e) { if (e.status) { logger.warn('Create B2C rate card failed · ' + e.message); return modernError(res, e.status, e.message); } next(e); }
});
router.patch('/:id', roleByName(['Admin']), validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    logger.info('Update B2C rate card · id=' + req.params.id + ' fields=' + Object.keys(req.body).join(','));
    const updated = await svc.updateRateCard(Number(req.params.id), req.body, req.user?.user_id);
    if (!updated) { logger.warn('B2C rate card not found · id=' + req.params.id); return modernError(res, 404, 'B2C Rate Card not found'); }
    logger.info('B2C rate card updated · id=' + req.params.id);
    modernOk(res, updated, 'B2C Rate Card updated');
  } catch (e) { if (e.status) { logger.warn('Update B2C rate card failed · id=' + req.params.id + ' · ' + e.message); return modernError(res, e.status, e.message); } next(e); }
});
router.delete('/:id', roleByName(['Admin']), validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Deactivate B2C rate card · id=' + req.params.id);
    const ok = await svc.deactivateRateCard(Number(req.params.id), req.user?.user_id);
    if (!ok) { logger.warn('B2C rate card not found · id=' + req.params.id); return modernError(res, 404, 'B2C Rate Card not found'); }
    logger.info('B2C rate card deactivated · id=' + req.params.id);
    modernOk(res, { deactivated: true });
  } catch (e) { if (e.status) { logger.warn('Deactivate B2C rate card failed · id=' + req.params.id + ' · ' + e.message); return modernError(res, e.status, e.message); } next(e); }
});

module.exports = router;
