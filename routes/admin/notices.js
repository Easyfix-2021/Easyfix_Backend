const router = require('express').Router();
const multer = require('multer');

const logger   = require('../../logger');
const validate = require('../../middleware/validate');
const svc      = require('../../services/notice.service');
const s3       = require('../../utils/s3-storage');
const { writeBuffer } = require('../../utils/file-storage');
const { modernOk, modernError } = require('../../utils/response');
const makeNoticeReader = require('../../utils/notice-reader-router');
const {
  noticeIdParam,
  noticeListQuery,
  noticeCreate,
  noticeUpdate,
  noticePublishBody,
} = require('../../validators/notice.validator');

/*
 * Image upload — 10 MB cap matches /api/shared/upload + S3 PutObject
 * defaults. Memory storage; we hand the buffer to either S3 or the
 * local file-storage util depending on whether S3 is enabled.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

/*
 * Notice Board CRM routes. All mounted under /api/admin/notices.
 *
 * Action gating: routes that MUTATE the notice (create / update /
 * publish / archive) require the `isNoticeManage` action permission.
 * READ routes (list / detail / active feed / mark-read) are open to
 * any admin-group user — operators consume the notice strip even
 * without authoring rights.
 *
 * Migrated 2026-05-30 to the shared `requireAction()` middleware
 * factory (middleware/require-action.js). The earlier inline pattern
 * read `req.user.permissions.actionPermissions` which was always
 * undefined — `requireAuth` only attaches the bare tbl_user row to
 * req.user. The factory loads permissions on demand via
 * getEffectivePermissions() and stashes them on req.user.permissions
 * for downstream reuse within the same request.
 */

const requireAction = require('../../middleware/require-action');
const requireNoticeManage = requireAction('isNoticeManage');

// ─── List ────────────────────────────────────────────────────────────
router.get(
  '/',
  validate(noticeListQuery, 'query'),
  async (req, res, next) => {
    try {
      logger.info('List notices · status=' + (req.query.status || 'all') + ' limit=' + req.query.limit + ' offset=' + req.query.offset);
      const data = await svc.listNotices(req.query);
      logger.info('Returning ' + (Array.isArray(data?.items) ? data.items.length : (Array.isArray(data) ? data.length : 0)) + ' notices');
      modernOk(res, data);
    } catch (e) { next(e); }
  },
);

// ─── Active feed + mark-read — delegated to shared factory ─────────
// `utils/notice-reader-router.js` owns the handlers. The same factory
// is mounted at `/api/mobile/notices` (and later `/api/client/notices`)
// — zero handler duplication across tiers. NOTE: must be declared
// BEFORE the `/:noticeId` route below, since Express matches in order
// and `active` would otherwise parse as a notice id.
//
// The CRM-side resolver hard-codes the surface to 'crm' AND the
// reader_type to 'crm_user'; the request's `?surface=` query param
// (if present) is ignored here — admins consuming the strip read AS
// CRM, never as another surface. This matches the previous behaviour.
router.use(makeNoticeReader((req) => ({
  surface: 'crm',
  type:    'crm_user',
  id:      req.user?.user_id,
})));

// ─── Detail ──────────────────────────────────────────────────────────
router.get(
  '/:noticeId',
  validate(noticeIdParam, 'params'),
  async (req, res, next) => {
    try {
      logger.info('Get notice detail · id=' + req.params.noticeId);
      const row = await svc.getNoticeById(Number(req.params.noticeId));
      if (!row) {
        logger.warn('Notice not found · id=' + req.params.noticeId);
        return modernError(res, 404, 'Notice not found');
      }
      modernOk(res, row);
    } catch (e) { next(e); }
  },
);

// ─── Create ──────────────────────────────────────────────────────────
router.post(
  '/',
  requireNoticeManage,
  validate(noticeCreate),
  async (req, res, next) => {
    try {
      logger.info('Create notice · title=' + (req.body?.title ? '"' + String(req.body.title).slice(0, 60) + '"' : 'untitled'));
      const row = await svc.createNotice(req.body, req.user?.user_id);
      logger.info('Notice created · id=' + (row?.id ?? row?.noticeId));
      res.status(201);
      modernOk(res, row, 'Notice saved');
    } catch (e) {
      if (e.status) {
        logger.warn('Notice create rejected · ' + e.message);
        return modernError(res, e.status, e.message);
      }
      next(e);
    }
  },
);

// ─── Update (drafts / scheduled only) ────────────────────────────────
router.patch(
  '/:noticeId',
  requireNoticeManage,
  validate(noticeIdParam, 'params'),
  validate(noticeUpdate),
  async (req, res, next) => {
    try {
      logger.info('Update notice · id=' + req.params.noticeId);
      const row = await svc.updateNotice(Number(req.params.noticeId), req.body);
      if (!row) {
        logger.warn('Notice not found for update · id=' + req.params.noticeId);
        return modernError(res, 404, 'Notice not found');
      }
      logger.info('Notice updated · id=' + req.params.noticeId);
      modernOk(res, row, 'Notice updated');
    } catch (e) {
      if (e.status) {
        logger.warn('Notice update rejected · id=' + req.params.noticeId + ' · ' + e.message);
        return modernError(res, e.status, e.message);
      }
      next(e);
    }
  },
);

