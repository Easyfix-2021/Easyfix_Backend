/*
 * GET /api/admin/jobs/:id/header — the Schedule & Assign console header with
 * NONE of /candidates' ranking work.
 *
 * WHAT IS ACTUALLY AT RISK
 *   The console draws a job's header on every open. Two endpoints can now draw
 *   it, and the failure is not a crash — it is the console rendering a subtly
 *   different job depending on which one answered. So the central property
 *   pinned here is EQUALITY: for one job, every key the ranked header carries
 *   has the same value on this one.
 *
 *   Beyond that:
 *   - the LIST's seven app-request fields ship under the LIST's names, with the
 *     LIST's values (0/1 flags, not a bit(1) Buffer that reads truthy), so the
 *     CRM's appRequestOf(job) works on this object unchanged;
 *   - the assigned technician ships as efr_id / efr_name / efr_mobile, all null
 *     while unassigned, and efr_mobile is MASKED in transit through the real
 *     mask-mobile middleware, as the offers list's `mobile` is;
 *   - it does no ranking work and, crucially, no WRITE: /candidates lazily
 *     expires stale offers, and a GET drawn on every console open must not.
 *
 * NO DB: a fake pool that answers every read with an empty result. Runner:
 * `node --test` (see npm test).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

process.env.WEBHOOK_OUTBOUND_ENABLED = 'false';

const fake = installFakePool([
  [/SELECT 1 FROM tbl_job_offer LIMIT 1/i, [{ 1: 1 }]],
  [/FROM easyfix_properties/i, []],
  [/SHOW COLUMNS/i, []],
  [/service_catg_name FROM tbl_service_catg/i, [{ catg_name: 'Carpentry Services', type_name: 'Modular Packed Furniture' }]],
  [/AS project_manager_name/i, [{ project_manager_name: 'Asha Rao', zonal_manager_name: 'Vikram Shah' }]],
  [/AS first_scheduled_by_name/i, [{
    first_scheduled_by_name: 'Meera Nair', checkin_by_name: null,
    accepted_date_time: '2026-09-16 10:15:00', accepted_efr_name: 'Imran Qureshi',
  }]],
  [/FROM tbl_vertical_mapping vm/i, [{ user_id: 55 }]],
]);

const jobSvc = require('../services/job.service');
const ranking = require('../services/candidate-ranking.service');

/*
 * The shape getById hands the route as req.scopedJob: j.* plus the detail
 * aliases. is_cancelled_by_app is a bit(1) Buffer, exactly as mysql2 returns it.
 */
function acceptedJob(overrides = {}) {
  return {
    job_id: 482657, job_status: 1, fk_client_id: 10, city_id: 2, fk_service_catg_id: 5, fk_service_type_id: 223,
    customer_name: 'Rahul', customer_mob_no: '9811122233', client_name: 'Urban Ladder',
    requested_date_time: '2026-09-17 10:00:00', time_slot: '09:00-12:00', booking_cut_off_time_slot: '9 AM - 12 PM',
    ticket_created_date_time: '2026-09-15 09:00:00', original_scheduling_date_time: '2026-09-15 11:00:00',
    checkin_date_time: null, first_scheduled_by: 91, fk_checkin_by: null,
    paid_by: null, collected_by: 1, product_quantity: 2, ageDays: 1, ageSecs: 90000,
    fk_easyfixter_id: 4242, easyfixer_name: 'Imran Qureshi', easyfixer_mobile: '9876543210',
    is_cancelled_by_app: Buffer.from([1]), is_rescheduled_by_app: Buffer.from([0]),
    cancel_date_time: '2026-09-16 09:30:00', reschedule_at_app: null, reschedule_date_time_app: null,
    app_cancel_reason_name: 'Customer not available', app_reschedule_reason_name: null,
    services: [{
      job_service_id: 652574, job_service_status: 1, service_name: 'FUR - Large / Installation',
      service_catg_name: 'Carpentry Services', service_type_name: 'Modular Packed Furniture',
      quantity: 2, total_charge: 1000, total_cost: 2000,
    }],
    ...overrides,
  };
}

/* ── Service level: the header IS the ranked header ──────────────────────── */

test('every key of the ranked header has the same value on the console header', async () => {
  /*
   * rankCandidatesForJob with an empty technician pool early-exits and returns
   * the header it built — the real ranked header, built the real way. The
   * console header for the same job must agree on every key it carries.
   */
  const ranked = await ranking.rankCandidatesForJob(482657, { preloadedJob: acceptedJob() });
  const consoleHeader = await ranking.consoleHeaderForJob(acceptedJob());
  assert.ok(ranked.job, 'the ranked path must have produced a header to compare against');
  for (const [key, value] of Object.entries(ranked.job)) {
    assert.deepEqual(consoleHeader[key], value, `"${key}" differs between /candidates and /header`);
  }
});

