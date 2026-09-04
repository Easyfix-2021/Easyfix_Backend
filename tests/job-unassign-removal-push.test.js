/*
 * unassign() must tell the technician the job has left their queue — the same
 * gap the reassign path closed, on the path ops use far more often.
 *
 * Also pins that the two callers do NOT share one sentence. A reassign hands
 * the job to somebody else; an unassign returns it to the pool, where this same
 * technician may be offered it again. Claiming "reassigned to another
 * technician" on an unassign is a plain untruth in the one place the technician
 * cannot check it.
 *
 * Non-destructive: fake pool, STOP sentinel, no real DB.
 * Runner: `node --test --test-force-exit`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const scenario = { lockedJob: { job_id: 100, job_status: 1, fk_easyfixter_id: 99 } };

const fake = installFakePool(
  [
    [/FROM easyfix_properties/i, () => [{ property_key: 'job.offer.flow.enabled', property_value: 'true' }]],
    [/SHOW COLUMNS/i, []],
    [/FROM information_schema/i, [{ column_count: 6, history_count: 1 }]],
    [/SELECT 1 FROM tbl_job_offer LIMIT 1/i, [{ 1: 1 }]],
    [/SELECT job_id, job_status, fk_easyfixter_id/, () => [scenario.lockedJob]],
    [/UPDATE tbl_job\s+SET fk_easyfixter_id = NULL/, { affectedRows: 1 }],
    [/INSERT INTO scheduling_history/, { insertId: 1 }],
    [/UPDATE tbl_job_offer/, { affectedRows: 1 }],
  ],
  // Stop at the post-commit re-read. Everything under test — including the
  // fire-and-forget push — has already happened by then.
  { stopOn: /SELECT\s+j\.\*/ },
);

const propsSvc = require('../services/properties.service');
const jobSvc = require('../services/job.service');
const pushSvc = require('../services/job-offer-push.service');
const pushDelivery = require('../services/push-delivery.service');

let sent;
beforeEach(async () => {
  fake.reset();
  scenario.lockedJob = { job_id: 100, job_status: 1, fk_easyfixter_id: 99 };
  sent = [];
  await propsSvc.flushCache();
});

// Reached through require(...) at CALL TIME inside unassign(), so replacing the
// export intercepts it; a destructured import would have been captured at load.
function stubPush() {
  const real = pushSvc.sendJobRemovedPush;
  pushSvc.sendJobRemovedPush = async (efrId, opts) => { sent.push({ efrId, ...opts }); return { delivered: true }; };
  return () => { pushSvc.sendJobRemovedPush = real; };
}

test('unassign pushes the technician whose job was taken off them', async () => {
  const restore = stubPush();
  try {
    await jobSvc.unassign(100, { reason: 'Ops removed' }, { user_id: 9 }).catch(() => {});
  } finally { restore(); }

  assert.equal(sent.length, 1, 'exactly one removal push');
  assert.equal(sent[0].efrId, 99);
  assert.equal(sent[0].jobId, 100);
  assert.ok(!sent[0].reassigned, 'an unassign is NOT a reassign — the job goes back to the pool');
});

test('a job with no technician pushes nobody', async () => {
  scenario.lockedJob = { job_id: 100, job_status: 0, fk_easyfixter_id: null };
  const restore = stubPush();
  try {
    await jobSvc.unassign(100, { reason: 'Ops removed' }, { user_id: 9 }).catch(() => {});
  } finally { restore(); }

  assert.equal(sent.length, 0, 'nothing was removed, so nobody is told anything');
});

test('the unassign and reassign wordings differ, and only one claims another technician', async () => {
  const realDeliver = pushDelivery.deliverToEfr;
  const bodies = {};
  pushDelivery.deliverToEfr = async (efrId, message) => {
    bodies[message.body.includes('reassigned') ? 'reassigned' : 'unassigned'] = message.body;
    return { delivered: true, deliveredCount: 1, tokenCount: 1 };
  };
  try {
    await pushSvc.sendJobRemovedPush(99, { jobId: 100, reassigned: true });
    await pushSvc.sendJobRemovedPush(99, { jobId: 100 });
  } finally { pushDelivery.deliverToEfr = realDeliver; }

  assert.ok(bodies.reassigned && bodies.unassigned, 'both wordings must be produced');
  assert.notEqual(bodies.reassigned, bodies.unassigned);
  assert.match(bodies.reassigned, /another technician/);
  assert.doesNotMatch(
    bodies.unassigned, /another technician/,
    'an unassign returns the job to the pool — telling the technician someone else has it is false',
  );
});
