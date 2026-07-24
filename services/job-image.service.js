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

module.exports = { uploadJobImage };
