'use strict';
/*
 * V3 Phase 4 through the REAL mobile router, the DB faked and auth passed
 * through.
 *
 *   1. GET /jobs list tags (approvedOn, travelCharge, isNewCustomer,
 *      materialBought) — ONE query for the page whatever its size, and done in
 *      the mobile route, never in the shared jobService.list.
 *   2. GET /jobs/:id carries tools, siteProducts, signatureOn, pinVerified.
 *   3. Checkout: the revisit branch asks setStatus to count the visit, and
 *      setStatus does it in its own UPDATE (not again from 10).
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

let TAGS; let PROOF; let JOB_META;
function reset() {
  TAGS = {
    42: { job_id: 42, approved_on_date_time: '2026-09-23 16:00:00', travel_charge: '180.00', new_customer: 1, material_approved: 1 },
    43: { job_id: 43, approved_on_date_time: null, travel_charge: null, new_customer: 0, material_approved: 1 },
    44: { job_id: 44, approved_on_date_time: null, travel_charge: '0', new_customer: null, material_approved: 1 },
  };
  PROOF = { pin_verified: 1, signed: 0 };
  JOB_META = { job_id: 42, job_status: 2, fk_easyfixter_id: 7, otp: null };
}
reset();

const fake = installFakePool([
  [/AS material_approved/, (_s, [ids]) => ids.map((id) => TAGS[id] || { job_id: id })],
  [/AS pin_verified/, () => [PROOF]],
  [/CAST\(collected_by AS SIGNED\)/, (_s, [ids]) => ids.map((id) => ({ job_id: id, job_status: id === 44 ? 1 : 10 }))],
  [/FROM tbl_job_tool jt/, () => [{ job_id: 42, tool_id: 3, tool_name: 'Drill' }]],
  [/FROM tbl_job_site_product/, () => [{ id: 9, job_id: 42, name: 'Geyser', qty: 1, brand: null }]],
  [/FROM tbl_job_signature WHERE job_id IN/, () => [{ job_id: 42, signed_on: '2026-09-24 13:00:00' }]],
  // setStatus (section 3): the job-meta read, and a photo so the close is allowed.
  [/FROM\s+tbl_job\s+WHERE\s+job_id/i, () => [JOB_META]],
  [/FROM tbl_job_image/, () => [{ 1: 1 }]],
  [/INFORMATION_SCHEMA/i, () => [{ n: 3 }]],
], { stopOn: /UPDATE\s+tbl_job\s+SET/i });

for (const [mod, exports] of [
  ['../middleware/tech-auth', (req, _res, next) => { req.tech = { efr_id: 7, user_id: 70 }; next(); }],
  ['../middleware/require-tech-lifecycle-capability', {
    requireTechCapability: () => (_req, _res, next) => next(),
    requireTechJobMutationCapability: (_req, _res, next) => next(),
  }],
  ['../middleware/idempotency', () => (_req, _res, next) => next()],
]) {
  const id = require.resolve(mod);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const jobService = require('../services/job.service');
const claims = require('../services/mobile-job-claims.service');

const originals = [];
function stub(obj, name, fn) { originals.push([obj, name, obj[name]]); obj[name] = fn; }

let LIST_ROWS = []; let setStatusCalls = [];
let server; let base;
before(async () => {
  stub(jobService, 'list', async () => ({ rows: LIST_ROWS.map((r) => ({ ...r })), total: LIST_ROWS.length }));
  stub(jobService, 'getById', async () => ({ job_id: 42, job_status: 2, fk_easyfixter_id: 7, otp: null, images: [] }));
  stub(jobService, 'resolveJobMedia', async () => []);
  stub(jobService, 'setStatus', async (jobId, payload) => { setStatusCalls.push(payload); return { updated: true }; });
  stub(claims, 'hasUnresolvedAdditionalWork', async () => false);
  const app = express();
  app.use(express.json());
  app.use('/mobile', require('../routes/mobile/index'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  for (const [o, n, f] of originals) o[n] = f;
  if (server) await new Promise((resolve) => server.close(resolve));
  fake.restore();
});
beforeEach(() => { reset(); fake.reset(); setStatusCalls = []; });

async function call(method, p, body) {
  const r = await fetch(base + p, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}

/* ─── 1. List tags ───────────────────────────────────────────────────── */

