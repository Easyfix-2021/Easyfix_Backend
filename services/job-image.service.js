const path = require('node:path');
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

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT MAY BE UPLOADED — ONE RULE, BOTH STORAGE BRANCHES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE HOLE THIS CLOSES. utils/file-storage.js has a well-formed ALLOWED_MIME
 * list, but it is only reached through writeBuffer() — i.e. the LOCAL-DISK
 * branch below. With S3 configured (every deployed environment) that branch
 * never runs, so until this check existed the client-declared mimetype was
 * written verbatim onto the S3 object's Content-Type and handed back through a
 * presigned URL. An `.exe`, or a `text/html` document that then executes on the
 * bucket's origin, was storable and servable. Grepping for the allowlist finds
 * file-storage's correct-looking one and gives the wrong answer, because
 * nothing in production reaches it.
 *
 * So the check sits HERE, above the S3/local fork, and therefore covers all
 * four callers — routes/admin/jobs.js (Booking), routes/admin/job-documents.js
 * (JobSheet / PurchaseOrder), routes/client/index.js (Booking) and
 * services/job-permission-request.service.js (Permission) — not just the route
 * that prompted it. None of them had a multer fileFilter; all four accepted
 * anything.
 *
 * WHY ONE LIST FOR EVERY CATEGORY, rather than a per-category table. Measured
 * against the live table before choosing (1,379,052 rows):
 *   · Everything this service has EVER written — it landed 2026-07-24 — is
 *     png/jpeg (21 rows) plus 24 extension-less S3 keys. No PDF, no video, no
 *     archive has ever come through this code path.
 *   · The wide tail (63k `.zip`, 12k `.mp4`, `.heic`, `.eml`, `.xlsx`, `.htm`)
 *     lives entirely in checkin/checkout/feedback/po/jobsheet rows written
 *     DIRECTLY by the legacy CRM, which does not call this service. Narrowing
 *     here cannot touch them.
 *   · The one caller that carries documents rather than photos —
 *     job-documents.js — exists for Job Sheets and Purchase Orders, whose
 *     legacy population is 2,368 PDFs. Refusing PDF there would be a
 *     regression waiting for its first user.
 * Images + PDF is therefore a NARROWING for all four callers (each previously
 * accepted anything) and a widening for none. A per-category map would encode a
 * distinction that does not exist yet; add one the day a caller needs it.
 *
 * WHY THE DECLARED TYPE IS NOT TRUSTED. `file.mimetype` is whatever the client
 * put in the multipart part header. Every type on this list has a stable magic
 * number, so the bytes decide and the declaration only has to agree with them.
 */
const ALLOWED_UPLOAD_MIME = Object.freeze([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf',
]);

/* Client-sent spellings that mean one of the above. */
function normaliseMime(raw) {
  const m = String(raw || '').trim().toLowerCase().split(';')[0].trim();
  if (m === 'image/jpg' || m === 'image/pjpeg') return 'image/jpeg';
  if (m === 'image/x-png') return 'image/png';
  return m;
}

/*
 * Leading-bytes sniff. Returns the real type, or null when the buffer is not
 * one of the five — which is itself the rejection: an executable declared as
 * `application/pdf` matches nothing here, so "declared type we cannot verify"
 * is not an accepted state and there is no way to talk past the check.
 *
 * ponytail: five magic numbers, no dependency. A PDF whose `%PDF-` sits behind
 * leading junk (the spec tolerates up to 1024 bytes of it; readers accept it,
 * real-world permits do not do it) reads as unsupported. If one ever turns up,
 * scan the first 1KB for the marker rather than adding a detection library.
 */
function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3) return null;
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length >= 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'image/png';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF'
      && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/*
 * The gate. Returns the type to STORE — the sniffed one, never the declared
 * one, so the object's Content-Type can only ever be one of the five.
 * `application/octet-stream` is accepted as a declaration (browsers send it for
 * PDFs — file-storage's list carries the same note) and resolved by the bytes.
 */
