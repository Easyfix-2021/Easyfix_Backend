'use strict';
/*
 * V3 Phase 3 through the REAL mobile router (routes/mobile/index.js and its
 * sub-routers), with the DB faked and auth passed through.
 *
 *   1. 3.9 MONEY SPLIT — every mobile serializer that can carry a client price
 *      is fed a payload BUILT FROM every key in CLIENT_PRICE_KEYS (top level and
 *      nested), and its HTTP response is walked, at every depth, for any of
 *      them. The denominator is in the test name: seven routes. Because the
 *      payload is built from the list, the spec's own names are pinned
 *      separately — dropping one from the list must fail, not pass quietly.
 *   2. collectFromCustomer — present on a cash-collect job only, and equal to
 *      the invoice/estimate grand_total.
 *   3. The list decoration's query budget does not grow with the page.
 *   4. The detail's claim state (reports, cancelRequest) and pendingOn.
 *   5. Checkout: unresolved additional work forces the revisit branch.
 *   6. Cancel: proof is required and checked BEFORE the ask is recorded.
 *   7. 'Proof' photos: stored as 'proof', ids returned, window 1/2/20 only.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

let JOB_ROW; let TX_REPORTS; let JOB_FACTS; let LINES; let IMAGE_ROWS;
function resetDb() {
  JOB_ROW = { job_id: 42, job_status: 2, fk_easyfixter_id: 7, checkin_date_time: '2026-09-24 11:00:00', fk_client_id: 3 };
  TX_REPORTS = [];
  JOB_FACTS = [];
  LINES = [];
  IMAGE_ROWS = [{ image_id: 601, job_id: 42, image_category: 'proof' }, { image_id: 602, job_id: 42, image_category: 'proof' }];
}
resetDb();

let insertId = 900;
const fake = installFakePool([
  [/SELECT job_id, job_status, fk_easyfixter_id, fk_customer_id/, () => [JOB_ROW]],
  [/SELECT job_id, fk_client_id, fk_easyfixter_id, job_status\s+FROM tbl_job/, () => [JOB_ROW]],
  [/INSERT INTO tbl_job_image/, () => ({ insertId: insertId++, affectedRows: 1 })],
  [/SELECT image_id FROM tbl_job_image WHERE job_id = \? AND image_id IN/,
    (_s, [jobId, ids, cat]) => IMAGE_ROWS.filter((i) => i.job_id === jobId && ids.includes(i.image_id) && i.image_category === cat)],
  [/FROM action_taken_reason/, () => [{ id: 267, reason: 'Customer want Cancellation' }]],
  [/FROM tbl_job_tx_report\s+WHERE job_id = \? AND kind = \?/, (_s, [, kind]) => TX_REPORTS.filter((r) => r.kind === kind && ['open', 'priced', 'returned'].includes(r.status))],
  [/FROM tbl_job_tx_report\s+WHERE job_id = \? AND status IN/, () => TX_REPORTS],
  [/FROM tbl_job_tx_report\s+WHERE job_id IN/, () => TX_REPORTS.filter((r) => ['open', 'priced', 'returned'].includes(r.status))],
  [/FROM tbl_job_tx_report WHERE id = \?/, (_s, [id]) => [{ id, job_id: 42, kind: 'cancel', status: 'open', proof_image_ids: '601,602', visit_charge_awarded: 0 }]],
  [/INSERT INTO tbl_job_tx_report/, () => ({ insertId: 1, affectedRows: 1 })],
  [/INSERT INTO job_material/, () => ({ affectedRows: 1 })],
  [/UPDATE tbl_job\s+SET job_status = \?,\s+is_cancelled_by_app = 1/, () => ({ affectedRows: 1 })],
  [/CAST\(collected_by AS SIGNED\)/, () => JOB_FACTS],
  [/service_charge_description/, (_s, ids) => LINES.filter((l) => ids.includes(l.job_id))],
  [/INSERT INTO tbl_job_logs/, () => ({ insertId: 1 })],
  // V3 Phase 4 checkout gate (closeProof): the PIN was verified at arrival.
  [/AS pin_verified/, () => [{ pin_verified: 1, signed: 0 }]],
]);

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
const dashboard = require('../services/mobile-dashboard.service');
const estimate = require('../services/mobile-job-estimate.service');
const claims = require('../services/mobile-job-claims.service');
const { CLIENT_PRICE_KEYS } = require('../routes/mobile/money-split');

const originals = {};
function stub(obj, name, fn) { originals[`${name}`] = [obj, name, obj[name]]; obj[name] = fn; }

/* Every client-price key, at the top AND nested — the shape of a real leak. */
const priced = (extra = {}) => ({
  ...Object.fromEntries(CLIENT_PRICE_KEYS.map((k) => [k, 1600])),
  services: [{ job_service_id: 1, quantity: 2, billing_label: 'Paid', ...Object.fromEntries(CLIENT_PRICE_KEYS.map((k) => [k, 800])) }],
  ...extra,
});

