/*
 * The customer's raw mobile never reaches the technician's device.
 *
 * The app never shows or dials it — calls go through the masked /customer-call
 * bridge, which resolves the number server-side — and GET /jobs/:id already
 * stripped it (2026-07-08). But three other technician routes still sent it:
 *   GET /jobs          customer_mob_no (jobService.list is the CRM's list too)
 *   GET /jobs/offered  customer_mob_no — to technicians who have not even
 *                      accepted the job
 *   GET /jobs/search   customerMobile
 * All closed 2026-09-11 (utils/mask-mobile.js stripCustomerMobiles, which nulls
 * every CUSTOMER_MOBILE_FIELDS key). The Expo app reads none of them.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');
const { stripCustomerMobiles } = require('../utils/mask-mobile');

const NUMBER = '9123456780';
const SEARCH_ROW = {
  job_id: 9, job_reference_id: 'R9', client_ref_id: null, job_status: 1, job_type: 'Installation',
  requested_date_time: '2026-09-11 10:00:00', time_slot: '10-12', customer_name: 'A', customer_mob_no: NUMBER,
  address: 'x', locality: 'y', landmark: null, pin_code: '560001', gps_location: null, city_name: 'B',
  client_name: 'C', service_category: 'AC',
};
const fake = installFakePool([[/FROM tbl_job j/, (sql) => [
  /customer_mob_no/.test(sql) ? SEARCH_ROW : Object.fromEntries(Object.entries(SEARCH_ROW).filter(([k]) => k !== 'customer_mob_no')),
]]]);

for (const [rel, exports] of [
  ['../middleware/tech-auth', (req, _res, next) => { req.tech = { efr_id: 7 }; next(); }],
  ['../middleware/require-tech-lifecycle-capability', {
    requireTechCapability: () => (_req, _res, next) => next(),
    requireTechJobMutationCapability: (_req, _res, next) => next(),
  }],
  ['../middleware/idempotency', () => (_req, _res, next) => next()],
]) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const jobService = require('../services/job.service');
const ROW = { job_id: 42, fk_easyfixter_id: 7, job_status: 1, customer_name: 'A', customer_mob_no: NUMBER,
  alternate_no: '9000000001', easyfixer_mobile: '9888888888' };
const saved = {};
let server;
let base;
before(async () => {
  for (const k of ['list', 'listOfferedForTech', 'getById']) saved[k] = jobService[k];
  jobService.list = async () => ({ rows: [{ ...ROW }], total: 1 });
  jobService.listOfferedForTech = async () => ({ items: [{ ...ROW, fk_easyfixter_id: null }] });
  jobService.getById = async () => ({ ...ROW, customer: { phone: NUMBER } });
  const app = express();
  app.use(express.json());
  app.use('/mobile', require('../routes/mobile/index'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/mobile`;
});
after(async () => {
  Object.assign(jobService, saved);
  await new Promise((r) => server.close(r));
  if (fake.restore) fake.restore();
});

const getJson = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };

for (const route of ['/jobs', '/jobs/offered', '/jobs/42']) {
  test(`GET ${route} carries no customer number`, async () => {
    const r = await getJson(route);
    assert.equal(r.status, 200, 'positive control: the route answered');
    assert.ok(r.text.includes('"job_id":42'), 'positive control: the job is in the payload');
    assert.ok(!r.text.includes(NUMBER), 'the customer\'s number must not reach the device');
    assert.ok(!r.text.includes('9000000001'), 'nor the alternate customer number');
  });
}

test('the technician\'s OWN number is not a customer number and stays', async () => {
  assert.ok((await getJson('/jobs')).text.includes('9888888888'));
});

test('GET /jobs/search carries no customer number and no longer reads it', async () => {
  const svc = require('../services/mobile-job-lifecycle.service');
  fake.calls.length = 0;
  const out = await svc.searchByJobId(9, 7);
  assert.ok(out && out.jobId === 9, 'positive control: the job was found');
  assert.ok(!JSON.stringify(out).includes(NUMBER));
  assert.doesNotMatch(fake.calls.find((c) => /FROM tbl_job j/.test(c.sql)).sql, /customer_mob_no/);
});

test('stripCustomerMobiles nulls every customer field at any depth and never mutates its input', () => {
  const input = { items: [{ customer_mob_no: '1', nested: { alternate_no: '2', customer_mobile: '3' }, efr_no: '4' }], total: 1 };
  const out = stripCustomerMobiles(input);
  assert.deepEqual(out, { items: [{ customer_mob_no: null, nested: { alternate_no: null, customer_mobile: null }, efr_no: '4' }], total: 1 });
  assert.equal(input.items[0].customer_mob_no, '1', 'the rows may be shared — the input must be untouched');
});
