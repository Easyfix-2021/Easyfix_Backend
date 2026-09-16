/*
 * POST /mobile/uploads/document stamps document.created_on with a BOUND Date,
 * not SQL NOW() (2026-09-16). Start Work shows the arrival selfie's "Recorded"
 * time from that column, so it must be IST on any DB host: a bound Date goes
 * through the pool's explicit timezone '+05:30', NOW() through the session's
 * SYSTEM zone — the host clock.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([[/INSERT INTO document/, { insertId: 9001 }]]);

for (const [rel, exports] of [
  ['../utils/s3-storage', { isEnabled: () => false }],
  ['../utils/file-storage', { writeBuffer: () => ({ filename: 'selfie.jpg', url: '/easydoc/selfie.jpg' }) }],
  ['../middleware/verify-idempotency-upload', {
    verifyIdempotencyUpload: (_req, _res, next) => next(),
    deterministicUploadToken: () => null,
  }],
]) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

let server;
let base;
before(async () => {
  const app = express();
  app.use((req, _res, next) => { req.tech = { efr_id: 7 }; next(); });
  app.use('/mobile/uploads', require('../routes/mobile/uploads'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/mobile/uploads`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  if (fake.restore) fake.restore();
});

test('the document row is stamped with a bound Date, never NOW()', async () => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'selfie.jpg');
  form.append('kind', 'reached_selfie');
  const r = await fetch(base + '/document', { method: 'POST', body: form });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.data.documentId, 9001, 'positive control: the insert ran and its id came back');

  const insert = fake.calls.find((c) => /INSERT INTO document/.test(c.sql));
  assert.doesNotMatch(insert.sql, /NOW\(\)/i);
  const createdOn = insert.params[2];
  assert.ok(createdOn instanceof Date, 'created_on is the third bound value');
  assert.ok(Math.abs(Date.now() - createdOn.getTime()) < 60_000, 'and it is now');
});
