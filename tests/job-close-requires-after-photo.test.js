/*
 * NO CLOSE WITHOUT AN AFTER-WORK PHOTO, IN ANY FLOW — services/job.service.js setStatus.
 *
 * The CRM's Check Out button closed job 538541 with no photo (11 Sep: Check In
 * then Check Out five seconds apart). The rule is in setStatus so no CRM
 * surface can do it again, whichever button sends the status. Pinned:
 *   - a CRM user closing (→ 10 Check Out, → 3 / 5 Complete, incl. 10 → 3 at
 *     audit) with no after-work photo is 409 AFTER_PHOTO_REQUIRED and NOTHING
 *     is written; with one, the close lands;
 *   - the photo test is the app's own after-photo predicate: after categories,
 *     no PDFs, bound job id;
 *   - moving between closed states (5 → 10 re-audit, 3 → 5) is not a close;
 *   - EVERY flow is held to it (owner: "every flow needs it") — the technician
 *     app for completion AND the revisit outcome, and a caller with no actor —
 *     except the partner API, the one explicit opt-out ({ partnerApi: true });
 *   - a transition that closes nothing costs no extra query;
 *   - the CRM receives the sentence and the code (error-handler passthrough).
 *
 * Runner: `node --test` (see npm test).
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const S = { jobMeta: null, hasPhoto: false };
const PHOTO_SQL = /FROM tbl_job_image[\s\S]*image_category/i;
const fake = installFakePool(
  [
    [PHOTO_SQL, () => (S.hasPhoto ? [{ 1: 1 }] : [])],
    [/INFORMATION_SCHEMA/i, () => [{ n: 3 }]],
    [/SELECT 1 FROM tbl_job_offer LIMIT 1/i, () => [{ ok: 1 }]],
    [/FROM\s+tbl_job\s+WHERE\s+job_id/i, () => (S.jobMeta ? [S.jobMeta] : [])],
  ],
  // Stop at the job UPDATE itself: whether it is reached is the whole question.
  { stopOn: /UPDATE tbl_job SET/i },
);
const jobSvc = require('../services/job.service');
const { errorHandler } = require('../middleware/error-handler');

const META = {
  job_id: 42, job_status: 2, fk_easyfixter_id: 7, fk_customer_id: 3,
  fk_client_id: 5, requested_date_time: '2026-07-10 10:00:00',
  booking_cut_off_time_slot: null, otp: null,
};
const CRM = { user_id: 12 };
const TECH = { user_id: 55, efr_id: 55 };

after(() => fake.restore());
beforeEach(() => { fake.reset(); S.jobMeta = { ...META }; S.hasPhoto = false; });

/** 'closed' when the job UPDATE was reached, else the error setStatus threw. */
async function run(from, to, actor, opts) {
  S.jobMeta = { ...META, job_status: from };
  try {
    await jobSvc.setStatus(42, { status: to }, actor, opts);
    return 'returned';                        // unreachable: stopOn fires first
  } catch (e) {
    if (e.__stop) return 'closed';
    return e;
  }
}
const jobUpdates = () => fake.calls.filter((c) => /UPDATE tbl_job SET/i.test(c.sql));
const photoQueries = () => fake.calls.filter((c) => PHOTO_SQL.test(c.sql));

test('CRM Check Out (2 → 10) with no after-work photo is refused, and nothing is written', async () => {
  const e = await run(2, 10, CRM);
  assert.equal(e.status, 409);
  assert.equal(e.code, 'AFTER_PHOTO_REQUIRED');
  assert.match(e.message, /after-work photo/);
  assert.equal(photoQueries().length, 1, 'positive control: the photo check ran');
  assert.equal(jobUpdates().length, 0, 'no status change reached the database');
});

test('every CRM close is covered — Pending to Close, Complete, and the audit completion 10 → 3', async () => {
  for (const [from, to] of [[20, 10], [2, 3], [2, 5], [10, 3], [10, 5], [0, 3]]) {
    fake.reset();
    const e = await run(from, to, CRM);
    assert.equal(e && e.code, 'AFTER_PHOTO_REQUIRED', `${from} → ${to} must need a photo`);
    assert.equal(jobUpdates().length, 0, `${from} → ${to} wrote nothing`);
  }
});