test('assigned_efr_id is the job\'s technician, as on the ranked header', async () => {
  const h = await ranking.consoleHeaderForJob(acceptedJob());
  assert.equal(h.assigned_efr_id, 4242);
  const unassigned = await ranking.consoleHeaderForJob(acceptedJob({ fk_easyfixter_id: null }));
  assert.equal(unassigned.assigned_efr_id, null);
});

test('the Part 1 service prices ride along — unit_price and line_total', async () => {
  const h = await ranking.consoleHeaderForJob(acceptedJob());
  assert.equal(h.services[0].unit_price, 1000);
  assert.equal(h.services[0].line_total, 2000);
});

/* ── The app-request fields: the LIST's names and the LIST's values ──────── */

const LIST_APP_REQUEST_FIELDS = [
  'job_status', 'is_cancelled_by_app', 'is_rescheduled_by_app',
  'cancel_date_time', 'reschedule_at_app', 'reschedule_date_time_app', 'app_request_reason',
];

test('the seven appRequestOf() fields exist under the names the LIST projects', () => {
  // Read the aliases straight out of LIST_COLUMNS so a rename there fails here.
  const projected = new Set();
  for (const m of jobSvc.LIST_COLUMNS.matchAll(/AS (\w+)/g)) projected.add(m[1]);
  for (const m of jobSvc.LIST_COLUMNS.matchAll(/\bj\.(\w+)\s*,/g)) projected.add(m[1]);
  projected.add('job_status'); // j.job_status — a plain column on the projection
  for (const f of LIST_APP_REQUEST_FIELDS) {
    assert.ok(projected.has(f), `LIST_COLUMNS no longer projects "${f}" — the header would drift from it`);
  }
  const fields = jobSvc.appRequestListFields(acceptedJob());
  assert.deepEqual(Object.keys(fields).sort(), [...LIST_APP_REQUEST_FIELDS].sort());
});

test('bit(1) flags ship as 0/1 — never a Buffer, which reads truthy for 0', async () => {
  const h = await ranking.consoleHeaderForJob(acceptedJob({
    is_cancelled_by_app: Buffer.from([0]), is_rescheduled_by_app: Buffer.from([0]),
  }));
  assert.equal(h.is_cancelled_by_app, 0);
  assert.equal(h.is_rescheduled_by_app, 0);
  assert.ok(!Buffer.isBuffer(h.is_cancelled_by_app));
});

test('app_request_reason follows the LIST\'s COALESCE: cancel first, then reschedule', () => {
  const cancelOnly = jobSvc.appRequestListFields(acceptedJob());
  assert.equal(cancelOnly.is_cancelled_by_app, 1);
  assert.equal(cancelOnly.app_request_reason, 'Customer not available');

  const reschedOnly = jobSvc.appRequestListFields(acceptedJob({
    is_cancelled_by_app: Buffer.from([0]), is_rescheduled_by_app: Buffer.from([1]),
    app_cancel_reason_name: 'stale cancel reason', app_reschedule_reason_name: 'Customer asked for Saturday',
    reschedule_at_app: '2026-09-16 11:00:00', reschedule_date_time_app: '2026-09-20 14:00',
  }));
  assert.equal(reschedOnly.app_request_reason, 'Customer asked for Saturday',
    'a cancel reason with no cancel flag must not leak through');

  // Cancel flag set but no cancel reason → falls through to the reschedule
  // reason, exactly as COALESCE(cancel-if-flag, reschedule-if-flag) does.
  const both = jobSvc.appRequestListFields(acceptedJob({
    is_rescheduled_by_app: Buffer.from([1]), app_cancel_reason_name: null,
    app_reschedule_reason_name: 'reschedule reason',
  }));
  assert.equal(both.app_request_reason, 'reschedule reason');

  const none = jobSvc.appRequestListFields(acceptedJob({
    is_cancelled_by_app: 0, is_rescheduled_by_app: 0,
  }));
  assert.equal(none.app_request_reason, null);
});

/*
 * A faithful port of the CRM's appRequestOf (src/lib/job-app-request.ts) — the
 * consumer this shape exists for. If the header's values make it answer
 * correctly here, the CRM can call it unchanged.
 */
function crmAppRequestOf(row) {
  const flagOn = (v) => v === true || v === 1 || v === '1';
  if (!row || Number(row.job_status) !== 1) return null;
  if (flagOn(row.is_cancelled_by_app)) return { kind: 'cancel', reason: row.app_request_reason, raisedAt: row.cancel_date_time };
  if (flagOn(row.is_rescheduled_by_app)) {
    return { kind: 'reschedule', reason: row.app_request_reason, raisedAt: row.reschedule_at_app, requestedFor: row.reschedule_date_time_app };
  }
  return null;
}

