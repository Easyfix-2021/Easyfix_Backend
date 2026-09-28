/*
 * routes/admin/advances.js — adv_status ladder (2026-09-28).
 *
 * The legacy Struts CRM is still live on the SAME tbl_efr_advance_payment, so
 * this route must speak legacy's numbers (AdvanceDaoImpl.java:429):
 *   1 Initiated · 2 Pending To Finance · 3 Rejected by Ops
 *   4 Advance Done · 5 Rejected by Finance
 *
 * These tests pin the ladder against the invented 0/1/2/3 one this route used
 * to carry, which made ops-approve 409 on every legacy row and let finance
 * approve a request Ops had never seen.
 *
 * Runner: `node --test --test-force-exit` (see npm test).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

// Mutable so each test picks the row's starting state.
let currentStatus = 1;
// Mutable so the cap tests can give the job a non-zero total. Travel/Incentive/
// Penalty rows come straight out of job_material with client_charge on them,
// so they move the total without dragging in serviceChargeMap.
let chargeRows = [];

// scopedAdvance's row has no client/city/vertical, so assertEntityInScope's
// null-dimension rule waves every caller through with no scope setup.
const fake = installFakePool([
  // FIRST: the scopedAdvance matcher below also matches this SQL, and the
  // fake dispatches in array order.
  [/SELECT COUNT\(\*\) AS total/i, () => [{ total: 137 }]],
  [/FROM tbl_efr_advance_payment a[\s\S]*LEFT JOIN/i, () => [{ advance_id: 1, client_id: null, efr_id: 5, vertical_id: null, city_id: null }]],
  [/SELECT adv_status FROM tbl_efr_advance_payment WHERE advance_id/i, () => [{ adv_status: currentStatus }]],
  [/^\s*UPDATE tbl_efr_advance_payment/i, () => ({ affectedRows: 1 })],
  [/INSERT INTO tbl_efr_advance_payment/i, () => ({ insertId: 42 })],
  // Matches BOTH the POST's one-column select and /context's two-column one.
  // Deliberately anchored on the column list so it cannot swallow the
  // counts query below, which also reads FROM tbl_job.
  [/SELECT fk_client_id[\s\S]*FROM tbl_job/i, () => [{ fk_client_id: null, fk_easyfixter_id: 5 }]],
  [/SELECT efr_cityId FROM tbl_easyfixer/i, () => [{ efr_cityId: null }]],
  [/FROM job_material/i, () => chargeRows],
  // Legacy's single counts query: FOH (status 21) / ESA (status 15) / OOA.
  [/job_count|foh_count/i, () => [{ foh_count: 7, esa_count: 3, tx_open_count: 4 }]],
]);

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { user_id: 9 }; next(); });
  app.use('/api/admin/advances', require('../routes/admin/advances'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/admin/advances`;
});
after(async () => { await new Promise((r) => server.close(r)); if (fake.restore) fake.restore(); });
beforeEach(() => { fake.calls.length = 0; currentStatus = 1; chargeRows = []; });

const post = (path, body) => fetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
});
const lastUpdate = () => fake.calls.filter((c) => /UPDATE tbl_efr_advance_payment/.test(c.sql)).pop();

test('a new advance is created as 1 (Initiated), the value legacy reads', async () => {
  const r = await post('/', { jobId: 11, efrId: 5, advanceAmt: 100, jobTotalAmt: 0 });
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  assert.equal((await r.json()).data.status, 1);
  const ins = fake.calls.find((c) => /INSERT INTO tbl_efr_advance_payment/.test(c.sql));
  assert.match(ins.sql, /VALUES \(\?, \?, \?, 1,/, 'adv_status literal in the INSERT is 1');
});

test('ops-approve moves 1 Initiated -> 2 Pending To Finance', async () => {
  currentStatus = 1;
  const r = await post('/1/ops-approve', { remarks: 'ok' });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal((await r.json()).data.status, 2);
  const upd = lastUpdate();
  assert.match(upd.sql, /SET adv_status = 2/);
  assert.match(upd.sql, /AND adv_status = 1/, 'guarded against the state it read');
  assert.match(upd.sql, /ops_action_on/, 'stamps the ops columns');
});

test('ops-approve refuses a row already past Ops', async () => {
  currentStatus = 2;
  const r = await post('/1/ops-approve', {});
  assert.equal(r.status, 409);
});

test('fin-approve moves 2 Pending To Finance -> 4 Advance Done', async () => {
  currentStatus = 2;
  const r = await post('/1/fin-approve', { remarks: 'paid', transactionId: 'TXN1' });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal((await r.json()).data.status, 4);
  const upd = lastUpdate();
  assert.match(upd.sql, /SET adv_status = 4/);
  assert.match(upd.sql, /AND adv_status = 2/);
  assert.match(upd.sql, /fin_action_on/, 'stamps the finance columns');
});

test('REGRESSION: finance cannot approve an Initiated request Ops never saw', async () => {
  // The old ladder accepted adv_status 1 here, which under legacy numbering is
  // "Initiated" — finance could pay out a request Ops had not approved.
  currentStatus = 1;
  const r = await post('/1/fin-approve', {});
  assert.equal(r.status, 409, 'finance must wait for Ops');
});

test('reject from 1 Initiated -> 3 Rejected by Ops, stamping ops columns', async () => {
  currentStatus = 1;
  const r = await post('/1/reject', { remarks: 'no' });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const body = (await r.json()).data;
  assert.equal(body.status, 3);
  assert.equal(body.rejectedBy, 'ops');
  const upd = lastUpdate();
  assert.match(upd.sql, /SET adv_status = 3/);
  assert.match(upd.sql, /ops_action_on/);
});

test('reject from 2 Pending To Finance -> 5 Rejected by Finance, stamping fin columns', async () => {
  currentStatus = 2;
  const r = await post('/1/reject', { remarks: 'no funds' });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const body = (await r.json()).data;
  assert.equal(body.status, 5, 'legacy keeps the two rejections apart');
  assert.equal(body.rejectedBy, 'finance');
  const upd = lastUpdate();
  assert.match(upd.sql, /SET adv_status = 5/);
  assert.match(upd.sql, /fin_action_on/);
});

test('a terminal advance cannot be rejected', async () => {
  for (const s of [3, 4, 5]) {
    currentStatus = s;
    const r = await post('/1/reject', {});
    assert.equal(r.status, 409, `status ${s} is terminal`);
  }
});

test('the 60% cap is enforced server-side, against a total the caller cannot forge', async () => {
  chargeRows = [{ id: 1, type: 'Travel', tx_charge: 100, client_charge: 1000 }];
  // Body claims a huge total; the route recomputes 1000 -> cap 600.
  const over = await post('/', { jobId: 11, efrId: 5, advanceAmt: 700, jobTotalAmt: 999999 });
  assert.equal(over.status, 422, 'over the cap is refused');

  const atCap = await post('/', { jobId: 11, efrId: 5, advanceAmt: 600, jobTotalAmt: 0 });
  assert.equal(atCap.status, 201, 'exactly the cap is allowed');
});

test('the cap is skipped while a job has no costed charges — legacy allowed this', async () => {
  chargeRows = [];
  const r = await post('/', { jobId: 11, efrId: 5, advanceAmt: 5000, jobTotalAmt: 0 });
  assert.equal(r.status, 201);
});

test('GET /context returns the legacy OPEN counters and the 60% cap', async () => {
  // 2500 of client charge on the job -> cap 1500.0
  chargeRows = [
    { id: 1, type: 'Travel', tx_charge: 100, client_charge: 1500 },
    { id: 2, type: 'Penalty', tx_charge: 100, client_charge: 1000 },
  ];
  const r = await fetch(base + '/context?jobId=11&efrId=5');
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const d = (await r.json()).data;
  assert.equal(d.job_total_amt, 2500);
  assert.equal(d.max_allowed_advance, 1500);
  assert.equal(d.foh_count, 7);
  assert.equal(d.esa_count, 3);
  assert.equal(d.tx_open_count, 4);
});

test('GET /context rounds the cap to one decimal, as legacy did', async () => {
  // 1000.05 * 0.6 = 600.03 -> 600.0
  chargeRows = [{ id: 1, type: 'Travel', tx_charge: 0, client_charge: 1000.05 }];
  const r = await fetch(base + '/context?jobId=11&efrId=5');
  const d = (await r.json()).data;
  assert.equal(d.max_allowed_advance, 600);
});

test('GET /context is not swallowed by the /:id route', async () => {
  const r = await fetch(base + '/context?jobId=11');
  assert.equal(r.status, 200, '"context" must not be parsed as an advance id');
});

/* ─── Audit Advance list filters (legacy findAllAdvanceList parity) ───── */

