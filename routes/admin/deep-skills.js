const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const ds = require('../../services/deep-skill.service');
const dsBulk = require('../../services/deep-skill-bulk.service');
const { modernOk, modernError } = require('../../utils/response');
const multer = require('multer');
const logger = require('../../logger');

/*
 * Image upload (2026-06-05).
 *
 * Multer in-memory storage so we can stream the buffer straight to S3
 * without touching local disk — mirrors the jobs `/images` upload at
 * routes/admin/jobs.js:1851. 10MB cap is the same; deep-skill images
 * are decorative and shouldn't need more than a standard product photo.
 */
/*
 * Allowlist for skill thumbnails (2026-06-10) — the editor only ever
 * shows small product-style images, so we hard-cap MIME types here
 * rather than trusting whatever the browser sent.
 */
const SKILL_IMAGE_MIMETYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
]);
const imageUpload = multer({
  storage: multer.memoryStorage(),
  // 2MB cap — skill images are thumbnails, never full-bleed assets.
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    if (SKILL_IMAGE_MIMETYPES.has(file.mimetype)) return cb(null, true);
    cb(Object.assign(
      new Error('unsupported image type — use PNG / JPEG / WEBP / GIF'),
      { status: 400 },
    ));
  },
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

// Pagination schema for the mapped-easyfixers sub-resource. Default 10
// keeps the modal's initial paint dense; cap of 500 matches the rest of
// the platform's sub-resource list endpoints (see
// validators/easyfixer.validator.js listSubresourceQuery).
const mappedEasyfixersQuery = Joi.object({
  limit:  Joi.number().integer().min(1).max(500).default(10),
  offset: Joi.number().integer().min(0).default(0),
});

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try { modernOk(res, await ds.list(req.query)); } catch (e) { next(e); }
});

/*
 * Route-ordering fix (2026-06-10 v2 — proper fix).
 *
 * The earlier `next('route')` stub did NOT work — Express's `next('route')`
 * SKIPS the remaining handlers on the matched route and continues to the
 * NEXT route that matches the URL. The next matching route is `/:id`,
 * which still rejects 'upload-template' as non-numeric → 400.
 *
 * Right fix: handle the literal path here, ABOVE `/:id`. The template-
 * generation logic is delegated to the original handler at the bottom
 * of the file — we just re-export it as a function so this top-level
 * route can call it directly. (Or: just inline a forwarding stub that
 * calls the handler function exported below.)
 *
 * Implementation: keeping the actual XLSX-generation block at the
 * bottom (it's 80 lines), we make the bottom handler EXPORT-equivalent
 * via a closure variable and invoke it from here.
 */
let uploadTemplateHandler = null; // assigned at bottom of file
router.get('/upload-template', async (req, res, next) => {
  if (!uploadTemplateHandler) return next(new Error('upload-template handler not registered'));
  return uploadTemplateHandler(req, res, next);
});

/*
 * GET /api/admin/deep-skills/download (2026-06-10).
 *
 * Streams an XLSX of the full catalogue (every skill + joined
 * category/type, options comma-joined, raw image filename, IST
 * created date). Inherits the admin-group guard from
 * routes/admin/index.js.
 *
 * Routed BEFORE `/:id` to avoid being shadowed (same trick as
 * /upload-template — `next('route')` lets us declare the real
 * handler further down without reordering this block).
 */
