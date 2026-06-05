/*
 * S3 storage helper — Job Image upload + retrieval.
 *
 * Path convention (per ops 2026-05-15, supersedes the 2026-05-14 rule):
 *   s3://<S3_BUCKET_NAME>/JobSupportings/<JobCategory>_<jobId>_<seq>
 *
 *   - <JobCategory>  PascalCase tag for the lifecycle stage that owns
 *                    the upload: `Booking` (Book-New-Call), `Completion`,
 *                    `Reschedule`, `Cancellation`, …
 *   - <seq>          1-based ordinal across that job's existing rows
 *                    (`tbl_job_image` row count + 1 at upload time)
 *
 * The S3 key intentionally does NOT carry the file extension — the
 * file's real extension/MIME type is preserved on the object's
 * `Content-Type` header at PutObject time, and the original filename
 * (with its extension) is stashed in object metadata under
 * `original-filename` for audit/recovery. Browsers fetching the
 * presigned URL render correctly because Content-Type is authoritative.
 *
 * Examples (the actual stored object is just the key on the left; the
 * extension on the right of `→` is metadata for context, not part of
 * the key):
 *   JobSupportings/Booking_18421_1          (.jpg in metadata)
 *   JobSupportings/Booking_18421_2          (.pdf in metadata)
 *   JobSupportings/Completion_18421_1       (.png in metadata)
 *
 * The stored DB value (`tbl_job_image.image`) is the FULL S3 key so the
 * read path can tell S3-stored images apart from legacy filesystem-only
 * images (`whatever.jpg`).
 *
 * Back-compat: rows still pointing at the old `Job_Images/<jobId>_<seq>`
 * prefix continue to resolve correctly via `resolveImageUrl` — both
 * prefixes are recognised on read. New writes always use the new prefix.
 *
 * Disabled gracefully: if `S3_BUCKET_NAME` is unset (local dev without
 * AWS creds), `isEnabled()` returns false and every caller falls back
 * to the local filesystem path under UPLOAD_JOB_FILES — matches
 * pre-S3 behaviour exactly so dev doesn't break on missing creds.
 *
 * Credentials: standard AWS SDK chain (env / shared file / IAM role).
 *   - AWS_REGION             — e.g. ap-south-1
 *   - AWS_ACCESS_KEY_ID      — when running outside EC2/ECS
 *   - AWS_SECRET_ACCESS_KEY  — ditto
 *   On Container Apps / ECS / EC2, omit the keys and attach an IAM role
 *   with s3:PutObject / s3:GetObject / s3:HeadObject on the bucket.
 */

const path = require('path');

const BUCKET = process.env.S3_BUCKET_NAME || '';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';
const PRESIGN_TTL_SEC = Number(process.env.S3_PRESIGN_TTL_SEC) || 300; // 5-min default

// Lazy SDK init so a misconfigured-but-disabled S3 doesn't crash boot.
let _client = null;
let _presigner = null;
function client() {
  if (_client) return _client;
  const { S3Client } = require('@aws-sdk/client-s3');
  _client = new S3Client({ region: REGION });
  return _client;
}
function presigner() {
  if (_presigner) return _presigner;
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  _presigner = getSignedUrl;
  return _presigner;
}

function isEnabled() { return !!BUCKET; }
function bucketName() { return BUCKET; }

/*
 * Opt-in migration flag. When TRUE (and S3 is enabled), the
 * read-path endpoint promotes a legacy local-filesystem image into
 * S3 on first access — read once from /var/www/html/easydoc/upload_jobs,
 * write to s3://<bucket>/Job_Images/<jobId>_<seq>, UPDATE the DB row
 * to point at the new key. Subsequent reads serve from S3.
 *
 * Default OFF. Operators turn this on temporarily (set
 * S3_MIGRATE_LEGACY_TO_S3=true and bounce the service) to drain
 * legacy local files into S3 organically as users view jobs, then
 * turn it OFF once `tbl_job_image` no longer has any bare-filename
 * rows. Keeps S3 cost predictable — every migration is a single
 * PutObject paid lazily on demand rather than a big batch job.
 */