test('with an after-work photo the CRM close lands', async () => {
  S.hasPhoto = true;
  assert.equal(await run(2, 10, CRM), 'closed');
  assert.equal(await run(10, 3, CRM), 'closed');
});

test('the photo check is the app\'s after-photo predicate: after categories, no PDFs, bound job id', async () => {
  await run(2, 10, CRM);
  const [q] = photoQueries();
  assert.deepEqual(q.params, [42]);
  assert.match(q.sql, /WHERE job_id = \?/);
  assert.match(q.sql, /LOWER\(image_category\) IN \('completion', 'after', 'checkout'\)/);
  assert.match(q.sql, /image NOT LIKE '%\.pdf'/);
  assert.doesNotMatch(q.sql, /job_stage/, 'job_stage is not a before/after axis (utils/job-image-buckets.js)');
});

test('moving between closed states is not a close: re-audit 5 → 10, and 3 → 5', async () => {
  assert.equal(await run(5, 10, CRM), 'closed');
  assert.equal(await run(3, 5, CRM), 'closed');
  assert.equal(photoQueries().length, 0);
});

test('the technician app is held to it too — completion AND the revisit outcome, any efr principal', async () => {
  for (const [to, actor] of [[3, TECH], [10, TECH], [3, { user_id: 'efr:55' }]]) {
    fake.reset();
    const e = await run(2, to, actor);
    assert.equal(e && e.code, 'AFTER_PHOTO_REQUIRED', `technician 2 → ${to} must need a photo`);
    assert.equal(jobUpdates().length, 0);
  }
  S.hasPhoto = true;
  assert.equal(await run(2, 3, TECH), 'closed', 'with the photo the app attached, the close lands');
});

test('a caller with no actor is held to it; the partner API is the ONE opt-out', async () => {
  const e = await run(2, 3, { user_id: null });
  assert.equal(e && e.code, 'AFTER_PHOTO_REQUIRED', 'no actor is not an exemption — only the explicit flag is');
  fake.reset();
  assert.equal(await run(2, 3, { user_id: null }, { partnerApi: true }), 'closed', 'partner checkout: no change for external clients');
  assert.equal(photoQueries().length, 0, 'the partner path is not even asked');
});

test('the partner route really passes the opt-out (routes/integration/v1 PATCH /jobs)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'integration', 'v1', 'index.js'), 'utf8');
  assert.match(src, /jobService\.setStatus\(\s*jobId, \{ status: newStatus, comment: req\.body\.comment \}, \{ user_id: null \}, \{ partnerApi: true \},?\s*\)/);
  assert.equal(src.split(', { partnerApi: true }').length - 1, 1, 'exactly one call opts out');
});

test('a transition that closes nothing costs no photo query', async () => {
  for (const [from, to] of [[1, 2], [0, 6], [9, 0], [2, 20]]) assert.equal(await run(from, to, CRM), 'closed');
  assert.equal(photoQueries().length, 0);
});

test('the CRM receives the sentence and AFTER_PHOTO_REQUIRED', async () => {
  const e = await run(2, 10, CRM);
  const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  errorHandler(e, { originalUrl: '/api/admin/jobs/42/status', method: 'PATCH' }, res, () => {});
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { success: false, error: e.message, code: 'AFTER_PHOTO_REQUIRED' });
});

test('the technician checkout forwards the code, so the app can show its translated sentence', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'mobile', 'index.js'), 'utf8');
  const start = src.indexOf("router.post('/jobs/:id/checkout'");
  assert.ok(start !== -1, 'positive control: the checkout route exists');
  const body = src.slice(start, src.indexOf('\n});', start));
  // Same shape as INVALID_CHECKOUT_PIN — the app's api.ts reads error.code, not a top-level code.
  assert.match(body, /if \(e\.code === 'AFTER_PHOTO_REQUIRED'\) return modernError\(res, e\.status, \{ message: e\.message, code: e\.code \}\);/);
});
