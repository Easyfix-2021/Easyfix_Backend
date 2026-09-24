'use strict';
/*
 * V3 Phase 4 BACKEND-B — Tools to Carry, Products at Site, Schedule Visit 2,
 * and the extrasForJobs batch read BACKEND-A's job detail depends on.
 *
 * WHAT IS AT RISK
 *   1. extrasForJobs QUERY BUDGET: 3 queries for 1 job and for 40; 0 for none.
 *      Every asked job gets an entry.
 *   2. PUT tools replaces the set IN ONE TRANSACTION, refuses unknown/inactive
 *      ids before writing anything, and gates on isJobEdit.
 *   3. Site products: validated, capped, deleted only on THIS job.
 *   4. Schedule Visit 2: only from 10, needs a technician, future time,
 *      visit_number raised idempotently (never lowered), then the CRM's own
 *      reschedule + setStatus(1). Gate isJobAppRequestResolve + stage access.
 *   5. Scope: an out-of-scope job is a 404 on every route.
 *   6. History: every change writes its row through BACKEND-A's real writer.
 *   7. The migration and scripts/schema-verify.js EXPECTED list the same columns,
 *      and uq_jt is a REQUIRED_INDEXES entry with its own impact line.
 *
 * NO DB: tests/helpers/fake-pool.js answers every read; the REAL
 * routes/admin/jobs-phase4.js is mounted with what routes/admin/index.js attaches.
 *
 * MUTATIONS RUN (each turned this file red, then was restored):
 *   MB1 job-extras.service extrasForJobs: the signature read moved inside a
 *       per-job loop → "extrasForJobs budget is 3" failed (42 vs 3 for 40 jobs).
 *   MB2 routes/admin/jobs-phase4.js: `canEdit` removed from PUT /:id/tools →
 *       "PUT tools needs isJobEdit" failed (200).
 *   MB3 job-extras.service setJobTools: the unknown-id refusal removed →
 *       "unknown tool ids are refused before any write" failed (200, DELETE ran).
 *   MB4 job-extras.service scheduleVisitTwo: GREATEST(...) replaced by
 *       visit_number + 1 → "visit 2 raises visit_number idempotently" failed.
 *   MB5 job-extras.service removeSiteProduct: `AND job_id = ?` dropped →
 *       "delete is scoped to the job" failed.
 *   MB6 job-extras.service addSiteProduct: log detail back to { count } (the
 *       brief's shape, which A's writer refuses) → "each change writes its
 *       tbl_job_logs row" failed (the 'added' row missing).
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');
const { readMigration } = require('./helpers/migration-file');

process.env.WEBHOOK_OUTBOUND_ENABLED = 'false';

const state = {};
function reset() {
  state.job = { job_id: 42, job_status: 10, fk_client_id: 5, city_id: 11, vertical_id: 3, fk_easyfixter_id: 901, requested_date_time: '2030-01-01 10:00:00' };
  state.actions = ['isJobEdit', 'isJobAppRequestResolve'];
  state.scope = undefined;
  state.allowedStages = null;
  state.okTools = [3, 7];
  state.productCount = 2;
  state.deleteAffected = 1;
}
reset();

const idsOf = (params) => (params || []).find(Array.isArray) || [];
const fake = installFakePool([
  [/FROM tbl_job_tool jt/i, (_s, p) => idsOf(p).flatMap((id) => [{ job_id: id, tool_id: 3, tool_name: 'Drill' }])],
  [/FROM tbl_job_site_product\s+WHERE job_id IN/i, (_s, p) => idsOf(p).map((id) => ({ id: 100 + id, job_id: id, name: 'AC', qty: 2, brand: null }))],
  [/FROM tbl_job_signature WHERE job_id IN/i, (_s, p) => idsOf(p).slice(0, 1).map((id) => ({ job_id: id, signed_on: '2026-09-24 11:00:00' }))],
  [/SELECT tool_id FROM tbl_tools/i, (_s, p) => idsOf(p).filter((t) => state.okTools.includes(t)).map((tool_id) => ({ tool_id }))],
  [/SELECT COUNT\(\*\) AS n FROM tbl_job_site_product/i, () => [{ n: state.productCount }]],
  [/INSERT INTO tbl_job_site_product/i, () => ({ insertId: 555, affectedRows: 1 })],
  [/DELETE FROM tbl_job_site_product/i, () => ({ affectedRows: state.deleteAffected })],
  [/INSERT INTO tbl_job_logs/i, () => ({ insertId: 1 })],
]);

const jobService = require('../services/job.service');
const extras = require('../services/job-extras.service');
const schemaVerify = require('../scripts/schema-verify')._internals;

const calls = { reschedule: [], setStatus: [] };
const orig = {};
let server; let base;
before(async () => {
  orig.getById = jobService.getById;
  orig.reschedule = jobService.reschedule;
  orig.setStatus = jobService.setStatus;
  jobService.getById = async () => (state.job ? { ...state.job } : null);
  jobService.reschedule = async (...a) => { calls.reschedule.push(a); return {}; };
  jobService.setStatus = async (...a) => { calls.setStatus.push(a); return { job_id: 42, job_status: 1 }; };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { user_id: 77, permissions: { menuIds: [], actionPermissions: state.actions } };
    req.scope = state.scope;
    req.allowedStages = state.allowedStages;
    next();
  });
  app.use('/', require('../routes/admin/jobs-phase4'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err && err.message) }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  if (server) server.close();
  Object.assign(jobService, orig);
  fake.restore();
});
beforeEach(() => { reset(); fake.reset(); calls.reschedule.length = 0; calls.setStatus.length = 0; });

async function req(method, p, body) {
  const r = await fetch(base + p, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
const callsLike = (re) => fake.calls.filter((c) => re.test(c.sql));

/* ─── 1. extrasForJobs ─────────────────────────────────────────────── */

