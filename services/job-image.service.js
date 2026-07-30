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

/**
 * Serve a stored job-image value (an S3 key OR a legacy server filename) to an
 * HTTP response, so both storage backends render identically. Mirrors the
 * admin `GET /images/:imageId/file` resolution order:
 *   1. In S3 (stored key, or JobSupportings/Job_Images basename) → 302 presigned URL.
 *   2. On local disk (fallback uploads / pre-S3 files) → stream with sendFile.
 *   3. FILE_BASE_URL is an ABSOLUTE url (prod Nginx-served /easydoc) → 302 to it.
 *   4. Otherwise → 404 (FE shows the empty state, not a broken-image icon).
 * Callers own the row lookup + RBAC; this only does the storage resolution.
 */
async function serveResolvedImage(res, storedValue) {
  const fs = require('fs');
  const path = require('path');
  const stored = String(storedValue || '').trim();
  if (!stored) { res.status(404).json({ success: false, error: 'image not found' }); return; }

  // (1) S3 — presigned redirect. Try the stored key, then basename variants.
  if (s3Storage.isEnabled()) {
    const candidates = [stored];
    if (!stored.startsWith('Job_Images/') && !stored.startsWith('JobSupportings/')) {
      candidates.push(`JobSupportings/${path.basename(stored)}`);
      candidates.push(`Job_Images/${path.basename(stored)}`);
    }
    for (const key of candidates) {
      try {
        if (await s3Storage.exists(key)) { return res.redirect(await s3Storage.getPresignedUrl(key)); }
      } catch (e) {
        logger.warn({ key, err: e?.message }, 'serveResolvedImage: S3 lookup failed — falling through to local');
        break;
      }
    }
  }

  // (2) Local file streaming — covers writeBuffer fallbacks + pre-S3 files.
  const rootCandidates = [
    process.env.UPLOAD_JOB_FILES, process.env.UPLOAD_ROOT_PATH,
    './uploads/upload_jobs', './uploads',
  ].filter(Boolean);
  const relForms = [stored, path.basename(stored)];
  for (const root of rootCandidates) {
    const absRoot = path.resolve(root);
    for (const rel of relForms) {
      const candidate = path.resolve(absRoot, rel.replace(/^\/+/, ''));
      if (!candidate.startsWith(absRoot + path.sep) && candidate !== absRoot) continue; // traversal guard
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) { return res.sendFile(candidate); }
    }
  }

  // (3) Absolute FILE_BASE_URL (prod Nginx) — never a relative /easydoc.
  const fileBase = process.env.FILE_BASE_URL || '';
  if (/^https?:\/\//i.test(fileBase)) {
    const url = stored.includes('/')
      ? `${fileBase.replace(/\/+$/, '')}/${stored.replace(/^\/+/, '')}`
      : `${fileBase.replace(/\/+$/, '')}/upload_jobs/${stored}`;
    return res.redirect(url);
  }

  // (4) Unresolvable.
  logger.warn({ stored, s3Enabled: s3Storage.isEnabled(), fileBase }, 'serveResolvedImage: unresolvable');
  res.status(404).json({ success: false, error: 'image file not found in S3 or on local disk' });
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

module.exports = { uploadJobImage, serveResolvedImage, deleteJobImage };