router.get('/download', async (_req, res, next) => {
  try {
    const buffer = await ds.downloadXlsx();
    const fname = `deep-skills-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Content-Length', String(buffer.byteLength));
    return res.end(Buffer.from(buffer));
  } catch (e) { return next(e); }
});

router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const data = await ds.getById(req.params.id);
    if (!data) return modernError(res, 404, 'deep skill not found');
    modernOk(res, data);
  } catch (e) { next(e); }
});

// ─── Mapped Easyfixers (sub-resource, read-only) ────────────────────
// Feeds the "View Mapped Easyfixers" modal on the Manage Deep Skills page.
// Aggregates all option-level mapping rows under the deep skill into one
// row per easyfixer (multiple option mappings for the same tech under
// the same deep skill collapse via GROUP BY easyfixer_id in the service).
// RBAC inherits the admin-group guard from routes/admin/index.js.
router.get('/:id/mapped-easyfixers',
  validate(idParam, 'params'),
  validate(mappedEasyfixersQuery, 'query'),
  async (req, res, next) => {
    try {
      const existing = await ds.getById(req.params.id);
      if (!existing) return modernError(res, 404, 'deep skill not found');
      const { rows, total } = await ds.listMappedEasyfixers(req.params.id, req.query);
      modernOk(res, { items: rows, total, limit: req.query.limit, offset: req.query.offset });
    } catch (e) { next(e); }
  });

/*
 * Bulk mapped-easyfixer counts (2026-06-08). Drives the "Mapped
 * Easyfixers" aggregate column on the Manage Deep Skills list page.
 * One round-trip returning counts for every skill_id on the current
 * page. FE caches results client-side for 30s.
 *
 * POST + body (not GET + querystring) so the FE can pass ~50-500 ids
 * without bumping the URL-length ceiling. Hard cap of 500 ids per
 * call is enforced inside the service.
 *
 * Registered as a LITERAL path BEFORE the `/:id` catch-alls below so
 * Express picks this route, not the parameterised ones, when the
 * caller hits POST /admin/deep-skills/mapped-easyfixer-counts.
 */
const mappedEasyfixerCountsBody = Joi.object({
  deepSkillIds: Joi.array().items(Joi.number().integer().positive()).min(1).max(500).required(),
});
router.post('/mapped-easyfixer-counts',
  validate(mappedEasyfixerCountsBody, 'body'),
  async (req, res, next) => {
    try {
      const { rows } = await ds.mappedEasyfixerCounts(req.body.deepSkillIds);
      modernOk(res, { items: rows });
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
/*
 * Image upload handler (2026-06-10).
 *
 * Single handler serves both the canonical `/upload-image` path and
 * the legacy `/image` alias (kept so older FE bundles don't 404 mid-
 * rollout). Delegates to `services/deep-skill.service.replaceImage`
 * which:
 *   - puts the new object at `Skills/Skill_<id>_<seq>`
 *   - UPDATEs tbl_deep_skill.deepskill_image
 *   - best-effort deletes the previous S3 object
 *   - returns a short-TTL presigned URL the FE can render immediately
 *
 * NOTE: the previous version of this handler queried `tbl_deepskill`
 * (no underscore) and wrote with the same broken name, so every
 * upload silently 404'd. Routing through the service helper now uses
 * the correct `tbl_deep_skill` table.
 */
async function handleImageUpload(req, res, next) {
  const skillId = Number(req.params.id);
  try {
    if (!req.file) return modernError(res, 400, 'missing "file" upload');
    logger.upload({
      skillId,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      bytes: req.file.size,
    }, 'deep skill image upload received');

    const result = await ds.replaceImage(skillId, {
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
      originalName: req.file.originalname,
    });
    modernOk(res, result, 'deep skill image uploaded');
  } catch (e) {
    if (e?.status && e.status >= 400 && e.status < 500) {
      return modernError(res, e.status, e.message);
    }
    next(e);
  }
}

router.post(
  '/:id/upload-image',
  validate(idParam, 'params'),
  imageUpload.single('file'),
  handleImageUpload,
);

// Legacy alias (kept so older FE bundles keep working during rollout).
router.post(
  '/:id/image',
  validate(idParam, 'params'),
  imageUpload.single('file'),
  handleImageUpload,
);

/*
 * Resolve the stored S3 key to a short-TTL presigned GET URL. Used
 * by the editor modal's Edit mode to render the existing image
 * preview without exposing the bucket publicly.
 */
router.get(
  '/:id/image-url',
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      const data = await ds.getImageUrl(req.params.id);
      modernOk(res, data);
    } catch (e) {
      if (e?.status && e.status >= 400 && e.status < 500) {
        return modernError(res, e.status, e.message);
      }
      next(e);
    }
  },
);

/*
 * Clear the image — null out the DB column AND best-effort delete
 * the underlying S3 object so we don't accumulate orphans.
 */
router.delete(
  '/:id/image',
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      const data = await ds.clearImage(req.params.id);
      modernOk(res, data, 'deep skill image cleared');
    } catch (e) {
      if (e?.status && e.status >= 400 && e.status < 500) {
        return modernError(res, e.status, e.message);
      }
      next(e);
    }
  },
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
/*
 * Implementation moved to a top-level variable so the literal-path
 * route registered ABOVE `/:id` can invoke it without re-declaring
 * the 80-line XLSX-generation block. See the `uploadTemplateHandler`
 * declaration near the top of this file (2026-06-10 route-ordering fix).
 */
uploadTemplateHandler = async (_req, res, next) => {
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

    /*
     * Row 1 — intentionally LEFT BLANK (2026-06-10 fix).
     *
     * The bulk-upload parser anchors on row 2 as the header row (see
     * `HEADER_ROW_INDEX = 2` in services/deep-skill-bulk.service.js
     * and the comment "Row 1: decorative section headers — SKIP"),
     * so this template must leave row 1 reserved. Previously it was
     * filled with placeholder text ("Screenshot 1", "deep skill
     * segregation added", etc) that matched legacy ops files but
     * looked like junk to operators downloading a fresh template.
     *
     * Now blank-celled. Backward compat: the parser's row-1-skip
     * rule still applies regardless of cell content, so files
     * uploaded with the OLD placeholder text continue to work.
     */
    ws.addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '']);

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
};

module.exports = router;