test('extrasForJobs budget is 3 queries for 1 job and for 40, 0 for none', async () => {
  assert.equal((await extras.extrasForJobs(null, [])).size, 0);
  assert.equal(fake.calls.length, 0, 'no ids → no queries');

  const one = await extras.extrasForJobs(null, [42]);
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(one.get(42), {
    tools: [{ id: 3, name: 'Drill' }],
    siteProducts: [{ id: 142, name: 'AC', qty: 2, brand: null }],
    signatureOn: '2026-09-24 11:00:00',
  });

  fake.reset();
  const ids = Array.from({ length: 40 }, (_, i) => 1000 + i);
  const many = await extras.extrasForJobs(null, [...ids, ids[0], 'x', -1]);
  assert.equal(fake.calls.length, 3, 'flat budget');
  assert.equal(many.size, 40, 'every asked job, deduped, junk dropped');
  assert.equal(many.get(1001).signatureOn, null, 'job with no signature → null');
  assert.equal(many.get(1001).tools.length, 1);
});

/* ─── 2. Tools ─────────────────────────────────────────────────────── */

test('PUT tools replaces the set in one transaction', async () => {
  const db = require('../db').pool;
  const realGet = db.getConnection;
  const txn = [];
  db.getConnection = async () => {
    const c = await realGet();
    return {
      ...c,
      query: async (sql, p) => { txn.push(/DELETE/.test(sql) ? 'delete' : 'insert'); return c.query(sql, p); },
      beginTransaction: async () => { txn.push('begin'); },
      commit: async () => { txn.push('commit'); },
    };
  };
  let r;
  try { r = await req('PUT', '/42/tools', { toolIds: [3, 7] }); } finally { db.getConnection = realGet; }
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(txn, ['begin', 'delete', 'insert', 'commit'], 'both writes on one connection, inside one transaction');
  const [del] = callsLike(/DELETE FROM tbl_job_tool/);
  assert.match(del.sql, /tool_id NOT IN \(\?\)/);
  assert.deepEqual(del.params, [42, [3, 7]]);
  const [ins] = callsLike(/INSERT INTO tbl_job_tool/);
  assert.match(ins.sql, /ON DUPLICATE KEY UPDATE tool_id = tool_id/, 'existing rows keep added_on');
  assert.deepEqual(ins.params[0].map((row) => [row[0], row[1], row[3]]), [[42, 3, 77], [42, 7, 77]]);
  assert.deepEqual(r.body.data.items, [{ id: 3, name: 'Drill' }]);
});

test('PUT tools with an empty set clears the job', async () => {
  const r = await req('PUT', '/42/tools', { toolIds: [] });
  assert.equal(r.status, 200);
  const [del] = callsLike(/DELETE FROM tbl_job_tool/);
  assert.deepEqual(del.params, [42]);
  assert.equal(callsLike(/INSERT INTO tbl_job_tool/).length, 0);
  assert.equal(callsLike(/FROM tbl_tools/).length, 0, 'nothing to validate');
});

