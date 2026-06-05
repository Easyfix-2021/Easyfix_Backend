const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const ds = require('../../services/deep-skill.service');
const dsBulk = require('../../services/deep-skill-bulk.service');
const { modernOk, modernError } = require('../../utils/response');
const s3Storage = require('../../utils/s3-storage');
const multer = require('multer');
const { pool } = require('../../db');
const logger = require('../../logger');

/*
 * Image upload (2026-06-05).
 *
 * Multer in-memory storage so we can stream the buffer straight to S3
 * without touching local disk — mirrors the jobs `/images` upload at
 * routes/admin/jobs.js:1851. 10MB cap is the same; deep-skill images
 * are decorative and shouldn't need more than a standard product photo.
 */
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

/*
 * Bulk-upload (2026-06-05) — separate multer instance so the .xlsx mime check
 * is enforced here without leaking into the per-skill image upload above.
 * 10MB cap matches every other ops bulk-upload flow (zones, pincodes).
 */
const XLSX_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream', // some browsers/curl send this for .xlsx
]);
const bulkUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const okExt  = /\.xlsx$/i.test(file.originalname);
    const okMime = XLSX_MIMETYPES.has(file.mimetype);
    if (okExt || okMime) return cb(null, true);
    cb(Object.assign(new Error('only .xlsx files are accepted'), { status: 400 }));
  },
});

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const optIdParam = Joi.object({
  id:       Joi.number().integer().positive().required(),
  optionId: Joi.number().integer().positive().required(),
});
const listQuery = Joi.object({
  categoryId:      Joi.number().integer().optional(),
  serviceTypeId:   Joi.number().integer().optional(),
  includeInactive: Joi.boolean().default(false),
});
const createBody = Joi.object({
  category_id:            Joi.number().integer().required(),
  service_type_id:        Joi.number().integer().required(),
  deepskill_name:         Joi.string().min(1).max(255).required(),
  deepskill_description:  Joi.string().max(1000).allow('', null).optional(),
  // deepskill_tag_words (2026-06-06): VARCHAR(255) — per-skill
  // technician-visit tags (max ~2 short phrases per ops convention).
  deepskill_tag_words:    Joi.string().max(255).allow('', null).optional(),
  deepskill_image:        Joi.string().max(500).allow('', null).optional(),
});
const updateBody = Joi.object({
  category_id:            Joi.number().integer().optional(),
  service_type_id:        Joi.number().integer().optional(),
  deepskill_name:         Joi.string().min(1).max(255).optional(),
  deepskill_description:  Joi.string().max(1000).allow('', null).optional(),
  deepskill_tag_words:    Joi.string().max(255).allow('', null).optional(),
  deepskill_image:        Joi.string().max(500).allow('', null).optional(),
  status:                 Joi.number().integer().valid(0, 1).optional(),
}).min(1);
const optionBody      = Joi.object({ skill_option: Joi.string().min(1).max(500).required() });
const optionPatchBody = Joi.object({
  skill_option: Joi.string().min(1).max(500).optional(),
  status:       Joi.number().integer().valid(0, 1).optional(),
}).min(1);

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try { modernOk(res, await ds.list(req.query)); } catch (e) { next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const data = await ds.getById(req.params.id);
    if (!data) return modernError(res, 404, 'deep skill not found');
    modernOk(res, data);
  } catch (e) { next(e); }
});

router.post('/', validate(createBody), async (req, res, next) => {
  try {
    const created = await ds.create(req.body, req.user);
    res.status(201);
    modernOk(res, created, 'deep skill created');
  } catch (e) { next(e); }
});

router.patch('/:id', validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try { modernOk(res, await ds.update(req.params.id, req.body), 'deep skill updated'); } catch (e) { next(e); }
});

// Soft-delete / deactivate — we never hard-delete because tbl_efr_deepskill_mapping
// holds FKs back to deepskill_id for every technician who ever had this skill.
router.delete('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try { modernOk(res, await ds.setStatus(req.params.id, false), 'deep skill deactivated'); } catch (e) { next(e); }
});

// ─── Options (nested under a deep skill) ────────────────────────────
router.post('/:id/options', validate(idParam, 'params'), validate(optionBody), async (req, res, next) => {
  try { modernOk(res, await ds.addOption(req.params.id, req.body), 'option added'); } catch (e) { next(e); }
});

router.patch('/:id/options/:optionId', validate(optIdParam, 'params'), validate(optionPatchBody), async (req, res, next) => {
  try { modernOk(res, await ds.updateOption(req.params.id, req.params.optionId, req.body), 'option updated'); } catch (e) { next(e); }
});

