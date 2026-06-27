const router = require('express').Router();
const Joi    = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const svc = require('../../services/rate-card-b2b.service');
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
  sortBy:          Joi.string().valid(...Object.keys(svc.SORTABLE_COLUMNS)).default('crc_ratecard_name'),
  sortDir:         Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

const createBody = Joi.object({
  crc_ratecard_name:  Joi.string().trim().min(1).max(200).required(),
  crc_servicetype_id: Joi.number().integer().positive().required(),
});

const updateBody = Joi.object({
  crc_ratecard_name:  Joi.string().trim().min(1).max(200).optional(),
  crc_servicetype_id: Joi.number().integer().positive().optional(),
  is_active:          Joi.boolean().optional(),
}).min(1);

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('List B2B rate cards · q=' + (req.query.q || '') + ' · limit=' + req.query.limit + ' · offset=' + req.query.offset + ' · includeInactive=' + req.query.includeInactive);
    modernOk(res, await svc.listRateCards(req.query));
  } catch (e) { logger.error('List B2B rate cards failed · ' + e.message); next(e); }
});
router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Get B2B rate card · id=' + req.params.id);
    const row = await svc.getRateCardById(Number(req.params.id));
    if (!row) return modernError(res, 404, 'B2B Rate Card not found');
    modernOk(res, row);
  } catch (e) { logger.error('Get B2B rate card failed · ' + e.message); next(e); }
});
router.post('/', roleByName(['Admin']), validate(createBody), async (req, res, next) => {
  try {
    logger.info('Create B2B rate card · serviceTypeId=' + req.body.crc_servicetype_id);
    const created = await svc.createRateCard({ ...req.body, createdBy: req.user?.user_id });
    logger.info('B2B rate card created · id=' + (created && created.crc_id));
    res.status(201); modernOk(res, created, 'B2B Rate Card added');
  } catch (e) { if (e.status) { logger.warn('Create B2B rate card rejected · ' + e.message); return modernError(res, e.status, e.message); } logger.error('Create B2B rate card failed · ' + e.message); next(e); }
});
router.patch('/:id', roleByName(['Admin']), validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    logger.info('Update B2B rate card · id=' + req.params.id);
    const updated = await svc.updateRateCard(Number(req.params.id), req.body, req.user?.user_id);
    if (!updated) return modernError(res, 404, 'B2B Rate Card not found');
    logger.info('B2B rate card updated · id=' + req.params.id);
    modernOk(res, updated, 'B2B Rate Card updated');
  } catch (e) { if (e.status) { logger.warn('Update B2B rate card rejected · ' + e.message); return modernError(res, e.status, e.message); } logger.error('Update B2B rate card failed · ' + e.message); next(e); }
});
router.delete('/:id', roleByName(['Admin']), validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Deactivate B2B rate card · id=' + req.params.id);
    const ok = await svc.deactivateRateCard(Number(req.params.id), req.user?.user_id);
    if (!ok) return modernError(res, 404, 'B2B Rate Card not found');
    logger.info('B2B rate card deactivated · id=' + req.params.id);
    modernOk(res, { deactivated: true });
  } catch (e) { if (e.status) { logger.warn('Deactivate B2B rate card rejected · ' + e.message); return modernError(res, e.status, e.message); } logger.error('Deactivate B2B rate card failed · ' + e.message); next(e); }
});

module.exports = router;
