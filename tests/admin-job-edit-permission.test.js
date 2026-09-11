/*
 * Who may write a job through /api/admin/jobs (2026-09-11).
 *
 * PUT/PATCH /:id and the four service-line routes had no permission check at
 * all, so any admin-group user could write any field of any in-scope job. The
 * gate (routes/admin/jobs.js canPatchJob / servicesEditable) has one branch per
 * CRM caller, and each is pinned from both sides: the caller it must keep, and
 * the neighbouring write it must refuse. The riskiest line is the second group:
 * Confirm & Schedule users hold isJobConfirm but NOT isJobEdit (QA: 41 active
 * Project Managers), and their PATCH /:id lands before PATCH /status — a naive
 * requireAction('isJobEdit') would have broken Book Call for all of them.
 *
 * The REAL router is mounted. job.getById / job.update are stubbed on the
 * module object the router calls through, so "allowed" is a positive signal
 * (the update ran) rather than "not a 403". The service routes' inline SQL hits
 * a fake pool that never connects.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([]);
const job = require('../services/job.service');
const scenario = { status: 9, actions: [], allowedStages: null };
const updates = [];
const realGetById = job.getById;
const realUpdate = job.update;
job.getById = async (id) => ({ job_id: Number(id), job_status: scenario.status, fk_client_id: 5, city_id: 11, vertical_id: 3 });
job.update = async (id, body) => { updates.push({ id: Number(id), body }); return { job_id: Number(id) }; };

const express = require('express');
const jobsRouter = require('../routes/admin/jobs');
let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { user_id: 77, permissions: { menuIds: [], actionPermissions: scenario.actions } };
    req.userRole = { role_name: 'Project Manager' };
    const all = { mode: 'all', ids: [], placeholders: '' };
    req.scope = { clients: all, cities: all, states: all, verticals: all };
    req.allowedStages = scenario.allowedStages;
    next();
  });
  app.use('/jobs', jobsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(500).json({ error: String(err && err.message) }); });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  job.getById = realGetById;
  job.update = realUpdate;
  fake.restore();
});

beforeEach(() => {
  updates.length = 0;
  fake.calls.length = 0;
  scenario.status = 9;
  scenario.actions = [];
  scenario.allowedStages = null;
});

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function patchJob(status, actions, body, { method = 'PATCH', allowedStages = null } = {}) {
  Object.assign(scenario, { status, actions, allowedStages });
  const res = await call(method, '/jobs/42', body);
  return { ...res, updated: updates.length === 1 };
}

// ── PUT/PATCH /:id ───────────────────────────────────────────────────

test('isJobEdit writes at any status — including a completed job', async () => {
  for (const status of [0, 1, 5, 9, 10]) {
    const r = await patchJob(status, ['isJobEdit'], { job_desc: 'Fix the tap' });
    assert.equal(r.status, 200, `status ${status}`);
    assert.ok(r.updated, `status ${status}: the update must have run`);
    updates.length = 0;
  }
});

test('Confirm & Schedule keeps working for an isJobConfirm-only user on an Unconfirmed job', async () => {
  const r = await patchJob(9, ['isJobConfirm'], { job_desc: 'Booked', remarks: 'Customer confirmed', efr_special_notes: 'Gate 2' });
  assert.equal(r.status, 200);
  assert.ok(r.updated, 'the C&S save must reach job.update');
});

test('isJobConfirm does not reach a job that is not Unconfirmed — the any-of over-grant', async () => {
  for (const status of [0, 1, 2, 5, 10]) {
    const r = await patchJob(status, ['isJobConfirm'], { job_desc: 'x' });
    assert.equal(r.status, 403, `status ${status}`);
    assert.equal(r.body?.error, 'Missing permission: isJobEdit');
    assert.ok(!r.updated, `status ${status}: nothing may be written`);
  }
});

test('isJobConfirm follows Job Stage Access, like the CRM entry icon', async () => {
  const other = await patchJob(9, ['isJobConfirm'], { job_desc: 'x' },
    { allowedStages: { mode: 'list', stages: ['pending-scheduling'] } });
  assert.equal(other.status, 403, 'a user who does not own the Unconfirmed stage cannot confirm');
  assert.ok(!other.updated);

  updates.length = 0;
  const owns = await patchJob(9, ['isJobConfirm'], { job_desc: 'x' },
    { allowedStages: { mode: 'list', stages: ['unconfirmed'] } });
  assert.equal(owns.status, 200, 'owning the Unconfirmed stage is exactly the grant');
  assert.ok(owns.updated);
});

test("the View Services tab's keyless job_type follow-up still lands on an open job", async () => {
  for (const status of [0, 1, 2, 6, 7, 9, 10]) {
    const r = await patchJob(status, [], { job_type: '1,2' });
    assert.equal(r.status, 200, `status ${status}`);
    assert.ok(r.updated, `status ${status}`);
    updates.length = 0;
  }
});

test('the keyless branch is job_type ALONE, and never on a completed job', async () => {
  for (const status of [3, 5]) {
    const r = await patchJob(status, [], { job_type: '1' });
    assert.equal(r.status, 403, `status ${status}`);
    assert.ok(!r.updated);
  }
  const smuggled = await patchJob(0, [], { job_type: '1', job_desc: 'x' });
  assert.equal(smuggled.status, 403, 'a second field turns the follow-up into an edit');
  assert.ok(!smuggled.updated);
});

test('no key, no edit — the ?action=edit form and PUT are both closed', async () => {
  for (const method of ['PATCH', 'PUT']) {
    const r = await patchJob(0, ['isBookNewCall', 'isJobAssign'], { job_desc: 'x' }, { method });
    assert.equal(r.status, 403, method);
    assert.ok(!r.updated, `${method} must not reach job.update`);
  }
});

// ── Service lines ────────────────────────────────────────────────────

const SERVICE_ROUTES = [
  ['POST', '/jobs/42/services', { service_id: 9, quantity: 1 }],
  ['PATCH', '/jobs/42/services/7', { quantity: 2 }],
  ['DELETE', '/jobs/42/services/7', undefined],
  ['POST', '/jobs/42/services/7/restore', undefined],
];
const touchedServices = () => fake.calls.some((c) => /tbl_job_services/i.test(c.sql));

test('no service-line write on a completed job (3 / 5)', async () => {
  for (const status of [3, 5]) {
    for (const [method, path, body] of SERVICE_ROUTES) {
      scenario.status = status;
      fake.calls.length = 0;
      const r = await call(method, path, body);
      assert.equal(r.status, 409, `${method} ${path} at ${status}`);
      assert.ok(!touchedServices(), `${method} ${path} at ${status} must not reach the handler`);
    }
  }
});

test('service lines stay editable, keyless, on every other status', async () => {
  // Positive control: the same four routes DO reach their handler (a
  // tbl_job_services statement is issued), so the 409s above are the guard and
  // not a harness that never gets that far. 10 is Under Audit, where the
  // audit's service approvals happen.
  for (const status of [0, 1, 2, 10]) {
    for (const [method, path, body] of SERVICE_ROUTES) {
      scenario.status = status;
      fake.calls.length = 0;
      const r = await call(method, path, body);
      assert.notEqual(r.status, 409, `${method} ${path} at ${status}`);
      assert.ok(touchedServices(), `${method} ${path} at ${status} must reach its handler`);
    }
  }
});
