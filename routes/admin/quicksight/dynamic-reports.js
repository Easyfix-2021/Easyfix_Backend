/*
 * QuickSight sub-router — Custom (dynamic) Reports.
 *   view key   : isQuickSightDynamicReportView   (+ family ef-QuickSight), router-wide
 *   manage key : isQuickSightDynamicReportManage (create; change reports you own)
 *   admin key  : isQuickSightDynamicReportAdmin  (change any report; transfer owner)
 *   service    : services/quicksight/quicksight-dynamic-reports.service.js
 *
 *   GET    /                        → { canCreate, isAdmin, reports[] }
 *   POST   /                        → detail      body: { name, columns[], chart, roleIds[] }
 *   GET    /:id                     → detail (definition, audience, uploads ≤30 days + current)
 *   PUT    /:id                     → detail      body: as POST
 *   DELETE /:id                     → { archived }
 *   PUT    /:id/owner               → detail      body: { userId }
 *   GET    /:id/template?format=xlsx|csv
 *   POST   /:id/upload              → detail      multipart: file (.xlsx/.csv), mode=replace|append
 *   DELETE /:id/uploads/:uploadId   → detail
 *   GET    /:id/rows?uploadId&page&pageSize&sortBy&sortDir&q
 *   GET    /:id/chart?uploadId
 *   GET    /:id/download?uploadId   → xlsx
 *   POST   /:id/share               → { shareToken }   (on, or regenerate)
 *   DELETE /:id/share               → { shareToken: null }
 *
 * Owner/audience checks are NOT middleware here: they need the report row, so
 * the service's loadReport() applies them on every call (404 = not visible,
 * 403 = visible but not yours to change). The public, token-addressed reads
 * live in routes/public/dynamic-report.js.
 */

const router = require('express').Router();
const multer = require('multer');
const Joi = require('joi');

const requireQuickSight = require('../../../middleware/require-quicksight');
const validate = require('../../../middleware/validate');
const { modernOk, modernError } = require('../../../utils/response');
const { streamWorkbook } = require('../../../utils/xlsx-styled-export');
const service = require('../../../services/quicksight/quicksight-dynamic-reports.service');

// A literal, not service.KEYS.VIEW: tests/quicksight-report-key-parity.test.js
// reads each router's gate key from its source to check it is seeded.
const ACTION_KEY = 'isQuickSightDynamicReportView';
router.use(requireQuickSight(ACTION_KEY));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: service.MAX_FILE_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (!/\.(xlsx|csv)$/i.test(file.originalname)) {
      return cb(Object.assign(new Error('Upload an Excel (.xlsx) or CSV (.csv) file'), { status: 400 }));
    }
    cb(null, true);
  },
});

// Multer's own errors (size, field name) carry no status and would surface as 500s.
function singleFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return modernError(res, 400, err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large (max 10 MB)' : err.message);
    }
    return next(err);
  });
}

function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

// Service errors carry an operator-readable message + status; anything else is a 500.
const handle = (fn) => async (req, res, next) => {
  try {
    return await fn(req, res, service.accessOf(req.user));
  } catch (err) {
    if (err && err.status && err.status < 500) return modernError(res, err.status, err.message);
    return next(err);
  }
};

const idParams = Joi.object({ id: Joi.number().integer().positive().required() });
const uploadParams = idParams.keys({ uploadId: Joi.number().integer().positive().required() });

const reportBody = Joi.object({
  name: Joi.string().trim().min(1).max(150).required(),
  columns: Joi.array().min(1).max(100).required().items(Joi.object({
    key: Joi.string().pattern(/^c\d{1,5}$/),
    name: Joi.string().trim().min(1).max(100).required(),
    type: Joi.string().valid('text', 'number', 'date').required(),
  })),
  chart: Joi.object({
    type: Joi.string().valid('bar', 'line', 'pie').required(),
    x: Joi.string().required(),
    y: Joi.array().items(Joi.string()).max(4).default([]),
    agg: Joi.string().valid('sum', 'count', 'avg').required(),
  }).allow(null).default(null),
  roleIds: Joi.array().items(Joi.number().integer().positive()).max(200).default([]),
});

