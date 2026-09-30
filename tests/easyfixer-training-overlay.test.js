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
 * can drift the four properties the overlay depends on —
 *
 *   1. fail OPEN (a failed lookup must never impose a restriction),
 *   2. `trainingOverdue` appears only as `true`, never as `false`,
 *   3. it must run AFTER overlayOpenJobCapabilities, so the restriction wins
 *      over the INACTIVE-with-open-jobs re-grant of the same capability,
 *   4. it withdraws `receiveNewJobs` and NOTHING ELSE — the narrowing of
 *      2026-09-07. A technician who missed a training deadline must still be
 *      able to finish, progress and submit for approval every job he already
 *      holds, and still mark attendance. Property 4 is the one this file most
 *      needs: it is invisible in the payload (three capabilities that are
 *      simply still there), so only an assertion can keep it.
 *
 * The block itself is NOT here. This overlay is display only — no offer path
 * calls it. tests/easyfixer-training-offer-block.test.js pins the predicate
 * that actually refuses the offer.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// hasOverdueTraining() is a single COUNT on easyfixer_courses; countOpenJobs()
// a single COUNT on tbl_job; pendingTraining() (the reason detail) joins
// easyfixer_courses to courses. All three are answered from these routes, so
// the tests exercise the real service functions without a DB.
let overdueCount = 0;   // number, or an Error instance to make the lookup throw
let openJobCount = 0;
let pendingRows = [];   // rows, or an Error instance to make the lookup throw

