/*
 * Internal job-image URL resolver (2026-07-10).
 *
 * Mounted at GET /api/internal/job-image-url?key=<URL-encoded stored value>.
 *
 * WHY this exists:
 *   The legacy Java EasyFix_CRM still renders job images by emitting a
 *   plain `/easydoc/upload_jobs/<val>` path. Once images migrated to S3
 *   that local path 404s for any row whose file only lives in the bucket.
 *   Rather than teach the legacy CRM how to sign S3 URLs (its own AWS
 *   creds, SDK, presigner), the CRM's `/resolveJobImage` Struts action
 *   calls THIS endpoint server-to-server to turn a stored
 *   `tbl_job_image.image` value into a browser-renderable URL — reusing
 *   s3-storage.resolveImageUrl() so the S3-first / local-fallback logic
 *   lives in exactly one place.
 *
 * AUTH — shared secret, NOT a JWT / Basic credential:
 *   This is a machine-to-machine endpoint reached only by the legacy CRM
 *   backend, never a browser. The caller must send
 *     X-Internal-Resolve-Secret: <secret>
 *   matching env INTERNAL_IMAGE_RESOLVE_SECRET (constant-time compared).
 *     - env unset/empty  → 503 (feature not configured; fail closed)
 *     - header missing / mismatch → 401
 *   It lives under /api/internal (a dedicated prefix mounted ahead of the
 *   authed /api aggregator, sibling to /api/public) so no requireAuth /
 *   maskMobile middleware wraps it.
 *
 * Response shape (modern envelope):
 *   200 { success: true,  data: { url: <resolved absolute URL> } }
 *   400 if `key` is missing / not a non-empty string
 *   401 if the shared secret is missing or wrong
 *   404 if the value resolves to nothing (falsy)
 *   503 if INTERNAL_IMAGE_RESOLVE_SECRET is not configured
 *
 * The returned url is whatever s3-storage.resolveImageUrl() yields — a
 * short-TTL presigned S3 URL when the object is in the bucket, else the
 * local `/easydoc/...` path. The bare stored value stays untouched in the
 * DB; this endpoint is read-only and runs no SQL.
 */

const router = require('express').Router();
const crypto = require('crypto');
const s3Storage = require('../../utils/s3-storage');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

const SECRET_HEADER = 'x-internal-resolve-secret';

/*
 * Constant-time shared-secret guard. Mirrors the timing-safe compare in
 * middleware/basic-auth.js so a wrong secret can't be distinguished by
 * response timing. Fails closed when the env secret is unset.
 */
function requireInternalSecret(req, res, next) {
  const expected = process.env.INTERNAL_IMAGE_RESOLVE_SECRET;
  if (!expected) {
    logger.security('503 job-image-url — INTERNAL_IMAGE_RESOLVE_SECRET not configured');
    return modernError(res, 503, 'Image resolve endpoint is not configured');
  }
  const supplied = Buffer.from(String(req.get(SECRET_HEADER) || ''), 'utf8');
  const stored = Buffer.from(String(expected), 'utf8');
  const ok = supplied.length === stored.length && crypto.timingSafeEqual(supplied, stored);
  if (!ok) {
    logger.security('401 job-image-url — bad or missing X-Internal-Resolve-Secret');
    return modernError(res, 401, 'Unauthorized');
  }
  next();
}

router.get('/', requireInternalSecret, async (req, res, next) => {
  try {
    const key = req.query.key;
    if (typeof key !== 'string' || key.trim() === '') {
      return modernError(res, 400, 'Query param "key" is required');
    }

    const url = await s3Storage.resolveImageUrl(key);
    if (!url) {
      logger.warn('job-image-url — no URL resolved for key=' + key);
      return modernError(res, 404, 'Image not found');
    }

    logger.info('job-image-url resolved · key=' + key);
    return modernOk(res, { url });
  } catch (e) {
    logger.error('job-image-url resolve failed · ' + e.message);
    next(e);
  }
});

module.exports = router;
