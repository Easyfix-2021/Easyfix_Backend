/*
 * WHY THIS FILE EXISTS.
 *
 * Until 2026-09-07 the overdue-training restriction was DISPLAY ONLY. It lived
 * in easyfixer-lifecycle.overlayTrainingRestriction(), whose own header says
 * callers "overlay it on the snapshot they SHOW, never on the one they DECIDE
 * from" — and no offer path called it. A technician who had missed a training
 * deadline saw a locked app and could still be offered and assigned jobs by the
 * CRM, by the candidate picker and by auto-assign. The wall was a picture of a
 * wall.
 *
 * The block now lives in the one predicate every offer path already consults:
 * easyfixer-work-eligibility. Two halves, ONE condition —
 *
 *   sqlPredicate()  filters candidate lists and open-offer reads in SQL;
 *   fromRow()       is the authoritative row check, reached by
 *                   job.service.assertTechniciansCanReceiveJobs, i.e. by
 *                   offerToTechnicians, assign and acceptOffer. THIS is the
 *                   half that actually refuses a direct CRM assign, and it
 *                   reads `training_overdue` — a column
 *                   easyfixer-lifecycle.readProjection() adds to the rows
 *                   those callers already build.
 *
 * The three assertions that matter, and what each stops coming back:
 *   1. an overdue technician is not offerable          (the bug)
 *   2. an overdue technician keeps every OTHER capability — continue, mutate,
 *      attendance                                      (over-blocking, the bug
 *                                                       the fix must not cause)
 *   3. a missing column / missing migration does not restrict anyone
 *                                                      (fail OPEN)
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

let trainingColumnsPresent = 2;   // 2 = due_date + completion_date installed

const fake = installFakePool([
  // The training-deadline probe. Must precede the lifecycle probe route: both
  // read information_schema.columns and first-match-wins.
  [/information_schema\.columns[\s\S]*easyfixer_courses/i,
    () => [{ n: trainingColumnsPresent }]],
  // probeLifecycleSchema(): pretend the lifecycle migration IS installed, so
  // the predicate under test is the reconciled one production runs.
  // lms.lmsFlagColumns(): courses.is_mandatory present, so the fragment carries
  // the real mandatory predicate rather than its `1=0` degradation.
  [/information_schema\.columns[\s\S]*table_name = \?/i,
    () => [{ t: 'courses', c: 'is_mandatory' }]],
  [/tbl_easyfixer_lifecycle_status_log/i,
    () => [{ column_count: 6, history_count: 1 }]],
]);

const lifecycle = require('../services/easyfixer-lifecycle.service');
const eligibility = require('../services/easyfixer-work-eligibility.service');

after(() => fake.restore());

// An ACTIVE, verified, legacy-enabled technician: offerable on every axis
// except the one under test.
const offerableRow = (extra = {}) => ({
  efr_id: 8379,
  efr_status: 1,
  is_technician_verified: 1,
  lifecycle_status: 'ACTIVE',
  ...extra,
});

const resetProbes = () => {
  lifecycle._internals.resetSchemaProbeForTests();
  require('../services/lms.service').invalidateLmsSchemaCache();
};

test('an overdue-training technician cannot be offered a new job', async () => {
  trainingColumnsPresent = 2;
  resetProbes();

  const clear = eligibility.fromRow(offerableRow({ training_overdue: 0 }));
  assert.equal(clear.canOffer, true, 'precondition: this technician is otherwise offerable');
  assert.equal(clear.trainingOverdue, false);

  const blocked = eligibility.fromRow(offerableRow({ training_overdue: 1 }));
  assert.equal(blocked.canOffer, false,
    'overdue mandatory training must stop a NEW offer, not merely display a warning');
  assert.equal(blocked.trainingOverdue, true);
  // The 400 body and the CRM picker both render lifecycle.reason. Without a
  // training-specific one they print "ACTIVE technicians cannot receive new job
  // offers", which is the reason the product owner asked to be shown.
  assert.equal(blocked.lifecycle.reasonCode, 'TRAINING_OVERDUE');
  assert.match(blocked.lifecycle.reason, /training/i);
});

test('the block takes NEW work only — everything already accepted is untouched', async () => {
  trainingColumnsPresent = 2;
  resetProbes();

  const blocked = eligibility.fromRow(offerableRow({ training_overdue: 1 }));
  const plain = lifecycle.capabilitiesForStatus('ACTIVE');
  /*
   * The product rule: "block new offers only ... Tx should be able to take all
   * actions on jobs already accepted by Tx and job which are in accepted and
   * further status like in progress, sent for approval, etc". Over-blocking
   * here would strand a job a customer is waiting on, which is the failure
   * this whole change exists to remove.
   */
  assert.equal(blocked.lifecycle.capabilities.continueAssignedJobs,
    plain.continueAssignedJobs, 'must still finish an accepted job');
  assert.equal(blocked.lifecycle.capabilities.mutateAssignedJobs,
    plain.mutateAssignedJobs, 'must still move it to in-progress / sent for approval');
  assert.equal(blocked.lifecycle.capabilities.markAttendance,
    plain.markAttendance, 'attendance is not a job offer');
  assert.equal(blocked.lifecycle.capabilities.claimMoney, plain.claimMoney);
  // Only receiveNewJobs moved.
  assert.deepEqual(blocked.lifecycle.capabilities, { ...plain, receiveNewJobs: false });
});