const fake = installFakePool([
  // hasOverdueTraining() is `SELECT EXISTS (… FROM easyfixer_courses ec JOIN
  // courses c …)`, so it would also match the pendingTraining route below —
  // it has to be caught first.
  [/^\s*SELECT EXISTS/i, () => {
    if (overdueCount instanceof Error) throw overdueCount;
    return [{ n: overdueCount }];
  }],
  // MUST precede the bare easyfixer_courses route: pendingTraining's statement
  // also selects FROM easyfixer_courses, and first-match-wins would otherwise
  // hand it the COUNT row and silently produce an empty course list.
  [/FROM easyfixer_courses ec\s+JOIN courses c/i, () => {
    if (pendingRows instanceof Error) throw pendingRows;
    return pendingRows;
  }],
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

// A course row shaped like pendingTraining()'s SELECT. Dates are far enough in
// the past that "overdue" is true on any day this suite ever runs.
// Mandatory and active by default: only such a course is a blocking reason.
const courseRow = (course_id, course_name, due_date, extra = {}) => ({
  course_id, course_name, due_date, videos_total: 3, videos_done: 1,
  mandatory: 1, course_status: 1, ...extra,
});

test('overdue training withdraws receiveNewJobs and NOTHING else', async () => {
  overdueCount = 1;
  pendingRows = [];
  const snapshot = snapshotFor('ACTIVE');
  const result = await lifecycle.overlayTrainingRestriction(snapshot, 8379);

  assert.equal(result.trainingOverdue, true);
  // "Exactly one": everything else is byte-identical to the input.
  assert.deepEqual(result.capabilities, {
    ...snapshot.capabilities,
    receiveNewJobs: false,
  });
  /*
   * THE NARROWING, spelled out. These three used to be withdrawn too, which
   * stranded jobs the technician had already accepted and travelled to, and
   * stopped him marking attendance for work he was doing. The product rule is
   * "block new offers only". deepEqual above already covers it; naming them
   * makes a re-tightening fail with a message that says what was broken.
   */
  assert.equal(result.capabilities.continueAssignedJobs,
    snapshot.capabilities.continueAssignedJobs,
    'a technician must be able to finish a job he already accepted');
  assert.equal(result.capabilities.mutateAssignedJobs,
    snapshot.capabilities.mutateAssignedJobs,
    'in-progress / sent-for-approval transitions must stay available');
  assert.equal(result.capabilities.markAttendance,
    snapshot.capabilities.markAttendance,
    'attendance is not a job offer');
  // And the three that were already protected: earned money, the way back in,
  // and the ability to fix your own registration.
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
  assert.equal('trainingOverdueDetail' in result, false);
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
  pendingRows = [];

  const regranted = await lifecycle.overlayOpenJobCapabilities(snapshotFor('INACTIVE'), 8379);
  assert.equal(regranted.capabilities.continueAssignedJobs, true, 'precondition: re-granted');
  assert.equal(regranted.openJobs, 2);

  const result = await lifecycle.overlayTrainingRestriction(regranted, 8379);
  assert.equal(result.capabilities.receiveNewJobs, false, 'the restriction still wins this one');
  /*
   * The re-grant SURVIVES the restriction now. This is the ordering property
   * and the narrowing meeting: a technician deactivated while holding open
   * jobs, who is also past a training deadline, keeps the app he needs to
   * close those jobs out. Withdrawing them here was the old behaviour.
   */
  assert.equal(result.capabilities.continueAssignedJobs, true);
  assert.equal(result.capabilities.mutateAssignedJobs, true);
  assert.equal(result.capabilities.markAttendance, true);
  assert.equal(result.trainingOverdue, true);
  assert.equal(result.openJobs, 2, 'the open-job counter is preserved, only capabilities change');

  openJobCount = 0;
  overdueCount = 0;
});

/*
 * trainingOverdueDetail — the WHY the app renders next to the block. The wire
 * contract: present only alongside trainingOverdue: true, { count,
 * earliestDueDate, courses[<=5] { id, title, dueDate } }, and OPTIONAL, so the
 * app must never depend on it.
 */
test('trainingOverdueDetail reports the count, the oldest deadline and up to five courses', async () => {
  overdueCount = 7;
  // pendingTraining() orders by (due_date IS NULL), due_date ASC; seven overdue
  // rows in that order, so the cap and the "earliest" pick are both exercised.
  pendingRows = [
    courseRow(11, 'Electrical Safety', '2020-01-05'),
    courseRow(12, 'Customer Handling', '2020-02-05'),
    courseRow(13, 'Water Purifier Basics', '2020-03-05'),
    courseRow(14, 'Chimney Servicing', '2020-04-05'),
    courseRow(15, 'AC Gas Charging', '2020-05-05'),
    courseRow(16, 'Invoice And Payment', '2020-06-05'),
    courseRow(17, 'Escalation Handling', '2020-07-05'),
  ];

  const result = await lifecycle.overlayTrainingRestriction(snapshotFor('ACTIVE'), 8379);

  assert.equal(result.trainingOverdue, true);
  assert.equal(result.trainingOverdueDetail.count, 7, 'the full count, not the capped list length');
  assert.equal(result.trainingOverdueDetail.earliestDueDate, '2020-01-05');
  assert.equal(result.trainingOverdueDetail.courses.length, 5, 'capped at five');
  assert.deepEqual(result.trainingOverdueDetail.courses[0],
    { id: 11, title: 'Electrical Safety', dueDate: '2020-01-05' });
  // Calendar dates stay calendar dates: YYYY-MM-DD in, YYYY-MM-DD out, no
  // timezone conversion anywhere on the way.
  for (const course of result.trainingOverdueDetail.courses) {
    assert.match(course.dueDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('a course that is not yet overdue is not listed as a reason', async () => {
  overdueCount = 1;
  pendingRows = [
    courseRow(21, 'Missed Deadline', '2020-01-05'),
    courseRow(22, 'Due Next Century', '2999-12-31'),
  ];

  const result = await lifecycle.overlayTrainingRestriction(snapshotFor('ACTIVE'), 8379);
  assert.equal(result.trainingOverdueDetail.count, 1);
  assert.deepEqual(result.trainingOverdueDetail.courses.map((c) => c.id), [21]);
});

test('an overdue OPTIONAL or RETIRED course is never listed as a reason', async () => {
  // efr 3687, 2026-09-29: "Deepskill" (not mandatory) was overdue and named
  // as "Mandatory training is overdue". Only the mandatory one may appear.
  overdueCount = 1;
  pendingRows = [
    courseRow(41, 'Deepskill', '2020-01-05', { mandatory: 0 }),
    courseRow(42, 'Retired Mandatory', '2020-01-06', { course_status: 0 }),
    courseRow(43, 'Electrician Assessment', '2020-01-07'),
  ];

  const result = await lifecycle.overlayTrainingRestriction(snapshotFor('ACTIVE'), 8379);
  assert.equal(result.trainingOverdueDetail.count, 1);
  assert.deepEqual(result.trainingOverdueDetail.courses.map((c) => c.id), [43]);

  pendingRows = [];
  overdueCount = 0;
});

test('the detail is OMITTED, never an empty husk, when the courses cannot be listed', async () => {
  // Two ways this happens in production, and both must look the same on the
  // wire: the app has to render a correct message from trainingOverdue alone.
  //   (a) the lookup throws;
  overdueCount = 1;
  pendingRows = new Error('courses table unavailable');
  let result = await lifecycle.overlayTrainingRestriction(snapshotFor('ACTIVE'), 8379);
  assert.equal(result.trainingOverdue, true, 'the block itself must survive');
  assert.equal('trainingOverdueDetail' in result, false);

  //   (b) hasOverdueTraining() counted a row pendingTraining() drops — a course
  //       with a deadline but no content yet. count: 0 with courses: [] would
  //       render as a blank parenthetical in the app.
  pendingRows = [{ ...courseRow(31, 'Empty Course', '2020-01-05'), videos_total: 0 }];
  result = await lifecycle.overlayTrainingRestriction(snapshotFor('ACTIVE'), 8379);
  assert.equal(result.trainingOverdue, true);
  assert.equal('trainingOverdueDetail' in result, false);

  pendingRows = [];
  overdueCount = 0;
});