router.delete('/:id/options/:optionId', validate(optIdParam, 'params'), async (req, res, next) => {
  try { modernOk(res, await ds.deleteOption(req.params.id, req.params.optionId), 'option removed'); } catch (e) { next(e); }
});

/*
 * POST /api/admin/deep-skills/:id/image
 *
 * Multipart upload: field `file`, single file, max 10MB. Stores at
 * `Skills/Skill_<id>_<seq>` per the ops-confirmed convention (2026-06-05)
 * and patches `tbl_deepskill.deepskill_image` with the new S3 key.
 *
 * Seq policy: each upload increments seq (parsed from the previous
 * key's tail integer). Old versions stay in S3 for audit; the DB
 * column always points at the newest. If the previous value isn't a
 * canonical key (e.g. legacy NULL or a bare filename from
 * /shared/files), seq starts at 1.
 *
 * Returns the new `{ image }` key string so the FE can update its
 * local state without a re-fetch.
 *
 * Requires S3 to be configured (S3_BUCKET_NAME env). If not, returns
 * 503 with a guidance message; deep-skill images don't have a local-
 * disk fallback by design — the legacy `easyfixer_documents` path was
 * never the canonical home for them.
 */
router.post(
  '/:id/image',
  validate(idParam, 'params'),
  imageUpload.single('file'),
  async (req, res, next) => {
    const skillId = Number(req.params.id);
    try {
      if (!req.file) {
        return modernError(res, 400, 'missing "file" upload');
      }
      if (!s3Storage.isEnabled()) {
        return modernError(res, 503,
          'S3 is not configured on this deploy (set S3_BUCKET_NAME in backend.env)');
      }

      // Resolve current row → derive next seq from existing key's tail.
      const [[row]] = await pool.query(
        'SELECT deepskill_image FROM tbl_deepskill WHERE deepskill_id = ?',
        [skillId]
      );
      if (!row) return modernError(res, 404, 'deep skill not found');

      const prev = String(row.deepskill_image || '');
      const match = prev.match(/^Skills\/Skill_\d+_(\d+)$/);
      const seq = match ? Number(match[1]) + 1 : 1;

      logger.upload({
        skillId, seq,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        bytes: req.file.size,
      }, 'deep skill image upload received');

      const Key = await s3Storage.putSkillImage({
        skillId, seq,
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        originalName: req.file.originalname,
      });

      // Persist the new key. Single UPDATE; the existing
      // ds.update() applies its own diff logic for textual fields,
      // but here we only touch this one column so a direct UPDATE is
      // both simpler and avoids the full update() path's audit trail
      // (image swap is a logically-distinct operation).
      await pool.query(
        'UPDATE tbl_deepskill SET deepskill_image = ? WHERE deepskill_id = ?',
        [Key, skillId]
      );

      modernOk(res, { image: Key }, 'deep skill image uploaded');
    } catch (e) { next(e); }
  }
);

/*
 * POST /api/admin/deep-skills/bulk-upload
 *
 * Multipart upload: field `file`, single .xlsx, max 10MB.
 * Query: ?commit=true     → write to DB inside a transaction.
 *        otherwise         → dry-run (parse + validate + resolve, no writes).
 *
 * Body shape matches the contract documented in services/deep-skill-bulk.service.js.
 * Per-row errors do NOT fail the request — they appear in the rows[] array
 * with status="error". Only whole-file failures (bad mimetype, parse fail,
 * header-row mismatch) return non-200.
 *
 * TODO(permissions): currently inherits the admin group guard from
 * routes/admin/index.js. If ops wants this scoped tighter than the existing
 * `isDeepSkillAddNew` action, mint a new `isDeepSkillBulkUpload` key via the
 * standard menu+action_name seed migration and gate here.
 */
router.post(
  '/bulk-upload',
  bulkUpload.single('file'),
  async (req, res, next) => {
    if (!req.file) return modernError(res, 400, 'missing "file" upload');

    const commit =
      String(req.query.commit || '').toLowerCase() === 'true' ||
      req.body?.commit === true ||
      String(req.body?.commit || '').toLowerCase() === 'true';

    logger.info({
      mode:         commit ? 'commit' : 'preview',
      originalName: req.file.originalname,
      bytes:        req.file.size,
      actor:        req.user?.user_id,
    }, 'deep-skill bulk upload received');

    try {
      const result = await dsBulk.processBuffer(req.file.buffer, {
        commit,
        actor: req.user,
      });
      return modernOk(res, result,
        commit ? 'deep skills bulk-uploaded' : 'deep skills preview generated');
    } catch (e) {
      if (e.status && e.status >= 400 && e.status < 500) {
        return modernError(res, e.status, e.message);
      }
      return next(e);
    }
  },
);