function shouldMigrateLegacy() {
  return String(process.env.S3_MIGRATE_LEGACY_TO_S3 || '').toLowerCase() === 'true';
}

/*
 * Build the canonical S3 key for a job image.
 *   keyFor(12345, 2, { category: 'Booking' })
 *     →  "JobSupportings/Booking_12345_2"
 *
 * Validates:
 *   - jobId / seq positive integers
 *   - category matches PascalCase word-chars only (`Booking`, `Completion`, …);
 *     prevents path injection via crafted category strings
 *
 * NB: no file extension is appended. The file's real extension / MIME
 * is preserved via the object's Content-Type header and the
 * `original-filename` metadata field at PutObject time.
 */
function keyFor(jobId, seq, opts) {
  if (!Number.isInteger(Number(jobId)) || Number(jobId) <= 0) {
    throw new Error('keyFor: invalid jobId');
  }
  if (!Number.isInteger(Number(seq)) || Number(seq) <= 0) {
    throw new Error('keyFor: invalid seq');
  }
  const category = String((opts && opts.category) || 'Booking');
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(category)) {
    throw new Error('keyFor: invalid category (PascalCase word-chars only)');
  }
  return `JobSupportings/${category}_${Number(jobId)}_${Number(seq)}`;
}

/*
 * Upload a buffer to S3 at the canonical key. Returns the stored
 * key (so callers can persist it on tbl_job_image.image).
 *
 * Throws if S3 isn't enabled — callers must guard with isEnabled()
 * first and pick their fallback path. (We don't auto-fall-back to
 * local disk here because the caller already has the buffer and
 * the choice belongs to the route handler.)
 */
async function putJobImage({ jobId, seq, buffer, contentType, originalName, category }) {
  if (!isEnabled()) throw new Error('S3 is not configured (S3_BUCKET_NAME unset)');
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const Key = keyFor(jobId, seq, { category: category || 'Booking' });
  const Metadata = {};
  if (originalName) {
    // Store the original filename in object metadata so admin tooling
    // can recover it later. S3 lowercases header names but preserves
    // values verbatim. Filenames may contain non-ASCII chars — strip
    // those defensively since SDK puts them in HTTP headers.
    const safe = String(originalName).replace(/[^\x20-\x7E]/g, '_').slice(0, 200);
    Metadata['original-filename'] = safe;
  }
  await client().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    Metadata,
  }));
  return Key;
}

/*
 * Build the canonical S3 key for a Manage Deep Skills image.
 *   keyForSkill(42, 1)
 *     →  "Skills/Skill_42_1"
 *
 * Mirrors `keyFor()` (jobs) — same shape constraints, separate prefix.
 * The legacy convention requested by ops 2026-06-05: every deep-skill
 * picture lands under the `Skills/` prefix so audit + lifecycle policies
 * can target the directory without touching JobSupportings.
 *
 * NB: no file extension on the key. Real extension/MIME is carried via
 * the object's Content-Type and the `original-filename` Metadata field.
 */
function keyForSkill(skillId, seq) {
  if (!Number.isInteger(Number(skillId)) || Number(skillId) <= 0) {
    throw new Error('keyForSkill: invalid skillId');
  }
  if (!Number.isInteger(Number(seq)) || Number(seq) <= 0) {
    throw new Error('keyForSkill: invalid seq');
  }
  return `Skills/Skill_${Number(skillId)}_${Number(seq)}`;
}

/*
 * Upload a Deep Skill image buffer to S3. Returns the stored key
 * (caller persists on `tbl_deepskill.deepskill_image`). Same
 * upload-then-record-key pattern as `putJobImage`.
 */
async function putSkillImage({ skillId, seq, buffer, contentType, originalName }) {
  if (!isEnabled()) throw new Error('S3 is not configured (S3_BUCKET_NAME unset)');
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const Key = keyForSkill(skillId, seq);
  const Metadata = {};
  if (originalName) {
    const safe = String(originalName).replace(/[^\x20-\x7E]/g, '_').slice(0, 200);
    Metadata['original-filename'] = safe;
  }
  await client().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    Metadata,
  }));
  return Key;
}

