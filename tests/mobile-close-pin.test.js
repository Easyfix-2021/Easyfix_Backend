/*
 * The customer PIN is the CLOSING control (2026-09-07).
 *
 * Product rule: "treat the Start PIN as job close pin. Its not mandatory to
 * start the job but is mandatory to close it. To start job, only the location
 * and selfie is required."
 *
 * So POST /api/mobile/jobs/:id/checkout now requires the PIN and verifies it
 * against tbl_job.otp, returning 409 INVALID_CHECKOUT_PIN when it is missing or
 * wrong. Two things must NOT regress and are pinned here:
 *   - a job whose row carries NO PIN stays closable (most old jobs never went
 *     through the BOOKED-confirm path that mints one);
 *   - the gate is MOBILE-ONLY. The CRM completes through
 *     PATCH /api/admin/jobs/:id/status → job.setStatus(), so ops can always
 *     close a job the technician could not.
 *
 * The check-in side (PIN no longer blocks starting) is pinned in
 * tests/mobile-checkin-nondestructive.test.js.
 *
 * Runner: `node --test --test-force-exit tests/mobile-close-pin.test.js`.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { installFakePool } = require('./helpers/fake-pool');

// Never touch a DB: patch the shared pool singleton BEFORE the router (and the
// services it pulls in) capture their `pool` reference.
const fake = installFakePool([]);

// Auth / capability / idempotency layers are not under test — seed
// require.cache with pass-throughs before the router asks for them.
require.cache[require.resolve('../middleware/tech-auth')] = {
  id: require.resolve('../middleware/tech-auth'),
  filename: require.resolve('../middleware/tech-auth'),
  loaded: true,
  exports: (req, _res, next) => { req.tech = { efr_id: 7 }; next(); },
};
require.cache[require.resolve('../middleware/require-tech-lifecycle-capability')] = {
  id: require.resolve('../middleware/require-tech-lifecycle-capability'),
  filename: require.resolve('../middleware/require-tech-lifecycle-capability'),
  loaded: true,
  exports: {
    requireTechCapability: () => (_req, _res, next) => next(),
    requireTechJobMutationCapability: (_req, _res, next) => next(),
  },
};
require.cache[require.resolve('../middleware/idempotency')] = {
  id: require.resolve('../middleware/idempotency'),
  filename: require.resolve('../middleware/idempotency'),
  loaded: true,
  exports: () => (_req, _res, next) => next(),
};

const jobService = require('../services/job.service');

const JOB = { job_id: 42, fk_easyfixter_id: 7, job_status: 2, otp: '1234' };

let captured = null;
let server;
let baseUrl;

const originalGetById = jobService.getById;
const originalSetStatus = jobService.setStatus;

before(async () => {
  jobService.getById = async () => ({ ...JOB });
  jobService.setStatus = async (jobId, payload) => {
    captured = { jobId, ...payload };
    return { updated: true };
  };

  // eslint-disable-next-line global-require
  const router = require('../routes/mobile/index');
  const app = express();
  app.use(express.json());
  app.use('/mobile', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  jobService.getById = originalGetById;
  jobService.setStatus = originalSetStatus;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fake.restore) fake.restore();
});

beforeEach(() => { captured = null; });

async function checkout(body) {
  const r = await fetch(`${baseUrl}/mobile/jobs/42/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

// ─── The gate ────────────────────────────────────────────────────────

test('closing WITHOUT the PIN is rejected before any write', async () => {
  const res = await checkout({});
  assert.equal(res.status, 409, 'the PIN is mandatory to close');
  assert.equal(res.body?.error?.code, 'INVALID_CHECKOUT_PIN');
  assert.equal(captured, null, 'no status write may happen on a PIN failure');
});

test('closing with the WRONG PIN is rejected before any write', async () => {
  const res = await checkout({ otp: '9999' });
  assert.equal(res.status, 409);
  assert.equal(res.body?.error?.code, 'INVALID_CHECKOUT_PIN');
  assert.match(res.body?.error?.message, /Incorrect/, 'wrong ≠ missing in the human sentence');
  assert.equal(captured, null);
});

test('the missing-PIN message differs from the wrong-PIN one, under one code', async () => {
  // One code because the app does the same thing either way (prompt + Resend);
  // two sentences because the technician needs to know which it was.
  const missing = await checkout({});
  const wrong = await checkout({ otp: '9999' });
  assert.equal(missing.body?.error?.code, wrong.body?.error?.code);
  assert.notEqual(missing.body?.error?.message, wrong.body?.error?.message);
});

// ─── The happy path ──────────────────────────────────────────────────

test('the right PIN closes the job — trimmed, like the check-in compare', async () => {
  const res = await checkout({ otp: ' 1234 ' });
  assert.equal(res.status, 200);
  assert.equal(captured.status, 3, 'transition to COMPLETED is unchanged');
});

test('a revisit close is gated the same way and still routes to REVISIT', async () => {
  const blocked = await checkout({ isNextVisit: true });
  assert.equal(blocked.status, 409, 'a revisit is still a close');
  const ok = await checkout({ otp: '1234', isNextVisit: true });
  assert.equal(ok.status, 200);
  assert.equal(captured.status, 10, 'REVISIT, not COMPLETED');
});

// ─── The regression that would strand every old job ──────────────────

test('a job with NO PIN on the row is still closable', async () => {
  // Most jobs predate the PIN, or never went through the BOOKED-confirm path
  // that mints one. Enforcing unconditionally makes them uncloseable forever.
  jobService.getById = async () => ({ ...JOB, otp: null });
  const res = await checkout({});
  assert.equal(res.status, 200, 'no PIN on the row → no PIN to demand');
  assert.equal(captured.status, 3);
  jobService.getById = async () => ({ ...JOB });
});

test('an empty-string PIN on the row counts as no PIN, not as a PIN of ""', async () => {
  jobService.getById = async () => ({ ...JOB, otp: '   ' });
  const res = await checkout({});
  assert.equal(res.status, 200);
  jobService.getById = async () => ({ ...JOB });
});

// ─── CRM safety: the gate must never migrate into the shared service ─

test('the closing-PIN gate lives in the mobile route ONLY', async () => {
  // job.setStatus() is what PATCH /api/admin/jobs/:id/status calls, i.e. how ops
  // completes a job from the CRM. If this gate ever moves into that shared
  // service, a CRM completion starts failing for want of a customer PIN the
  // operator does not have — the exact escape hatch this design depends on.
  const service = fs.readFileSync(path.join(__dirname, '..', 'services', 'job.service.js'), 'utf8');
  assert.ok(!service.includes('INVALID_CHECKOUT_PIN'),
    'the closing-PIN check must not be in job.service.js — it would block CRM completion too');
  const adminJobs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin', 'jobs.js'), 'utf8');
  assert.ok(!adminJobs.includes('INVALID_CHECKOUT_PIN'),
    'ops must be able to close a job the technician could not');
});

// ─── The guess cap on the closing PIN (2026-09-11) ───────────────────
/*
 * 5 attempts per JOB per 30 minutes (routes/mobile/index.js
 * checkoutPinAttempts). Without it the assigned technician could try every
 * four-digit PIN and close the job without the customer. Each test uses its
 * own job id: the window is per job and lives for the whole process, and the
 * tests above already spent attempts on job 42.
 */