/*
 * GET /api/admin/deep-skills/upload-template
 *
 * Emits a blank .xlsx in the exact ops-shape so operators editing a
 * fresh catalogue file start from a canonical template — eliminates
 * the class of bug where someone hand-built a workbook with slightly
 * different column headers and the bulk-upload endpoint 400s on
 * header mismatch.
 *
 * Shape (mirrors the 4 sample files in ops's Downloads/ on 2026-06-05):
 *   Row 1 — decorative section labels ("Screenshot 1", "Screenshot 2 -
 *           Left Column", "Screenshot 2 - Selection Details", "SCREEN
 *           SHOT 3", "deep skill segregation added" repeated across
 *           the option columns)
 *   Row 2 — REAL column headers (anchor strings the bulk-upload
 *           parser regex-matches). Bold + filled background to read
 *           as the header row.
 *   Row 3 — example row pre-filled with placeholder italic text so
 *           operators see the column-value semantic. They overwrite
 *           with real data; the bulk-upload parser's "template noise"
 *           detection (cells equal to `service_catg_name` etc.) will
 *           still skip if they forget.
 *
 * No auth-side effects: pure read endpoint, but inherits the admin
 * group guard from routes/admin/index.js so unauthorized roles can't
 * exfiltrate a template (low-sensitivity but matches the rest of the
 * route group).
 */
router.get('/upload-template', async (_req, res, next) => {
  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'EasyFix CRM';
    wb.created = new Date(0); // deterministic mtime so re-downloads are byte-identical
    const ws = wb.addWorksheet('Deep Skills');

    // Column widths roughly matching the sample files for readability.
    ws.columns = [
      { width: 60 }, // A — Key words
      { width: 40 }, // B — Tag words
      { width: 28 }, // C — Service Category
      { width: 28 }, // D — Service Type
      { width: 36 }, // E — Services
      { width: 36 }, // F — deep skill option 1
      { width: 22 }, { width: 22 }, { width: 22 }, { width: 22 },
      { width: 22 }, { width: 22 }, { width: 22 }, { width: 22 },
    ];

    // Row 1 — decorative section labels (matches ops files; ignored by
    // the parser via the row-1-skip rule).
    const decor = [
      'Screenshot 1',
      'Screenshot 2 - Left Column',
      'Screenshot 2 - Selection Details',
      'SCREEN SHOT 3',
      'deep skill segregation added',
      'deep skill segregation added',
      'deep skill segregation added', 'deep skill segregation added',
      'deep skill segregation added', 'deep skill segregation added',
      'deep skill segregation added', 'deep skill segregation added',
      'deep skill segregation added', 'deep skill segregation added',
    ];
    ws.addRow(decor);

    // Row 2 — REAL column headers (parser anchors). Keep these strings
    // in lock-step with the header-validation regexes in
    // services/deep-skill-bulk.service.js — changing one without the
    // other breaks the contract.
    const headers = [
      'Key words Attached to theTechnician who selects the skill',
      'Tag Words to tell technicians when attending the service, THIS he should KEEP in mind. ((MAX 2 Tags))',
      'Service Category',
      'Service Type',
      'Services',
      'deep skill detailed segregation 1',
      '+1', '+1', '+1', '+1', '+1', '+1', '+1', '+1',
    ];
    const headerRow = ws.addRow(headers);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' },
    };

    // Row 3 — example placeholder row so operators see the semantic
    // at a glance. The bulk-upload parser SKIPs rows where columns C/D/E
    // literally equal `service_catg_name` / `service_type_name` /
    // `deepskill_name`, so this template row is safe to leave in a file
    // operators forget to delete.
    const example = [
      'comma-separated keyword search terms (long string)',
      'short tag (max ~2 phrases)',
      'service_catg_name',
      'service_type_name',
      'deepskill_name',
      'first skill option (chip)',
      'additional option chip', 'additional option chip', '', '', '', '', '', '',
    ];
    const exampleRow = ws.addRow(example);
    exampleRow.font = { italic: true, color: { argb: 'FF9CA3AF' } };

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="deep-skills-bulk-upload-template.xlsx"',
    );
    res.setHeader('Content-Length', String(buffer.byteLength));
    return res.end(Buffer.from(buffer));
  } catch (e) { return next(e); }
});

module.exports = router;
