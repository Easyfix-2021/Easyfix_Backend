const router = require('express').Router();
const multer = require('multer');
const crypto = require('crypto');

const logger = require('../../logger');
const validate = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const svc = require('../../services/branding.service');
const s3 = require('../../utils/s3-storage');
const { writeBuffer } = require('../../utils/file-storage');
const { modernOk, modernError } = require('../../utils/response');
const {
  brandingSettings,
  variantIdParam,
  variantListQuery,
  variantCreate,
  variantUpdate,
} = require('../../validators/branding.validator');

/*
 * Settings → Theme & Branding. Mounted at /api/admin/branding, so requireAuth +
 * role(['admin']) are already applied by routes/admin/index.js.
 *
 * Two surfaces behind two RBAC actions (seeded by
 * migrations/2026-08-18-settings-branding.sql):
 *
 *   isBrandingView — read the banner copy, the tagline and the festival
 *                    calendar. Broad on purpose: an operator troubleshooting
 *                    "why does the login page say that?" needs to see it
 *                    without being able to change it.
 *   isBrandingEdit — every write, including the S3 ornament upload.
 *
 * NOT property-gated. Unlike Switch Call Mode / Teleprompter, branding is
 * ordinary product configuration that belongs on the Manage Role screen, so it
 * carries real menu_action rows. The ONE property-gated thing here is the AI
 * art generator (FEATURES.canGenerateBrandArt → branding.ai.emails), registered
 * in services/feature-access.service.js and seeded EMPTY = deny-all.
 */
const requireBrandingView = requireAction('isBrandingView');
const requireBrandingEdit = requireAction('isBrandingEdit');

/*
 * Ornament upload — 10 MB cap, single file, memory storage. Identical shape to
 * /api/admin/notices/upload-image so the FE upload helper is reusable verbatim.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

// Same allowlist as the notice-image upload. SVG is deliberately absent — it
// executes script when rendered inline, and this asset is served to the
// UNAUTHENTICATED login page.
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// ─── GET / — everything the Branding screen renders in one call ──────
router.get('/', requireBrandingView, async (req, res, next) => {
  try {
    logger.info('Get branding settings + variants');
    const [settings, variants] = await Promise.all([
      Promise.resolve(svc.getSettings()),
      svc.listVariants({ includeDisabled: true, limit: 100, offset: 0 }),
    ]);
    logger.info('Returning branding config · variants=' + variants.length);
    return modernOk(res, { settings, variants });
  } catch (e) { next(e); }
});

// ─── PUT /settings — banner copy + login tagline ─────────────────────
/*
 * setProperty → flushCache → re-read through the resolver, the otp-channel
 * pattern. The response carries what getSettings() now resolves, never an echo
 * of the request body — so a caller can trust it as confirmation.
 */
router.put('/settings', requireBrandingEdit, validate(brandingSettings), async (req, res, next) => {
  try {
    logger.info('Update branding settings · fields=[' + Object.keys(req.body).join(', ') + ']');
    const { settings, written } = await svc.saveSettings(req.body);
    logger.info('Branding settings updated by user #' + req.user.user_id + ' · keys=' + written.length);
    return modernOk(res, settings, 'Branding settings saved');
  } catch (e) { next(e); }
});

// ─── GET /variants ───────────────────────────────────────────────────
router.get('/variants', requireBrandingView, validate(variantListQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('List theme variants · includeDisabled=' + req.query.includeDisabled + ' limit=' + req.query.limit + ' offset=' + req.query.offset);
    const variants = await svc.listVariants(req.query);
    logger.info('Returning ' + variants.length + ' theme variants');
    return modernOk(res, variants);
  } catch (e) { next(e); }
});

// ─── POST /variants ──────────────────────────────────────────────────
/*
 * `render_mode` ('overlay' | 'replace') decides whether the uploaded asset is
 * drawn OVER the official EasyFix lockup or INSTEAD of it. Joi defaults it to
 * 'overlay', so a client that omits the field creates a variant that behaves
 * exactly as every variant did before the field existed.
 *
 * It is logged because it is the one field on this row that can change what
 * brand mark an UNAUTHENTICATED page shows. When someone asks why the login
 * screen stopped showing the EasyFix logo, this line is the answer.
 */
