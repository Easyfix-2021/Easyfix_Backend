const router = require('express').Router();
const Joi    = require('joi');
const multer = require('multer');

const validate       = require('../../middleware/validate');
const requireAction   = require('../../middleware/require-action');
const svc      = require('../../services/material.service');
const brandSvc = require('../../services/brand.service');
const imports  = require('../../services/material-import.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

const userIdOf = (req) => (req.user && req.user.user_id) || null;
const hasAction = (req, key) => {
  const perms = (req.user && req.user.permissions && req.user.permissions.actionPermissions) || [];
  return perms.includes(key);
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(xlsx|xls)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only .xlsx / .xls files are accepted'));
  },
});

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  search: Joi.string().allow('', null).optional(),
  service_catg_id: Joi.number().integer().positive().optional(),
  pricing_type: Joi.string().valid('FIXED', 'DYNAMIC').optional(),
  brand_id: Joi.number().integer().positive().optional(),
  status: Joi.string().valid('active', 'inactive', 'price_pending', 'all').default('active'),
  page:   Joi.number().integer().min(0).default(0),
  limit:  Joi.number().integer().min(1).max(1000).default(20),
  sort_by:  Joi.string().valid('material_name', 'service_catg_name', 'pricing_type', 'price_min', 'status').default('material_name'),
  sort_dir: Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

const stateEntry = Joi.object({
  price: Joi.number().min(0).allow(null).optional(),
  state_ids: Joi.array().items(Joi.number().integer().positive()).min(1).required(),
});
const groupEntry = Joi.object({
  price: Joi.number().min(0).allow(null).optional(),
  brand_ids: Joi.array().items(Joi.number().integer().positive()).default([]),
  states: Joi.array().items(stateEntry).default([]),
});
const writeBody = Joi.object({
  material_name: Joi.string().trim().min(1).max(200).required(),
  description: Joi.string().trim().max(1000).allow('', null).optional(),
  service_catg_id: Joi.number().integer().positive().required(),
  uom_id: Joi.number().integer().positive().allow(null).optional(),
  pricing_type: Joi.string().valid('FIXED', 'DYNAMIC').required(),
  groups: Joi.array().items(groupEntry).default([]),
});
const statusBody = Joi.object({ is_active: Joi.boolean().required() });
const replaceBody = Joi.object({ replacement_id: Joi.number().integer().positive().required() });

function sendSvcError(res, next, e) {
  if (e.status) return modernError(res, e.status, e.message, e.references || e.conflicts ? { references: e.references, conflicts: e.conflicts } : undefined);
  return next(e);
}

// ─── Literal paths — declared BEFORE /:id ────────────────────────────────

router.get('/uoms', requireAction('isMaterialView'), async (req, res, next) => {
  try { modernOk(res, await svc.listUoms()); } catch (e) { next(e); }
});

router.get('/brand-options', requireAction('isMaterialView'), async (req, res, next) => {
  try { modernOk(res, await brandSvc.listActiveBrandOptions()); } catch (e) { next(e); }
});

router.get('/import/template.xlsx', requireAction('isMaterialImport'), async (req, res, next) => {
  try { await imports.generateMaterialTemplate(res); } catch (e) { next(e); }
});

router.post('/import/preview', requireAction('isMaterialImport'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return modernError(res, 400, 'file (multipart field "file") is required');
    modernOk(res, await imports.previewMaterialImport(req.file.buffer, { canCreateBrands: hasAction(req, 'isBrandAddNew') }));
  } catch (e) { next(e); }
});

router.post('/import/commit', requireAction('isMaterialImport'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return modernError(res, 400, 'file (multipart field "file") is required');
    modernOk(res, await imports.commitMaterialImport(req.file.buffer, { userId: userIdOf(req) }, { canCreateBrands: hasAction(req, 'isBrandAddNew') }));
  } catch (e) { next(e); }
});

router.post('/import/errors.xlsx', requireAction('isMaterialImport'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return modernError(res, 400, 'file (multipart field "file") is required');
    await imports.generateMaterialErrorsXlsx(res, req.file.buffer, { canCreateBrands: hasAction(req, 'isBrandAddNew') });
  } catch (e) { next(e); }
});

// ─── CRUD ────────────────────────────────────────────────────────────────

router.get('/', requireAction('isMaterialView'), validate(listQuery, 'query'), async (req, res, next) => {
  try { modernOk(res, await svc.listMaterials(req.query)); } catch (e) { next(e); }
});

router.post('/', requireAction('isMaterialAddNew'), validate(writeBody), async (req, res, next) => {
  logger.info('Create material · name=' + req.body.material_name);
  try { res.status(201); modernOk(res, await svc.createMaterial(req.body, { userId: userIdOf(req) })); }
  catch (e) { sendSvcError(res, next, e); }
});

router.get('/:id', requireAction('isMaterialView'), validate(idParam, 'params'), async (req, res, next) => {
  try {
    const row = await svc.getMaterialById(Number(req.params.id));
    if (!row) return modernError(res, 404, 'Material not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});

router.put('/:id', requireAction('isMaterialEdit'), validate(idParam, 'params'), validate(writeBody), async (req, res, next) => {
  logger.info('Update material · id=' + req.params.id);
  try { modernOk(res, await svc.updateMaterial(Number(req.params.id), req.body, { userId: userIdOf(req) })); }
  catch (e) { sendSvcError(res, next, e); }
});

router.patch('/:id/status', requireAction('isMaterialDeactivate'), validate(idParam, 'params'), validate(statusBody), async (req, res, next) => {
  logger.info('Set material status · id=' + req.params.id + ' active=' + req.body.is_active);
  try { modernOk(res, await svc.setMaterialStatus(Number(req.params.id), req.body.is_active, { userId: userIdOf(req) })); }
  catch (e) { sendSvcError(res, next, e); }
});

router.get('/:id/references', requireAction('isMaterialView'), validate(idParam, 'params'), async (req, res, next) => {
  try { modernOk(res, await svc.getMaterialReferences(Number(req.params.id))); }
  catch (e) { sendSvcError(res, next, e); }
});

router.delete('/:id', requireAction('isMaterialDelete'), validate(idParam, 'params'), async (req, res, next) => {
  logger.info('Delete material · id=' + req.params.id);
  try { modernOk(res, await svc.deleteMaterial(Number(req.params.id))); }
  catch (e) { sendSvcError(res, next, e); }
});

router.post('/:id/replace-and-delete', requireAction('isMaterialDelete'), validate(idParam, 'params'), validate(replaceBody), async (req, res, next) => {
  logger.info('Replace-and-delete material · id=' + req.params.id + ' replacement=' + req.body.replacement_id);
  try { modernOk(res, await svc.replaceAndDeleteMaterial(Number(req.params.id), req.body.replacement_id)); }
  catch (e) { sendSvcError(res, next, e); }
});

module.exports = router;