test('a genuine lifecycle reason is not overwritten by the training one', async () => {
  trainingColumnsPresent = 2;
  resetProbes();

  const blacklisted = eligibility.fromRow({
    efr_id: 8379,
    efr_status: 0,
    is_technician_verified: 1,
    lifecycle_status: 'BLACKLISTED',
    lifecycle_reason: 'Documents found to be forged',
    training_overdue: 1,
  });
  assert.equal(blacklisted.canOffer, false);
  assert.equal(blacklisted.lifecycle.reason, 'Documents found to be forged',
    'training is the lesser reason; it must not hide why the technician is really blocked');
  assert.notEqual(blacklisted.lifecycle.reasonCode, 'TRAINING_OVERDUE');
});

test('an absent training_overdue column restricts nobody', async () => {
  trainingColumnsPresent = 2;
  resetProbes();
  // A caller whose SELECT predates readProjection's new column, or a row read
  // in a test. Absence must read as "not overdue" — a restriction imposed
  // because a value was missing is the mirror of the fail-OPEN property the
  // display overlay already holds.
  assert.equal(eligibility.fromRow(offerableRow()).canOffer, true);
  assert.equal(eligibility.fromRow(offerableRow()).trainingOverdue, false);
  assert.equal(eligibility.fromRow(offerableRow({ training_overdue: null })).canOffer, true);
});

test('readProjection ships the column the offer gate decides from', async () => {
  trainingColumnsPresent = 2;
  resetProbes();

  const projection = await lifecycle.readProjection('e');
  assert.match(projection, /AS training_overdue/,
    'the offer gate builds its rows from this projection and nothing else');
  assert.match(projection, /FROM easyfixer_courses ec/);
  // The overdue rule itself, restated in SQL: not finished, had a deadline,
  // deadline is in the past. Dates compared as dates — no timezone conversion.
  assert.match(projection, /ec\.completion_date IS NULL/);
  assert.match(projection, /ec\.due_date IS NOT NULL/);
  assert.match(projection, /ec\.due_date < '\d{4}-\d{2}-\d{2}'/);
  // ONLY a mandatory, active course with content blocks (efr 3687: an optional
  // "Deepskill" assignment with a lapsed deadline blocked his offers).
  assert.match(projection, /c\.is_mandatory = 1/);
  assert.match(projection, /c\.status = 1/);
  assert.match(projection, /FROM lms_content lc WHERE lc\.course_id = ec\.course_id/);
});

test('sqlPredicate carries the same condition, so lists and the row gate agree', async () => {
  trainingColumnsPresent = 2;
  resetProbes();

  const predicate = await eligibility.sqlPredicate('e');
  assert.match(predicate, /AND NOT EXISTS/,
    'candidate lists must not surface a technician the write gate will refuse');
  assert.match(predicate, /FROM easyfixer_courses ec/);
  // Both halves are generated from lifecycle.overdueTrainingSql(), so they
  // cannot drift into disagreeing about who is overdue.
  assert.ok(predicate.includes(await lifecycle.overdueTrainingSql('e')));
});

test('a database without the training-deadline migration blocks nobody', async () => {
  // due_date / completion_date arrived in a migration. readProjection feeds
  // every authenticated mobile request and the CRM easyfixer lists, so naming
  // a column that is not there would 500 all of them; and a technician must
  // never be restricted because a schema probe came back empty.
  trainingColumnsPresent = 0;
  resetProbes();

  const projection = await lifecycle.readProjection('e');
  assert.match(projection, /0 AS training_overdue/);
  assert.doesNotMatch(projection, /easyfixer_courses/);

  const predicate = await eligibility.sqlPredicate('e');
  assert.doesNotMatch(predicate, /easyfixer_courses/);

  trainingColumnsPresent = 2;
  resetProbes();
});

test('an invalid alias never reaches the generated SQL', async () => {
  assert.throws(() => lifecycle.overdueTrainingSql('e; DROP TABLE tbl_job --'), /invalid SQL alias/);
  await assert.rejects(lifecycle.readProjection('e); --'), /invalid SQL alias/);
});
