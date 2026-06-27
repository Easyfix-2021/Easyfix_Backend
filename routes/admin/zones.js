const router  = require('express').Router();
const Joi     = require('joi');
const multer  = require('multer');

const validate    = require('../../middleware/validate');
const zone        = require('../../services/zone.service');
const zoneUpload  = require('../../services/zone-upload.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

// ─── Validators ──────────────────────────────────────────────────────
const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const createBody = Joi.object({
  zone_name: Joi.string().trim().min(2).max(100).required(),
  city_id:   Joi.number().integer().positive().required(),
});

const updateBody = Joi.object({
  zone_name:   Joi.string().trim().min(2).max(100).optional(),
  zone_status: Joi.boolean().optional(),
}).min(1);

const pincodeMapBody = Joi.object({
  pincode_ids: Joi.array().items(Joi.number().integer().positive()).max(5000).required(),
});

const searchQuery  = Joi.object({
  q:          Joi.string().allow('', null).optional(),
  limit:      Joi.number().integer().min(1).max(500).default(200),
  activeOnly: Joi.boolean().default(true),
});

// List filter/pagination — `q` matches zone or city name.
const listQuery = Joi.object({
  q:      Joi.string().allow('', null).optional(),
  limit:  Joi.number().integer().min(1).max(5000).default(1000),
  offset: Joi.number().integer().min(0).default(0),
  includeInactive: Joi.boolean().truthy('true').falsy('false').default(false),
});

// Assignable-pincode search/pagination — `q` matches pincode/location/city/district.
const assignableQuery = Joi.object({
  q:      Joi.string().allow('', null).optional(),
  limit:  Joi.number().integer().min(1).max(200).default(50),
  offset: Joi.number().integer().min(0).default(0),
  inZoneOnly: Joi.boolean().truthy('true').falsy('false').optional(),
});
const pincodeQuery = Joi.object({
  pincode: Joi.string().pattern(/^\d{6}$/).required(),
  limit:   Joi.number().integer().min(1).max(500).default(200),
});
const uploadQuery  = Joi.object({
  dryRun: Joi.boolean().default(false),
});

// ─── Multer ──────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.(xlsx|xls)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only .xlsx / .xls files are accepted'));
  },
});

const userIdOf = (req) => (req.user && req.user.user_id) || null;

// ─── READ ────────────────────────────────────────────────────────────
router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  logger.info('List zones · q=' + (req.query.q || '') + ' includeInactive=' + req.query.includeInactive + ' limit=' + req.query.limit + ' offset=' + req.query.offset);
  try { modernOk(res, await zone.listZones(req.query)); } catch (e) { next(e); }
});

// `/by-pincode` and `/template` listed BEFORE `/:id` to avoid Express
// capturing the literal segment as a zoneId.
router.get('/by-pincode', validate(pincodeQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('Search easyfixers by pincode · pincode=' + req.query.pincode + ' limit=' + req.query.limit);
    const items = await zone.searchEasyfixersByPincode(req.query.pincode, { limit: req.query.limit });
    logger.info('Found ' + (Array.isArray(items) ? items.length : 0) + ' easyfixers for pincode ' + req.query.pincode);
    modernOk(res, { pincode: req.query.pincode, easyfixers: items });
  } catch (e) { next(e); }
});

router.get('/template', async (_req, res, next) => {
  try {
    logger.info('Generate zone mapping template');
    const buf = await zoneUpload.generateTemplate();
    res.setHeader('Content-Type',        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="easyfix-zone-mapping-template.xlsx"');
    res.send(Buffer.from(buf));
  } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Get zone detail · id=' + req.params.id);
    const data = await zone.getZoneDetail(req.params.id);
    if (!data) return modernError(res, 404, 'zone not found');
    modernOk(res, data);
  } catch (e) { next(e); }
});