const listSql = () => fake.calls.map((c) => c.sql).find((q) => /FROM tbl_efr_advance_payment a/i.test(q));

test('list carries the legacy columns Audit Advance needs', async () => {
  await fetch(base + '/');
  const sql = listSql();
  assert.match(sql, /e\.current_balance/, 'Tx Current Balance');
  assert.match(sql, /ci\.city_name/, 'City Name');
  assert.match(sql, /j\.job_status/, 'job status, for the open/closed filter');
});

test('jobStatus filter maps to legacy 1 open / 2 completed / 3 closed', async () => {
  await fetch(base + '/?jobStatus=1');
  assert.match(listSql(), /j\.job_status NOT IN \(3, 5, 6, 7\)/);
  fake.calls.length = 0;
  await fetch(base + '/?jobStatus=2');
  assert.match(listSql(), /j\.job_status IN \(3, 5\)/);
  fake.calls.length = 0;
  await fetch(base + '/?jobStatus=3');
  assert.match(listSql(), /j\.job_status IN \(6, 7\)/);
});

test('city / NDM / PM filters are bound, not concatenated', async () => {
  await fetch(base + '/?cityId=12&ndmId=34&pmId=56');
  const call = fake.calls.find((c) => /FROM tbl_efr_advance_payment a/i.test(c.sql));
  assert.match(call.sql, /ci\.city_id = \?/);
  assert.match(call.sql, /ci\.state_user = \?/);
  assert.match(call.sql, /a\.initiated_by = \?/);
  // Legacy interpolated these straight into the SQL string.
  assert.ok(call.params.includes(12) && call.params.includes(34) && call.params.includes(56));
});