// ─── Publish ─────────────────────────────────────────────────────────
router.post(
  '/:noticeId/publish',
  requireNoticeManage,
  validate(noticeIdParam, 'params'),
  validate(noticePublishBody),
  async (req, res, next) => {
    try {
      logger.info('Publish notice · id=' + req.params.noticeId);
      const row = await svc.publishNotice(
        Number(req.params.noticeId),
        req.body,
        req.user?.user_id,
      );
      if (!row) {
        logger.warn('Notice not found for publish · id=' + req.params.noticeId);
        return modernError(res, 404, 'Notice not found');
      }
      logger.info('Notice ' + (row.status === 'scheduled' ? 'scheduled' : 'published') + ' · id=' + req.params.noticeId);
      modernOk(res, row, row.status === 'scheduled' ? 'Notice scheduled' : 'Notice published');
    } catch (e) {
      if (e.status) {
        logger.warn('Notice publish rejected · id=' + req.params.noticeId + ' · ' + e.message);
        return modernError(res, e.status, e.message);
      }
      next(e);
    }
  },
);

// ─── Archive ─────────────────────────────────────────────────────────
router.post(
  '/:noticeId/archive',
  requireNoticeManage,
  validate(noticeIdParam, 'params'),
  async (req, res, next) => {
    try {
      logger.info('Archive notice · id=' + req.params.noticeId);
      const row = await svc.archiveNotice(Number(req.params.noticeId));
      if (!row) {
        logger.warn('Notice not found for archive · id=' + req.params.noticeId);
        return modernError(res, 404, 'Notice not found');
      }
      logger.info('Notice archived · id=' + req.params.noticeId);
      modernOk(res, row, 'Notice archived');
    } catch (e) {
      if (e.status) {
        logger.warn('Notice archive rejected · id=' + req.params.noticeId + ' · ' + e.message);
        return modernError(res, e.status, e.message);
      }
      next(e);
    }
  },
);

/*
 * DELETE /admin/notices/:noticeId — permanent removal.
 *
 * Sits alongside archive rather than replacing it: archive retires a notice
 * that legitimately ran, delete removes one that should never have existed
 * (typo / duplicate / test broadcast). Same isNoticeManage gate; the service
 * drops the read receipts in the same transaction.
 */
router.delete(
  '/:noticeId',
  requireNoticeManage,
  validate(noticeIdParam, 'params'),
  async (req, res, next) => {
    try {
      logger.info('Delete notice · id=' + req.params.noticeId);
      const row = await svc.deleteNotice(Number(req.params.noticeId));
      if (!row) {
        logger.warn('Notice not found for delete · id=' + req.params.noticeId);
        return modernError(res, 404, 'Notice not found');
      }
      logger.info('Notice deleted · id=' + req.params.noticeId);
      modernOk(res, row, 'Notice deleted');
    } catch (e) {
      if (e.status) {
        logger.warn('Notice delete rejected · id=' + req.params.noticeId + ' · ' + e.message);
        return modernError(res, e.status, e.message);
      }
      next(e);
    }
  },
);

// ─── Image upload (S3 → Notices/ prefix; local fallback when S3 off) ──
/*
 * POST /api/admin/notices/upload-image
 *   multipart/form-data: file = <image binary, required>
 *
 * Response:
 *   { key: "Notices/1716_a4b9c0d2", url: "<presigned GET URL>" }
 *
 * Storage:
 *   - S3 enabled (S3_BUCKET_NAME set)  → PutObject at Notices/<ts>_<rand>
 *     with Content-Type + original-filename metadata; `url` is a 5-min
 *     presigned GET. `key` is the stored S3 key — the FE round-trips it
 *     on Save so the BE can re-sign for display later.
 *   - S3 disabled (local dev)          → falls back to writeBuffer with
 *     category="general"; key + url both come from the local utility.
 *
 * Gated by isNoticeManage so only authors can upload. MIME validated
 * against the same allowlist /shared/upload uses (images only here).
 */
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

router.post(
  '/upload-image',
  requireNoticeManage,
  upload.single('file'),
  async (req, res, next) => {
    try {
      logger.info('Upload notice image · mime=' + (req.file?.mimetype || 'none') + ' size=' + (req.file?.size ?? 0));
      if (!req.file) return modernError(res, 400, 'missing "file" upload');
      if (!IMAGE_MIME.has(req.file.mimetype)) {
        logger.warn('Notice image rejected · disallowed mime=' + req.file.mimetype);
        return modernError(res, 400, `mimetype "${req.file.mimetype}" is not allowed; use PNG/JPEG/WEBP/GIF`);
      }
      if (s3.isEnabled()) {
        const key = await s3.putNoticeImage({
          buffer:       req.file.buffer,
          contentType:  req.file.mimetype,
          originalName: req.file.originalname,
        });
        const url = await s3.getPresignedUrl(key);
        logger.info('Notice image stored on S3 · key=' + key);
        return modernOk(res, { key, url }, 'image uploaded');
      }
      // Local fallback — store under the `general` category. The FE
      // form treats `key` as the round-trip token; for local mode the
      // key IS the URL (relative), so they're the same string.
      const result = writeBuffer(
        'general',
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
      );
      logger.info('Notice image stored locally · key=' + result.url);
      return modernOk(res, { key: result.url, url: result.url }, 'image uploaded');
    } catch (e) {
      if (e.code === 'LIMIT_FILE_SIZE') {
        logger.warn('Notice image upload failed · file exceeds 10MB');
        return modernError(res, 400, 'file exceeds 10MB');
      }
      if (e.status) {
        logger.warn('Notice image upload rejected · ' + e.message);
        return modernError(res, e.status, e.message);
      }
      next(e);
    }
  },
);

// /:noticeId/mark-read was previously declared here — now handled
// by the makeNoticeReader factory above (mounted on '/').

module.exports = router;
