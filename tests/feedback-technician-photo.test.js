'use strict';
/*
 * The public feedback page's technician photo — sent ONLY to a signed link
 * (2026-09-30, owner's call). GET /api/public/feedback/:jobId is reachable by
 * guessing an integer, so a bare-id request must never carry a face photo;
 * the job-bound ?t= token is what a real customer's link has.
 *
 * Runs the REAL gate and the REAL handler in sequence, the way the router does.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-feedback-photo';
process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
delete process.env.FILE_BASE_URL;

const S = { photo: 'EFRDoc20240223205832.jpg' };
const fake = installFakePool([
  [/FROM tbl_job j/i, () => [{
    job_id: 42, job_status: 3, fk_customer_id: 1, fk_easyfixter_id: 7, fk_service_catg_id: 2,
    customer_name: 'Mr. Ravi Kumar', easyfixer_name: 'Suresh Yadav', efr_profile_img: S.photo,
    service_catg_name: 'AC', client_id: 5, client_name: 'Acme',
  }]],
  [/tbl_easyfixer_rating_by_customer/i, () => []],
]);
const profileLink = require('../services/easyfixer-profile-update-link.service');
const realPresign = profileLink.presignProfileImage;
const S3 = new Map();          // key → presigned URL; empty = not in the bucket
profileLink.presignProfileImage = async (k) => S3.get(k) || null;

const router = require('../routes/public/feedback');
const { feedbackGate } = router;
const { mintFeedbackLink } = require('../services/feedback-link.service');
const layer = router.stack.find((e) => e.route && e.route.path === '/:jobId' && e.route.methods.get);
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

const realFetch = global.fetch;
const probed = [];
test.beforeEach(() => {
  S.photo = 'EFRDoc20240223205832.jpg';
  S3.clear();
  probed.length = 0;
  global.fetch = (url) => {
    probed.push(String(url));
    return Promise.resolve(String(url).endsWith('/easyfixer_documents/EFRDoc20240223205832.jpg')
      ? { ok: true, status: 200, headers: new Map([['content-type', 'image/jpeg']]) }
      : { ok: false, status: 404, headers: new Map([['content-type', 'text/html']]) });
  };
});
test.after(() => { global.fetch = realFetch; profileLink.presignProfileImage = realPresign; fake.restore(); });

async function get({ t } = {}) {
  const req = { params: { jobId: '42' }, query: t === undefined ? {} : { t } };
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  let passed = false;
  feedbackGate(req, res, () => { passed = true; });
  if (passed) await handler(req, res, (e) => { throw e; });
  return res;
}
const photoOf = (r) => r.body.data.easyfixer_image;

test('a SIGNED link gets the technician photo from the legacy file host', async () => {
  const r = await get({ t: mintFeedbackLink(42).token });
  assert.equal(photoOf(r), 'https://core.easyfix.in/easydoc/easyfixer_documents/EFRDoc20240223205832.jpg');
});

test('a BARE-ID link gets no photo — and the host is never even probed', async () => {
  const r = await get();
  assert.equal(r.code, 200, 'the page still works for legacy links');
  assert.equal(photoOf(r), null);
  assert.deepEqual(probed, [], 'no lookup for a request that may not see the result');
});

test('an S3 photo wins over the legacy host', async () => {
  S.photo = 'EasyfixerProfile/7_abc';
  S3.set('EasyfixerProfile/7_abc', 'https://bucket.example/EasyfixerProfile/7_abc?sig=x');
  const r = await get({ t: mintFeedbackLink(42).token });
  assert.equal(photoOf(r), 'https://bucket.example/EasyfixerProfile/7_abc?sig=x');
});

test('the dummy placeholder and missing files fall back to initials (null)', async () => {
  const t = mintFeedbackLink(42).token;
  S.photo = 'MobileUploads/dummy_profile.jpg';
  assert.equal(photoOf(await get({ t })), null);
  S.photo = 'EFRDoc00000000000000.jpg';
  assert.equal(photoOf(await get({ t })), null, 'an HTML 404 must never become an <img src>');
  assert.ok(probed.some((u) => u.endsWith('/EFRDoc00000000000000.jpg')), 'positive control: it looked');
});

test("another job's token still gets a 401, not a photo", async () => {
  const r = await get({ t: mintFeedbackLink(99).token });
  assert.equal(r.code, 401);
  assert.equal(r.body.data, undefined);
});