let server; let base; let setStatusCalls = [];
before(async () => {
  stub(jobService, 'list', async () => ({ rows: [priced({ job_id: 42, job_status: 2 }), priced({ job_id: 43, job_status: 1 })], total: 2 }));
  stub(jobService, 'listOfferedForTech', async () => ({ items: [priced({ job_id: 44, job_status: 0 })] }));
  stub(jobService, 'getById', async () => priced({
    job_id: 42, job_status: 1, fk_easyfixter_id: 7, otp: null, checkin_date_time: '2026-09-24 11:00:00',
    is_cancelled_by_app: Buffer.from([1]), app_cancel_reason_name: 'Customer want Cancellation',
    cancel_date_time: '2026-09-24 12:00:00', images: [],
  }));
  stub(jobService, 'resolveJobMedia', async () => []);
  stub(jobService, 'setStatus', async (jobId, payload) => { setStatusCalls.push(payload); return { updated: true }; });
  stub(dashboard, 'getDashboard', async () => ({ todaysJobs: { items: [priced({ jobId: 42 })] }, counts: { allJobs: 1 } }));
  stub(estimate, 'listQuotationLines', async () => ({ items: [priced({ lineId: 1, name: 'Hinge', quantity: 2, amount: 500, state: 'approval_pending' })] }));
  stub(estimate, 'getRateCard', async () => ({ items: [priced({ clientRateCardId: 1, name: 'Shutter alignment', price: 800 })] }));
  stub(estimate, 'getJobMaterials', async () => ({ items: [priced({ material_id: 1, material_name: 'Hinge', price: 50, brands: [{ brand_id: 1, brand_name: 'X', price: 60 }] })] }));

  const app = express();
  app.use(express.json());
  app.use('/mobile', require('../routes/mobile/index'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const [obj, name, fn] of Object.values(originals)) obj[name] = fn;
  if (server) await new Promise((resolve) => server.close(resolve));
  fake.restore();
});

beforeEach(() => { resetDb(); fake.reset(); setStatusCalls = []; });

async function call(method, path, body) {
  const r = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}

function keysAnywhere(value) {
  const out = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); walk(x); }
  };
  walk(value);
  return out;
}

/* ─── 1. The money split, across every serializer ───────────────────── */

const SERIALIZERS = [
  ['GET', '/mobile/jobs', []],
  ['GET', '/mobile/jobs/offered', []],
  ['GET', '/mobile/jobs/42', []],
  ['GET', '/mobile/dashboard', []],
  ['GET', '/mobile/jobs/42/quotation', ['amount']],
  ['GET', '/mobile/jobs/42/rate-card', ['price']],
  ['GET', '/mobile/jobs/42/materials', ['price']],
];

test(`no client price leaves any of the ${SERIALIZERS.length} mobile serializers, at any depth`, async () => {
  // The names spec 3.9 lists, pinned literally: the payloads below are built
  // FROM the deny-list, so without this a key removed from it would vanish
  // from the test's input too and the walk would still come back clean.
  for (const k of ['total_amount', 'total_charge', 'effective_charge', 'total_cost', 'orderTotal', 'order_value',
    'client_charge', 'clientCharge', 'approved_charge', 'approvedCharge', 'unit_price']) {
    assert.ok(CLIENT_PRICE_KEYS.includes(k), `"${k}" must stay on the deny-list`);
  }
  for (const [method, path, extra] of SERIALIZERS) {
    const { status, body } = await call(method, path);
    assert.equal(status, 200, `${path} → ${status} ${JSON.stringify(body).slice(0, 200)}`);
    const keys = keysAnywhere(body.data);
    assert.ok(keys.size > 3, `${path}: the payload must have reached the response (${keys.size} keys)`);
    for (const k of [...CLIENT_PRICE_KEYS, ...extra]) assert.equal(keys.has(k), false, `${path} leaked "${k}"`);
  }
});

