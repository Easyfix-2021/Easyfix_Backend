const router = require('express').Router();
const Joi    = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const svc = require('../../services/document-type.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  q:               Joi.string().allow('', null).optional(),
  includeInactive: Joi.boolean().default(false),
  limit:           Joi.number().integer().min(1).max(1000).default(200),
  offset:          Joi.number().integer().min(0).default(0),
  sortBy:          Joi.string().valid(...Object.keys(svc.SORTABLE_COLUMNS)).default('document_name'),
  sortDir:         Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

const createBody = Joi.object({
  document_name:      Joi.string().trim().min(2).max(200).required(),
  document_mandatory: Joi.string().valid('Yes', 'No').required(),
  document_catg_id:   Joi.number().integer().positive().allow(null).optional(),
});

const updateBody = Joi.object({
  document_name:      Joi.string().trim().min(2).max(200).optional(),
  document_mandatory: Joi.string().valid('Yes', 'No').optional(),
  is_active:          Joi.boolean().optional(),
}).min(1);

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('List document types · q=' + (req.query.q || '') + ' includeInactive=' + req.query.includeInactive + ' limit=' + req.query.limit + ' offset=' + req.query.offset);
    modernOk(res, await svc.listDocTypes(req.query));
  } catch (e) { next(e); }
});
router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Get document type · id=' + req.params.id);
    const row = await svc.getDocTypeById(Number(req.params.id));
    if (!row) return modernError(res, 404, 'Document Type not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});
router.post('/', roleByName(['Admin']), validate(createBody), async (req, res, next) => {
  try {
    logger.info('Create document type · name=' + req.body.document_name + ' mandatory=' + req.body.document_mandatory);
    const created = await svc.createDocType(req.body); res.status(201);
    logger.info('Document Type created · id=' + (created && created.id));
    modernOk(res, created, 'Document Type added');
  }
  catch (e) { if (e.status) { logger.warn('Create document type failed · ' + e.message); return modernError(res, e.status, e.message); } next(e); }
});
router.patch('/:id', roleByName(['Admin']), validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    logger.info('Update document type · id=' + req.params.id);
    const updated = await svc.updateDocType(Number(req.params.id), req.body);
    if (!updated) return modernError(res, 404, 'Document Type not found');
    logger.info('Document Type updated · id=' + req.params.id);
    modernOk(res, updated, 'Document Type updated');
  } catch (e) { if (e.status) { logger.warn('Update document type failed · ' + e.message); return modernError(res, e.status, e.message); } next(e); }
});
router.delete('/:id', roleByName(['Admin']), validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Deactivate document type · id=' + req.params.id);
    const ok = await svc.deactivateDocType(Number(req.params.id));
    if (!ok) return modernError(res, 404, 'Document Type not found');
    logger.info('Document Type deactivated · id=' + req.params.id);
    modernOk(res, { deactivated: true });
  } catch (e) { if (e.status) { logger.warn('Deactivate document type failed · ' + e.message); return modernError(res, e.status, e.message); } next(e); }
});

module.exports = router;
