'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const s3Storage = require('../utils/s3-storage');
const identity = require('../services/mobile-identity.service');

/*
 * The mobile "Your Identity" screen could never prefill its uploaded photos:
 * the read returned numeric efr_doc_ids and nothing anywhere converted one into
 * a fetchable URL. These tests pin the two halves of the fix — Aadhaar BACK
 * (doc type 14) is finally read back at all, and every stored key resolves to a
 * short-TTL presigned URL — plus the non-negotiable failure posture: prefill is
 * an enhancement, so anything unresolvable degrades to null instead of a 500,
 * and no identity value or signed URL is ever written to a log.
 *
 * S3 is unconfigured in the test process (no dotenv is loaded), so utils/s3-storage
 * is stubbed at the module boundary rather than reached over the network.
 */

const original = {
  isEnabled: s3Storage.isEnabled,
  exists: s3Storage.exists,
  getPresignedUrl: s3Storage.getPresignedUrl,
};

const SIGNED = 'https://bucket.s3.ap-south-1.amazonaws.com/k?X-Amz-Signature=deadbeefcafe';

afterEach(() => Object.assign(s3Storage, original));

function stubS3({ enabled = true, exists = async () => true, presign = async () => SIGNED } = {}) {
  s3Storage.isEnabled = () => enabled;
  s3Storage.exists = exists;
  s3Storage.getPresignedUrl = presign;
}

// One-row prefill stand-in. Column names mirror the aggregate's aliases.
function identityDb(overrides = {}) {
  const probed = [];
  const database = {
    probed,
    async query() {
      return [[{
        name: 'Ramesh Kumar',
        aadhaar_number: '123456789012',
        pan_number: 'ABCDE1234F',
        dob: '1990-01-01',
        identity_verified: 1,
        aadhaar_doc_id: 41,
        aadhaar_back_doc_id: 43,
        pan_doc_id: 42,
        aadhaar_doc_key: 'MobileUploads/8379_1_front',
        aadhaar_back_doc_key: 'MobileUploads/8379_1_back',
        pan_doc_key: 'MobileUploads/8379_1_pan',
        ...overrides,
      }], []];
    },
  };
  return database;
}

// logger.js writes every line through console.log, so capturing it catches both
// logger calls and any stray console use on the path.
async function captureLogs(run) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    return { result: await run(), lines };
  } finally {
    console.log = originalLog;
  }
}

test('resolves Aadhaar front, Aadhaar back and PAN to presigned URLs', async () => {
  const keys = [];
  stubS3({ presign: async (key) => { keys.push(key); return `${SIGNED}&k=${key}`; } });

  const result = await identity.getIdentityDetails(8379, { database: identityDb() });

  assert.equal(result.aadhaarFrontUrl, `${SIGNED}&k=MobileUploads/8379_1_front`);
  // The back photo is the regression this feature exists for: it was written on
  // every save and read back by nothing.
  assert.equal(result.aadhaarBackUrl, `${SIGNED}&k=MobileUploads/8379_1_back`);
  assert.equal(result.aadhaarBackDocId, 43);
  assert.equal(result.panUrl, `${SIGNED}&k=MobileUploads/8379_1_pan`);
  assert.deepEqual(keys.sort(), [
    'MobileUploads/8379_1_back', 'MobileUploads/8379_1_front', 'MobileUploads/8379_1_pan',
  ]);
});

test('existing id fields survive unchanged for older app builds', async () => {
  stubS3();
  const result = await identity.getIdentityDetails(8379, { database: identityDb() });
  assert.equal(result.aadhaarDocId, 41);
  assert.equal(result.panDocId, 42);
  assert.equal(result.aadhaarNumber, '123456789012');
  assert.equal(result.panNumber, 'ABCDE1234F');
  assert.equal(result.isVerified, true);
});