test('unknown tool ids are refused before any write', async () => {
  const r = await req('PUT', '/42/tools', { toolIds: [3, 99] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'TOOL_NOT_FOUND');
  assert.match(r.body.error.message, /99/);
  assert.equal(callsLike(/DELETE|INSERT/).length, 0);
});

test('a tool already on the job is accepted even if since deactivated', async () => {
  await req('PUT', '/42/tools', { toolIds: [3] });
  const [check] = callsLike(/SELECT tool_id FROM tbl_tools/);
  assert.match(check.sql, /tool_id IN \(SELECT tool_id FROM tbl_job_tool WHERE job_id = \?\)/);
  assert.deepEqual(check.params, [[3], 42]);
});

test('PUT tools needs isJobEdit; bad bodies are 400', async () => {
  state.actions = ['isJobAppRequestResolve'];
  assert.equal((await req('PUT', '/42/tools', { toolIds: [3] })).status, 403);
  state.actions = ['isJobEdit'];
  assert.equal((await req('PUT', '/42/tools', { toolIds: [3, 3] })).status, 400, 'duplicates');
  assert.equal((await req('PUT', '/42/tools', { toolIds: Array.from({ length: 51 }, (_, i) => i + 1) })).status, 400, 'over the cap');
  assert.equal((await req('PUT', '/42/tools', {})).status, 400);
});

/* ─── 3. Site products ─────────────────────────────────────────────── */

test('POST site-product validates, inserts on this job, returns the row', async () => {
  const r = await req('POST', '/42/site-products', { name: '  Split AC ', qty: 2, brand: 'LG' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { id: 555, name: 'Split AC', qty: 2, brand: 'LG' });
  const [ins] = callsLike(/INSERT INTO tbl_job_site_product/);
  assert.deepEqual([ins.params[0], ins.params[1], ins.params[2], ins.params[3], ins.params[5]], [42, 'Split AC', 2, 'LG', 77]);

  assert.equal((await req('POST', '/42/site-products', { name: '' })).status, 400);
  assert.equal((await req('POST', '/42/site-products', { name: 'x', qty: 0 })).status, 400);
  assert.equal((await req('POST', '/42/site-products', { name: 'x'.repeat(161) })).status, 400);
  assert.equal((await req('POST', '/42/site-products', { name: 'x', brand: 'b'.repeat(81) })).status, 400);
  const d = await req('POST', '/42/site-products', { name: 'Fan' });
  assert.equal(d.body.data.qty, 1, 'qty defaults to 1');
});

test('the 51st product is refused', async () => {
  state.productCount = 50;
  const r = await req('POST', '/42/site-products', { name: 'Fan' });
  assert.equal(r.status, 409);
  assert.equal(callsLike(/INSERT INTO tbl_job_site_product/).length, 0);
});

test('delete is scoped to the job; a miss is 404', async () => {
  const r = await req('DELETE', '/42/site-products/142');
  assert.equal(r.status, 200);
  const [del] = callsLike(/DELETE FROM tbl_job_site_product/);
  assert.match(del.sql, /WHERE id = \? AND job_id = \?/);
  assert.deepEqual(del.params, [142, 42]);
  state.deleteAffected = 0;
  assert.equal((await req('DELETE', '/42/site-products/999')).status, 404);
  state.actions = [];
  assert.equal((await req('DELETE', '/42/site-products/142')).status, 403);
  assert.equal((await req('POST', '/42/site-products', { name: 'Fan' })).status, 403);
});

test('GET tools / site-products are scope-only reads', async () => {
  state.actions = [];
  const t = await req('GET', '/42/tools');
  assert.equal(t.status, 200);
  assert.deepEqual(t.body.data.items, [{ id: 3, name: 'Drill' }]);
  const p = await req('GET', '/42/site-products');
  assert.deepEqual(p.body.data.items, [{ id: 142, name: 'AC', qty: 2, brand: null }]);
});

test('an out-of-scope or missing job is 404 on every route', async () => {
  state.scope = {
    clients: { mode: 'allow', ids: [999] }, cities: { mode: 'all', ids: [] },
    states: { mode: 'all', ids: [] }, verticals: { mode: 'all', ids: [] },
  };
  for (const [m, p, b] of [['GET', '/42/tools'], ['PUT', '/42/tools', { toolIds: [3] }], ['GET', '/42/site-products'],
    ['POST', '/42/site-products', { name: 'Fan' }], ['DELETE', '/42/site-products/1'], ['GET', '/42/signature'],
    ['POST', '/42/schedule-visit-two', { visitOn: '2099-01-01 10:00' }]]) {
    assert.equal((await req(m, p, b)).status, 404, `${m} ${p}`);
  }
  assert.equal(callsLike(/tbl_job_tool|tbl_job_site_product|tbl_job_signature|UPDATE tbl_job/).length, 0);
  state.scope = undefined; state.job = null;
  assert.equal((await req('GET', '/42/tools')).status, 404);
});

/* ─── 4. Schedule Visit 2 ──────────────────────────────────────────── */

test('visit 2 raises visit_number idempotently, then reschedules and moves 10 → 1', async () => {
  const r = await req('POST', '/42/schedule-visit-two', { visitOn: '2099-01-02T15:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [bump] = callsLike(/UPDATE tbl_job SET visit_number/);
  assert.match(bump.sql, /visit_number = GREATEST\(COALESCE\(visit_number, 1\), 2\)/);
  assert.match(bump.sql, /AND job_status = \?/);
  assert.deepEqual(bump.params, [42, 10]);
  const bumpAt = fake.calls.indexOf(bump);
  assert.equal(bumpAt, fake.calls.findIndex((c) => /visit_number/.test(c.sql)), 'bump happens first');

  assert.equal(calls.reschedule.length, 1);
  const [jobId, body, actor] = calls.reschedule[0];
  assert.equal(jobId, 42);
  assert.equal(body.requestedDateTime, '2099-01-02T15:00');
  assert.equal(actor.user_id, 77);
  assert.equal(calls.setStatus.length, 1);
  assert.deepEqual(calls.setStatus[0].slice(0, 2), [42, { status: 1 }]);
  assert.deepEqual(r.body.data, { job_id: 42, job_status: 1 });
});

test('visit 2 is refused off 10, without a technician, or in the past', async () => {
  state.job.job_status = 1;
  let r = await req('POST', '/42/schedule-visit-two', { visitOn: '2099-01-02 15:00' });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'NOT_REVISIT');
  state.job.job_status = 10; state.job.fk_easyfixter_id = null;
  r = await req('POST', '/42/schedule-visit-two', { visitOn: '2099-01-02 15:00' });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'NO_TECHNICIAN');
  state.job.fk_easyfixter_id = 901;
  r = await req('POST', '/42/schedule-visit-two', { visitOn: '2020-01-02 15:00' });
  assert.equal(r.status, 400);
  assert.equal((await req('POST', '/42/schedule-visit-two', { visitOn: 'tomorrow' })).status, 400);
  assert.equal(calls.reschedule.length + calls.setStatus.length, 0);
  assert.equal(callsLike(/UPDATE tbl_job/).length, 0);
});

test('visit 2 gates: isJobAppRequestResolve, then Job Stage Access for 10 → 1', async () => {
  state.actions = ['isJobEdit'];
  assert.equal((await req('POST', '/42/schedule-visit-two', { visitOn: '2099-01-02 15:00' })).status, 403);
  state.actions = ['isJobAppRequestResolve'];
  state.allowedStages = { mode: 'list', stages: ['pending-start'] }; // cannot act on a 10
  assert.equal((await req('POST', '/42/schedule-visit-two', { visitOn: '2099-01-02 15:00' })).status, 403);
  assert.equal(calls.setStatus.length, 0);
});

/* ─── 5. History rows land through BACKEND-A's real writers ────────── */

test('each change writes its tbl_job_logs row with the detail the writer accepts', async () => {
  const rows = () => callsLike(/INSERT INTO tbl_job_logs/).map((c) => [c.params[0], c.params[1], c.params[3], c.params[6]]);
  await req('PUT', '/42/tools', { toolIds: [3, 7] });
  await req('POST', '/42/site-products', { name: 'Fan' });
  await req('DELETE', '/42/site-products/142');
  await req('POST', '/42/schedule-visit-two', { visitOn: '2099-01-02 15:00' });
  state.job.visit_number = 3;
  await req('POST', '/42/schedule-visit-two', { visitOn: '2099-01-02 15:00' });
  assert.deepEqual(rows(), [
    ['tools set', 'Count: 2', 42, 77],
    ['site products changed', 'Change: added', 42, 77],
    ['site products changed', 'Change: removed', 42, 77],
    ['visit two scheduled', 'Visit: 2', 42, 77],
    ['visit two scheduled', 'Visit: 3', 42, 77],
  ]);
});

/* ─── 6. Migration ↔ schema-verify ─────────────────────────────────── */

test('the Phase 4 migration and schema-verify EXPECTED list the same columns; uq_jt is required', () => {
  const sql = readMigration('2026-09-24-v3-phase4-tables.sql');
  const tables = ['tbl_job_signature', 'tbl_job_tool', 'tbl_job_site_product'];
  for (const t of tables) {
    const body = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(([\\s\\S]*?)\\) ENGINE`))[1];
    const cols = body.split('\n').map((l) => l.trim().split(/\s+/)[0])
      .filter((w) => w && !/^(PRIMARY|UNIQUE|KEY)$/.test(w));
    assert.deepEqual(cols, schemaVerify.EXPECTED[t], t);
  }
  const uq = schemaVerify.REQUIRED_INDEXES.find((i) => i.table === 'tbl_job_tool');
  assert.deepEqual(uq.columns, ['job_id', 'tool_id']);
  assert.equal(uq.unique, true);
  assert.ok(uq.impact && /twice/.test(uq.impact));
  assert.match(sql, /UNIQUE KEY uq_jt \(job_id, tool_id\)/);
  assert.match(sql, /RUN THIS BEFORE DEPLOYING/);
});
