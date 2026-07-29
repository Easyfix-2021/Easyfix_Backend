/*
 * ROUTE-LEVEL tests for Job Stage Access — the enforcement half.
 *
 * tests/job-stages.test.js pins the pure rules (lib/job-stages.js). This file
 * pins the WIRING, which is where the real risk lives:
 *
 *   1. TRANSITIONS — middleware/require-stage sits AFTER `scopedJob` (so it has
 *      the SOURCE status) and BEFORE the handler (so an out-of-stage move 403s
 *      instead of falling through to handler-level validation). A correct
 *      transitionAllowed() proves nothing if the guard is mounted in the wrong
 *      order, on the wrong routes, or reads the wrong target.
 *   2. LIST ROW-FILTERING — `req.allowedStages` actually reaches job.list() and
 *      becomes a `j.job_status IN (…)` predicate (or `1=0` for a NO-ACCESS
 *      grant), intersected with any tab/status filter.
 *
 * Faithfulness: we mount the REAL routes/admin/jobs.js router, so the middleware
 * chain under test is the shipped one. Only what routes/admin/index.js would
 * have attached (req.user / req.userRole / req.scope / req.allowedStages) is
 * injected by a stand-in middleware — that mount is not what we're testing.
 *
 * No DB: the fake-pool seam answers the reads and STOPS at the first write, so
 * nothing is inserted anywhere and the fire-and-forget notification/webhook tail
 * never runs. A request that reaches a write therefore surfaces as HTTP 599 via
 * the terminal error handler below — 599 means "the guard let it through".
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// Mutable per-test scenario the fake routes + the injector middleware read.
const scenario = {
  jobStatus: 9,            // SOURCE status of job 42 (drives stageOfStatus)
  allowedStages: null,     // req.allowedStages for the request under test
  serviceCount: 0,         // tbl_job_services rows (the ≥1-service BOOKED gate)
};

// The job row `scopedJob` loads. city/client/vertical are all in-scope below.
function jobRow() {
  return {
    job_id: 42,
    job_status: scenario.jobStatus,
    fk_client_id: 5,
    city_id: 11,
    vertical_id: 3,
    fk_easyfixter_id: null,
    fk_customer_id: 3,
    requested_date_time: '2026-07-30 10:00:00',
    booking_cut_off_time_slot: null,
    otp: null,
    remarks: null,
    custom_property: null,
  };
}

const fake = installFakePool(
  [
    // Column-presence probes (hasClientVerticalIdColumn / hasAddressInstruction…)
    [/INFORMATION_SCHEMA/i, () => [{ n: 3 }]],
    // scopedJob → job.getById → getByIdCore's single-row detail read.
    [/WHERE\s+j\.job_id\s*=\s*\?\s*LIMIT\s+1/i, () => [jobRow()]],
    // setStatus/reschedule's own getJobMeta probe (unaliased `FROM tbl_job`).
    // Without it the service 404s before the write and we'd never see whether
    // the guard let the request through.
    [/FROM\s+tbl_job\s+WHERE\s+job_id\s*=\s*\?/i, () => [jobRow()]],
    // The ≥1-service gate on the BOOKED (status 0) transition. Kept SEPARATE
    // from the list COUNT below by its `AS n` alias.
    [/COUNT\(\*\)\s+AS\s+n\s+FROM\s+tbl_job_services/i, () => [{ n: scenario.serviceCount }]],
    // list()'s COUNT half — must return a row or the `[[{ total }]]` destructure
    // in job.service throws before we can inspect anything.
    [/SELECT\s+COUNT\(\*\)\s+AS\s+total/i, () => [{ total: 0 }]],
  ],
  // Stop at the FIRST write of any kind: reaching one is exactly the signal
  // "this request got past the stage guard".
  { stopOn: /^\s*(UPDATE|INSERT|DELETE)\s/i },
);

const express = require('express');
const jobsRouter = require('../routes/admin/jobs');

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  /*
   * Stand-in for routes/admin/index.js. Full geo scope + a NON-bypass role, so
   * scopedJob always passes and the ONLY thing that can 403 is the stage guard.
   */
  app.use((req, _res, next) => {
    req.user = { user_id: 77, user_name: 'Stage Tester' };
    req.userRole = { role_name: 'Executive Supply' }; // not in SCOPE_BYPASS_ROLES
    req.scope = {
      clients:   { mode: 'all', ids: [], placeholders: '' },
      cities:    { mode: 'all', ids: [], placeholders: '' },
      states:    { mode: 'all', ids: [], placeholders: '' },
      verticals: { mode: 'all', ids: [], placeholders: '' },
    };
    req.allowedStages = scenario.allowedStages;
    next();
  });
  app.use('/jobs', jobsRouter);
  // Terminal handler: 599 = "hit the fake-pool write sentinel", i.e. the request
  // reached the service layer. Anything else is a genuine 500.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err && err.__stop ? 599 : 500).json({ stopped: !!(err && err.__stop) });
  });

  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  scenario.jobStatus = 9;
  scenario.allowedStages = null;
  scenario.serviceCount = 0;
});

