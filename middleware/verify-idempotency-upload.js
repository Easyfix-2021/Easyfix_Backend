const crypto = require('crypto');

const { modernError } = require('../utils/response');

const MD5_PATTERN = /^[a-f0-9]{32}$/i;

function requestDigest(req) {
  return String(req.headers?.['idempotency-content-digest'] || '').trim().toLowerCase();
}

/*
 * Runs after Multer. The outer idempotency middleware requires/binds the app's
 * digest before parsing; this second check proves those 32 hex characters are
 * actually the uploaded bytes instead of trusting a caller-supplied header.
 */
function verifyIdempotencyUpload(req, res, next) {
  if (!req.headers?.['idempotency-key']) return next();
  const supplied = requestDigest(req);
  if (!MD5_PATTERN.test(supplied) || !Buffer.isBuffer(req.file?.buffer)) {
    return modernError(res, 400, 'A verifiable Idempotency-Content-Digest is required', {
      code: 'IDEMPOTENCY_CONTENT_DIGEST_REQUIRED',
    });
  }
  const actual = crypto.createHash('md5').update(req.file.buffer).digest('hex');
  const matches = crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(supplied, 'hex'));
  if (!matches) {
    return modernError(res, 400, 'Idempotency-Content-Digest does not match the uploaded file', {
      code: 'IDEMPOTENCY_CONTENT_DIGEST_MISMATCH',
    });
  }
  req.idempotencyContentDigestVerified = true;
  return next();
}

/*
 * Stable, non-sensitive object-name component. It includes actor, endpoint,
 * logical operation key and verified content digest, so a replay after ledger
 * expiry overwrites the same object instead of orphaning another random key.
 */
function deterministicUploadToken(req) {
  if (!req.idempotencyContentDigestVerified) return null;
  const actorId = req.tech?.efr_id ?? req.user?.user_id;
  const key = String(req.headers?.['idempotency-key'] || '');
  const digest = requestDigest(req);
  if (actorId == null || !key || !MD5_PATTERN.test(digest)) return null;
  return crypto
    .createHash('sha256')
    .update(`${actorId}\n${req.method}\n${req.originalUrl}\n${key}\n${digest}`)
    .digest('hex')
    .slice(0, 40);
}

module.exports = {
  verifyIdempotencyUpload,
  deterministicUploadToken,
  _internals: { requestDigest },
};
