const router = require('express').Router();
const multer = require('multer');

const validate = require('../../middleware/validate');
const svc      = require('../../services/notice.service');
const s3       = require('../../utils/s3-storage');
const { writeBuffer } = require('../../utils/file-storage');
const { modernOk, modernError } = require('../../utils/response');
const {
  noticeIdParam,
  noticeListQuery,
  noticeActiveQuery,
  noticeCreate,
  noticeUpdate,
  noticePublishBody,
  noticeMarkReadBody,
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
 * Note on requireAction: we don't have a dedicated middleware factory
 * for action-key checks in this codebase yet (the existing routes
 * inline the check). Following the same pattern here keeps the
 * surface consistent. If/when an `requireAction()` middleware lands
 * we'll migrate this and the click-to-call route together.
 */

function requireNoticeManage(req, res, next) {
  const perms = req.user?.permissions?.actionPermissions || [];
  if (!perms.includes('isNoticeManage')) {
    return modernError(res, 403, 'Missing permission: isNoticeManage');
  }
  next();
}

// ─── List ────────────────────────────────────────────────────────────
router.get(
  '/',
  validate(noticeListQuery, 'query'),
  async (req, res, next) => {
    try {
      const data = await svc.listNotices(req.query);
      modernOk(res, data);
    } catch (e) { next(e); }
  },
);

// ─── Active feed for a surface (dashboard strip / app bell) ─────────
// NOTE: must be declared BEFORE /:noticeId — Express matches in order
// and `active` would otherwise be parsed as a notice id.
router.get(
  '/active',
  validate(noticeActiveQuery, 'query'),
  async (req, res, next) => {
    try {
      // For admin route, the reader is always the calling tbl_user. App
      // routes (Phase 2) will pass different readerType/readerId.
      const items = await svc.listActiveForSurface({
        surface:    req.query.surface,
        readerType: 'crm_user',
        readerId:   req.user?.user_id,
        limit:      req.query.limit,
      });
      modernOk(res, { items });
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

// ─── Detail ──────────────────────────────────────────────────────────
router.get(
  '/:noticeId',
  validate(noticeIdParam, 'params'),
  async (req, res, next) => {
    try {
      const row = await svc.getNoticeById(Number(req.params.noticeId));
      if (!row) return modernError(res, 404, 'Notice not found');
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
      const row = await svc.createNotice(req.body, req.user?.user_id);
      res.status(201);
      modernOk(res, row, 'Notice saved');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
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
      const row = await svc.updateNotice(Number(req.params.noticeId), req.body);
      if (!row) return modernError(res, 404, 'Notice not found');
      modernOk(res, row, 'Notice updated');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
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
      const row = await svc.publishNotice(
        Number(req.params.noticeId),
        req.body,
        req.user?.user_id,
      );
      if (!row) return modernError(res, 404, 'Notice not found');
      modernOk(res, row, row.status === 'scheduled' ? 'Notice scheduled' : 'Notice published');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
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
      const row = await svc.archiveNotice(Number(req.params.noticeId));
      if (!row) return modernError(res, 404, 'Notice not found');
      modernOk(res, row, 'Notice archived');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
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
      if (!req.file) return modernError(res, 400, 'missing "file" upload');
      if (!IMAGE_MIME.has(req.file.mimetype)) {
        return modernError(res, 400, `mimetype "${req.file.mimetype}" is not allowed; use PNG/JPEG/WEBP/GIF`);
      }
      if (s3.isEnabled()) {
        const key = await s3.putNoticeImage({
          buffer:       req.file.buffer,
          contentType:  req.file.mimetype,
          originalName: req.file.originalname,
        });
        const url = await s3.getPresignedUrl(key);
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
      return modernOk(res, { key: result.url, url: result.url }, 'image uploaded');
    } catch (e) {
      if (e.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'file exceeds 10MB');
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

// ─── Mark-as-read ────────────────────────────────────────────────────
// Open to any authenticated admin user. Idempotent — repeated calls
// don't bump read_at.
router.post(
  '/:noticeId/mark-read',
  validate(noticeIdParam, 'params'),
  validate(noticeMarkReadBody),
  async (req, res, next) => {
    try {
      await svc.markRead({
        noticeId:   Number(req.params.noticeId),
        surface:    req.body.surface,
        readerType: 'crm_user',
        readerId:   req.user?.user_id,
      });
      modernOk(res, { ok: true });
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

module.exports = router;
