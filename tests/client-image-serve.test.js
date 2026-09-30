/*
 * The client portal's image route (routes/client/index.js → serveResolvedImage)
 * must resolve exactly like the admin one. Its old private copy had no
 * legacy-file-host branch, so job 545900's bare-filename photos and .mp4 404'd
 * for the SPOC while the admin CRM rendered them.
 */
process.env.S3_BUCKET_NAME = '';          // BEFORE utils/s3-storage.js is loaded
process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
delete process.env.FILE_BASE_URL;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

installFakePool([
  // Top of the reporting tree → no hierarchy narrowing in loadJobInScope.
  [/SELECT manager_id FROM tbl_client_contacts/i, () => [{ manager_id: null }]],
]);
const { serveResolvedImage } = require('../services/job-image.service');
const jobService = require('../services/job.service');

const realFetch = global.fetch;
after(() => { global.fetch = realFetch; });

function fakeRes() {
  const r = { redirected: null, status: 200, body: null };
  r.redirect = (u) => { r.redirected = u; };
  r.sendFile = (p) => { r.sent = p; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; };
  return r;
}

test('a bare-filename video on the legacy host is redirected to, not 404d', async () => {
  global.fetch = (url) => Promise.resolve(String(url).includes('/upload_jobs/')
    ? { ok: true, status: 200, headers: new Map([['content-type', 'video/mp4']]) }
    : { ok: false, status: 404, headers: new Map([['content-type', 'text/html']]) });
  const res = fakeRes();
  await serveResolvedImage(res, '545900_20260930132025_4.mp4');
  assert.equal(res.redirected, 'https://core.easyfix.in/easydoc/upload_jobs/545900_20260930132025_4.mp4');
});

test('a file that is nowhere still answers 404 JSON', async () => {
  global.fetch = () => Promise.resolve({ ok: false, status: 404, headers: new Map([['content-type', 'text/html']]) });
  const res = fakeRes();
  await serveResolvedImage(res, 'gone.jpg');
  assert.equal(res.code, 404);
  assert.equal(res.redirected, null, 'positive control: nothing redirected when the host has no file');
});

/*
 * GET /api/client/jobs/:id — the portal renders images[].image_url in a plain
 * <img>, so it must be loadable with NO auth. getById leaves legacy rows as a
 * relative /easydoc path (404 on the portal host); the route must replace it.
 */
test('job detail rewrites a relative legacy image_url to the verified legacy-host URL', async () => {
  const router = require('../routes/client/index');
  const layer = router.stack.find((e) => e.route && e.route.path === '/jobs/:id' && e.route.methods.get);
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  const presigned = 'https://bucket.example/JobSupportings/Booking_545900_1?sig=x';
  const realGetById = jobService.getById;
  jobService.getById = async () => ({
    job_id: 545900, fk_client_id: 133, reporting_contact_id: 42,
    images: [
      { image_id: 1, image: 'JobSupportings/Booking_545900_1', image_url: presigned },
      { image_id: 2, image: '545900_20260930132025_4.mp4', image_url: '/easydoc/upload_jobs/545900_20260930132025_4.mp4' },
      { image_id: 3, image: 'gone.jpg', image_url: '/easydoc/upload_jobs/gone.jpg' },
    ],
  });
  const probed = [];
  global.fetch = (url) => {
    probed.push(String(url));
    return Promise.resolve(String(url).includes('/upload_jobs/545900_')
      ? { ok: true, status: 200, headers: new Map([['content-type', 'video/mp4']]) }
      : { ok: false, status: 404, headers: new Map([['content-type', 'text/html']]) });
  };
  const res = { status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  try {
    await handle({ spoc: { id: 42, client_id: 133 }, access: { allStores: true }, query: {}, params: { id: '545900' } },
      res, (e) => { throw e; });
  } finally { jobService.getById = realGetById; }

  const urls = Object.fromEntries(res.body.data.images.map((i) => [i.image_id, i.image_url]));
  assert.equal(urls[1], presigned, 'an already-absolute S3 URL is kept as is');
  assert.ok(!probed.some((u) => u.includes('Booking_545900_1')), 'and is not probed a second time');
  assert.equal(urls[2], 'https://core.easyfix.in/easydoc/upload_jobs/545900_20260930132025_4.mp4');
  assert.equal(urls[3], null, 'nothing loadable → null, so the portal shows its empty state');
});

test('GET /jobs/:id/documents returns verified Jobsheet/Estimate URLs, null when absent', async () => {
  const router = require('../routes/client/index');
  const layer = router.stack.find((e) => e.route && e.route.path === '/jobs/:id/documents' && e.route.methods.get);
  assert.ok(layer, 'GET /jobs/:id/documents must be mounted');
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  const realGetById = jobService.getById;
  jobService.getById = async () => ({ job_id: 530707, fk_client_id: 133, reporting_contact_id: 42 });
  global.fetch = (url) => Promise.resolve(String(url).includes('/feedback_jobs/feedback530707.pdf')
    ? { ok: true, status: 200, headers: new Map([['content-type', 'application/pdf']]) }
    : { ok: false, status: 404, headers: new Map([['content-type', 'text/html']]) });
  const res = { status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  try {
    await handle({ spoc: { id: 42, client_id: 133 }, access: { allStores: true }, query: {}, params: { id: '530707' } },
      res, (e) => { throw e; });
  } finally { jobService.getById = realGetById; }
  assert.deepEqual(res.body.data, {
    jobsheet_url: 'https://core.easyfix.in/easydoc/feedback_jobs/feedback530707.pdf',
    estimate_url: null,
  });
});

test('GET /jobs/:id/documents on another client\'s job is a 404, not URLs', async () => {
  const router = require('../routes/client/index');
  const layer = router.stack.find((e) => e.route && e.route.path === '/jobs/:id/documents' && e.route.methods.get);
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  const realGetById = jobService.getById;
  jobService.getById = async () => ({ job_id: 530707, fk_client_id: 999, reporting_contact_id: 42 });
  let probed = false;
  global.fetch = () => { probed = true; return Promise.resolve({ ok: true, status: 200, headers: new Map([['content-type', 'application/pdf']]) }); };
  const res = { status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  try {
    await handle({ spoc: { id: 42, client_id: 133 }, access: { allStores: true }, query: {}, params: { id: '530707' } },
      res, (e) => { throw e; });
  } finally { jobService.getById = realGetById; }
  assert.equal(res.code, 404);
  assert.equal(probed, false, 'must not even probe for a job outside the caller\'s client');
});
