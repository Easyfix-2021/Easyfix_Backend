const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  verifyIdempotencyUpload,
  deterministicUploadToken,
} = require('../middleware/verify-idempotency-upload');

function response() {
  const sent = [];
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { sent.push({ status: this.statusCode, body }); return this; },
  };
  return { res, sent };
}

function request(buffer, digest) {
  return {
    method: 'POST',
    originalUrl: '/api/mobile/uploads',
    headers: {
      'idempotency-key': 'identity-42.front',
      'idempotency-content-digest': digest,
    },
    tech: { efr_id: 8379 },
    file: { buffer },
  };
}

test('server verifies the app digest against uploaded bytes before storage', () => {
  const buffer = Buffer.from('bounded identity image');
  const digest = crypto.createHash('md5').update(buffer).digest('hex');
  const req = request(buffer, digest.toUpperCase());
  const { res, sent } = response();
  let proceeded = false;

  verifyIdempotencyUpload(req, res, () => { proceeded = true; });
  assert.equal(proceeded, true);
  assert.equal(sent.length, 0);
  assert.equal(req.idempotencyContentDigestVerified, true);
});

test('digest mismatch is rejected before object storage', () => {
  const req = request(Buffer.from('actual bytes'), '00000000000000000000000000000000');
  const { res, sent } = response();
  let proceeded = false;

  verifyIdempotencyUpload(req, res, () => { proceeded = true; });
  assert.equal(proceeded, false);
  assert.equal(sent[0].status, 400);
  assert.equal(sent[0].body.details.code, 'IDEMPOTENCY_CONTENT_DIGEST_MISMATCH');
});

test('stable actor endpoint key and digest derive the same crash-replay object token', () => {
  const buffer = Buffer.from('same identity image');
  const digest = crypto.createHash('md5').update(buffer).digest('hex');
  const first = request(buffer, digest);
  const replay = request(buffer, digest);
  first.idempotencyContentDigestVerified = true;
  replay.idempotencyContentDigestVerified = true;

  const firstToken = deterministicUploadToken(first);
  assert.equal(deterministicUploadToken(replay), firstToken);
  replay.headers['idempotency-key'] = 'identity-42.back';
  assert.notEqual(deterministicUploadToken(replay), firstToken);
});

test('every mobile Multer route verifies keyed bytes after parsing', () => {
  const expected = [
    ['routes/mobile/uploads.js', /upload\.single\('file'\)\s*,\s*verifyIdempotencyUpload/g, 2],
    ['routes/mobile/profile-extra.js', /profileImageUpload\.single\('file'\)\s*,\s*verifyIdempotencyUpload/g, 1],
    ['routes/mobile/kyc.js', /upload\.single\('file'\)\s*,\s*verifyIdempotencyUpload/g, 1],
  ];
  for (const [relativePath, pattern, expectedCount] of expected) {
    const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
    assert.equal(
      source.match(pattern)?.length || 0,
      expectedCount,
      `${relativePath} must verify every keyed upload after Multer`,
    );
  }
});
