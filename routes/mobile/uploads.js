const router = require('express').Router();
const multer = require('multer');
const crypto = require('crypto');

const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const s3Storage = require('../../utils/s3-storage');
const { writeBuffer } = require('../../utils/file-storage');
const uploadLogger = require('../../logger');
const {
  verifyIdempotencyUpload,
  deterministicUploadToken,
} = require('../../middleware/verify-idempotency-upload');

/*
 * /api/mobile/uploads — generic Technician-app image-upload primitive.
 *
 * Mounted UNDER /uploads in routes/mobile/index.js, AFTER
 * `router.use(requireTechAuth)`, so `req.tech.efr_id` is always populated.
 *
 * REQUIRED MOUNT (add to routes/mobile/index.js, alongside the other
 *   sub-router mounts, e.g. after `router.use('/notices', …)`):
 *
 *     router.use('/uploads', require('./uploads'));
 *
 * Mounting under /uploads means the path below resolves to:
 *   POST /api/mobile/uploads
 *
 * CONTRACT
 *   multipart/form-data:
 *     file   (required) — the image bytes (png/jpg/jpeg/webp)
 *     kind   (optional) — 'kyc' | 'job' | 'profile' | 'general'
 *                         (cosmetic key prefix hint; defaults to 'general')
 *   →  modernOk { key, url, imageId }
 *
 * `imageId` is ALIASED to `key` so the RN's loose `{ url, imageId }` mapper
 * is satisfied. The RN flow is: call THIS endpoint first to upload the
 * bytes, then pass the returned `key` (== imageId) as the ref/id to the
 * downstream endpoints — job-images (`refs[]`), selfie, saveIdentity (KYC).
 *
 * Storage: S3 when configured (key `MobileUploads/<efrId>_<ts>_<rand8>`,
 * no extension on the key — Content-Type + original-filename carry the
 * real type, mirroring the JobSupportings/Notices conventions). When S3 is
 * disabled (local dev, no S3_BUCKET_NAME) it falls back to the local disk
 * via file-storage.writeBuffer('general', …) and returns that filename as
 * the key + its public URL.
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  // Images only — same allowlist the admin job-image upload enforces.
  fileFilter: (_req, file, cb) => {
    const ok = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(
      String(file.mimetype || '').toLowerCase(),
    );
    if (!ok) {
      const e = new Error('only png/jpg/jpeg/webp images are allowed');
      e.code = 'LIMIT_UNEXPECTED_FILE';
      return cb(e);
    }
    return cb(null, true);
  },
});

// Build a collision-resistant S3 key. Mirrors buildNoticeKey's id style
// (<ts>_<rand8>) but namespaced under MobileUploads/ and prefixed with the
// technician's efr_id for at-a-glance ownership in the bucket. crypto
// randomness (NOT Math.random) keeps the suffix unguessable.
function buildKey(efrId, req) {
  const stableToken = deterministicUploadToken(req);
  if (stableToken) return `MobileUploads/${Number(efrId)}_${stableToken}`;
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  return `MobileUploads/${Number(efrId)}_${ts}_${rand}`;
}

router.post('/', upload.single('file'), verifyIdempotencyUpload, async (req, res, next) => {
  const efrId = req.tech.efr_id;
  try {
    if (!req.file) {
      uploadLogger.warn('Mobile upload rejected · missing file');
      return modernError(res, 400, 'missing "file" upload');
    }
    const kind = String(req.body?.kind || 'general').trim() || 'general';
    uploadLogger.info('Mobile upload received · kind=' + kind + ' bytes=' + req.file.size);

    let key;
    let url;
    let storage;

    if (s3Storage.isEnabled()) {
      key = await s3Storage.putAtKey({
        key: buildKey(efrId, req),
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        originalName: req.file.originalname,
      });
      url = await s3Storage.resolveImageUrl(key);
      storage = 's3';
    } else {
      // Local fallback — return the bare filename as the key so the
      // downstream consumers persist a value resolveImageUrl can read back.
      const stableToken = deterministicUploadToken(req);
      const saved = writeBuffer(
        'general',
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        stableToken ? { deterministicStem: `MobileUpload_${Number(efrId)}_${stableToken}` } : undefined,
      );
      key = saved.filename;
      url = saved.url;
      storage = 'local';
    }

    uploadLogger.upload(
      {
        efrId,
        kind,
        key,
        storage,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        bytes: req.file.size,
      },
      'mobile upload stored',
    );

    // `imageId` aliases `key` for the RN's loose { url, imageId } mapper.
    uploadLogger.info('Mobile upload stored · kind=' + kind + ' storage=' + storage + ' key=' + key);
    return modernOk(res, { key, url, imageId: key });
  } catch (e) {
    if (e?.code === 'LIMIT_FILE_SIZE') {
      uploadLogger.warn('Mobile upload rejected · file exceeds 10MB · ' + e.message);
      return modernError(res, 400, 'file exceeds 10MB');
    }
    if (e?.code === 'LIMIT_UNEXPECTED_FILE') {
      uploadLogger.warn('Mobile upload rejected · unsupported file · ' + e.message);
      return modernError(res, 400, e.message || 'unsupported file');
    }
    uploadLogger.error('Mobile upload failed · ' + e.message);
    uploadLogger.error({ efrId, err: e }, 'mobile upload failed');
    return next(e);
  }
});

/*
 * POST /api/mobile/uploads/document — like POST /uploads, but ALSO inserts a
 * `document` row and returns its numeric id, so callers that reference a document
 * FK (tbl_job.tx_selfie_id → document.id for the reached-location selfie) get a
 * real integer id instead of an opaque S3-key string. The S3 key is stored in
 * document.path so the admin selfie resolver can presign it on read; url is left
 * NULL. Same multer allowlist / size limit as the generic upload.
 *
 *   →  modernOk { documentId, key, url }
 */
