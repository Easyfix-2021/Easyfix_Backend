/*
 * GET /mobile/jobs/:id carries the reached-location selfie as `selfie_url`
 * (2026-09-16) so Start Work can show what was recorded and offer a retake —
 * but ONLY to the job's owner. An open-offer holder can open the same job, and
 * tx_selfie_id survives an unassign: without the owner check a re-offered job
 * would show the previous technician's face to every technician offered it.
 *
 * Runner: `node --test` (see npm test).
 */

delete process.env.S3_BUCKET_NAME; // S3 disabled → the legacy document.url path

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([[/FROM document WHERE id = \?/, (_sql, [id]) =>
  id === 555 ? [{ path: null, url: 'http://media.easyfix.in/selfie/555.jpg' }] : []]]);

for (const [rel, exports] of [
  ['../middleware/tech-auth', (req, _res, next) => { req.tech = { efr_id: 7 }; next(); }],
  ['../middleware/require-tech-lifecycle-capability', {
    requireTechCapability: () => (_req, _res, next) => next(),
    requireTechJobMutationCapability: (_req, _res, next) => next(),
  }],
  ['../middleware/idempotency', () => (_req, _res, next) => next()],
]) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const jobService = require('../services/job.service');
const saved = {};
let owner = 7;
let server;
let base;
before(async () => {
  for (const k of ['getById', 'techHasOpenOffer']) saved[k] = jobService[k];
  jobService.getById = async () => ({ job_id: 42, fk_easyfixter_id: owner, job_status: 1, tx_selfie_id: 555 });
  jobService.techHasOpenOffer = async () => true;
  const app = express();
  app.use(express.json());
  app.use('/mobile', require('../routes/mobile/index'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/mobile`;
});
after(async () => {
  Object.assign(jobService, saved);
  await new Promise((r) => server.close(r));
  if (fake.restore) fake.restore();
});

const getDetail = async () => {
  const r = await fetch(base + '/jobs/42');
  return { status: r.status, body: await r.json() };
};
const documentReads = () => fake.calls.filter((c) => /FROM document/.test(c.sql)).length;

test('the owner gets the recorded selfie as a renderable https URL', async () => {
  owner = 7;
  const { status, body } = await getDetail();
  assert.equal(status, 200);
  assert.equal(body.data.selfie_url, 'https://media.easyfix.in/selfie/555.jpg');
});

test('a technician holding only an OFFER can open the job but never gets the selfie', async () => {
  owner = 99;
  fake.calls.length = 0;
  const { status, body } = await getDetail();
  assert.equal(status, 200, 'positive control: the offered technician may still view the job');
  assert.equal(body.data.job_id, 42);
  assert.equal(body.data.selfie_url, null);
  assert.equal(documentReads(), 0, 'the document is not even looked up for a non-owner');
});

test('resolveSelfieUrl: no selfie id or no document row → null, no guess', async () => {
  assert.equal(await jobService.resolveSelfieUrl(null, 1), null);
  assert.equal(await jobService.resolveSelfieUrl(777, 1), null);
});
