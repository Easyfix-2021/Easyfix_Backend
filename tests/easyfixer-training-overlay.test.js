/*
 * WHY THIS FILE EXISTS.
 *
 * The overdue-training capability overlay used to be written inline inside
 * services/tech-auth.service.js findById — i.e. on the technician-token path
 * ONLY. So the CRM, reading the very same technician, could not see the single
 * most common reason that technician's app was locked: the lifecycle read
 * reported the plain capabilities while the app showed the training wall.
 *
 * The overlay now lives once, in easyfixer-lifecycle.service.js, and both paths
 * call it. These are characterization tests: they pin the behaviour that was
 * already shipping, so the extraction cannot have changed it and no later edit
 * can drift the three properties the overlay depends on —
 *
 *   1. fail OPEN (a failed lookup must never impose a restriction),
 *   2. `trainingOverdue` appears only as `true`, never as `false`,
 *   3. it must run AFTER overlayOpenJobCapabilities, so the restriction wins
 *      over the INACTIVE-with-open-jobs re-grant of the same capabilities.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// hasOverdueTraining() is a single COUNT on easyfixer_courses; countOpenJobs()
// a single COUNT on tbl_job. Both are answered from these two routes, so the
// tests exercise the real service functions without a DB.
let overdueCount = 0;   // number, or an Error instance to make the lookup throw
let openJobCount = 0;

const fake = installFakePool([
  [/FROM easyfixer_courses/i, () => {
    if (overdueCount instanceof Error) throw overdueCount;
    return [{ n: overdueCount }];
  }],
  [/FROM tbl_job/i, () => [{ open_jobs: openJobCount }]],
]);

const lifecycle = require('../services/easyfixer-lifecycle.service');

after(() => fake.restore());

const snapshotFor = (status) => Object.freeze({
  status,
  capabilities: lifecycle.capabilitiesForStatus(status),
});

test('overdue training withdraws exactly the four work capabilities', async () => {
  overdueCount = 1;
  const snapshot = snapshotFor('ACTIVE');
  const result = await lifecycle.overlayTrainingRestriction(snapshot, 8379);

  assert.equal(result.trainingOverdue, true);
  // "Exactly those four": everything else is byte-identical to the input.
  assert.deepEqual(result.capabilities, {
    ...snapshot.capabilities,
    receiveNewJobs: false,
    continueAssignedJobs: false,
    mutateAssignedJobs: false,
    markAttendance: false,
  });
  // Spelled out as well, because these three are the ones a future "tighten the
  // restriction" change would be tempted to take: earned money, the way back
  // in, and the ability to fix your own registration.
  assert.equal(result.capabilities.claimMoney, snapshot.capabilities.claimMoney);
  assert.equal(result.capabilities.reapply, snapshot.capabilities.reapply);
  assert.equal(result.capabilities.editRegistration, snapshot.capabilities.editRegistration);
  // The input object is never mutated — callers keep the un-overlaid snapshot.
  assert.equal(snapshot.capabilities.receiveNewJobs, true);
});

test('no overdue training returns the snapshot unchanged, with no trainingOverdue key', async () => {
  overdueCount = 0;
  const snapshot = snapshotFor('ACTIVE');
  const result = await lifecycle.overlayTrainingRestriction(snapshot, 8379);

  assert.equal(result, snapshot, 'healthy path must return the same object, not a copy');
  assert.equal('trainingOverdue' in result, false,
    'emitting trainingOverdue: false would change the payload for every healthy technician');
  assert.deepEqual(result.capabilities, lifecycle.capabilitiesForStatus('ACTIVE'));
});

test('a failing overdue-training lookup fails OPEN', async () => {
  overdueCount = new Error('easyfixer_courses unavailable');
  const snapshot = snapshotFor('ACTIVE');
  const result = await lifecycle.overlayTrainingRestriction(snapshot, 8379);

  assert.equal(result, snapshot, 'a failed query must not restrict anybody');
  assert.deepEqual(result.capabilities, lifecycle.capabilitiesForStatus('ACTIVE'));
  assert.equal('trainingOverdue' in result, false);
  overdueCount = 0;
});

test('training restriction wins over the INACTIVE open-job re-grant', async () => {
  // The exact ordering tech-auth.service.js findById uses: open-job overlay
  // first (which re-GRANTS continue/mutate/attendance to a deactivated
  // technician who still owns work), then the training restriction.
  openJobCount = 2;
  overdueCount = 1;

  const regranted = await lifecycle.overlayOpenJobCapabilities(snapshotFor('INACTIVE'), 8379);
  assert.equal(regranted.capabilities.continueAssignedJobs, true, 'precondition: re-granted');
  assert.equal(regranted.openJobs, 2);

  const result = await lifecycle.overlayTrainingRestriction(regranted, 8379);
  assert.equal(result.capabilities.continueAssignedJobs, false);
  assert.equal(result.capabilities.mutateAssignedJobs, false);
  assert.equal(result.capabilities.markAttendance, false);
  assert.equal(result.capabilities.receiveNewJobs, false);
  assert.equal(result.trainingOverdue, true);
  assert.equal(result.openJobs, 2, 'the open-job counter is preserved, only capabilities change');

  openJobCount = 0;
  overdueCount = 0;
});