router.post('/document', upload.single('file'), verifyIdempotencyUpload, async (req, res, next) => {
  const efrId = req.tech.efr_id;
  try {
    if (!req.file) {
      uploadLogger.warn('Mobile document upload rejected · missing file');
      return modernError(res, 400, 'missing "file" upload');
    }
    const kind = String(req.body?.kind || 'general').trim() || 'general';

    let key;
    let url;
    let storage;
    if (s3Storage.isEnabled()) {
      key = await s3Storage.putAtKey({
        key: buildKey(efrId, req),
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        originalName: req.file.originalname,
      });
      url = await s3Storage.resolveImageUrl(key);
      storage = 's3';
    } else {
      const stableToken = deterministicUploadToken(req);
      const saved = writeBuffer(
        'general',
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        stableToken ? { deterministicStem: `MobileUpload_${Number(efrId)}_${stableToken}` } : undefined,
      );
      key = saved.filename;
      url = saved.url;
      storage = 'local';
    }

    // Persist a document row so a numeric FK can reference it. S3 KEY → `path`
    // (resolver presigns from it); url + document_type_id left NULL. created_by
    // is the technician's efr_id (nullable column — matches the legacy insert).
    const [ins] = await pool.query(
      'INSERT INTO document (`path`, url, file_name, created_on, created_by, document_type_id) '
      + 'VALUES (?, NULL, ?, NOW(), ?, NULL)',
      [key, req.file.originalname || null, efrId || null],
    );
    const documentId = ins.insertId;

    uploadLogger.upload(
      { efrId, kind, key, storage, documentId, originalName: req.file.originalname, mimeType: req.file.mimetype, bytes: req.file.size },
      'mobile document upload stored',
    );
    uploadLogger.info('Mobile document upload stored · kind=' + kind + ' storage=' + storage + ' documentId=' + documentId);
    return modernOk(res, { documentId, key, url });
  } catch (e) {
    if (e?.code === 'LIMIT_FILE_SIZE') {
      uploadLogger.warn('Mobile document upload rejected · file exceeds 10MB · ' + e.message);
      return modernError(res, 400, 'file exceeds 10MB');
    }
    if (e?.code === 'LIMIT_UNEXPECTED_FILE') {
      uploadLogger.warn('Mobile document upload rejected · unsupported file · ' + e.message);
      return modernError(res, 400, e.message || 'unsupported file');
    }
    uploadLogger.error('Mobile document upload failed · ' + e.message);
    uploadLogger.error({ efrId, err: e }, 'mobile document upload failed');
    return next(e);
  }
});

module.exports = router;
module.exports._internals = { buildKey };
