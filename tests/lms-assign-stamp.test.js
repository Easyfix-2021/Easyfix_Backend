const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * Assignment-time completion stamping.
 *
 * THE BUG THIS PINS (found 2026-08-21, live):
 *
 * stampCourseCompletions() was reachable from exactly ONE place — the mobile
 * progress ping. So assigning a course to a technician who had ALREADY
 * watched every video in it left completion_date NULL indefinitely: he had
 * nothing left to watch, so he had no reason to ping, so nothing ever stamped
 * him complete.
 *
 * That is not cosmetic. hasOverdueTraining() reads completion_date and runs on
 * EVERY authenticated mobile request; once the due date passed, tech-auth
 * zeroed receiveNewJobs / continueAssignedJobs / mutateAssignedJobs /
 * markAttendance. The technician was blocked from earning, for training he had
 * already completed, with no action available to him that would clear it.
 *
 * On the real dataset that was armed and waiting: 2,439 technicians have
 * watched all three induction videos to 100%.
 */

let scenario = [];
const fake = installFakePool([[/.*/, (sql, params) => {
  for (const [re, rows] of scenario) if (re.test(sql)) return typeof rows === 'function' ? rows(sql, params) : rows;
  return [];
}]]);
const lms = require('../services/lms.service');

after(() => fake.restore());

const STAMP = /UPDATE easyfixer_courses ec\s+SET ec\.completion_date/i;

function stampCall() {
  return fake.calls.find((c) => STAMP.test(c.sql));
}

test('assignCourse stamps completion for technicians who already finished the content', async () => {
  fake.reset();
  scenario = [
    [/FROM course_videos WHERE course_id/i, [{ n: 3 }]],
    [/SELECT efr_id FROM tbl_easyfixer/i, (sql, params) => params.map((efr_id) => ({ efr_id }))],
    [/FROM courses/i, [{ id: 4, name: 'Induction', status: 1 }]],
    [/INSERT INTO easyfixer_courses/i, { affectedRows: 1 }],
    [STAMP, { affectedRows: 3 }],
  ];
  const out = await lms.assignCourse(4, [11, 22, 33], { durationDays: 30 });
  assert.equal(out.alreadyComplete, 3,
    'the three who had already watched everything are resolved at assignment time');
  const call = stampCall();
  assert.ok(call, 'the stamp must run as part of assignment');
});

test('the stamp is ONE statement for the whole batch, not one per technician', async () => {
  fake.reset();
  scenario = [
    [/FROM course_videos WHERE course_id/i, [{ n: 3 }]],
    [/SELECT efr_id FROM tbl_easyfixer/i, (sql, params) => params.map((efr_id) => ({ efr_id }))],
    [/FROM courses/i, [{ id: 4, name: 'Induction', status: 1 }]],
    [/INSERT INTO easyfixer_courses/i, { affectedRows: 1 }],
    [STAMP, { affectedRows: 0 }],
  ];
  await lms.assignCourse(4, [1, 2, 3, 4, 5, 6, 7, 8], { durationDays: 30 });
  const stamps = fake.calls.filter((c) => STAMP.test(c.sql));
  assert.equal(stamps.length, 1,
    'assignCourse accepts up to 500 technicians — a per-technician stamp would be 500 round trips');
});

test('the stamp only touches rows still NULL, so re-assigning cannot rewrite a completion date', async () => {
  fake.reset();
  scenario = [[STAMP, { affectedRows: 0 }]];
  await lms.stampCompletionsForCourse(4, [1, 2]);
  const sql = stampCall().sql;
  assert.match(sql, /ec\.completion_date IS NULL/,
    'idempotent — a second call must be a no-op, not a re-stamp with today\'s date');
});

test('the stamp requires the course to HAVE content — an empty course is never vacuously complete', async () => {
  fake.reset();
  scenario = [[STAMP, { affectedRows: 0 }]];
  await lms.stampCompletionsForCourse(4, [1]);
  const sql = stampCall().sql;
  assert.match(sql, /EXISTS \(SELECT 1 FROM course_videos/,
    'without this, a course with no videos has no video below the threshold and stamps instantly');
  assert.match(sql, /NOT EXISTS/, 'and completion still means no video below COMPLETION_PERCENT');
});

test('the stamp is scoped to the course and the technicians just assigned', async () => {
  fake.reset();
  scenario = [[STAMP, { affectedRows: 0 }]];
  await lms.stampCompletionsForCourse(7, [101, 102]);
  const call = stampCall();
  assert.match(call.sql, /ec\.course_id = \?/);
  assert.match(call.sql, /ec\.easyfixer_id IN \(\?,\?\)/);
  // [now, now, courseId, ...ids, COMPLETION_PERCENT]
  assert.equal(call.params[2], 7);
  assert.deepEqual(call.params.slice(3, 5), [101, 102]);
  assert.equal(call.params[5], 100, 'COMPLETION_PERCENT is 100 and is not a tunable');
});

test('an empty technician list issues no statement at all', async () => {
  fake.reset();
  scenario = [];
  const r = await lms.stampCompletionsForCourse(4, []);
  assert.deepEqual(r, { stamped: 0 });
  assert.equal(stampCall(), undefined);
});

test('a failing stamp does NOT fail the assignment the operator just made', async () => {
  fake.reset();
  scenario = [
    [/FROM course_videos WHERE course_id/i, [{ n: 3 }]],
    [/SELECT efr_id FROM tbl_easyfixer/i, (sql, params) => params.map((efr_id) => ({ efr_id }))],
    [/FROM courses/i, [{ id: 4, name: 'Induction', status: 1 }]],
    [/INSERT INTO easyfixer_courses/i, { affectedRows: 1 }],
    [STAMP, () => { throw new Error('simulated outage'); }],
  ];
  const out = await lms.assignCourse(4, [11], { durationDays: 30 });
  assert.equal(out.assigned, 1, 'the assignment stands');
  assert.equal(out.alreadyComplete, 0, 'and degrades to the pre-existing behaviour');
});
