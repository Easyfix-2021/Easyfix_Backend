'use strict';
/*
 * V3 Phase 4 rules with no route around them:
 *   1. pending-on: a revisit (10) waiting for visit 2 is EasyFix's —
 *      schedule_visit2, band A — ahead of "submitted for audit".
 *   2. lib/job-stages: 10 → 1 is a move the Under Audit stage may make, and
 *      nothing else changed for anybody.
 *   3. The four Phase 4 history writers: their log_for, and no free text.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([[/INSERT INTO tbl_job_logs/i, () => ({ insertId: 1 })]]);

const { pendingOnForJobs, _internals: { decide } } = require('../services/job-pending-on');
const { STAGES, transitionAllowed } = require('../lib/job-stages');
const jobLog = require('../services/job-log.service');

const d = (status, facts = {}, reports = []) => decide({ job_status: status }, facts, reports);
const VISIT2 = { pendingOn: 'easyfix', waitingFor: 'schedule_visit2', band: 'A', situation: 'visit_two_pending' };

/* ─── 1. Pending on ──────────────────────────────────────────────────── */

test('a revisit waiting for visit 2 is the desk\'s: schedule_visit2, band A', () => {
  assert.deepEqual(d(10, { visit_number: 2 }), VISIT2, 'the checkout counted the visit');
  assert.deepEqual(d(10, { revisit_reason_id: 4 }), VISIT2, 'he said he is coming back');
  assert.deepEqual(d(10, { revisit_date: '2026-09-26 10:00:00' }), VISIT2);
  assert.deepEqual(d(10, {}, [{ kind: 'additional_work', status: 'priced' }]), VISIT2, 'extra work in flight');
  // Ahead of rule 9: before this rule every one of these read "submitted for audit".
  assert.deepEqual(d(10, { visit_number: 2, verified_on: null }), VISIT2);
});

test('what schedule_visit2 must NOT swallow', () => {
  assert.equal(d(10).waitingFor, 'audit', 'a 10 with no revisit marker is Under Audit, as before');
  assert.equal(d(10, { visit_number: 1 }).waitingFor, 'audit');
  assert.equal(d(10, {}, [{ kind: 'additional_work', status: 'open' }]).waitingFor, 'pricing', 'unpriced work is priced first');
  assert.equal(d(3, { visit_number: 2 }).waitingFor, 'audit', 'visit 2 finished → audit, not another visit');
  assert.equal(d(1, { visit_number: 2 }).waitingFor, 'not_started', 'visit 2 booked → his move');
});

test('the facts come from the SAME batched query, not a third one', async () => {
  fake.reset();
  await pendingOnForJobs(require('../db').pool, [{ job_id: 1, job_status: 10 }, { job_id: 2, job_status: 2 }]);
  assert.equal(fake.calls.length, 2);
  const factsQ = fake.calls.find((c) => /LEFT JOIN tbl_job_verification/.test(c.sql));
  assert.match(factsQ.sql, /j\.visit_number, j\.revisit_reason_id, j\.revisit_date/);
});

/* ─── 2. The stage transition ────────────────────────────────────────── */

test('10 → 1 (schedule visit 2) is permitted to an Under Audit holder, and to nobody new', () => {
  const audit = { mode: 'list', stages: ['audit-complete'] };
  assert.equal(transitionAllowed(audit, 10, 1), true);
  assert.equal(transitionAllowed(audit, 10, 3), true, 'the old moves stay');
  // Source-anchored: holding the TARGET stage is not enough to reach into 10.
  assert.equal(transitionAllowed({ mode: 'list', stages: ['pending-start'] }, 10, 1), false);
  assert.equal(transitionAllowed({ mode: 'list', stages: ['pending-close'] }, 10, 1), false);
  // Only audit-complete gained a target.
  const targetsWith1 = Object.entries(STAGES).filter(([, s]) => s.targets.includes(1)).map(([k]) => k).sort();
  assert.deepEqual(targetsWith1, ['audit-complete', 'estimate-pending', 'onhold', 'pending-scheduling']);
  assert.deepEqual(STAGES['audit-complete'].targets, [3, 5, 6, 1]);
});

/* ─── 3. History writers ─────────────────────────────────────────────── */

const inserts = () => fake.calls.filter((c) => /INSERT INTO tbl_job_logs/i.test(c.sql));
const COL = Object.fromEntries(jobLog.COLUMNS.map((c, i) => [c, i]));

test('the four Phase 4 writers: own log_for, <token>_<jobId>, closed old_data', async () => {
  const cases = [
    [() => jobLog.logSignatureTaken(42, {}, { efr_id: 9 }), 'signature taken', 'signature_42', null],
    [() => jobLog.logToolsSet(42, { count: 3 }, { user_id: 7 }), 'tools set', 'toolsSet_42', 'Count: 3'],
    [() => jobLog.logToolsSet(42, { count: 0 }, { user_id: 7 }), 'tools set', 'toolsSet_42', 'Count: 0'],
    [() => jobLog.logSiteProductsChanged(42, { change: 'removed' }, { user_id: 7 }), 'site products changed', 'siteProducts_42', 'Change: removed'],
    [() => jobLog.logVisitTwoScheduled(42, { visitNumber: 2 }, { user_id: 7 }), 'visit two scheduled', 'visitTwo_42', 'Visit: 2'],
  ];
  for (const [write, logFor, newData, oldData] of cases) {
    fake.reset();
    await write();
    const q = inserts()[0];
    assert.ok(q, `${logFor}: a row must be written`);
    assert.deepEqual([q.params[COL.log_for], q.params[COL.new_data], q.params[COL.old_data], q.params[COL.eta_status]],
      [logFor, newData, oldData, null]);
  }
});

test('free text or a bad number writes NO row', async () => {
  for (const write of [
    () => jobLog.logToolsSet(42, { count: 'drill, hammer' }, { user_id: 7 }),
    () => jobLog.logToolsSet(42, { count: -1 }, { user_id: 7 }),
    () => jobLog.logSiteProductsChanged(42, { change: 'Customer has a Bosch geyser' }, { user_id: 7 }),
    () => jobLog.logVisitTwoScheduled(42, { visitNumber: 0 }, { user_id: 7 }),
  ]) {
    fake.reset();
    assert.equal(await write(), null);
    assert.equal(inserts().length, 0);
  }
});
