'use strict';
/*
 * Charges lock at checkout (2026-09-30). Entering 3 / 5 posts the completion
 * ledger from job_material once, so a charge written afterwards would never be
 * paid and the payout would disagree with the job. Walks the REAL router, so a
 * charge route added later without the lock fails here rather than in a payout.
 *
 * Runner: `node --test --test-force-exit tests/job-charges-checkout-lock.test.js`
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
db.pool.query = async () => [[], []];
const router = require('../routes/admin/job-charges');

const WRITE = new Set(['post', 'patch', 'delete']);
const routes = router.stack
  .filter((l) => l.route)
  .map((l) => ({
    path: l.route.path,
    methods: Object.keys(l.route.methods).filter((m) => WRITE.has(m)),
    handles: l.route.stack.map((s) => s.handle),
  }))
  .filter((r) => r.methods.length);

// The one write that is not a charge: tbl_job_services billing approval.
const NOT_A_CHARGE = '/:id/services/:jobServiceId/approval';

test('every charge write route carries the checkout lock', () => {
  const charges = routes.filter((r) => r.path !== NOT_A_CHARGE);
  assert.ok(charges.length >= 7, `expected the 7 charge write routes; found ${charges.length}: the walk is broken`);
  const unlocked = charges.filter((r) => !r.handles.some((h) => h.name === 'chargesOpen'));
  assert.deepEqual(unlocked.map((r) => `${r.methods} ${r.path}`), [], 'charge routes without chargesOpen');
});

test('the lock refuses a checked-out job (3, 5) and passes an open one', () => {
  const lock = routes.flatMap((r) => r.handles).find((h) => h.name === 'chargesOpen');
  assert.ok(lock, 'chargesOpen is mounted');
  const run = (status) => {
    let code = null; let passed = false;
    const res = { status(c) { code = c; return this; }, json() { return this; } };
    lock({ params: { id: 1 }, scopedJob: { job_status: status } }, res, () => { passed = true; });
    return { code, passed };
  };
  for (const s of [3, 5, '3']) assert.deepEqual(run(s), { code: 409, passed: false }, `status ${s} must be locked`);
  for (const s of [10, 2, 16]) assert.deepEqual(run(s), { code: null, passed: true }, `status ${s} must stay open`);
});