test('a date range matches any of the three action timestamps, as legacy did', async () => {
  await fetch(base + '/?dateFrom=2026-09-01&dateTo=2026-09-30');
  const call = fake.calls.find((c) => /FROM tbl_efr_advance_payment a/i.test(c.sql));
  assert.match(call.sql, /a\.initiated_on\s+BETWEEN/);
  assert.match(call.sql, /a\.ops_action_on BETWEEN/);
  assert.match(call.sql, /a\.fin_action_on BETWEEN/);
  assert.ok(call.params.includes('2026-09-01 00:00:00'));
  assert.ok(call.params.includes('2026-09-30 23:59:59'));
});

test('export streams a spreadsheet of the WHOLE filtered set, not one page', async () => {
  const r = await fetch(base + '/export?jobStatus=1');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /spreadsheetml/);
  const sql = listSql();
  assert.doesNotMatch(sql, /LIMIT/i, 'an export is the whole filtered set');
  assert.match(sql, /j\.job_status NOT IN \(3, 5, 6, 7\)/, 'same filters as the screen');
});

test('list returns { items, total } so the pager knows the real size', async () => {
  const r = await fetch(base + '/?limit=20&offset=40');
  assert.equal(r.status, 200);
  const d = (await r.json()).data;
  assert.ok(Array.isArray(d.items), 'rows arrive under items');
  assert.equal(d.total, 137, 'total is the count BEFORE the limit');
  assert.equal(d.limit, 20);
  assert.equal(d.offset, 40);
});

test('the count query carries the same filters as the page query', async () => {
  fake.calls.length = 0;
  await fetch(base + '/?jobStatus=2&cityId=9');
  const count = fake.calls.find((c) => /SELECT COUNT\(\*\) AS total/i.test(c.sql));
  assert.ok(count, 'a count query ran');
  assert.match(count.sql, /j\.job_status IN \(3, 5\)/);
  assert.match(count.sql, /ci\.city_id = \?/);
  assert.doesNotMatch(count.sql, /LIMIT/i, 'the count must not be capped by the page size');
});