/*
 * Check whether an object exists at `key`. Returns true/false; any
 * error other than NotFound bubbles so the caller can log it (S3
 * outages shouldn't be silently treated as "file missing").
 */
async function exists(key) {
  if (!isEnabled()) return false;
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  try {
    await client().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound' || e?.Code === 'NotFound') return false;
    throw e;
  }
}

/*
 * Mint a presigned GET URL the browser can hit directly. TTL is
 * intentionally short (5 min) — long enough to render images in a
 * page session, short enough that a leaked URL ages out before it's
 * abusable. Re-mint on every image render.
 */
async function getPresignedUrl(key) {
  if (!isEnabled()) throw new Error('S3 is not configured');
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return await presigner()(client(), cmd, { expiresIn: PRESIGN_TTL_SEC });
}

/*
 * Resolve a stored `tbl_job_image.image` value to a public URL.
 *
 * Read priority (per ops 2026-05-14): check S3 first, then fall back
 * to the local filesystem path. Cases:
 *
 *   1. Stored value already looks like an S3 key (`Job_Images/...`):
 *      - If exists in S3 → presigned URL.
 *      - Else → fall through to local (same basename under
 *        UPLOAD_JOB_FILES).
 *
 *   2. Stored value is a bare filename (legacy: pre-S3 row):
 *      - Try S3 at `Job_Images/<filename>` first in case the file
 *        was migrated. If exists → presigned URL.
 *      - Else → local URL under /easydoc/upload_jobs/.
 *
 * Callers (read paths) receive the resolved absolute URL; the bare
 * stored value stays untouched in the DB.
 */
async function resolveImageUrl(storedValue) {
  const stored = String(storedValue || '').trim();
  if (!stored) return null;

  const fileBase = process.env.FILE_BASE_URL || '/easydoc';
  const localUrl = stored.includes('/')
    ? `${fileBase}/${stored.replace(/^\/+/, '')}`            // already a relative path
    : `${fileBase}/upload_jobs/${stored}`;                    // bare filename → legacy layout

  if (!isEnabled()) return localUrl;

  // S3 keys to try, in order:
  //   1. the stored value verbatim (already a key — covers both old
  //      `Job_Images/...` rows and new `JobSupportings/...` rows)
  //   2. legacy migration shape `Job_Images/<basename>` (pre-S3 bare
  //      filenames promoted by the migration flag)
  //   3. new-convention shape `JobSupportings/<basename>` for forward
  //      compat with any manually-renamed objects
  const candidateKeys = [stored];
  if (!stored.startsWith('Job_Images/') && !stored.startsWith('JobSupportings/')) {
    candidateKeys.push(`JobSupportings/${path.basename(stored)}`);
    candidateKeys.push(`Job_Images/${path.basename(stored)}`);
  }

  for (const key of candidateKeys) {
    try {
      if (await exists(key)) return await getPresignedUrl(key);
    } catch (e) {
      // S3 outage / permission error — don't fail the whole image
      // listing; log and fall through to local URL so the user still
      // sees what was previously stored on disk.
      // eslint-disable-next-line no-console
      console.warn('s3-storage.resolveImageUrl: S3 lookup failed, falling back to local', { key, err: e?.message });
      break;
    }
  }
  return localUrl;
}