test('what the money split must KEEP: names, quantities, states, Free/Paid', async () => {
  const detail = (await call('GET', '/mobile/jobs/42')).body.data;
  assert.equal(detail.services[0].quantity, 2);
  assert.equal(detail.services[0].billing_label, 'Paid');
  const q = (await call('GET', '/mobile/jobs/42/quotation')).body.data.items[0];
  assert.deepEqual([q.name, q.quantity, q.state], ['Hinge', 2, 'approval_pending']);
  const m = (await call('GET', '/mobile/jobs/42/materials')).body.data.items[0];
  assert.deepEqual([m.material_name, m.brands[0].brand_name], ['Hinge', 'X']);
});

/* ─── 2. collectFromCustomer ─────────────────────────────────────────── */

test('collectFromCustomer: the bill\'s grand_total on a cash-collect job, absent on every other job', async () => {
  JOB_FACTS = [{ job_id: 42, job_status: 2, collected_by: 1 }, { job_id: 43, job_status: 1, collected_by: 2 }];
  // Job 43 is priced too, so ONLY its collected_by can keep the field off it.
  LINES = [{ job_service_id: 1, job_id: 42, quantity: 2, total_charge: 800, material_charge: 100 },
    { job_service_id: 2, job_id: 43, quantity: 1, total_charge: 500 }];
  const { body } = await call('GET', '/mobile/jobs');
  const [cash, other] = body.data.items;
  assert.equal(cash.collectFromCustomer, 1700, '800 × 2 + 100 — job-line-total\'s grand_total');
  assert.equal('collectFromCustomer' in other, false, 'collected_by 2 is not a cash-collect job');
  assert.deepEqual([cash.visitNo, cash.pendingOn, cash.waitingFor], [1, 'technician', 'working']);
  assert.deepEqual([other.pendingOn, other.waitingFor], ['technician', 'not_started']);
});

test('collectFromCustomer is absent (not ₹0) on a cash job with nothing priced', async () => {
  JOB_FACTS = [{ job_id: 42, job_status: 2, collected_by: 1 }];
  const { body } = await call('GET', '/mobile/jobs');
  assert.equal('collectFromCustomer' in body.data.items[0], false);
});

test('visitNo is 2 at status 10, or with a revisit stamp / visit_number > 1 — the My Team rule', async () => {
  const rows = [
    { job_id: 1, job_status: 10 }, { job_id: 2, job_status: 1 }, { job_id: 3, job_status: 1 }, { job_id: 4, job_status: 1 },
  ];
  JOB_FACTS = [
    { job_id: 1, job_status: 10 }, { job_id: 2, job_status: 1, visit_number: 2 },
    { job_id: 3, job_status: 1, revisit_reason_id: 4 }, { job_id: 4, job_status: 1, visit_number: 1 },
  ];
  await claims.decorateJobState(rows);
  assert.deepEqual(rows.map((r) => r.visitNo), [2, 2, 2, 1]);
});

/* ─── 3. Query budget ────────────────────────────────────────────────── */

test('decorateJobState costs the same number of queries for 1 job and for 50', async () => {
  const counts = [];
  for (const n of [1, 50]) {
    fake.reset();
    JOB_FACTS = Array.from({ length: n }, (_, i) => ({ job_id: i + 1, job_status: 2, collected_by: 1 }));
    LINES = JOB_FACTS.map((f) => ({ job_service_id: f.job_id, job_id: f.job_id, quantity: 1, total_charge: 100 }));
    await claims.decorateJobState(JOB_FACTS.map((f) => ({ job_id: f.job_id, job_status: 2 })));
    counts.push(fake.calls.filter((c) => !/easyfix_properties/.test(c.sql)).length);
  }
  assert.equal(counts[0], counts[1], `1 job: ${counts[0]} queries, 50 jobs: ${counts[1]}`);
  assert.ok(counts[0] <= 5, `pending-on 2 + tbl_job 1 + bill 2 — got ${counts[0]}`);
});

/* ─── 4. Detail claim state ──────────────────────────────────────────── */