// ── helpers ──────────────────────────────────────────────────────────
async function patch(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const wroteAnything = () => fake.calls.some((c) => /^\s*(UPDATE|INSERT|DELETE)\s/i.test(c.sql));

// Every captured SELECT whose WHERE the stage filter would land in.
const sqlWith = (re) => fake.calls.filter((c) => re.test(c.sql));

const BOOKING   = { mode: 'list', stages: ['unconfirmed'] };       // sees 9 → 0, 6
const SCHEDULER = { mode: 'list', stages: ['pending-scheduling'] };// sees 0 → 1, 6, 9
const CLOSER    = { mode: 'list', stages: ['pending-close'] };     // sees 2/20 → 3, 5, 21, 6
const NO_ACCESS = { mode: 'list', stages: [] };                    // sees nothing
const ALL       = { mode: 'all',  stages: [] };

// ── 1. TRANSITIONS — PATCH /:id/status ───────────────────────────────

test('403 when the SOURCE status is outside the caller\'s stages', async () => {
  scenario.jobStatus = 1;              // pending-start — not the Booking user's
  scenario.allowedStages = BOOKING;
  const res = await patch('/jobs/42/status', { status: 2 });
  assert.equal(res.status, 403);
  assert.equal(res.body?.success, false);
  assert.equal(wroteAnything(), false, 'a 403 must not reach any write');
});

test('403 when the caller owns the source stage but the TARGET is not one it declares', async () => {
  scenario.jobStatus = 9;              // unconfirmed — owned
  scenario.allowedStages = BOOKING;    // targets are [0, 6] only
  const res = await patch('/jobs/42/status', { status: 3 }); // complete
  assert.equal(res.status, 403);
  assert.equal(wroteAnything(), false);
});

test('the canonical Booking grant passes the guard on 9 → 6 and reaches the write', async () => {
  scenario.jobStatus = 9;
  scenario.allowedStages = BOOKING;
  const res = await patch('/jobs/42/status', { status: 6, reasonId: 12 });
  assert.notEqual(res.status, 403, 'cancel-from-unconfirmed is a declared target');
  assert.equal(res.status, 599, 'should reach the service-layer UPDATE');
  assert.equal(wroteAnything(), true);
});

/*
 * Guard ORDER. The ≥1-service gate on the BOOKED transition lives INSIDE the
 * handler; the stage guard must run first, so an unauthorized caller gets 403
 * (permission) rather than 400 (validation) — and never learns whether the job
 * has services. The pair below is the discriminating test: same request, same
 * zero-service job, different grant.
 */
test('stage guard runs BEFORE the ≥1-service gate — unauthorized is 403, not 400', async () => {
  scenario.jobStatus = 9;
  scenario.serviceCount = 0;
  scenario.allowedStages = CLOSER;     // does not own `unconfirmed`
  const res = await patch('/jobs/42/status', { status: 0 });
  assert.equal(res.status, 403);
  // NB: scopedJob's getById legitimately reads tbl_job_services rows, so assert
  // on the handler's COUNT probe specifically — that is the gate we're ordering
  // against.
  assert.equal(
    fake.calls.some((c) => /COUNT\(\*\)\s+AS\s+n\s+FROM\s+tbl_job_services/i.test(c.sql)), false,
    'the service-count gate must not run for a caller the guard rejects',
  );
});

test('…and an AUTHORIZED caller falls through to that 400', async () => {
  scenario.jobStatus = 9;
  scenario.serviceCount = 0;
  scenario.allowedStages = BOOKING;    // 9 → 0 IS declared
  const res = await patch('/jobs/42/status', { status: 0 });
  assert.equal(res.status, 400, 'past the guard, stopped by the zero-services gate');
  assert.match(String(res.body?.error ?? ''), /BOOKED/i);
});

// ── 2. TRANSITIONS — assign / offer / reschedule ─────────────────────

test('assign + offer target SCHEDULED(1): 403 from a stage that does not declare it', async () => {
  scenario.jobStatus = 9;
  scenario.allowedStages = BOOKING;    // unconfirmed targets [0,6] — no 1
  const a = await patch('/jobs/42/assign', { easyfixerId: 7 });
  assert.equal(a.status, 403);
  const o = await post('/jobs/42/offer', { easyfixerIds: [7, 8] });
  assert.equal(o.status, 403);
  assert.equal(wroteAnything(), false);
});

test('assign + offer pass for a scheduler holding the source stage', async () => {
  scenario.jobStatus = 0;              // pending-scheduling — owned, targets [1,6,9]
  scenario.allowedStages = SCHEDULER;
  const a = await patch('/jobs/42/assign', { easyfixerId: 7 });
  assert.notEqual(a.status, 403);
  const o = await post('/jobs/42/offer', { easyfixerIds: [7, 8] });
  assert.notEqual(o.status, 403);
});

/*
 * Reschedule changes no status, so the guard uses stageVisible (the CURRENT
 * stage must be one the caller holds) rather than transitionAllowed.
 */
test('reschedule is gated on the CURRENT stage being visible to the caller', async () => {
  const body = {
    requestedDateTime: '2026-08-01T10:00',
    reasonId: 12,
    remarks: 'slot moved',
  };
  scenario.jobStatus = 9;              // unconfirmed — NOT the closer's stage
  scenario.allowedStages = CLOSER;
  assert.equal((await patch('/jobs/42/reschedule', body)).status, 403);
  assert.equal(wroteAnything(), false);

  scenario.jobStatus = 2;              // pending-close — owned
  assert.notEqual((await patch('/jobs/42/reschedule', body)).status, 403);
});

// ── 3. The two grants that are NOT stage lists ───────────────────────

test('an explicit NO-ACCESS grant is refused every transition', async () => {
  scenario.allowedStages = NO_ACCESS;
  for (const src of [9, 0, 1, 2]) {
    scenario.jobStatus = src;
    const res = await patch('/jobs/42/status', { status: 6 });
    assert.equal(res.status, 403, `source ${src} must be refused`);
  }
  assert.equal(wroteAnything(), false);
});

test('mode all is a no-op — the guard never fires', async () => {
  scenario.jobStatus = 1;
  scenario.allowedStages = ALL;
  assert.notEqual((await patch('/jobs/42/status', { status: 2 })).status, 403);
  // Absent (a caller that predates the feature) behaves identically.
  scenario.allowedStages = undefined;
  assert.notEqual((await patch('/jobs/42/status', { status: 2 })).status, 403);
});

// ── 4. LIST ROW-FILTERING — GET /jobs ────────────────────────────────

async function listJobs(qs = '') {
  const res = await fetch(`${baseUrl}/jobs${qs}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('list: a stage grant becomes a j.job_status IN (…) predicate', async () => {
  scenario.allowedStages = BOOKING;    // visible = [9]
  const res = await listJobs('?limit=10&offset=0');
  assert.equal(res.status, 200);
  const filtered = sqlWith(/j\.job_status IN \(/);
  assert.ok(filtered.length > 0, 'the stage filter must reach the SQL');
  assert.ok(
    filtered.every((c) => (c.params || []).includes(9)),
    'the bound param must be the stage\'s visible status (9)',
  );
});

test('list: the grant INTERSECTS the tab/status filter rather than replacing it', async () => {
  scenario.allowedStages = BOOKING;                 // visible = [9]
  const res = await listJobs('?limit=10&offset=0&status=1'); // a tab they don't own
  assert.equal(res.status, 200);
  // Single `status` renders as `= ?`, the stage union as `IN (…)`. Both must
  // survive — AND-ed, so the caller gets the (empty) intersection rather than
  // the tab they asked for.
  const [first] = sqlWith(/j\.job_status IN \(/);
  assert.ok(first, 'the stage clause must be present');
  assert.match(first.sql, /j\.job_status = \?/, 'the tab filter must survive alongside it');
  assert.ok(first.params.includes(9) && first.params.includes(1));

  // Multi-status tabs (e.g. Pending to Close = 2 OR 20) render as a second
  // IN (…) — same intersection, different shape.
  fake.calls.length = 0;
  await listJobs('?limit=10&offset=0&statuses=2,20');
  const [multi] = sqlWith(/j\.job_status IN \(/);
  assert.equal((multi.sql.match(/j\.job_status IN \(/g) || []).length, 2);
});

test('list: an explicit NO-ACCESS grant degenerates to 1=0 (no rows, ever)', async () => {
  scenario.allowedStages = NO_ACCESS;
  const res = await listJobs('?limit=10&offset=0');
  assert.equal(res.status, 200);
  assert.ok(sqlWith(/1=0/).length > 0, 'empty stage union must short-circuit the WHERE');
  assert.equal(sqlWith(/j\.job_status IN \(/).length, 0);
});

test('list: mode all adds no stage predicate at all', async () => {
  scenario.allowedStages = ALL;
  const res = await listJobs('?limit=10&offset=0');
  assert.equal(res.status, 200);
  assert.equal(
    sqlWith(/j\.job_status IN \(/).length, 0,
    'unrestricted callers must not be narrowed',
  );
});