/*
 * Lazy migration of a single legacy row. Called from the read-path
 * endpoint when the migration flag is on and the stored value is a
 * bare filename (no `/`). Resolves the local file, uploads its
 * contents to S3 at the CANONICAL key
 * `JobSupportings/Booking_<jobId>_<seq>` — legacy rows are assumed
 * Booking-category since the legacy flow only captured Book-New-Call
 * attachments (the original legacy filename like
 * `1736245821123-a4b9_camera.jpg` is intentionally discarded — every
 * migrated image conforms to the new ops spec naming), then DELETES
 * the local copy so the server stops
 * carrying duplicate state. Returns the new S3 key on success; null
 * when the migration is a no-op (flag off, S3 off, value already
 * keyed, local file missing, etc.) — caller doesn't UPDATE the DB
 * in that case.
 *
 *   storedValue : current `tbl_job_image.image` value (bare filename)
 *   jobId       : the job this row belongs to (drives the S3 key)
 *   seq         : 1-based ordinal of this row among the job's images
 *                 — compute as COUNT(*) WHERE job_id=? AND image_id <= ?
 *                 so the seq stays stable across re-renders even when
 *                 some siblings migrate and others don't.
 *
 * Path-traversal guarded: the resolved local path MUST sit under
 * UPLOAD_JOB_FILES — refuses to read or unlink anything outside.
 *
 * Local-file delete policy (2026-05-14):
 *   - On successful S3 upload, the local file is fs.unlinkSync()'d
 *     so the server doesn't keep accumulating dead files. The DB
 *     row's `image` column gets rewritten to the new S3 key by the
 *     caller, so any reader following the redirect endpoint will
 *     hit S3 from then on.
 *   - The unlink is best-effort: a permission error / mount issue
 *     is logged but does NOT roll back the migration (the S3 copy
 *     is already canonical, so retaining the local file is just a
 *     cleanup tax, not a correctness risk).
 */
async function migrateLegacyToS3({ storedValue, jobId, seq }) {
  if (!isEnabled() || !shouldMigrateLegacy()) return null;
  const stored = String(storedValue || '').trim();
  // Already an S3 key (or any path with a slash): not a legacy row.
  if (!stored || stored.includes('/')) return null;

  const fs = require('fs');
  const root = process.env.UPLOAD_JOB_FILES;
  if (!root) return null;
  const resolvedRoot = path.resolve(root);
  const localPath = path.resolve(resolvedRoot, stored);
  // Path-traversal guard — anything outside the UPLOAD_JOB_FILES
  // root is refused even if `stored` got crafted with `..`.
  if (!localPath.startsWith(resolvedRoot + path.sep) && localPath !== resolvedRoot) {
    return null;
  }
  let buffer;
  try {
    buffer = fs.readFileSync(localPath);
  } catch {
    // Local file gone (already migrated by hand, or never existed).
    // Treat as a no-op; the resolveImageUrl fallback will surface a
    // broken-link state for ops to investigate.
    return null;
  }

  const ext = path.extname(stored).toLowerCase();
  const contentTypeByExt = {
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.pdf':  'application/pdf',
  };
  const contentType = contentTypeByExt[ext] || 'application/octet-stream';

  let newKey;
  try {
    // Canonical S3 key is JobSupportings/Booking_<jobId>_<seq> — see
    // keyFor(). `category: 'Booking'` is the only correct value for
    // legacy migration because the legacy `tbl_job_image` flow only
    // captured booking-time attachments. The original `stored`
    // filename (with its extension) is preserved only in S3 object
    // metadata (`original-filename`) for traceability, NOT in the
    // key. Content-Type was derived above from the legacy file's
    // extension and is set on the S3 object so browsers render
    // correctly.
    newKey = await putJobImage({
      jobId, seq, buffer, contentType, originalName: stored, category: 'Booking',
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('s3-storage.migrateLegacyToS3: PutObject failed', { stored, jobId, seq, err: e?.message });
    return null;
  }

  // Cleanup: drop the local copy now that S3 holds the canonical
  // file. Best-effort — log and continue on failure.
  try {
    fs.unlinkSync(localPath);
  } catch (e) {
    // EACCES / EBUSY / ENOENT are non-fatal here. ENOENT in particular
    // is benign (file already gone, e.g. a concurrent migration of
    // the same row from another request). Logging keeps the audit
    // trail honest without surfacing a user-visible error.
    if (e?.code !== 'ENOENT') {
      // eslint-disable-next-line no-console
      console.warn('s3-storage.migrateLegacyToS3: local unlink failed (S3 copy is canonical, leaving local stub)', {
        localPath, err: e?.message,
      });
    }
  }

  return newKey;
}

/* ─── Notice Board image storage ───────────────────────────────────
 *
 * Notice images live under a distinct prefix so the S3 bucket is
 * scannable / lifecycle-rule-able per feature:
 *
 *   s3://<S3_BUCKET_NAME>/Notices/<ts>_<rand8>
 *
 * Key shape mirrors the JobSupportings convention: no extension on
 * the key (Content-Type metadata + original-filename header carry
 * the real type), and the basename uses timestamp + 8 random hex
 * chars for global uniqueness without needing a notice_id (the
 * uploader is the Compose wizard, which hasn't yet created the
 * tbl_notice row at upload time — images are picked first, the
 * row is written on Save/Publish).
 *
 * S3 has no real concept of directories, but the prefix appears
 * as a folder in the AWS console + in any tooling that groups by
 * "/". No explicit create-folder step is needed; the first
 * PutObject under `Notices/` makes the prefix visible.
 *
 * If S3_BUCKET_NAME is unset (local dev), this helper still throws
 * via isEnabled() — the route handler should fall back to local
 * disk storage in that case, see routes/admin/notices.js.
 */

function buildNoticeKey(originalName) {
  const crypto = require('crypto');
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  // Extension intentionally NOT appended. Content-Type metadata
  // carries the real MIME; the original filename + extension live
  // in object metadata for audit/recovery.
  // (originalName retained for the assertion that we received SOMETHING
  // semantically file-shaped — but it's not used in the key.)
  void originalName;
  return `Notices/${ts}_${rand}`;
}

/*
 * Upload a notice-attached image to S3. Returns the stored key —
 * the caller (route handler) is responsible for round-tripping the
 * key into the BE response so the FE can request a presigned URL
 * for display.
 *
 *   buffer        Buffer    — image bytes
 *   contentType   string    — MIME type, e.g. "image/png"
 *   originalName  string    — operator-supplied filename (kept in S3
 *                             metadata only; not in the key)
 *
 * Strict guard: throws if S3 isn't configured. Use isEnabled() first
 * to pick a fallback. Mime allowlist is enforced at the route layer
 * (multer + file-storage.checkMime); this function trusts its caller.
 */
async function putNoticeImage({ buffer, contentType, originalName }) {
  if (!isEnabled()) throw new Error('S3 is not configured (S3_BUCKET_NAME unset)');
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const Key = buildNoticeKey(originalName);
  const Metadata = {};
  if (originalName) {
    const safe = String(originalName).replace(/[^\x20-\x7E]/g, '_').slice(0, 200);
    Metadata['original-filename'] = safe;
  }
  await client().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    Metadata,
  }));
  return Key;
}

