/*
 * GET /api/mobile/jobs/search must not carry the customer PIN.
 *
 * services/mobile-job-lifecycle.service.js searchByJobId returned
 * `checkinPin: row.otp` — tbl_job.otp, the CLOSING PIN the technician must read
 * back from the customer — so the assigned technician could close a job
 * without them. The app never read the key. (GET /jobs/:id, the other route
 * that leaked it, is pinned in tests/mobile-close-pin.test.js.)
 *
 * Runner: `node --test` (see npm test).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const ROW = {
  job_id: 9, job_reference_id: 'R9', client_ref_id: null, job_status: 1, job_type: 'Installation',
  requested_date_time: '2026-09-11 10:00:00', time_slot: '10-12', otp: '7391',
  customer_name: 'A', customer_mob_no: '9000000000', address: 'x', locality: 'y', landmark: null,
  pin_code: '560001', gps_location: null, city_name: 'Bengaluru', client_name: 'C', service_category: 'AC',
};
const fake = installFakePool([[/FROM tbl_job j/, (sql) => [
  // Whatever the query selects, answer with what the row really holds, so a
  // re-added `j.otp` in the SELECT would reach the mapper and be caught below.
  /j\.otp/.test(sql) ? ROW : Object.fromEntries(Object.entries(ROW).filter(([k]) => k !== 'otp')),
]]]);
after(() => fake.restore && fake.restore());

const svc = require('../services/mobile-job-lifecycle.service');

test('the search summary carries no PIN, under any name', async () => {
  const out = await svc.searchByJobId(9, 7);
  assert.ok(out && out.jobId === 9, 'positive control: the job was found and mapped');
  assert.ok(!JSON.stringify(out).includes(ROW.otp), 'the PIN value appears nowhere in the payload');
  assert.deepEqual(Object.keys(out).filter((k) => /pin|otp/i.test(k) && k !== 'pincode'), [],
    'no PIN-shaped key');
});

test('the search query no longer selects the PIN at all', () => {
  const q = fake.calls.find((c) => /FROM tbl_job j/.test(c.sql));
  assert.ok(q, 'positive control: the search ran its query');
  assert.doesNotMatch(q.sql, /\bj\.otp\b/, 'a column nobody maps should not be read');
});