test('a document row whose S3 object is gone yields a null URL, not an error', async () => {
  // Signing a missing key succeeds and 403s only at fetch time — the app would
  // render a broken tile instead of its placeholder. Hence the HEAD probe.
  let presigned = 0;
  stubS3({ exists: async () => false, presign: async () => { presigned += 1; return SIGNED; } });

  const result = await identity.getIdentityDetails(8379, { database: identityDb() });

  assert.deepEqual(
    [result.aadhaarFrontUrl, result.aadhaarBackUrl, result.panUrl],
    [null, null, null],
  );
  assert.equal(presigned, 0, 'a key with no object must never be signed');
  assert.equal(result.aadhaarBackDocId, 43, 'the id still restores even without a URL');
});

test('an S3 outage or a presign failure degrades to null rather than a 500', async () => {
  for (const stub of [
    { exists: async () => { throw new Error('S3 unavailable'); } },
    { presign: async () => { throw new Error('credentials expired'); } },
  ]) {
    stubS3(stub);
    const result = await identity.getIdentityDetails(8379, { database: identityDb() });
    assert.deepEqual(
      [result.aadhaarFrontUrl, result.aadhaarBackUrl, result.panUrl],
      [null, null, null],
    );
  }
});

test('a missing document degrades to null without probing S3', async () => {
  stubS3({ exists: async () => { throw new Error('should not be probed'); } });

  const result = await identity.getIdentityDetails(8379, {
    database: identityDb({ aadhaar_back_doc_id: null, aadhaar_back_doc_key: null, pan_doc_key: '' }),
  });

  assert.equal(result.aadhaarBackUrl, null);
  assert.equal(result.aadhaarBackDocId, undefined);
  assert.equal(result.panUrl, null);
});

test('a bare legacy filename also tries the easyfixer_documents prefix', async () => {
  // Pre-S3-convention rows store just `EFRDoc<ts>.jpg`; the object sits under
  // the prefix that mirrors the Nginx layout.
  const probed = [];
  stubS3({
    exists: async (key) => { probed.push(key); return key.startsWith('easyfixer_documents/'); },
    presign: async (key) => `${SIGNED}&k=${key}`,
  });

  const result = await identity.getIdentityDetails(8379, {
    database: identityDb({ aadhaar_doc_key: 'EFRDoc20260423133411.jpg' }),
  });

  // The three documents resolve concurrently, so assert membership + relative
  // order of this key's candidates rather than absolute positions.
  assert.equal(
    probed.indexOf('EFRDoc20260423133411.jpg') >= 0
    && probed.indexOf('EFRDoc20260423133411.jpg')
       < probed.indexOf('easyfixer_documents/EFRDoc20260423133411.jpg'),
    true,
    'the stored value is tried verbatim first, then under the legacy prefix',
  );
  assert.equal(result.aadhaarFrontUrl, `${SIGNED}&k=easyfixer_documents/EFRDoc20260423133411.jpg`);
});

test('local-disk dev (S3_BUCKET_NAME unset) returns the upload URL, never a broken one', async () => {
  stubS3({ enabled: false, exists: async () => { throw new Error('S3 must not be touched'); } });

  const result = await identity.getIdentityDetails(8379, {
    // Local fallback stores the bare on-disk filename; an S3-shaped key cannot
    // exist on this box, so it resolves to null instead of a fabricated link.
    database: identityDb({ aadhaar_doc_key: '1755000000000_ab12cd34.jpg' }),
  });

  // Byte-for-byte the URL POST /api/mobile/uploads replied with for this file —
  // both sides go through file-storage.publicUrlFor('general', …).
  assert.equal(result.aadhaarFrontUrl, '/easydoc/general/1755000000000_ab12cd34.jpg');
  assert.equal(result.panUrl, null);
});

test('neither an identity number nor a signed URL is ever logged', async () => {
  const secrets = ['123456789012', 'ABCDE1234F', 'X-Amz-Signature', 'deadbeefcafe'];

  for (const stub of [
    {},                                                            // healthy path
    { exists: async () => false },                                 // object gone
    { exists: async () => { throw new Error('S3 unavailable'); } }, // probe blew up
  ]) {
    stubS3(stub);
    const { lines } = await captureLogs(() => identity.getIdentityDetails(8379, {
      database: identityDb(),
    }));
    const logged = lines.join('\n');
    for (const secret of secrets) {
      assert.equal(logged.includes(secret), false, `"${secret}" must not reach a log line`);
    }
  }
});
