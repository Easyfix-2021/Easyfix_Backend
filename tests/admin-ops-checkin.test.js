/*
 * ROUTE-LEVEL tests for the OPS CHECK-IN — POST /api/admin/jobs/:id/checkin.
 *
 * WHAT IS ACTUALLY AT RISK HERE
 *   The endpoint exists because PATCH /:id/status {status:2} moves the status
 *   code and writes NONE of the check-in columns, so a job started from the CRM
 *   had no TAT anchor and no visit owner. Everything worth pinning is therefore
 *   about WHICH COLUMNS GET WHICH VALUES:
 *     - fk_checkin_by must receive the JOB'S TECHNICIAN (an efr_id), never the
 *       operator's tbl_user.user_id — the legacy CRM wrote the operator into
 *       that column and that is how it came to mean two different things;
 *     - checkin_date_time must be written COALESCE (write-once), so an ops
 *       check-in after a technician's cannot move a breached anchor forward;
 *     - no gps/address/pincode may be touched — the operator is not on site;
 *     - the operator must still be identifiable, which happens through the
 *       tbl_job_logs actor + a tbl_job_comment comment_on=2 carrying the reason.
 *
 * FAITHFULNESS
 *   The REAL routes/admin/jobs.js router is mounted, so the guard chain under
 *   test is the shipped one. Only what routes/admin/index.js would attach
 *   (req.user / req.userRole / req.scope / req.allowedStages) is injected.
 *   `req.user.permissions` is pre-seeded so requireAction reuses it instead of
 *   reading tbl_user — the permission LOOKUP is not what this file tests, the
 *   fact that the guard is mounted is.
 *
 * NO DB, NO PROD WRITES: the fake-pool seam answers the reads and RECORDS the
 *   writes (no stopOn — the assertions are about statements two layers apart:
 *   the UPDATE, the tbl_job_logs INSERT and the tbl_job_comment INSERT).
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// The transition fires the TechStart webhook + notification tail. Both are
// fail-soft and both are fed by this fake pool, but the kill switch is set
// anyway so a test run can never reach a real outbound endpoint.
process.env.WEBHOOK_OUTBOUND_ENABLED = 'false';

const OPS_USER_ID = 77;      // the CRM operator pressing the button
const TECH_EFR_ID = 4242;    // tbl_job.fk_easyfixter_id — deliberately NOT 77
/*
 * The technician's tbl_user id, and the value fk_checkin_by must receive.
 * MEASURED on the live schema 2026-09-08: of 348,619 populated rows, 223,012
 * equal tbl_easyfixer.user_id and 29 equal efr_id — the column is a
 * tbl_user.user_id. All three ids here are distinct so a test cannot pass by
 * confusing them.
 */
const TECH_USER_ID = 9001;

const scenario = {
  jobStatus: 1,                 // SCHEDULED — the only status check-in accepts
  efrId: TECH_EFR_ID,
  actions: ['isJobStatusChange'],
  allowedStages: null,          // unrestricted unless a test says otherwise
};

// Relative, never hardcoded: sibling routes on this router refuse a past
// appointment, so a fixed date would go red on its own one day.
function istPlusDays(days) {
  const ist = new Date(Date.now() + (5 * 60 + 30) * 60 * 1000 + days * 86_400_000);
  return ist.toISOString().slice(0, 16).replace('T', ' ');
}

// The row scopedJob + getJobMeta both read. No customer_mob_no: the TechStart
// notification only sends when one is present, and this file is not a test of
// the SMS path.
function jobRow() {
  return {
    job_id: 42,
    job_status: scenario.jobStatus,
    fk_easyfixter_id: scenario.efrId,
    fk_client_id: 5,
    city_id: 11,
    vertical_id: 3,
    fk_customer_id: 3,
    requested_date_time: `${istPlusDays(1)}:00`,
    booking_cut_off_time_slot: null,
    otp: null,
    remarks: null,
    custom_property: null,
  };
}

