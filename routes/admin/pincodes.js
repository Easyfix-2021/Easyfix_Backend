const router  = require('express').Router();
const Joi     = require('joi');
const multer  = require('multer');

const validate    = require('../../middleware/validate');
const pin         = require('../../services/pincode.service');
const pinUpload   = require('../../services/pincode-upload.service');
const { modernOk, modernError } = require('../../utils/response');

// ─── Validators ──────────────────────────────────────────────────────
const idParam = Joi.object({
  pincodeId: Joi.number().integer().positive().required(),
});

const techniciansQuery = Joi.object({
  q:      Joi.string().allow('', null).optional(),
  limit:  Joi.number().integer().min(1).max(200).default(20),
  offset: Joi.number().integer().min(0).default(0),
});

const listQuery = Joi.object({
  q:       Joi.string().allow('', null).optional(),
  status:  Joi.string().valid('LOCAL', 'TRAVEL').optional(),
  cityId:  Joi.number().integer().positive().optional(),
  includeInactive: Joi.boolean().default(false),
  limit:   Joi.number().integer().min(1).max(200000).default(100),
  offset:  Joi.number().integer().min(0).default(0),
});

const lookupManyBody = Joi.object({
  pincodes: Joi.array().items(Joi.string().pattern(/^\d{6}$/)).min(1).max(500).required(),
});

const createBody = Joi.object({
  pincode:  Joi.string().pattern(/^\d{6}$/).required(),
  location: Joi.string().trim().max(255).allow('', null).optional(),
  city_id:  Joi.number().integer().positive().required(),
  district: Joi.string().trim().max(100).allow('', null).optional(),
});

const updateBody = Joi.object({
  location:  Joi.string().trim().max(255).allow('', null).optional(),
  city_id:   Joi.number().integer().positive().optional(),
  district:  Joi.string().trim().max(100).allow('', null).optional(),
  is_active: Joi.boolean().optional(),
}).min(1);

const setZonesBody = Joi.object({
  zoneIds: Joi.array().items(Joi.number().integer().positive()).default([]),
});

const uploadQuery = Joi.object({
  dryRun: Joi.boolean().default(false),
});

// ─── Multer (in-memory, .xlsx/.xls only, 5 MB) ──────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.(xlsx|xls)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only .xlsx / .xls files are accepted'));
  },
});

// helper — extract user_id off the JWT-validated req.user (added by requireAuth)
const userIdOf = (req) => (req.user && req.user.user_id) || null;

// ─── READ ────────────────────────────────────────────────────────────
router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const data = await pin.listPincodes(req.query);
    return modernOk(res, data);
  } catch (err) { return next(err); }
});

// Bulk lookup by codes — used by the CRM verification page's bulk-paste
// "Add All Matching Pincodes" flow. Declared BEFORE /:pincodeId so the
// dynamic param matcher doesn't swallow "lookup-many".
router.post('/lookup-many',
  validate(lookupManyBody, 'body'),
  async (req, res, next) => {
    try {
      const result = await pin.lookupManyByCode(req.body.pincodes);
      return modernOk(res, result);
    } catch (err) { return next(err); }
  }
);

router.get('/:pincodeId', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const row = await pin.getPincodeById(Number(req.params.pincodeId));
    if (!row) return modernError(res, 404, 'Pincode not found');
    return modernOk(res, row);
  } catch (err) { return next(err); }
});

// GET /admin/pincodes/:pincodeId/technicians?q=&limit=&offset=
// Returns active+verified technicians whose serviceable pincodes include
// this pincode. Powers the clickable-count modal on Manage Pincodes.
router.get('/:pincodeId/technicians',
  validate(idParam, 'params'),
  validate(techniciansQuery, 'query'),
  async (req, res, next) => {
    try {
      const row = await pin.getPincodeById(Number(req.params.pincodeId));
      if (!row) return modernError(res, 404, 'Pincode not found');
      const result = await pin.listTechniciansForPincode(
        Number(req.params.pincodeId),
        {
          q:      req.query.q,
          limit:  req.query.limit,
          offset: req.query.offset,
        }
      );
      return modernOk(res, result);
    } catch (err) { return next(err); }
  }
);

// ─── CREATE / UPDATE / DELETE ────────────────────────────────────────
router.post('/', validate(createBody), async (req, res, next) => {
  try {
    const created = await pin.createPincode(req.body, { userId: userIdOf(req) });
    return modernOk(res, created, 'Pincode added');
  } catch (err) {
    if (err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

router.patch('/:pincodeId',
  validate(idParam, 'params'),
  validate(updateBody),
  async (req, res, next) => {
    try {
      const updated = await pin.updatePincode(Number(req.params.pincodeId), req.body, { userId: userIdOf(req) });
      if (!updated) return modernError(res, 404, 'Pincode not found');
      return modernOk(res, updated, 'Pincode updated');
    } catch (err) {
      if (err.status) return modernError(res, err.status, err.message);
      return next(err);
    }
  }
);

// PUT /admin/pincodes/:pincodeId/zones — body { zoneIds: number[] }
// Reverse of the zone editor's pincode-set: assign THIS pincode to zone(s).
// Wipe-and-reinsert this pincode's tbl_zone_pincode_mapping rows to match.
router.put('/:pincodeId/zones',
  validate(idParam, 'params'),
  validate(setZonesBody),
  async (req, res, next) => {
    try {
      const result = await pin.setZonesForPincode(
        Number(req.params.pincodeId),
        req.body.zoneIds,
        { userId: userIdOf(req) }
      );
      return modernOk(res, result, 'Zones updated');
    } catch (err) {
      if (err.status) return modernError(res, err.status, err.message);
      return next(err);
    }
  }
);

router.delete('/:pincodeId', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const ok = await pin.deletePincode(Number(req.params.pincodeId), { userId: userIdOf(req) });
    if (!ok) return modernError(res, 404, 'Pincode not found');
    return modernOk(res, { deleted: true });
  } catch (err) { return next(err); }
});

// ─── Bulk upload (Excel) ─────────────────────────────────────────────
router.get('/template/download', async (_req, res, next) => {
  try {
    const buffer = await pinUpload.generateTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="manage-pincodes-template.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) { return next(err); }
});

router.post('/upload',
  validate(uploadQuery, 'query'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file?.buffer) return modernError(res, 400, 'No file uploaded (field name "file" required)');
      const report = await pinUpload.processUpload(req.file.buffer, {
        dryRun: !!req.query.dryRun,
        userId: userIdOf(req),
      });
      return modernOk(res, report, report.summary.dryRun ? 'Dry-run complete' : 'Upload complete');
    } catch (err) { return next(err); }
  }
);

module.exports = router;