router.post('/variants', requireBrandingEdit, validate(variantCreate), async (req, res, next) => {
  try {
    logger.info('Create theme variant · name=' + req.body.name + ' window=' + req.body.starts_on + '→' + req.body.ends_on + ' render_mode=' + req.body.render_mode);
    const created = await svc.createVariant(req.body, req.user.user_id);
    res.status(201);
    logger.info('Theme variant created · id=' + (created && created.id));
    return modernOk(res, created, 'Theme variant created');
  } catch (e) {
    if (e.status) { logger.warn('Create theme variant failed · ' + e.message); return modernError(res, e.status, e.message); }
    next(e);
  }
});

// ─── PATCH /variants/:id ─────────────────────────────────────────────
/*
 * PARTIAL, INCLUDING render_mode. The field is `.optional()` with NO Joi
 * default (see validators/branding.validator.js) and updateVariant only writes
 * keys the body actually carries — so a PATCH that nudges anchor_x leaves a
 * 'replace' variant on 'replace'. Sending render_mode explicitly is the only
 * way to change it.
 *
 * The response echoes the STORED mode. It is not the "will it actually render
 * that way today" mode: a 'replace' variant whose ornament is missing still
 * reads back as 'replace' here, on purpose, because that mismatch is exactly
 * what the operator needs to see in order to go and upload the art. The
 * lockup fallback is applied only on the public render path — see
 * getActiveVariant() in services/branding.service.js.
 */
router.patch(
  '/variants/:id',
  requireBrandingEdit,
  validate(variantIdParam, 'params'),
  validate(variantUpdate),
  async (req, res, next) => {
    try {
      logger.info('Update theme variant · id=' + req.params.id + ' fields=[' + Object.keys(req.body).join(', ') + ']');
      const updated = await svc.updateVariant(Number(req.params.id), req.body);
      if (!updated) return modernError(res, 404, 'Theme variant not found');
      logger.info('Theme variant updated · id=' + req.params.id);
      return modernOk(res, updated, 'Theme variant updated');
    } catch (e) {
      if (e.status) { logger.warn('Update theme variant failed · ' + e.message); return modernError(res, e.status, e.message); }
      next(e);
    }
  },
);

// ─── DELETE /variants/:id — soft: enabled = 0 ────────────────────────
router.delete('/variants/:id', requireBrandingEdit, validate(variantIdParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Disable theme variant · id=' + req.params.id);
    const disabled = await svc.disableVariant(Number(req.params.id));
    if (!disabled) return modernError(res, 404, 'Theme variant not found');
    logger.info('Theme variant disabled · id=' + req.params.id);
    return modernOk(res, disabled, 'Theme variant disabled');
  } catch (e) {
    if (e.status) { logger.warn('Disable theme variant failed · ' + e.message); return modernError(res, e.status, e.message); }
    next(e);
  }
});

// ─── GET /variants/:id/ornament-url — presigned preview ──────────────
/*
 * Lets an admin SEE the ornament on a variant that is not live today.
 *
 * THE GAP THIS CLOSES. GET /admin/branding returns each variant's
 * `ornament_key` but never a URL, and the only endpoint that presigned one was
 * the UNAUTHENTICATED /api/public/branding/active — which by definition only
 * ever covers the single window whose dates bracket today. So an admin
 * scheduling Diwali in August could upload an ornament, save, reopen the row,
 * and be told to re-upload the image just to look at it. Now every variant
 * previews, regardless of its window.
 *
 * A READ, SO IT IS GATED ON isBrandingView, not isBrandingEdit. Looking at the
 * ornament attached to a row is exactly as sensitive as reading the row, and
 * the view permission is deliberately broad (an operator troubleshooting the
 * login page needs to see what is on it without being able to change it).
 *
 * PREFIX GUARD — NOT RE-IMPLEMENTED HERE. svc.getVariantOrnamentUrl() calls the
 * same resolveOrnamentUrl() the public route reaches through getActiveVariant(),
 * so the `Branding/` allowlist is enforced in exactly one place. Authentication
 * does not buy a weaker check: rows written by a DBA or a future migration never
 * pass through Joi, and presigning whatever string happens to be in the column
 * would make this a presigned-URL oracle for the whole bucket — merely one that
 * costs an admin token first. If this guard ever needs changing, change it in
 * services/branding.service.js and BOTH callers move together.
 *
 * `{ url: null }` IS A SUCCESS. A variant with no ornament is the normal state
 * — "No Change" is the default on every new window — so a missing image is a
 * 200 with a null, never a 404. The 404 is reserved for a missing VARIANT, which
 * is the only thing the caller can actually act on.
 */