/*
 * Resolve a stored notice-image value (either an S3 key or a local
 * URL) to a publicly-loadable URL the FE <img> can render.
 *
 *   - "Notices/<ts>_<rand>"   → presigned GET URL (5-min TTL)
 *   - "/easydoc/<filename>"   → returned as-is (local fallback)
 *   - "https://…"             → returned as-is (external URL)
 *
 * Distinct from resolveImageUrl() (which is Job-Image-shaped + does
 * an existence probe) because notice-image reads are batched on every
 * dashboard load (up to ~20 notices × 5 images = 100 lookups). Skipping
 * the HeadObject probe keeps the per-request signing cost flat (no
 * network round-trip per image — getSignedUrl just signs locally).
 *
 * Returns null when given null/empty input, so callers can map over
 * arrays without per-item guards.
 */
async function resolveNoticeImageUrl(storedValue) {
  const stored = String(storedValue || '').trim();
  if (!stored) return null;
  // Already a URL — passthrough.
  if (/^https?:\/\//i.test(stored)) return stored;
  // Local-disk URL — passthrough.
  if (stored.startsWith('/')) return stored;
  // S3 key shape — sign and return.
  if (isEnabled() && stored.startsWith('Notices/')) {
    try {
      return await getPresignedUrl(stored);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('s3-storage.resolveNoticeImageUrl: presign failed', { stored, err: e?.message });
      return null;
    }
  }
  // Anything else — best-effort: assume it's a relative path under
  // the public file base. Matches the existing job-image fallback shape.
  const fileBase = process.env.FILE_BASE_URL || '/easydoc';
  return `${fileBase}/${stored.replace(/^\/+/, '')}`;
}

/* ─── Client Documents (Manage Clients → Documents tab, 2026-05-25) ─── */

/*
 * Keys land under the `ClientDocs/` prefix to keep the bucket browsable
 * by feature (Notices/, ClientDocs/, Jobs/, …). Same key shape as
 * buildNoticeKey: timestamp + 8 hex chars, no extension (Content-Type
 * carries the MIME, original filename lives in object metadata).
 */
function buildClientDocKey() {
  const crypto = require('crypto');
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  return `ClientDocs/${ts}_${rand}`;
}

/*
 * Upload a client document (PAN / TAN / GSTIN / Aadhaar / other) to S3.
 * Returns the stored key — the caller persists it into tbl_client_document.
 *
 * Mirrors putNoticeImage: strict guard on isEnabled(), MIME allowed at the
 * route layer, original filename preserved in metadata for download UX.
 */
async function putClientDocument({ buffer, contentType, originalName }) {
  if (!isEnabled()) throw new Error('S3 is not configured (S3_BUCKET_NAME unset)');
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const Key = buildClientDocKey();
  const Metadata = {};
  if (originalName) {
    const safe = String(originalName).replace(/[^\x20-\x7E]/g, '_').slice(0, 200);
    Metadata['original-filename'] = safe;
  }
  await client().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    Metadata,
  }));
  return Key;
}

