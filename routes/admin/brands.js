const router = require('express').Router();
const Joi    = require('joi');
const multer = require('multer');

const validate      = require('../../middleware/validate');
const requireAction  = require('../../middleware/require-action');
const svc     = require('../../services/brand.service');
const imports = require('../../services/material-import.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

const userIdOf = (req) => (req.user && req.user.user_id) || null;

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
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  page:   Joi.number().integer().min(0).default(0),
  limit:  Joi.number().integer().min(1).max(1000).default(20),
  sort_by:  Joi.string().valid('brand_name', 'used_by', 'status').default('brand_name'),
  sort_dir: Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

const createBody = Joi.object({ brand_name: Joi.string().trim().min(1).max(150).required() });
const updateBody = Joi.object({ brand_name: Joi.string().trim().min(1).max(150).required() });
const statusBody = Joi.object({ is_active: Joi.boolean().required() });
const replaceBody = Joi.object({ replacement_id: Joi.number().integer().positive().required() });

function sendSvcError(res, next, e) {
  if (e.status) return modernError(res, e.status, e.message, e.references || e.conflicts ? { references: e.references, conflicts: e.conflicts } : undefined);
  return next(e);
}

// ─── Import (literal paths — declared before /:id) ─────────────────────

router.get('/import/template.xlsx', requireAction('isBrandImport'), async (req, res, next) => {
  try { await imports.generateBrandTemplate(res); } catch (e) { next(e); }
});

router.post('/import/preview', requireAction('isBrandImport'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return modernError(res, 400, 'file (multipart field "file") is required');
    modernOk(res, await imports.previewBrandImport(req.file.buffer));
  } catch (e) { next(e); }
});

router.post('/import/commit', requireAction('isBrandImport'), requireAction('isBrandAddNew'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return modernError(res, 400, 'file (multipart field "file") is required');
    modernOk(res, await imports.commitBrandImport(req.file.buffer, { userId: userIdOf(req) }));
  } catch (e) { next(e); }
});

router.post('/import/errors.xlsx', requireAction('isBrandImport'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return modernError(res, 400, 'file (multipart field "file") is required');
    await imports.generateBrandErrorsXlsx(res, req.file.buffer);
  } catch (e) { next(e); }
});

// ─── CRUD ────────────────────────────────────────────────────────────────

router.get('/', requireAction('isBrandView'), validate(listQuery, 'query'), async (req, res, next) => {
  try { modernOk(res, await svc.listBrands(req.query)); } catch (e) { next(e); }
});

router.post('/', requireAction('isBrandAddNew'), validate(createBody), async (req, res, next) => {
  logger.info('Create brand · name=' + req.body.brand_name);
  try { res.status(201); modernOk(res, await svc.createBrand(req.body, { userId: userIdOf(req) })); }
  catch (e) { sendSvcError(res, next, e); }
});

router.put('/:id', requireAction('isBrandEdit'), validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  logger.info('Update brand · id=' + req.params.id);
  try { modernOk(res, await svc.updateBrand(Number(req.params.id), req.body, { userId: userIdOf(req) })); }
  catch (e) { sendSvcError(res, next, e); }
});

router.patch('/:id/status', requireAction('isBrandDeactivate'), validate(idParam, 'params'), validate(statusBody), async (req, res, next) => {
  logger.info('Set brand status · id=' + req.params.id + ' active=' + req.body.is_active);
  try { modernOk(res, await svc.setBrandStatus(Number(req.params.id), req.body.is_active, { userId: userIdOf(req) })); }
  catch (e) { sendSvcError(res, next, e); }
});

router.get('/:id/references', requireAction('isBrandView'), validate(idParam, 'params'), async (req, res, next) => {
  try { modernOk(res, await svc.getBrandReferences(Number(req.params.id))); }
  catch (e) { sendSvcError(res, next, e); }
});

router.delete('/:id', requireAction('isBrandDelete'), validate(idParam, 'params'), async (req, res, next) => {
  logger.info('Delete brand · id=' + req.params.id);
  try { modernOk(res, await svc.deleteBrand(Number(req.params.id))); }
  catch (e) { sendSvcError(res, next, e); }
});

router.post('/:id/replace-and-delete', requireAction('isBrandDelete'), validate(idParam, 'params'), validate(replaceBody), async (req, res, next) => {
  logger.info('Replace-and-delete brand · id=' + req.params.id + ' replacement=' + req.body.replacement_id);
  try { modernOk(res, await svc.replaceAndDeleteBrand(Number(req.params.id), req.body.replacement_id, { userId: userIdOf(req) })); }
  catch (e) { sendSvcError(res, next, e); }
});

module.exports = router;
