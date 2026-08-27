const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * A client document is bytes in S3 plus a row in tbl_client_document. Writing
 * one without the other is the failure this pins.
 *
 * Both upload routes used to do the two steps themselves — put the object,
 * then insert the row — so a failed insert left a PAN or Aadhaar file in the
 * bucket with nothing pointing at it, and one more on every retry. Invisible:
 * the operator saw an error and tried again, and the only trace was the bill.
 *
 * A sweeper ("delete S3 objects with no row") would be WORSE THAN THE BUG here,
 * because an object with no live row is a normal state — softDelete() keeps the
 * file on purpose so a deletion stays reversible and auditable. The rollback
 * therefore removes exactly one key, the one it just wrote, and only when the
 * row it was written for never existed.
 */

const scenario = { insertFails: false, deleteFails: false };
const deleted = [];

const fake = installFakePool([
  // Probe answers "table present" so recordUpload reaches its INSERT.
  [/INFORMATION_SCHEMA\.TABLES/i, [{ 1: 1 }]],
  [/^\s*INSERT INTO tbl_client_document/i, () => {
    if (scenario.insertFails) throw new Error('ER_LOCK_WAIT_TIMEOUT: insert failed');
    return { insertId: 4242 };
  }],
]);

/*
 * The service does `const s3 = require(...)` and calls `s3.putClientDocument()`
 * at call time, so patching the shared module object reaches it — no loader
 * interception needed.
 */
const s3 = require('../utils/s3-storage');
s3.putClientDocument = async () => 'ClientDocs/1724750000000_abc123';
s3.deleteObject = async (key) => {
  deleted.push(key);
  if (scenario.deleteFails) return { deleted: false, reason: 'error', error: 'access denied' };
  return { deleted: true };
};

const docsSvc = require('../services/client-documents.service');

after(() => fake.restore());
beforeEach(() => {
  deleted.length = 0;
  scenario.insertFails = false;
  scenario.deleteFails = false;
  fake.reset();
});

const FILE = {
  buffer: Buffer.from('%PDF-1.4 fake'),
  contentType: 'application/pdf',
  originalName: 'pan.pdf',
  docType: 'pan',
  docLabel: null,
  uploadedBy: 99,
};

test('a successful upload keeps the object and returns the row id', async () => {
  const res = await docsSvc.storeAndRecord(7, FILE);
  assert.equal(res.documentId, 4242);
  assert.equal(res.s3Key, 'ClientDocs/1724750000000_abc123');
  assert.deepEqual(deleted, [], 'nothing may be deleted on the happy path');
});

test('a failed record removes the object it just uploaded', async () => {
  scenario.insertFails = true;
  await assert.rejects(() => docsSvc.storeAndRecord(7, FILE), /insert failed/);
  assert.deepEqual(deleted, ['ClientDocs/1724750000000_abc123'],
    'the orphan must be rolled back — exactly the key just written, and only that one');
});

test('the original error survives a cleanup that also fails', async () => {
  scenario.insertFails = true;
  scenario.deleteFails = true;
  await assert.rejects(() => docsSvc.storeAndRecord(7, FILE), /insert failed/,
    'the caller must hear that the SAVE failed, not that the tidying did');
  assert.equal(deleted.length, 1, 'cleanup was still attempted');
});

test('both upload routes go through storeAndRecord, neither hand-rolls the pair', () => {
  const fs = require('fs');
  const path = require('path');
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');

  for (const rel of ['routes/admin/clients.js', 'routes/client/index.js']) {
    const src = strip(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
    assert.match(src, /\.storeAndRecord\(/, `${rel} must use the paired helper`);
    /*
     * The point of the helper is that the two steps cannot be separated again.
     * A route that calls putClientDocument itself has re-created the window,
     * whatever else it does afterwards.
     */
    assert.equal(/putClientDocument\(/.test(src), false,
      `${rel} must not upload on its own — that is how the orphan window reopens`);
    assert.equal(/\.recordUpload\(/.test(src), false,
      `${rel} must not insert on its own either`);
  }
});
