'use strict';
/*
 * GET /api/admin/ops-desk — the live-ops desk list (V3 Phase 3.2).
 *
 * WHAT IS AT RISK
 *   1. QUERY BUDGET. The desk polls every 30 s per operator. A per-row lookup
 *      slipped into the hydration turns 150 in-flight jobs into 150 queries a
 *      poll. The budget is asserted as the SAME count for 1 job and for 150.
 *   2. THE GATE. isJobAppRequestResolve, via the shipped requireAction.
 *   3. SCOPE. The in-flight SQL must carry the caller's row scope exactly the
 *      way GET /api/admin/jobs does (j.fk_client_id / ad.city_id / stages).
 *   4. BANDS come from services/job-pending-on.js (BACKEND-A's real function,
 *      not a stub), so the desk and the app cannot disagree.
 *   5. start proof / needsMeIn / money shapes.
 *
 * NO DB: the fake-pool seam answers every read. The REAL routes/admin/ops-desk.js
 * router is mounted; only what routes/admin/index.js attaches is injected.
 *
 * MUTATIONS RUN (each turned this file red, then was restored):
 *   M1 ops-desk.service listDesk: moneyForJobs called once per item instead of
 *      once per page → "budget is flat" failed (150 jobs: 905 queries vs 11).
 *   M2 routes/admin/ops-desk.js: `gate` removed from GET /ops-desk →
 *      "403 without the action key" failed (200).
 *   M3 ops-desk.service scopeClauses: the clients dimension skipped →
 *      "scope reaches the SQL" failed.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

process.env.WEBHOOK_OUTBOUND_ENABLED = 'false';

const state = { jobs: [], reports: [], logs: [], actions: ['isJobAppRequestResolve'], scope: undefined, allowedStages: null };

function istMinutesAgo(min) {
  const d = new Date(Date.now() + (5 * 60 + 30) * 60000 - min * 60000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function jobRow(id, over = {}) {
  return {
    job_id: id, job_status: 2, job_reference_id: `EF-${id}`, client_ref_id: null, fk_client_id: 5,
    fk_easyfixter_id: 900 + id, requested_date_time: istMinutesAgo(60), checkin_date_time: istMinutesAgo(30),
    checkout_date_time: null, approved_on_date_time: null, is_cancelled_by_app: 0, is_rescheduled_by_app: 0,
    client_name: 'Sankalp', locality: 'Sector 56', city_name: 'Gurgaon', efr_name: 'Binod', service_catg_name: 'Shutters',
    ...over,
  };
}

const idsOf = (params) => (params || []).find(Array.isArray) || [];

const fake = installFakePool([
  [/SHOW COLUMNS FROM tbl_client/i, () => [{ Field: 'vertical_id' }]],
  [/FROM tbl_tax_rate/i, () => [{ rate: 18 }]],
  [/tbl_easyfixer_rating_parameters_weightage/i, () => [{ value: 0 }]],
  // The in-flight set (the UNION'd derived table).
  [/FROM \(\s*SELECT job_id FROM tbl_job/i, () => state.jobs],
  // BACKEND-A's openForJobs AND the desk's page read — both key on job_id IN (?).
  [/FROM tbl_job_tx_report\s+WHERE job_id IN/i, (_sql, params) => {
    const ids = idsOf(params);
    return state.reports.filter((r) => ids.includes(r.job_id));
  }],
  // pendingOnForJobs' facts read.
  [/LEFT JOIN tbl_job_verification v ON v.job_id = j.job_id\s+WHERE j.job_id IN/i, (_sql, params) => {
    const ids = idsOf(params);
    return state.jobs.filter((j) => ids.includes(j.job_id)).map((j) => ({
      job_id: j.job_id, cancel_request: 0, reschedule_request: 0, site_access: 0,
      verified_on: j.verified_on || null, qc_status: j.qc_status || null,
    }));
  }],
  [/FROM tbl_job_logs WHERE job_id IN/i, () => state.logs],
  [/FROM tbl_job_transaction WHERE fk_job_id IN/i, () => []],
]);

const express = require('express');
const deskRouter = require('../routes/admin/ops-desk');

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { user_id: 77, permissions: { menuIds: [], actionPermissions: state.actions } };
    req.userRole = { role_name: 'Executive Supply' };
    req.scope = state.scope;
    req.allowedStages = state.allowedStages;
    next();
  });
  app.use('/', deskRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err && err.message) }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { if (server) server.close(); fake.restore(); });

beforeEach(() => {
  state.jobs = []; state.reports = []; state.logs = [];
  state.actions = ['isJobAppRequestResolve']; state.scope = undefined; state.allowedStages = null;
  fake.reset();
});

const get = async (path) => {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.json() };
};

test('the query budget is flat: 1 job and 150 jobs cost the same statements', async () => {
  state.jobs = [jobRow(1)];
  await get('/ops-desk');           // warm the per-process caches (vertical probe, ledger config)
  fake.reset();
  const one = await get('/ops-desk');
  assert.equal(one.status, 200);
  assert.equal(one.body.data.items.length, 1);
  const oneCount = fake.calls.length;

  state.jobs = Array.from({ length: 150 }, (_, i) => jobRow(i + 1));
  fake.reset();
  const many = await get('/ops-desk?limit=200');
  assert.equal(many.body.data.items.length, 150);
  assert.equal(fake.calls.length, oneCount, `150 jobs issued ${fake.calls.length} queries, 1 job issued ${oneCount}`);
  // Positive control on the counter itself: it saw the in-flight read.
  assert.ok(fake.calls.some((c) => /FROM \(\s*SELECT job_id FROM tbl_job/i.test(c.sql)), 'the in-flight read must be among the counted calls');
  assert.ok(oneCount <= 12, `desk budget is 12 statements, got ${oneCount}`);
});

test('403 without the action key, before any job is read', async () => {
  state.actions = ['isJobEdit'];
  state.jobs = [jobRow(1)];
  const r = await get('/ops-desk');
  assert.equal(r.status, 403);
  assert.match(String(r.body.error), /isJobAppRequestResolve/);
  assert.equal(fake.calls.length, 0);
});

test('scope reaches the SQL the way GET /admin/jobs applies it', async () => {
  state.scope = {
    clients: { mode: 'allow', ids: [5, 6] },
    cities: { mode: 'allow', ids: [11] },
    states: { mode: 'all', ids: [] },
    verticals: { mode: 'all', ids: [] },
  };
  state.allowedStages = { mode: 'list', stages: ['pending-close'] };
  await get('/ops-desk');
  const call = fake.calls.find((c) => /FROM \(\s*SELECT job_id FROM tbl_job/i.test(c.sql));
  assert.ok(call, 'in-flight read ran');
  assert.match(call.sql, /j\.fk_client_id IN \(\?\)/);
  assert.match(call.sql, /ad\.city_id IN \(\?\)/);
  assert.match(call.sql, /j\.job_status IN \(\?\)/);
  assert.ok(call.params.some((p) => Array.isArray(p) && p.join() === '5,6'), 'client ids bound');
  assert.ok(call.params.some((p) => Array.isArray(p) && p.join() === '11'), 'city ids bound');
});

test('bands, counts and the band filter come from pendingOnForJobs', async () => {
  state.jobs = [jobRow(1), jobRow(2), jobRow(3, { job_status: 3, checkout_date_time: istMinutesAgo(5) })];
  state.reports = [
    { id: 11, job_id: 1, kind: 'help', status: 'open', reason_code: 'gate', left_site_on: null, reported_on: istMinutesAgo(2) },
    { id: 12, job_id: 2, kind: 'additional_work', status: 'open', reason_code: null, left_site_on: null, reported_on: istMinutesAgo(10) },
  ];
  const r = await get('/ops-desk');
  const byId = new Map(r.body.data.items.map((i) => [i.jobId, i]));
  assert.equal(byId.get(1).band, 'A');
  assert.equal(byId.get(1).situation, 'help:gate');
  assert.equal(byId.get(1).helpReason, 'gate');
  assert.equal(byId.get(1).pendingOn, 'easyfix');
  assert.equal(byId.get(2).waitingFor, 'pricing');
  assert.equal(byId.get(3).band, 'C', 'completed, unaudited → audit');
  assert.deepEqual(r.body.data.counts, { A: 2, B: 0, C: 1, D: 0 });

  const onlyC = await get('/ops-desk?band=C');
  assert.deepEqual(onlyC.body.data.items.map((i) => i.jobId), [3]);
  assert.equal(onlyC.body.data.total, 1);
  assert.deepEqual(onlyC.body.data.counts, { A: 2, B: 0, C: 1, D: 0 }, 'counts are over the whole set, not the filter');
});

test('a completed job past audit and QC is not in flight', async () => {
  state.jobs = [jobRow(4, { job_status: 3, verified_on: istMinutesAgo(60), qc_status: 'passed' })];
  const r = await get('/ops-desk');
  assert.equal(r.body.data.items.length, 0);
  assert.equal(r.body.data.total, 0);
});

test('start proof, door clock and the report shape', async () => {
  state.jobs = [jobRow(1), jobRow(2), jobRow(3), jobRow(5, { job_status: 1, checkin_date_time: null })];
  state.logs = [
    { job_id: 1, old_data: null },
    { job_id: 2, old_data: 'Late: yes' },
  ];
  state.reports = [{
    id: 21, job_id: 3, kind: 'additional_work', status: 'priced', reason_code: null, left_site_on: null,
    client_amount: 2000, tx_amount: 1000, reported_on: istMinutesAgo(10), proof_image_ids: '7,8', visit_charge_awarded: 0,
  }];
  const r = await get('/ops-desk');
  const byId = new Map(r.body.data.items.map((i) => [i.jobId, i]));
  assert.equal(byId.get(1).startProof, 'pin');
  assert.equal(byId.get(2).startProof, 'pin_late');
  assert.equal(byId.get(3).startProof, 'photos', 'checked in with no PIN row');
  assert.equal(byId.get(5).startProof, null, 'not checked in');
  const nm = byId.get(3).needsMeIn;
  assert.ok(nm >= 19 && nm <= 20, `30-minute door clock, 10 min used → ~20, got ${nm}`);
  assert.deepEqual(byId.get(3).report.proofImageIds, [7, 8]);
  assert.equal(byId.get(3).report.clientAmount, 2000);
  assert.equal(byId.get(3).leftSite, false);
  assert.deepEqual(Object.keys(byId.get(3).money).sort(), ['client', 'tx']);
});

test('limit is bounded by the validator', async () => {
  const r = await get('/ops-desk?limit=5000');
  assert.equal(r.status, 400);
});