function assertUploadableFile(file) {
  const sniffed = sniffMime(file.buffer);
  if (!sniffed || !ALLOWED_UPLOAD_MIME.includes(sniffed)) {
    const err = new Error('unsupported file type — upload an image (PNG, JPEG, GIF, WebP) or a PDF');
    err.status = 400;
    throw err;
  }
  const declared = normaliseMime(file.mimetype);
  if (declared && declared !== 'application/octet-stream' && declared !== sniffed) {
    const err = new Error(`declared type "${file.mimetype}" does not match the file contents (${sniffed})`);
    err.status = 400;
    throw err;
  }
  return sniffed;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * READING THE TYPE BACK — WHY IT HAS TO BE DERIVED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * tbl_job_image DOES NOT STORE A MIME TYPE. Its eleven columns are image_id,
 * job_id, job_stage, image, status, created_date, updated_date, created_by,
 * updated_by, source, image_category — verified against the live schema, not
 * inferred. (tbl_job_media, a different table, does have content_type; that is
 * the WhatsApp/customer-media table and nothing here writes it.) Adding a
 * column would be an ALTER on a 1.38M-row table shared with the legacy CRM,
 * which is exactly what the shared-DB rule forbids.
 *
 * It is nonetheless persisted twice already, once per storage branch:
 *   · LOCAL / LEGACY rows keep the extension in `image` — writeBuffer names
 *     files `{ts}_{rand}{ext}`, and 1,379,028 of the 1,379,052 rows in the
 *     table carry one. That extension is exact, not a guess.
 *   · S3 rows deliberately have NO extension on the key (utils/s3-storage.js
 *     documents this) — the type lives on the object's Content-Type header,
 *     which putJobImage sets. Reading it back costs one HeadObject.
 * Those 24 extension-less rows are precisely the S3-keyed ones, and every
 * permission document from now on will be one, so extension-only derivation
 * would report "unknown" for every permit in production. Hence both sources.
 *
 * LIMITS, PLAINLY. An extension we do not recognise (`.zip`, `.mp4`, `.heic`,
 * `.crdownload` — all present in legacy rows) yields `unknown`, never a guess.
 * An extension-less row whose S3 object is missing or whose HEAD fails yields
 * `unknown`. Nothing here re-reads the bytes; a legacy row whose extension lies
 * about its content is reported as its extension claims. Rows written from now
 * on cannot lie, because assertUploadableFile above sniffed them.
 */
const EXT_MIME = Object.freeze({
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
});

/* The coarse branch a frontend actually switches on: <img> vs a PDF viewer. */
function kindOfMime(mime) {
  if (mime === 'application/pdf') return 'pdf';
  if (mime && mime.startsWith('image/')) return 'image';
  return 'unknown';
}

/*
 * ContentType of an S3 object, or null on any failure. Never throws: an
 * unresolved type must degrade to "unknown", not blank a list.
 *
 * ponytail: its own S3Client because utils/s3-storage.js does not export one
 * (five other services in this repo do the same). The cheaper upgrade, when
 * that file is next open, is to have `exists()` return the HeadObject response
 * it already makes and discards — resolveImageUrl calls it on every render, so
 * the type would then cost nothing at all.
 */
let _headClient = null;
async function s3ContentType(key) {
  if (!s3Storage.isEnabled()) return null;
  try {
    const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
    if (!_headClient) {
      _headClient = new S3Client({
        region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1',
      });
    }
    const head = await _headClient.send(new HeadObjectCommand({
      Bucket: s3Storage.bucketName(), Key: key,
    }));
    return normaliseMime(head.ContentType) || null;
  } catch (e) {
    logger.warn({ key, err: e?.message }, 'job image content-type HEAD failed — type reported as unknown');
    return null;
  }
}

/*
 * Resolve a stored `tbl_job_image.image` value to { mimeType, kind }.
 *   mimeType : exact string, or null when it could not be established
 *   kind     : 'image' | 'pdf' | 'unknown' — always a string, so a frontend
 *              can branch without sniffing a presigned URL that carries no
 *              extension to sniff.
 */
async function resolveImageType(storedValue) {
  const stored = String(storedValue || '').trim();
  if (!stored) return { mimeType: null, kind: 'unknown' };

  const ext = path.extname(stored).toLowerCase();
  if (ext) {
    const mimeType = EXT_MIME[ext] || null;
    return { mimeType, kind: kindOfMime(mimeType) };
  }

  const mimeType = await s3ContentType(stored);
  return { mimeType, kind: kindOfMime(mimeType) };
}

/*
 * The S3-or-local write + tbl_job_image insert — extracted from
 * uploadJobImage() (2026-09-22, Material Request Flow v2 on-behalf approval)
 * so a caller with its OWN content-type gate (routes/admin/jobs.js's
 * client-approval-on-behalf route validates audio + image + PDF by mimetype
 * AND extension, not the image/PDF-only byte-sniff below) can reuse the exact
 * storage + row-insert path without re-deriving it. `contentType` is
 * therefore the caller's job to establish; this function trusts it.
 */
async function storeJobImageFile({ jobId, file, category, contentType }) {
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
        contentType,
        originalName: file.originalname,
        category,
      });
      storage = 's3';
    } catch (e) {
      logger.warn({ jobId, seq, err: e.message }, 'job image S3 put failed — local fallback');
      image = writeBuffer('job_files', file.buffer, file.originalname, contentType).filename;
      storage = 'local-fallback';
    }
  } else {
    image = writeBuffer('job_files', file.buffer, file.originalname, contentType).filename;
    storage = 'local';
  }

  const [ins] = await pool.query(
    `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, created_date)
     VALUES (?, ?, ?, ?, ?)`,
    [jobId, image, String(category).toLowerCase(), 0, new Date()]);

  logger.info('Job image stored · job=' + jobId + ' · seq=' + seq + ' · storage=' + storage
    + ' · type=' + contentType);
  return {
    image_id: ins.insertId, job_id: jobId, image,
    image_category: String(category).toLowerCase(), job_stage: 0, seq, storage,
    // The verified type, for a caller that wants to answer "image or PDF?"
    // without a second round trip through resolveImageType().
    mime_type: contentType, kind: kindOfMime(contentType),
  };
}

async function uploadJobImage({ jobId, file, category = 'Booking' }) {
  if (!file || !file.buffer) {
    const err = new Error('missing "file" upload');
    err.status = 400;
    throw err;
  }
  // Above the storage fork on purpose — see the block comment. The STORED type
  // is the sniffed one, so a lying Content-Type cannot reach the bucket.
  const contentType = assertUploadableFile(file);
  return storeJobImageFile({ jobId, file, category, contentType });
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

module.exports = {
  uploadJobImage, serveResolvedImage, deleteJobImage,
  // The shared storage+insert tail — see its own header for why a caller
  // with its own content-type gate reuses this instead of uploadJobImage.
  storeJobImageFile,
  // Upload allowlist (GAP 2) + type read-back (GAP 1) — exported for the
  // permission-request service's wire item and for the tests that pin them.
  ALLOWED_UPLOAD_MIME, sniffMime, assertUploadableFile, resolveImageType, kindOfMime,
};