const fake = installFakePool([
  // Column-presence probes (hasOtpColumn / hasJobStageColumn / …) → "present".
  [/INFORMATION_SCHEMA/i, () => [{ n: 3 }]],
  // The technician's CRM user id — what fk_checkin_by actually holds.
  [/SELECT user_id FROM tbl_easyfixer WHERE efr_id/i, () => [{ user_id: TECH_USER_ID }]],
  // scopedJob → job.getById → the aliased single-row detail read.
  [/WHERE\s+j\.job_id\s*=\s*\?\s*LIMIT\s+1/i, () => [jobRow()]],
  // setStatus's own getJobMeta probe (unaliased `FROM tbl_job`).
  [/FROM\s+tbl_job\s+WHERE\s+job_id\s*=\s*\?/i, () => [jobRow()]],
  // The ≥1-service gate the sibling status route runs on a BOOKED transition.
  [/COUNT\(\*\)\s+AS\s+n\s+FROM\s+tbl_job_services/i, () => [{ n: 1 }]],
  // addComment's read-back of the row it just inserted. Without it the fake
  // returns no row, shapeRow(undefined) throws, and the route's fail-open
  // catch logs a comment failure — a harness artifact that reads exactly like
  // the defect these tests are here to detect.
  [/FROM\s+tbl_job_comment\s+c\b[\s\S]*comment_id\s*=\s*\?/i, () => [{ id: 1, job_id: 42, comment_on: 2 }]],
]);

