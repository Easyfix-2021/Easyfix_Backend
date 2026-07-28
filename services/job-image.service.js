const { pool } = require('../db');
const logger = require('../logger');
const s3Storage = require('../utils/s3-storage');
const { writeBuffer } = require('../utils/file-storage');

/*
 * Job-image upload — the ONE place that turns an uploaded file into a stored
 * job image. Used by the ops route (POST /admin/jobs/:id/images) and the
 * client Book-a-service route (POST /client/jobs/:id/images) so both behave
 * identically.
 *
 * Storage: S3 at `JobSupportings/Booking_<jobId>_<seq>` when configured, else a
 * local-disk fallback (dev / single-host). Always writes a tbl_job_image row
 * with the resolved key/filename in `image`.
 */
async function uploadJobImage({ jobId, file, category = 'Booking' }) {
  if (!file || !file.buffer) {
    const err = new Error('missing "file" upload');
    err.status = 400;
    throw err;
  }

  // Next seq from existing rows (human-readable key; not a uniqueness key).
  const [[{ existing }]] = await pool.query(
    'SELECT COUNT(*) AS existing FROM tbl_job_image WHERE job_id = ?', [jobId]);
  const seq = Number(existing || 0) + 1;

  let image;
  let storage;
  if (s3Storage.isEnabled()) {
    try {
      image = await s3Storage.putJobImage({
        jobId, seq,
        buffer: file.buffer,
        contentType: file.mimetype,
        originalName: file.originalname,
        category,
      });
      storage = 's3';
    } catch (e) {
      logger.warn({ jobId, seq, err: e.message }, 'job image S3 put failed — local fallback');
      image = writeBuffer('job_files', file.buffer, file.originalname, file.mimetype).filename;
      storage = 'local-fallback';
    }
  } else {
    image = writeBuffer('job_files', file.buffer, file.originalname, file.mimetype).filename;
    storage = 'local';
  }

  const [ins] = await pool.query(
    `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, created_date)
     VALUES (?, ?, ?, ?, NOW())`,
    [jobId, image, String(category).toLowerCase(), 0]);

  logger.info('Job image stored · job=' + jobId + ' · seq=' + seq + ' · storage=' + storage);
  return { image_id: ins.insertId, job_id: jobId, image, image_category: String(category).toLowerCase(), job_stage: 0, seq, storage };
}

/*
 * Guarded delete of a single tbl_job_image row. Mirrors the storage-cleanup +
 * hard-DB-delete behaviour of the Images tab (routes/admin/jobs.js
 * DELETE /images/:imageId) but adds ownership guards so callers can restrict a
 * delete to a specific job AND a specific set of image_category values (used by
 * the Billing & Charges documents delete so Job Sheet / Purchase Order removal
 * can NEVER touch other categories).
 *
 *   opts.jobId       — if set, the row must belong to this job.
 *   opts.categories  — if set (array of labels), LOWER(image_category) must be
 *                      one of them (case-insensitive; the upload path lowercases).
 *
 * Returns the deleted row's summary, or null when nothing matched the guards
 * (caller maps null → 404). Storage removal is best-effort — an orphaned S3
 * object / local file is cheaper than a dangling DB row on a half-failed delete.
 */
async function deleteJobImage({ imageId, jobId = null, categories = null }) {
  const params = [Number(imageId)];
  let clause = '';
  if (jobId != null) { clause += ' AND job_id = ?'; params.push(Number(jobId)); }
  if (Array.isArray(categories) && categories.length) {
    clause += ` AND LOWER(image_category) IN (${categories.map(() => '?').join(',')})`;
    params.push(...categories.map((c) => String(c).toLowerCase()));
  }
  const [[row]] = await pool.query(
    `SELECT image_id, job_id, image, image_category
       FROM tbl_job_image WHERE image_id = ?${clause} LIMIT 1`,
    params
  );
  if (!row) return null;

  const stored = String(row.image || '').trim();
  if (stored) {
    if (stored.includes('/')) {
      // S3 key — deleteObject soft-fails internally.
      try { await s3Storage.deleteObject(stored); }
      catch (e) { logger.warn({ imageId, err: e?.message }, 'job image S3 delete failed (continuing with DB delete)'); }
    } else {
      // Legacy local-only bare filename. Path-traversal guarded.
      try {
        const fs = require('fs');
        const path = require('path');
        const root = process.env.UPLOAD_JOB_FILES;
        if (root) {
          const resolvedRoot = path.resolve(root);
          const localPath = path.resolve(resolvedRoot, stored);
          if (localPath === resolvedRoot || localPath.startsWith(resolvedRoot + path.sep)) {
            if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
          }
        }
      } catch (e) {
        logger.warn({ imageId, err: e?.message }, 'job image local unlink failed (continuing with DB delete)');
      }
    }
  }

  await pool.query('DELETE FROM tbl_job_image WHERE image_id = ?', [Number(imageId)]);
  logger.info('Job image deleted · imageId=' + imageId + ' · job=' + row.job_id + ' · category=' + row.image_category);
  return { image_id: Number(imageId), job_id: row.job_id, image_category: row.image_category };
}

module.exports = { uploadJobImage, deleteJobImage };
