const router = require('express').Router();
const Joi    = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const svc = require('../../services/tool.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  q:               Joi.string().allow('', null).optional(),
  includeInactive: Joi.boolean().default(false),
  limit:           Joi.number().integer().min(1).max(1000).default(200),
  offset:          Joi.number().integer().min(0).default(0),
  sortBy:          Joi.string().valid(...Object.keys(svc.SORTABLE_COLUMNS)).default('tool_name'),
  sortDir:         Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

const createBody = Joi.object({
  tool_name: Joi.string().trim().min(1).max(200).required(),
  tool_desc: Joi.string().trim().max(500).allow('', null).optional(),
  tool_img:  Joi.string().trim().max(500).allow('', null).optional(),
});

const updateBody = Joi.object({
  tool_name: Joi.string().trim().min(1).max(200).optional(),
  tool_desc: Joi.string().trim().max(500).allow('', null).optional(),
  tool_img:  Joi.string().trim().max(500).allow('', null).optional(),
  is_active: Joi.boolean().optional(),
}).min(1);

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  logger.info('List tools · q=' + (req.query.q || '') + ' includeInactive=' + req.query.includeInactive + ' limit=' + req.query.limit + ' offset=' + req.query.offset);
  try { modernOk(res, await svc.listTools(req.query)); } catch (e) { next(e); }
});
router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  logger.info('Get tool · id=' + req.params.id);
  try {
    const row = await svc.getToolById(Number(req.params.id));
    if (!row) return modernError(res, 404, 'Tool not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});
router.post('/', roleByName(['Admin']), validate(createBody), async (req, res, next) => {
  logger.info('Create tool · name=' + req.body.tool_name);
  try { const created = await svc.createTool(req.body); res.status(201); modernOk(res, created, 'Tool added'); }
  catch (e) { if (e.status) return modernError(res, e.status, e.message); next(e); }
});
router.patch('/:id', roleByName(['Admin']), validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  logger.info('Update tool · id=' + req.params.id + ' fields=' + Object.keys(req.body).join(','));
  try {
    const updated = await svc.updateTool(Number(req.params.id), req.body);
    if (!updated) return modernError(res, 404, 'Tool not found');
    modernOk(res, updated, 'Tool updated');
  } catch (e) { if (e.status) return modernError(res, e.status, e.message); next(e); }
});
router.delete('/:id', roleByName(['Admin']), validate(idParam, 'params'), async (req, res, next) => {
  logger.info('Deactivate tool · id=' + req.params.id);
  try {
    const ok = await svc.deactivateTool(Number(req.params.id));
    if (!ok) return modernError(res, 404, 'Tool not found');
    modernOk(res, { deactivated: true });
  } catch (e) { if (e.status) return modernError(res, e.status, e.message); next(e); }
});

module.exports = router;