const express = require('express');
const jobsRouter = require('../routes/admin/jobs');

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      user_id: OPS_USER_ID,
      user_name: 'Ops Tester',
      // Pre-seeded so requireAction reuses it (see its lazy-load comment).
      permissions: { menuIds: [], actionPermissions: scenario.actions },
    };
    req.userRole = { role_name: 'Executive Supply' }; // not a scope-bypass role
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
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(500).json({ error: String(err && err.message) }); });

  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  // Let the transition's fire-and-forget setImmediate tail run against the FAKE
  // pool; restoring first would point it at the real one.
  await new Promise((resolve) => setImmediate(resolve));
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  scenario.jobStatus = 1;
  scenario.efrId = TECH_EFR_ID;
  scenario.actions = ['isJobStatusChange'];
  scenario.allowedStages = null;
});

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function patch(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const jobUpdate     = () => fake.calls.find((c) => /UPDATE\s+tbl_job\s+SET/i.test(c.sql)) || null;
const logInsert     = () => fake.calls.find((c) => /INSERT\s+INTO\s+tbl_job_logs/i.test(c.sql)) || null;
const commentInsert = () => fake.calls.find((c) => /INSERT\s+INTO\s+tbl_job_comment/i.test(c.sql)) || null;

/*
 * The value bound to one column of a SET clause. Params bind in statement
 * order, so the value for `col` is the params entry at the count of '?' that
 * appear before that column's assignment. Counting placeholders rather than
 * splitting on commas is deliberate: `COALESCE(checkin_date_time, ?)` contains
 * a comma and a naive split would mis-index every column after it.
 */
function boundValue(call, col) {
  const at = call.sql.search(new RegExp(`\\b${col}\\s*=`));
  if (at < 0) return undefined;
  const before = (call.sql.slice(0, at).match(/\?/g) || []).length;
  return call.params[before];
}

// tbl_job_logs column order — services/job-log.service.js COLUMNS.
const LOG_CHANGED_BY = 6;
const LOG_COMMENTS   = 7;

// ── 1. The columns the status endpoint never writes ──────────────────

test('a check-in writes job_status, last_update_time, fk_checkin_by and checkin_date_time', async () => {
  const res = await post('/jobs/42/checkin', { reason: 'Tech phone dead, confirmed arrival by call' });
  assert.equal(res.status, 200);
  assert.equal(res.body?.success, true);

  const upd = jobUpdate();
  assert.ok(upd, 'an UPDATE tbl_job should have been issued');
  for (const col of ['job_status', 'last_update_time', 'fk_checkin_by', 'checkin_date_time']) {
    assert.match(upd.sql, new RegExp(`\\b${col}\\s*=`), `UPDATE must set ${col}`);
  }
  assert.equal(boundValue(upd, 'job_status'), 2, 'status must land on IN_PROGRESS');
  assert.ok(boundValue(upd, 'last_update_time') instanceof Date);
});

/*
 * NEGATIVE CONTROL for the test above. Same job, same fake, same matchers —
 * but through PATCH /:id/status, which is the endpoint that does NOT write the
 * check-in columns. If this one ever started passing "columns present", the
 * assertions above would be matching something other than what they claim to.
 */
test('control: PATCH /:id/status {status:2} writes NEITHER check-in column', async () => {
  const res = await patch('/jobs/42/status', { status: 2 });
  assert.equal(res.status, 200);
  const upd = jobUpdate();
  assert.ok(upd);
  assert.doesNotMatch(upd.sql, /\bfk_checkin_by\s*=/, 'the status endpoint must stay as it is');
  assert.doesNotMatch(upd.sql, /\bcheckin_date_time\s*=/);
});

// ── 2. WHOSE id lands in fk_checkin_by ───────────────────────────────

test('fk_checkin_by receives the TECHNICIAN\'s CRM user id — not the efr_id, not the operator', async () => {
  /*
   * THREE distinct ids, and only one is right. The column is a
   * tbl_user.user_id (measured: 223,012 of 348,619 rows match
   * tbl_easyfixer.user_id, 29 match efr_id — and those 29 are noise, because
   * the id ranges overlap and membership is not identity).
   *
   * Writing the efr_id would be the first row in a second namespace in a
   * column with 348k consistent rows, and would resolve to a DIFFERENT PERSON
   * wherever it is joined — including the legacy CRM, which renders the actor
   * through LEFT JOIN tbl_user ON user_id = fk_checkin_by. Nothing has forked
   * yet: every populated row predates cutover and this backend has written the
   * column zero times.
   */
  await post('/jobs/42/checkin', { reason: 'App not installed on the new handset' });
  const upd = jobUpdate();
  assert.equal(boundValue(upd, 'fk_checkin_by'), TECH_USER_ID);
  assert.notEqual(boundValue(upd, 'fk_checkin_by'), TECH_EFR_ID,
    'the efr_id is a different namespace — it would name someone else');
  assert.notEqual(boundValue(upd, 'fk_checkin_by'), OPS_USER_ID);
  assert.equal(upd.params.includes(OPS_USER_ID), false,
    'the operator id must not reach the tbl_job UPDATE at all');
});

// ── 3. The TAT anchor cannot be moved ────────────────────────────────

test('checkin_date_time is written WRITE-ONCE (COALESCE), so it can never move forward', async () => {
  await post('/jobs/42/checkin', { reason: 'Poor network at site' });
  const upd = jobUpdate();
  assert.match(upd.sql, /checkin_date_time\s*=\s*COALESCE\(\s*checkin_date_time\s*,\s*\?\s*\)/i);
  assert.doesNotMatch(upd.sql, /checkin_date_time\s*=\s*\?/, 'a bare assignment would overwrite the anchor');
});

test('a SECOND check-in on an already-started job is refused 409 and writes nothing', async () => {
  await post('/jobs/42/checkin', { reason: 'first' });
  fake.calls.length = 0;
  scenario.jobStatus = 2;             // the first check-in already moved it
  const res = await post('/jobs/42/checkin', { reason: 'second' });
  assert.equal(res.status, 409);
  assert.match(String(res.body?.error ?? ''), /scheduled/i);
  assert.equal(jobUpdate(), null, 'a refused check-in must not reach any write');
});

// ── 4. No location is invented for an operator who is not on site ────

test('no gps / address / pincode column is touched', async () => {
  await post('/jobs/42/checkin', { reason: 'Verified arrival over the phone' });
  const upd = jobUpdate();
  assert.doesNotMatch(upd.sql, /checkin_gps_location/);
  assert.doesNotMatch(upd.sql, /checkin_address/);
  assert.doesNotMatch(upd.sql, /checkin_pincode/);
});

// ── 5. "Ops did this" stays recoverable ──────────────────────────────

test('the tbl_job_logs row carries the OPERATOR, not the technician', async () => {
  await post('/jobs/42/checkin', { reason: 'Handset lost' });
  const log = logInsert();
  assert.ok(log, 'the status change must be logged');
  assert.equal(log.params[LOG_CHANGED_BY], OPS_USER_ID);
  assert.equal(log.params[LOG_COMMENTS], 'Changed by New CRM',
    'a technician check-in would read "Changed by New CRM App"');
});

test('a comment_on = 2 (check_in) row records the reason against the operator', async () => {
  const reason = 'Technician on site, app crashing on start';
  await post('/jobs/42/checkin', { reason });
  const c = commentInsert();
  assert.ok(c, 'the reason must be persisted as a job comment');
  // INSERT column order: job_id, comments, comment_on, appointment_on,
  // commented_by, enum_reason_id, efr_id[, job_stage].
  assert.equal(c.params[0], 42);
  assert.equal(c.params[1], reason);
  assert.equal(c.params[2], 2, 'comment_on must be the check_in code');
  assert.equal(c.params[4], OPS_USER_ID, 'commented_by is a tbl_user.user_id');
});

// ── 6. Refusals ──────────────────────────────────────────────────────

test('409 when no technician is assigned — and nothing is written', async () => {
  scenario.efrId = null;
  const res = await post('/jobs/42/checkin', { reason: 'anything' });
  assert.equal(res.status, 409);
  assert.match(String(res.body?.error ?? ''), /technician/i);
  assert.equal(jobUpdate(), null);
});

test('409 when the job is not SCHEDULED', async () => {
  scenario.jobStatus = 0;             // BOOKED, not yet scheduled
  const res = await post('/jobs/42/checkin', { reason: 'anything' });
  assert.equal(res.status, 409);
  assert.equal(jobUpdate(), null);
});

test('400 when the reason is missing, and when it is only whitespace', async () => {
  const missing = await post('/jobs/42/checkin', {});
  assert.equal(missing.status, 400);
  const blank = await post('/jobs/42/checkin', { reason: '   ' });
  assert.equal(blank.status, 400, 'a trimmed-empty reason is not a reason');
  assert.equal(jobUpdate(), null);
});

test('403 without the isJobStatusChange grant', async () => {
  scenario.actions = [];
  const res = await post('/jobs/42/checkin', { reason: 'anything' });
  assert.equal(res.status, 403);
  assert.match(String(res.body?.error ?? ''), /isJobStatusChange/);
  assert.equal(jobUpdate(), null);
});

// ── 7. Job Stage Access ──────────────────────────────────────────────

/*
 * The guard reads a FIXED target of 2 for this route (kind 'checkin'). Reusing
 * kind 'status' here would read Number(undefined) → NaN, which maps to no stage
 * and would 403 exactly the grant the feature is for. These two pin that.
 */
test('a pending-start grant may check a job in (2 is one of its declared targets)', async () => {
  scenario.allowedStages = { mode: 'list', stages: ['pending-start'] };
  const res = await post('/jobs/42/checkin', { reason: 'Tech at site, phone dead' });
  assert.equal(res.status, 200);
  assert.ok(jobUpdate());
});

test('a grant that does not own pending-start is 403', async () => {
  scenario.allowedStages = { mode: 'list', stages: ['pending-close'] };
  const res = await post('/jobs/42/checkin', { reason: 'anything' });
  assert.equal(res.status, 403);
  assert.equal(jobUpdate(), null);
});
