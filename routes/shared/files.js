const router = require('express').Router();
const multer = require('multer');

const logger = require('../../logger');
const validate = require('../../middleware/validate');
const { role } = require('../../middleware/role');
const { writeBuffer, unlinkFile } = require('../../utils/file-storage');
const { modernOk, modernError } = require('../../utils/response');
const { uploadForm, deleteQuery } = require('../../validators/files.validator');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

/*
 * POST /api/shared/upload
 *   multipart/form-data:
 *     file       = <binary, required>
 *     category   = easyfixer_documents | job_files | invoices | general (default)
 *
 * DELETE /api/shared/files?category=...&filename=...   [ADMIN GROUP ONLY]
 *   Both query params are required. Filename must not contain "/", "\", or null bytes.
 *   Resolved path must start with the category root (path-traversal guard).
 *
 *   This raw filename delete carries NO owner/entity linkage (on-disk names are
 *   opaque `{ts}_{rand8}{ext}`), so ownership cannot be authorized from the name
 *   alone. It is therefore gated to the `admin` group — a technician (efr) or
 *   client SPOC bearer, which requireAuth otherwise accepts on this shared mount,
 *   now fails closed (403). Entity-aware deletes that also remove DB rows and are
 *   scope-checked (e.g. tbl_job_image via DELETE /api/admin/jobs/images/:imageId,
 *   tbl_easyfixer_document) live in the owning route groups, NOT here. No app/CRM
 *   caller uses this shared delete today (they use the entity endpoints).
 */

router.post('/upload', upload.single('file'), validate(uploadForm, 'body'), async (req, res, next) => {
  try {
    logger.info('Upload file · category=' + (req.body.category || 'general') + ' type=' + (req.file ? req.file.mimetype : 'none'));
    if (!req.file) return modernError(res, 400, 'missing "file" upload');

    const result = writeBuffer(
      req.body.category,
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
    );
    logger.info('File uploaded · category=' + (req.body.category || 'general'));
    modernOk(res, result, 'file uploaded');
  } catch (e) {
    if (e.code === 'LIMIT_FILE_SIZE') { logger.warn('Upload rejected · file exceeds 10MB'); return modernError(res, 400, 'file exceeds 10MB'); }
    if (e.status) { logger.warn('Upload failed · ' + e.message); return modernError(res, e.status, e.message); }
    next(e);
  }
});

router.delete('/files', role(['admin']), validate(deleteQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('Delete file · category=' + req.query.category + ' filename=' + req.query.filename);
    const result = unlinkFile(req.query.category, req.query.filename);
    logger.info('File deleted · category=' + req.query.category + ' filename=' + req.query.filename);
    modernOk(res, result, 'file deleted');
  } catch (e) {
    if (e.status) { logger.warn('Delete failed · ' + e.message); return modernError(res, e.status, e.message); }
    next(e);
  }
});

module.exports = router;