const uploadIdQuery = Joi.object({ uploadId: Joi.number().integer().positive() });
const rowsQuery = uploadIdQuery.keys({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(service.MAX_PAGE_SIZE).default(50),
  sortBy: Joi.string().pattern(/^c\d{1,5}$/).allow('').default(''),
  sortDir: Joi.string().valid('asc', 'desc').default('asc'),
  q: Joi.string().max(200).allow('').default(''),
});

router.get('/', noStore, handle(async (_req, res, access) => modernOk(res, await service.list(access))));

router.post('/', validate(reportBody), handle(async (req, res, access) =>
  modernOk(res, await service.create(access, req.body), 'Report created')));

router.get('/:id', validate(idParams, 'params'), noStore, handle(async (req, res, access) =>
  modernOk(res, await service.detail(access, req.params.id))));

router.put('/:id', validate(idParams, 'params'), validate(reportBody), handle(async (req, res, access) =>
  modernOk(res, await service.update(access, req.params.id, req.body), 'Report updated')));

router.delete('/:id', validate(idParams, 'params'), handle(async (req, res, access) =>
  modernOk(res, await service.archive(access, req.params.id), 'Report archived')));

router.put('/:id/owner', validate(idParams, 'params'),
  validate(Joi.object({ userId: Joi.number().integer().positive().required() })),
  handle(async (req, res, access) =>
    modernOk(res, await service.transferOwner(access, req.params.id, req.body.userId), 'Owner changed')));

router.get('/:id/template', validate(idParams, 'params'),
  validate(Joi.object({ format: Joi.string().valid('xlsx', 'csv').default('xlsx') }), 'query'),
  handle(async (req, res, access) => {
    const t = await service.template(access, req.params.id, req.query.format);
    if (t.csv != null) {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      res.set('Content-Disposition', `attachment; filename="${t.filename}"`);
      return res.send(t.csv);
    }
    return streamWorkbook(res, t.filename, t.workbook);
  }));

router.post('/:id/upload', validate(idParams, 'params'), singleFile, handle(async (req, res, access) => {
  if (!req.file) return modernError(res, 400, 'Choose an .xlsx or .csv file to upload');
  const mode = (req.body && req.body.mode) || 'replace';
  if (!['replace', 'append'].includes(mode)) return modernError(res, 400, 'mode must be replace or append');
  const out = await service.upload(access, req.params.id, {
    buffer: req.file.buffer, originalName: req.file.originalname, mode,
  });
  return modernOk(res, out, mode === 'append' ? 'Rows appended' : 'Data replaced');
}));

router.delete('/:id/uploads/:uploadId', validate(uploadParams, 'params'), handle(async (req, res, access) =>
  modernOk(res, await service.deleteUpload(access, req.params.id, req.params.uploadId), 'Upload deleted')));

router.get('/:id/rows', validate(idParams, 'params'), validate(rowsQuery, 'query'), noStore,
  handle(async (req, res, access) => modernOk(res, await service.rows(access, req.params.id, req.query))));

router.get('/:id/chart', validate(idParams, 'params'), validate(uploadIdQuery, 'query'), noStore,
  handle(async (req, res, access) => modernOk(res, await service.chart(access, req.params.id, req.query.uploadId))));

router.get('/:id/download', validate(idParams, 'params'), validate(uploadIdQuery, 'query'),
  handle(async (req, res, access) => {
    const { filename, workbook } = await service.download(access, req.params.id, req.query.uploadId);
    return streamWorkbook(res, filename, workbook);
  }));

router.post('/:id/share', validate(idParams, 'params'), handle(async (req, res, access) =>
  modernOk(res, await service.setShare(access, req.params.id, true), 'Public link enabled')));

router.delete('/:id/share', validate(idParams, 'params'), handle(async (req, res, access) =>
  modernOk(res, await service.setShare(access, req.params.id, false), 'Public link disabled')));

module.exports = router;
