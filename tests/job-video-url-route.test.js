/*
 * Customer-shared videos (tbl_job_media) through the REAL admin router.
 *
 * The CRM's video strip pointed <video src> at /videos/:id/file with no token,
 * and a <video> sends no Authorization header — every tile 401'd in Prod
 * (2026-09-30). /videos/:id/url is called WITH the header and hands back the
 * presigned URL; both routes share one resolver, asserted here.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const S = { row: { media_id: 7, job_id: 42, s3_key: 'JobSupportings/BookingVideo_42_1' }, inS3: true, clientId: 5 };
const fake = installFakePool([
  [/FROM tbl_job_media WHERE media_id = \?/, () => (S.row ? [S.row] : [])],
]);
const job = require('../services/job.service');
const s3 = require('../utils/s3-storage');
const real = { getById: job.getById, isEnabled: s3.isEnabled, exists: s3.exists, getPresignedUrl: s3.getPresignedUrl };
job.getById = async (id) => ({ job_id: Number(id), fk_client_id: S.clientId, city_id: 11, vertical_id: 3 });
s3.isEnabled = () => true;
s3.exists = async () => S.inS3;
s3.getPresignedUrl = async (key) => `https://bucket.example/${key}?sig=x`;

const express = require('express');
const { errorHandler } = require('../middleware/error-handler');
let server;
let base;
before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { user_id: 77, permissions: { menuIds: [], actionPermissions: [] } };
    req.userRole = { role_name: 'Project Manager' };
    const all = { mode: 'all', ids: [], placeholders: '' };
    req.scope = { clients: S.scope || all, cities: all, states: all, verticals: all };
    next();
  });
  app.use('/jobs', require('../routes/admin/jobs'));
  app.use(errorHandler);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/jobs`;
});
after(() => {
  server.close();
  job.getById = real.getById;
  Object.assign(s3, { isEnabled: real.isEnabled, exists: real.exists, getPresignedUrl: real.getPresignedUrl });
  fake.restore();
});
beforeEach(() => {
  S.row = { media_id: 7, job_id: 42, s3_key: 'JobSupportings/BookingVideo_42_1' };
  S.inS3 = true;
  S.scope = null;
  fake.reset();
});

const getUrl = async (id = 7) => { const r = await fetch(`${base}/videos/${id}/url`); return { status: r.status, body: await r.json() }; };

test('/url returns the presigned URL as JSON', async () => {
  const r = await getUrl();
  assert.equal(r.status, 200);
  assert.equal(r.body.data.url, 'https://bucket.example/JobSupportings/BookingVideo_42_1?sig=x');
});

test('/file redirects to the SAME URL /url returns', async () => {
  const r = await fetch(`${base}/videos/7/file`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://bucket.example/JobSupportings/BookingVideo_42_1?sig=x');
});

test('/url answers url:null (not an error) when the object is gone', async () => {
  S.inS3 = false;
  const r = await getUrl();
  assert.equal(r.status, 200);
  assert.equal(r.body.data.url, null);
});

test('/url for an out-of-scope job looks identical to an unknown id', async () => {
  S.scope = { mode: 'list', ids: [999], placeholders: '?' };
  const scoped = await getUrl();
  S.scope = null; S.row = null;
  const unknown = await getUrl();
  assert.equal(scoped.body.data.url, null);
  assert.deepEqual(scoped.body, { ...unknown.body }, 'a difference here is a job-existence oracle');
});

test('/url rejects a non-numeric id', async () => {
  const r = await fetch(`${base}/videos/abc/url`);
  assert.equal(r.status, 400);
});