router.get(
  '/variants/:id/ornament-url',
  requireBrandingView,
  validate(variantIdParam, 'params'),
  async (req, res, next) => {
    try {
      logger.info('Resolve theme ornament URL · variant=' + req.params.id);
      const result = await svc.getVariantOrnamentUrl(Number(req.params.id));
      if (!result) return modernError(res, 404, 'Theme variant not found');
      logger.info('Ornament URL resolved · variant=' + req.params.id + ' hasUrl=' + (result.url != null));
      return modernOk(res, result);
    } catch (e) { next(e); }
  },
);

// ─── POST /variants/:id/ornament — image upload ──────────────────────
/*
 * Storage mirrors the notice-image route:
 *   - S3 on  → PutObject at Branding/<ts>_<rand> (no extension; Content-Type
 *              carries the MIME, original filename lives in object metadata).
 *              `url` is a short-lived presigned GET for the admin preview.
 *   - S3 off → writeBuffer('general') local fallback; key and url are the same
 *              relative /easydoc string.
 *
 * The `Branding/` prefix is load-bearing, not cosmetic: it is the allowlist
 * that services/branding.service.js checks before presigning anything for the
 * unauthenticated public endpoint. Do not write ornaments anywhere else.
 *
 * The key is persisted onto the row immediately, so the upload IS the save —
 * there is no dangling staged object waiting for a second call to claim it.
 */
router.post(
  '/variants/:id/ornament',
  requireBrandingEdit,
  validate(variantIdParam, 'params'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      logger.info('Upload theme ornament · variant=' + req.params.id + ' mime=' + (req.file?.mimetype || 'none') + ' size=' + (req.file?.size ?? 0));
      if (!req.file) return modernError(res, 400, 'missing "file" upload');
      if (!IMAGE_MIME.has(req.file.mimetype)) {
        logger.warn('Ornament rejected · disallowed mime=' + req.file.mimetype);
        return modernError(res, 400, `mimetype "${req.file.mimetype}" is not allowed; use PNG/JPEG/WEBP/GIF`);
      }

      // Confirm the variant exists BEFORE spending an S3 PUT on an orphan.
      const variant = await svc.getVariantById(Number(req.params.id));
      if (!variant) return modernError(res, 404, 'Theme variant not found');

      let key;
      let url;
      if (s3.isEnabled()) {
        const objectKey = `${svc.ORNAMENT_PREFIX}${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        key = await s3.putAtKey({
          key: objectKey,
          buffer: req.file.buffer,
          contentType: req.file.mimetype,
          originalName: req.file.originalname,
        });
        url = await s3.getPresignedUrl(key);
        logger.info('Ornament stored on S3 · key=' + key);
      } else {
        const result = writeBuffer('general', req.file.buffer, req.file.originalname, req.file.mimetype);
        key = result.url;
        url = result.url;
        logger.info('Ornament stored locally · key=' + key);
      }

      await svc.setOrnament(Number(req.params.id), key);
      return modernOk(res, { key, url }, 'ornament uploaded');
    } catch (e) {
      if (e.code === 'LIMIT_FILE_SIZE') {
        logger.warn('Ornament upload failed · file exceeds 10MB');
        return modernError(res, 400, 'file exceeds 10MB');
      }
      if (e.status) {
        logger.warn('Ornament upload rejected · ' + e.message);
        return modernError(res, e.status, e.message);
      }
      next(e);
    }
  },
);

module.exports = router;