test('list tags: APPROVED, TRAVEL (his tx money, absent at 0), NEW CUSTOMER, MATERIAL BOUGHT only on a revisit', async () => {
  LIST_ROWS = [{ job_id: 42, job_status: 10 }, { job_id: 43, job_status: 10 }, { job_id: 44, job_status: 1 }];
  const { status, body } = await call('GET', '/mobile/jobs');
  assert.equal(status, 200, JSON.stringify(body));
  const [a, b, c] = body.data.items;
  assert.deepEqual([a.approvedOn, a.travelCharge, a.isNewCustomer, a.materialBought, a.visitNo],
    ['2026-09-23 16:00:00', 180, true, true, 2]);
  assert.deepEqual([b.approvedOn, 'travelCharge' in b, b.isNewCustomer, b.materialBought], [null, false, false, true]);
  assert.deepEqual(['travelCharge' in c, c.isNewCustomer, c.materialBought], [false, null, false],
    'no travel row = absent (not ₹0); no customer = unknown; approved material on visit 1 is not "bought"');
  const q = fake.calls.find((x) => /AS material_approved/.test(x.sql));
  assert.match(q.sql, /m\.type = 'Travel'/);
  assert.match(q.sql, /SUM\(m\.tx_charge\)/, 'his money, never client_charge');
  assert.match(q.sql, /q\.client_status = 1/, 'the shared client-approved predicate');
  assert.match(q.sql, /NOT LIKE 'Additional work%'/, 'the desk\'s additional-work price line is not "material"');
});

test('list tags cost ONE query for one job and for fifty', async () => {
  for (const n of [1, 50]) {
    fake.reset();
    LIST_ROWS = Array.from({ length: n }, (_, i) => ({ job_id: 5000 + i, job_status: 1 }));
    const { body } = await call('GET', '/mobile/jobs');
    assert.equal(body.data.items.length, n, 'positive control');
    assert.ok(body.data.items.every((it) => 'materialBought' in it), 'every row was decorated');
    assert.equal(fake.calls.filter((x) => /AS material_approved/.test(x.sql)).length, 1, `${n} job(s)`);
  }
});

test('the tags are added by the mobile route, never inside the shared jobService.list', () => {
  const svc = fs.readFileSync(path.join(__dirname, '..', 'services', 'job.service.js'), 'utf8');
  for (const k of ['material_approved', 'travelCharge', 'isNewCustomer', 'materialBought']) {
    assert.equal(svc.includes(k), false, `${k} must not be in job.service.js — the CRM list and XLSX export read it`);
  }
});

/* ─── 2. Detail ──────────────────────────────────────────────────────── */

test('detail carries tools, products at site, the signature date and pinVerified', async () => {
  const { status, body } = await call('GET', '/mobile/jobs/42');
  assert.equal(status, 200, JSON.stringify(body));
  const d = body.data;
  assert.deepEqual(d.tools, [{ id: 3, name: 'Drill' }]);
  assert.deepEqual(d.siteProducts, [{ id: 9, name: 'Geyser', qty: 1, brand: null }]);
  assert.equal(d.signatureOn, '2026-09-24 13:00:00');
  assert.equal(d.pinVerified, true);
  const proofQ = fake.calls.find((x) => /AS pin_verified/.test(x.sql));
  assert.deepEqual(proofQ.params, [42, 'customer pin verified', 42]);
  PROOF = { pin_verified: 0, signed: 0 };
  assert.equal((await call('GET', '/mobile/jobs/42')).body.data.pinVerified, false);
});

/* ─── 3. Visit number ────────────────────────────────────────────────── */

test('a revisit checkout asks setStatus to count the visit; a completion does not', async () => {
  let r = await call('POST', '/mobile/jobs/42/checkout', { isNextVisit: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(setStatusCalls[0].status, 10);
  assert.equal(setStatusCalls[0].extras.bump_visit_number, true);
  setStatusCalls = [];
  r = await call('POST', '/mobile/jobs/42/checkout', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(setStatusCalls[0].status, 3);
  assert.equal('bump_visit_number' in setStatusCalls[0].extras, false);
});

const realSetStatus = () => originals.find(([o, n]) => o === jobService && n === 'setStatus')[2];
async function runSetStatus(existingStatus, extras) {
  JOB_META = { job_id: 42, job_status: existingStatus, fk_easyfixter_id: 7, otp: null };
  fake.reset();
  try { await realSetStatus()(42, { status: 10, extras }, { user_id: 7, efr_id: 7 }); } catch (e) { if (!e.__stop) throw e; }
  return fake.calls.find((c) => /UPDATE\s+tbl_job\s+SET/i.test(c.sql));
}

test('setStatus counts the visit in its own UPDATE, never from a job already at 10, never as a column', async () => {
  let upd = await runSetStatus(2, { app_checkout_date_time: new Date(), bump_visit_number: true });
  assert.ok(upd, 'positive control: the UPDATE was issued');
  assert.match(upd.sql, /visit_number = COALESCE\(visit_number, 1\) \+ 1/);
  assert.equal(upd.sql.includes('bump_visit_number'), false, 'the flag is not a column');
  upd = await runSetStatus(10, { bump_visit_number: true });
  assert.ok(upd);
  assert.doesNotMatch(upd.sql, /visit_number/, 'a retry from 10 is the same visit');
  upd = await runSetStatus(2, { app_checkout_date_time: new Date() });
  assert.doesNotMatch(upd.sql, /visit_number/, 'no flag, no count — the CRM close is unchanged');
});