test('the CRM\'s appRequestOf() reads the header correctly, unchanged', async () => {
  const cancel = crmAppRequestOf(await ranking.consoleHeaderForJob(acceptedJob()));
  assert.deepEqual(cancel, { kind: 'cancel', reason: 'Customer not available', raisedAt: '2026-09-16 09:30:00' });

  const noAsk = crmAppRequestOf(await ranking.consoleHeaderForJob(acceptedJob({
    is_cancelled_by_app: Buffer.from([0]),
  })));
  assert.equal(noAsk, null, 'a zero Buffer must not read as a pending cancellation');
});

/* ── The assigned technician ─────────────────────────────────────────────── */

test('efr_id / efr_name / efr_mobile name the ASSIGNED technician', async () => {
  const h = await ranking.consoleHeaderForJob(acceptedJob());
  assert.equal(h.efr_id, 4242);
  assert.equal(h.efr_name, 'Imran Qureshi');
  assert.equal(h.efr_mobile, '9876543210', 'raw at the service; the middleware masks it in transit');
});

test('all three are null while the job is unassigned', async () => {
  const h = await ranking.consoleHeaderForJob(acceptedJob({
    fk_easyfixter_id: null, easyfixer_name: 'stale join', easyfixer_mobile: '9999999999',
  }));
  assert.equal(h.efr_id, null);
  assert.equal(h.efr_name, null, 'a name without an assignment must not be shown as the technician');
  assert.equal(h.efr_mobile, null);
});

test('the header does not mutate the row the route handed it', async () => {
  const row = acceptedJob({ time_slot: 'something the slot model would rewrite' });
  const before = row.time_slot;
  await ranking.consoleHeaderForJob(row);
  assert.equal(row.time_slot, before, 'req.scopedJob is shared with other middleware');
});

/* ── Route level ─────────────────────────────────────────────────────────── */

const scenario = { scoped: true, job: acceptedJob() };
const realGetById = jobSvc.getById;
let server;
let baseUrl;

before(async () => {
  jobSvc.getById = async () => (scenario.scoped ? scenario.job : null);
  const jobsRouter = require('../routes/admin/jobs');
  const maskMobile = require('../middleware/mask-mobile');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { user_id: 77, user_name: 'Sonam Patel', permissions: { menuIds: [], actionPermissions: [] } };
    req.userRole = { role_name: 'Admin' };
    const all = { mode: 'all', ids: [], placeholders: '' };
    req.scope = { clients: all, cities: all, states: all, verticals: all };
    req.allowedStages = null;
    next();
  });
  // The REAL masking middleware, mounted as routes/admin/index.js mounts it.
  app.use(maskMobile);
  app.use('/jobs', jobsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(500).json({ error: String(err && err.message) }); });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  jobSvc.getById = realGetById;
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  scenario.scoped = true;
  scenario.job = acceptedJob();
});

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('GET /jobs/:id/header returns { job } with the header and the extras', async () => {
  const r = await get('/jobs/482657/header');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.data), ['job']);
  const job = r.body.data.job;
  assert.equal(job.job_id, 482657);
  assert.equal(job.is_cancelled_by_app, 1);
  assert.equal(job.efr_id, 4242);
  assert.equal(job.services[0].line_total, 2000);
});

test('efr_mobile is MASKED in transit, as the offers list\'s mobile is', async () => {
  const r = await get('/jobs/482657/header');
  const { efr_mobile: efrMobile } = r.body.data.job;
  assert.notEqual(efrMobile, '9876543210', 'a raw technician number must never reach the browser');
  assert.match(efrMobile, /^9876•+$/, 'first four digits, then bullets — the estate convention');
});

test('an out-of-scope job 404s before any header work', async () => {
  scenario.scoped = false;
  const r = await get('/jobs/482657/header');
  assert.equal(r.status, 404);
  assert.equal(fake.calls.filter((c) => /AS project_manager_name|AS first_scheduled_by_name/.test(c.sql)).length, 0);
});

test('NO ranking work and NO write — this is a header read', async () => {
  await get('/jobs/482657/header');
  const writes = fake.calls.filter((c) => /^\s*(UPDATE|INSERT|DELETE)\b/i.test(c.sql));
  assert.deepEqual(writes.map((c) => c.sql.slice(0, 60)), [],
    'no write may happen — /candidates expires stale offers, this must not');
  const rankingReads = fake.calls.filter((c) => /FROM tbl_easyfixer\s+e\b|efr_attendance|tbl_easyfixer_attendance/i.test(c.sql));
  assert.equal(rankingReads.length, 0, 'no technician-pool query may run for a header');
});