/*
 * Resolve a stored client-document value (S3 key, local URL, or HTTP
 * URL) to a publicly-loadable URL. Same shape as resolveNoticeImageUrl
 * but keyed on the ClientDocs/ prefix.
 *
 * Documents are typically PDFs or images; we don't probe HEAD (signing
 * is cheap, the FE will see a 403 if the key is stale).
 */
async function resolveClientDocumentUrl(storedValue) {
  const stored = String(storedValue || '').trim();
  if (!stored) return null;
  if (/^https?:\/\//i.test(stored)) return stored;
  if (stored.startsWith('/')) return stored;
  if (isEnabled() && stored.startsWith('ClientDocs/')) {
    try {
      return await getPresignedUrl(stored);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('s3-storage.resolveClientDocumentUrl: presign failed', { stored, err: e?.message });
      return null;
    }
  }
  const fileBase = process.env.FILE_BASE_URL || '/easydoc';
  return `${fileBase}/${stored.replace(/^\/+/, '')}`;
}

/*
 * Generic best-effort delete by S3 key. Used by the Job Image DELETE
 * endpoint (2026-05-28) so the operator-driven "X" on an already-
 * uploaded image tile also reclaims storage. Soft-fails on missing
 * object / permission errors so the DB row removal can still proceed.
 *
 * Accepts ONLY a key under the configured bucket — callers pass the
 * raw `tbl_job_image.image` value verbatim. If the value happens to be
 * a bare filename (legacy local-only row), we skip the S3 call and
 * return `{ deleted: false, reason: 'not-s3' }` so the caller knows to
 * unlink the local file instead.
 */
async function deleteObject(key) {
  if (!isEnabled()) return { deleted: false, reason: 'disabled' };
  const stored = String(key || '').trim();
  if (!stored) return { deleted: false, reason: 'empty-key' };
  // Bare filename (no `/`) means a legacy local row — not an S3 object.
  if (!stored.includes('/')) return { deleted: false, reason: 'not-s3' };
  try {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: stored }));
    return { deleted: true };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('s3-storage.deleteObject: failed', { key: stored, err: e?.message });
    return { deleted: false, reason: 'error', error: e?.message };
  }
}

module.exports = {
  isEnabled,
  bucketName,
  keyFor,
  putJobImage,
  exists,
  getPresignedUrl,
  resolveImageUrl,
  shouldMigrateLegacy,
  migrateLegacyToS3,
  deleteObject,
  // Notice Board (2026-05-22):
  putNoticeImage,
  resolveNoticeImageUrl,
  // Client Documents (2026-05-25):
  putClientDocument,
  resolveClientDocumentUrl,
  // Deep Skill images (2026-06-05) — `Skills/Skill_<id>_<seq>`:
  keyForSkill,
  putSkillImage,
};