test('the detail carries the server\'s claim state — and no client amount inside it', async () => {
  TX_REPORTS = [
    { id: 5, job_id: 42, kind: 'help', status: 'open', reason_code: 'gate', reported_on: '2026-09-24 12:10:00' },
    { id: 4, job_id: 42, kind: 'cancel', status: 'open', proof_image_ids: '601,602', visit_charge_awarded: 1, reason_text: 'x' },
    { id: 3, job_id: 42, kind: 'additional_work', status: 'priced', client_amount: 2000, tx_amount: 1000, reported_on: 'x' },
  ];
  const d = (await call('GET', '/mobile/jobs/42')).body.data;
  assert.deepEqual(d.reports.help, { id: 5, reasonCode: 'gate', reportedOn: '2026-09-24 12:10:00' });
  assert.equal(d.reports.additionalWork.status, 'priced');
  assert.deepEqual(d.cancelRequest, {
    reasonText: 'Customer want Cancellation', proofCount: 2, requestedOn: '2026-09-24 12:00:00', visitCharge: 250,
  });
  assert.equal(d.pendingOn, 'easyfix');
  assert.equal(d.waitingFor, 'help', 'help outranks the cancel ask and the priced estimate');
  const txt = JSON.stringify(d);
  assert.doesNotMatch(txt, /2000/, 'the desk\'s client price for the additional work must not reach him');
});

/* ─── 5. Checkout → revisit ──────────────────────────────────────────── */

test('checkout with additional work still waiting closes as a REVISIT (10), whatever the app sent', async () => {
  TX_REPORTS = [{ id: 3, job_id: 42, kind: 'additional_work', status: 'priced' }];
  const r = await call('POST', '/mobile/jobs/42/checkout', { isNextVisit: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(setStatusCalls.length, 1, 'the transition must have been issued');
  assert.equal(setStatusCalls[0].status, 10);
  TX_REPORTS = [];
  setStatusCalls = [];
  await call('POST', '/mobile/jobs/42/checkout', { isNextVisit: false });
  assert.equal(setStatusCalls[0].status, 3, 'no waiting work → an ordinary completion');
});

/* ─── 6. Cancel: proof first ─────────────────────────────────────────── */

const cancelUpdate = () => fake.calls.filter((c) => /is_cancelled_by_app = 1/.test(c.sql));

test('cancel without proof is refused, and a bad proof id is refused BEFORE the ask is recorded', async () => {
  assert.equal((await call('POST', '/mobile/jobs/42/cancel', { reasonId: 267 })).status, 400);
  assert.equal((await call('POST', '/mobile/jobs/42/cancel', { reasonId: 267, proofImageIds: [701] })).status, 400);
  assert.equal(cancelUpdate().length, 0, 'no half-ask: the tbl_job flag must not be set');
});

test('cancel with proof records the ask, the claim and the ₹250 for a man on site', async () => {
  const r = await call('POST', '/mobile/jobs/42/cancel', { reasonId: 267, proofImageIds: [601, 602] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(cancelUpdate().length, 1);
  assert.equal(r.body.data.requested, true);
  assert.equal(r.body.data.proofCount, 2);
  const claim = fake.calls.find((c) => /INSERT INTO tbl_job_tx_report/.test(c.sql));
  assert.equal(claim.params[2], 'cancel');
  assert.equal(claim.params[7], 2, 'the status BEFORE the request parked the job at 1');
  assert.ok(fake.calls.some((c) => /INSERT INTO job_material/.test(c.sql)), 'he reached — ₹250');
});

/* ─── 7. Proof photos ────────────────────────────────────────────────── */

test('a Proof photo is stored as "proof", returns its image id, and is refused outside 1/2/20', async () => {
  JOB_ROW.job_status = 1;
  const ok = await call('POST', '/mobile/jobs/42/images?category=Proof', { refs: ['MobileUploads/7_a'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const ins = fake.calls.find((c) => /INSERT INTO tbl_job_image/.test(c.sql));
  assert.deepEqual([ins.params[2], ins.params[3]], ['proof', 1], 'category proof, stage = the status it was taken at');
  assert.equal(ok.body.data.imageIds.length, 1);
  fake.reset();
  JOB_ROW.job_status = 3;
  assert.equal((await call('POST', '/mobile/jobs/42/images?category=Proof', { refs: ['k'] })).status, 409);
  assert.equal(fake.calls.filter((c) => /INSERT INTO tbl_job_image/.test(c.sql)).length, 0);
});

test('the new routes 404 on a job that is not his', async () => {
  JOB_ROW = { ...JOB_ROW, fk_easyfixter_id: 8 };
  for (const [m, p, b] of [
    ['GET', '/mobile/jobs/42/chat'], ['POST', '/mobile/jobs/42/chat', { body: 'hi' }],
    ['POST', '/mobile/jobs/42/help', { reason: 'gate' }], ['POST', '/mobile/jobs/42/additional-work', {}],
    ['POST', '/mobile/jobs/42/cancel/undo', {}],
  ]) assert.equal((await call(m, p, b)).status, 404, `${m} ${p}`);
});