async function checkoutJob(id, body) {
  jobService.getById = async (jobId) => ({ ...JOB, job_id: Number(jobId) });
  try {
    const r = await fetch(`${baseUrl}/mobile/jobs/${id}/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  } finally {
    jobService.getById = async () => ({ ...JOB });
  }
}

test('each wrong PIN says how many attempts are left; the 5th locks, and then even the RIGHT PIN is refused', async () => {
  for (let left = 4; left >= 1; left--) {
    const r = await checkoutJob(101, { otp: '0000' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'INVALID_CHECKOUT_PIN', 'the app shows this code as a PIN-field error');
    assert.equal(r.body.error.reason, 'PIN_MISMATCH');
    assert.equal(r.body.error.attemptsRemaining, left);
    assert.match(r.body.error.message, new RegExp(`${left} attempts? left`));
  }
  const fifth = await checkoutJob(101, { otp: '0000' });
  assert.equal(fifth.body.error.reason, 'PIN_ATTEMPTS_EXCEEDED');
  assert.equal(fifth.body.error.retryAfterMinutes, 30);
  assert.match(fifth.body.error.message, /Try again in 30 minutes/);
  const right = await checkoutJob(101, { otp: '1234' });
  assert.equal(right.status, 409, 'a locked job refuses without comparing');
  assert.equal(right.body.error.reason, 'PIN_ATTEMPTS_EXCEEDED');
  assert.equal(captured, null, 'no status write while locked');
});

test('the lock lifts by itself after 30 minutes', async () => {
  for (let i = 0; i < 5; i++) await checkoutJob(102, { otp: '0000' });
  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 60_000;
  try {
    const r = await checkoutJob(102, { otp: '1234' });
    assert.equal(r.status, 200, 'the window has passed');
    assert.equal(captured.status, 3);
  } finally { Date.now = realNow; }
});

test('a missing PIN is not a guess — it never counts toward the lock', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await checkoutJob(103, {});
    assert.equal(r.body.error.reason, 'PIN_MISSING');
  }
  const r = await checkoutJob(103, { otp: '1234' });
  assert.equal(r.status, 200);
});

test('the right PIN clears the count', async () => {
  for (let i = 0; i < 4; i++) await checkoutJob(104, { otp: '0000' });
  assert.equal((await checkoutJob(104, { otp: '1234' })).status, 200);
  const next = await checkoutJob(104, { otp: '0000' });
  assert.equal(next.body.error.attemptsRemaining, 4, 'a fresh window after a success');
});

test('twenty parallel wrong PINs are compared at most five times', async () => {
  // The claim and the compare run with no await between them, so however the
  // requests interleave on getById's await, only five ever reach the compare.
  const rs = await Promise.all(Array.from({ length: 20 }, () => checkoutJobParallel(105, { otp: '0000' })));
  const reasons = rs.map((r) => r.body.error.reason);
  assert.equal(reasons.filter((x) => x === 'PIN_MISMATCH').length, 4, reasons.join(','));
  assert.equal(reasons.filter((x) => x === 'PIN_ATTEMPTS_EXCEEDED').length, 16);
  assert.equal((await checkoutJobParallel(105, { otp: '1234' })).body.error.reason, 'PIN_ATTEMPTS_EXCEEDED');
});

// Parallel variant: getById stays swapped for the whole burst (checkoutJob
// resets it per call, which would race).
async function checkoutJobParallel(id, body) {
  jobService.getById = async (jobId) => {
    await new Promise((r) => setImmediate(r));   // a real await, so requests interleave
    return { ...JOB, job_id: Number(jobId) };
  };
  const r = await fetch(`${baseUrl}/mobile/jobs/${id}/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

// ─── Nowhere else to read or test the PIN (2026-09-11) ───────────────
/*
 * A guess cap on the close is only a cap if the PIN cannot be READ, and cannot
 * be TESTED somewhere uncapped. Found by a sweep of all 38 technician job
 * routes: GET /jobs/:id sent the raw `otp` column (to the assigned tech, to
 * anyone holding an open offer, to delegates), GET /jobs/search sent it as
 * `checkinPin`, and a PIN volunteered at check-in came back as `pinMatched`
 * with no limit — an oracle for the close.
 */
async function postJob(id, action, body) {
  jobService.getById = async (jobId) => ({ ...JOB, job_id: Number(jobId) });
  try {
    const r = await fetch(`${baseUrl}/mobile/jobs/${id}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  } finally {
    jobService.getById = async () => ({ ...JOB });
  }
}

test('the job detail never carries the PIN', async () => {
  const r = await fetch(`${baseUrl}/mobile/jobs/42`);
  const body = await r.json();
  assert.equal(r.status, 200, 'positive control: the job was served');
  assert.equal(body.data.job_id, 42);
  assert.ok(!('otp' in body.data), 'tbl_job.otp must not reach the device');
  assert.ok(!JSON.stringify(body).includes(JOB.otp), 'the PIN value appears nowhere in the payload');
});

test('a PIN volunteered at check-in spends the SAME budget as the close — check-in is no oracle', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await postJob(106, 'checkin', { otp: '0000' });
    assert.equal(r.status, 200, 'the PIN never blocks check-in');
    assert.equal(r.body.data.pinMatched, false);
  }
  const right = await postJob(106, 'checkin', { otp: '1234' });
  assert.equal(right.status, 200, 'still checks in');
  assert.equal(right.body.data.pinMatched, null, 'locked: "not checked", never a verdict');
  const close = await checkoutJob(106, { otp: '1234' });
  assert.equal(close.body.error.reason, 'PIN_ATTEMPTS_EXCEEDED', 'the guesses at check-in locked the close too');
});

test('a right PIN at check-in says so and clears the budget', async () => {
  for (let i = 0; i < 3; i++) await postJob(107, 'checkin', { otp: '0000' });
  assert.equal((await postJob(107, 'checkin', { otp: '1234' })).body.data.pinMatched, true);
  assert.equal((await checkoutJob(107, { otp: '0000' })).body.error.attemptsRemaining, 4);
});