// Pincodes the zone editor can pick from — ALL active pincodes (any city),
// searchable + paginated. Returns { items, total }.
router.get('/:id/assignable-pincodes',
  validate(idParam, 'params'),
  validate(assignableQuery, 'query'),
  async (req, res, next) => {
    try {
      logger.info('List assignable pincodes · zoneId=' + req.params.id + ' q=' + (req.query.q || '') + ' limit=' + req.query.limit + ' offset=' + req.query.offset + ' inZoneOnly=' + req.query.inZoneOnly);
      const result = await zone.listAssignablePincodes(Number(req.params.id), req.query);
      logger.info('Returning ' + (result && Array.isArray(result.items) ? result.items.length : (Array.isArray(result) ? result.length : 0)) + ' assignable pincodes · zoneId=' + req.params.id);
      modernOk(res, result);
    } catch (e) { next(e); }
  }
);

router.get('/:id/easyfixers', validate(idParam, 'params'), validate(searchQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('Search easyfixers in zone · zoneId=' + req.params.id + ' q=' + (req.query.q || '') + ' limit=' + req.query.limit + ' activeOnly=' + req.query.activeOnly);
    const items = await zone.searchEasyfixersInZone(req.params.id, req.query);
    logger.info('Found ' + (Array.isArray(items) ? items.length : 0) + ' easyfixers in zone ' + req.params.id);
    modernOk(res, items);
  } catch (e) { next(e); }
});

// ─── WRITE ───────────────────────────────────────────────────────────
router.post('/', validate(createBody), async (req, res, next) => {
  try {
    logger.info('Create zone · zone_name=' + req.body.zone_name + ' city_id=' + req.body.city_id);
    const created = await zone.createZone(req.body);
    logger.info('Zone created · id=' + (created && (created.zone_id || created.id)));
    res.status(201);
    modernOk(res, created, 'zone created');
  } catch (e) {
    if (e.status) logger.warn('Create zone failed · ' + e.message);
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.patch('/:id', validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    logger.info('Update zone · id=' + req.params.id);
    const updated = await zone.updateZone(Number(req.params.id), req.body);
    logger.info('Zone updated · id=' + req.params.id);
    modernOk(res, updated, 'zone updated');
  } catch (e) {
    if (e.status) logger.warn('Update zone failed · ' + e.message);
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * PATCH /:id/pincodes — replace the zone's pincode set. Body:
 *   { pincode_ids: [int, …] }
 * Empty array unassigns everything currently in the zone.
 *
 * Response includes `rejected: [{ pincode_id, pincode?, reason }]` for
 * rows the backend refused (already in another zone, wrong city, …).
 */
router.patch('/:id/pincodes', validate(idParam, 'params'), validate(pincodeMapBody), async (req, res, next) => {
  try {
    logger.info('Set zone pincode mapping · zoneId=' + req.params.id + ' pincodeCount=' + (Array.isArray(req.body.pincode_ids) ? req.body.pincode_ids.length : 0));
    const result = await zone.setPincodeMapping(
      Number(req.params.id),
      req.body.pincode_ids,
      { userId: userIdOf(req) }
    );
    logger.info('Pincode mapping saved · zoneId=' + req.params.id + ' rejected=' + (result && Array.isArray(result.rejected) ? result.rejected.length : 0));
    modernOk(res, result, 'pincode mapping saved');
  } catch (e) {
    if (e.status) logger.warn('Set pincode mapping failed · ' + e.message);
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

// ─── BULK upload ─────────────────────────────────────────────────────
router.post('/upload',
  upload.single('file'),
  validate(uploadQuery, 'query'),
  async (req, res, next) => {
    try {
      logger.info('Bulk zone upload · dryRun=' + req.query.dryRun + ' hasFile=' + !!req.file);
      if (!req.file) return modernError(res, 400, 'file (multipart field "file") is required');
      const out = await zoneUpload.processUpload(req.file.buffer, {
        dryRun: req.query.dryRun,
        userId: userIdOf(req),
      });
      logger.info('Bulk zone upload processed · dryRun=' + req.query.dryRun);
      modernOk(res, out);
    } catch (e) { next(e); }
  }
);

module.exports = router;
