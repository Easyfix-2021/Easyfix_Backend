/*
 * The two admin routes around the every-close photo rule, through the REAL
 * router and the REAL error handler (routes/admin/jobs.js):
 *
 *   POST /:id/hold/release — writes 10 directly (so the partner webhook does not
 *   re-fire), so it applies the rule itself: only a job ON HOLD (21) releases,
 *   and only with an after-work photo; the write re-checks 21 (race).
 *
 *   POST /:id/images — category 'Booking' (default, today) or 'Completion' (an
 *   after-work photo ops add so a job can close). Completion needs
 *   isJobAfterPhotoUpload and image BYTES (the S3 key has no extension, so a PDF
 *   stored as completion would count as proof); anything else is refused.
 *
 * job.getById / job.hasAfterWorkPhoto and job-image.service.uploadJobImage are
 * stubbed on the module objects the router calls through, so "allowed" is a
 * positive signal (the write / upload ran) and nothing touches S3 or disk.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const S = { status: 21, hasPhoto: true, released: 1, actions: [] };
const fake = installFakePool([
  [/UPDATE tbl_job SET job_status = 10 WHERE job_id = \? AND job_status = 21/, () => ({ affectedRows: S.released })],
]);
const job = require('../services/job.service');
const images = require('../services/job-image.service');
const uploads = [];
const real = { getById: job.getById, hasAfterWorkPhoto: job.hasAfterWorkPhoto, uploadJobImage: images.uploadJobImage };
job.getById = async (id) => ({ job_id: Number(id), job_status: S.status, fk_client_id: 5, city_id: 11, vertical_id: 3 });
job.hasAfterWorkPhoto = async () => S.hasPhoto;
images.uploadJobImage = async (args) => { uploads.push(args); return { image_id: 900, image: 'k', storage: 's3' }; };

const express = require('express');
const { errorHandler } = require('../middleware/error-handler');
let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { user_id: 77, permissions: { menuIds: [], actionPermissions: S.actions } };
    req.userRole = { role_name: 'Project Manager' };
    const all = { mode: 'all', ids: [], placeholders: '' };
    req.scope = { clients: all, cities: all, states: all, verticals: all };
    next();
  });
  app.use('/jobs', require('../routes/admin/jobs'));
  app.use(errorHandler);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/jobs`;
});
after(() => {
  server.close();
  Object.assign(job, { getById: real.getById, hasAfterWorkPhoto: real.hasAfterWorkPhoto });
  images.uploadJobImage = real.uploadJobImage;
  fake.restore();
});
beforeEach(() => { Object.assign(S, { status: 21, hasPhoto: true, released: 1, actions: [] }); fake.reset(); uploads.length = 0; });

const releases = () => fake.calls.filter((c) => /UPDATE tbl_job SET job_status = 10/.test(c.sql));
const release = async () => { const r = await fetch(`${base}/42/hold/release`, { method: 'POST' }); return { status: r.status, body: await r.json() }; };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const PDF = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n');
async function upload({ category, bytes = PNG, type = 'image/png', name = 'after.png' } = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  if (category) fd.append('category', category);
  const r = await fetch(`${base}/42/images`, { method: 'POST', body: fd });
  return { status: r.status, body: await r.json() };
}

/* ── hold release ─────────────────────────────────────────────────────── */

test('release on hold WITH an after-work photo lands, and the write re-checks 21', async () => {
  const r = await release();
  assert.equal(r.status, 200);
  assert.equal(releases().length, 1, 'positive control: the release wrote');
  assert.deepEqual(releases()[0].params, [42]);
});

test('release of a job that is NOT on hold is 409 and writes nothing (Check In → Release)', async () => {
  S.status = 2;
  const r = await release();
  assert.equal(r.status, 409);
  assert.match(r.body.error, /not on fulfillment hold/);
  assert.equal(releases().length, 0);
});

test('release with NO after-work photo is 409 AFTER_PHOTO_REQUIRED and writes nothing', async () => {
  S.hasPhoto = false;
  const r = await release();
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'AFTER_PHOTO_REQUIRED');
  assert.match(r.body.error, /after-work photo/);
  assert.equal(releases().length, 0);
});

test('a release that loses the race (no longer 21 at write time) is 409', async () => {
  S.released = 0;
  const r = await release();
  assert.equal(r.status, 409);
  assert.match(r.body.error, /not on fulfillment hold/);
});

/* ── image upload category ────────────────────────────────────────────── */

test('no category is the Booking attachment, as today — no key needed', async () => {
  const r = await upload();
  assert.equal(r.status, 200);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].category, 'Booking');
});

test('Completion without isJobAfterPhotoUpload is 403 and nothing is stored', async () => {
  const r = await upload({ category: 'Completion' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /isJobAfterPhotoUpload/);
  assert.equal(uploads.length, 0);
});

test('Completion with the key stores an after-work photo', async () => {
  S.actions = ['isJobAfterPhotoUpload'];
  const r = await upload({ category: 'Completion' });
  assert.equal(r.status, 200);
  assert.equal(uploads[0].category, 'Completion');
});

test('a PDF is refused as an after-work photo, by its bytes — even labelled image/png', async () => {
  S.actions = ['isJobAfterPhotoUpload'];
  for (const type of ['application/pdf', 'image/png']) {
    const r = await upload({ category: 'Completion', bytes: PDF, type, name: 'proof.pdf' });
    assert.equal(r.status, 400, `declared ${type}`);
    assert.match(r.body.error, /must be an image/);
  }
  assert.equal(uploads.length, 0);
});

test('an unknown category is 400', async () => {
  const r = await upload({ category: 'Selfie' });
  assert.equal(r.status, 400);
  assert.equal(uploads.length, 0);
});

test('a photo over 10 MB is a clear 400, not a 500 (multer rejects it before the handler)', async () => {
  S.actions = ['isJobAfterPhotoUpload'];
  const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024 + 1)]);
  const r = await upload({ category: 'Completion', bytes: big });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'file exceeds 10MB');
  assert.equal(uploads.length, 0);
});
