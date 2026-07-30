const router = require('express').Router();
const Joi = require('joi');
const multer = require('multer');

const validate = require('../../middleware/validate');
const { requirePropertyAllowlist } = require('../../middleware/require-property-allowlist');
const { FEATURES } = require('../../services/feature-access.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const { uploadJobImage, deleteJobImage } = require('../../services/job-image.service');
const { imageUrl, DOC_CATEGORIES } = require('../../services/job-charges.service');
const { scopedJob } = require('./jobs');

/*
 * Billing & Charges — Job Sheet / Purchase Order documents (mounted at
 * /api/admin/jobs). Both are ordinary `tbl_job_image` rows discriminated by
 * `image_category` ('JobSheet' | 'PurchaseOrder'), stored via the shared
 * job-image.service (S3 with local-disk fallback), so they read back through
 * the same authenticated /jobs/images/:imageId/file serve endpoint the Images
 * tab uses.
 *
 * Row scope: scopedJob (manage_* RBAC). Gating: property allowlist
 * `job.charges.emails` on BOTH the upload and the delete (fail-closed). The
 * delete is category-guarded in the service so it can never remove non-document
 * images (Booking / stage photos / signatures).
 */

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const docDeleteParams = Joi.object({
  id: Joi.number().integer().positive().required(),
  imageId: Joi.number().integer().positive().required(),
});

const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

const gate = requirePropertyAllowlist(FEATURES.canManageJobCharges, { label: 'Manage Job Charges' });

// Canonical category matcher — accepts the exact labels case-insensitively and
// returns the canonical form ('JobSheet' | 'PurchaseOrder'), else null.
function resolveCategory(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return DOC_CATEGORIES.find((c) => c.toLowerCase() === v) || null;
}

// ─── UPLOAD a Job Sheet / Purchase Order ─────────────────────────────
router.post(
  '/:id/documents',
  gate,
  validate(idParam, 'params'),
  scopedJob,
  docUpload.single('file'),
  async (req, res, next) => {
    const jobId = Number(req.params.id);
    try {
      const category = resolveCategory(req.body && req.body.category);
      if (!category) {
        return modernError(res, 400, "category must be 'JobSheet' or 'PurchaseOrder'");
      }
      if (!req.file || !req.file.buffer) {
        return modernError(res, 400, 'missing "file" upload');
      }
      const result = await uploadJobImage({ jobId, file: req.file, category });
      logger.info('Job document uploaded · jobId=' + jobId + ' · imageId=' + result.image_id + ' · category=' + category);
      return modernOk(res, { image_id: result.image_id, url: imageUrl(result.image_id) }, 'document uploaded');
    } catch (e) {
      if (e && e.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'file exceeds 10MB');
      if (e && e.status === 400) return modernError(res, 400, e.message);
      logger.error({ jobId, err: e?.message }, 'job document upload failed');
      next(e);
    }
  }
);

// ─── DELETE a document (category-guarded — never other image kinds) ──
router.delete(
  '/:id/documents/:imageId',
  gate,
  validate(docDeleteParams, 'params'),
  scopedJob,
  async (req, res, next) => {
    try {
      const out = await deleteJobImage({
        imageId: req.params.imageId,
        jobId: req.params.id,
        categories: DOC_CATEGORIES,
      });
      if (!out) return modernError(res, 404, 'document not found');
      return modernOk(res, { image_id: out.image_id, deleted: true }, 'document deleted');
    } catch (e) { next(e); }
  }
);

module.exports = router;
