const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dashboard = require('../services/mobile-dashboard.service');
const { pool } = require('../db');

test.after(async () => {
  await pool.end();
});

/*
 * Regression: a technician checked into job 533336 — booked for an appointment
 * 16 days out — and it disappeared from Home. Both halves of "Today's Jobs"
 * bucketed on the APPOINTMENT date for all three active statuses, so starting
 * the job moved it into `upcoming` and out of the only screen that lists it.
 */
const { dedupeById, isStarted, isTodaysWork } = dashboard._internals;

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/** Checked in TODAY, booked for an appointment 16 days out — the reported job. */
const startedFutureJob = {
  job_id: 533336,
  job_status: 2,
  requested_date_time: '2026-09-17 11:00:00',
  checkin_date_time: now(),
};
/** Checked in months ago and never closed. Real: every started job in QA looks
 *  like this, 132-287 days stale. It is not today's work and must not be shown. */
const abandonedStartedJob = {
  job_id: 400001,
  job_status: 2,
  requested_date_time: '2025-11-18 10:00:00',
  checkin_date_time: '2025-11-18 10:20:00',
};
const scheduledTodayJob = {
  job_id: 533337,
  job_status: 1,
  requested_date_time: now(),
};
const completedJob = { job_id: 533338, job_status: 3, requested_date_time: now() };

test('a job started today is today\'s work whatever date it was booked for', () => {
  assert.equal(isTodaysWork(startedFutureJob), true,
    'checked in today — the appointment being 16 days out is no longer what dates it');
  assert.equal(isTodaysWork(scheduledTodayJob), true, 'not started, but booked for today');
  assert.equal(isStarted({ job_id: 1, job_status: 20 }), true, 'pending-to-close counts as started');
  assert.equal(isStarted({ job_id: 1, job_status: 3 }), false, 'completed is not started');
});

test('a job started months ago and never closed is NOT today\'s work', () => {
  // Guards the over-correction: "started" is not "started today". Every started
  // job in the QA database is 132-287 days stale, and treating them as today's
  // would pin abandoned work to Home permanently.
  assert.equal(isTodaysWork(abandonedStartedJob), false);
});

test('a started job with no check-in stamp falls back to its appointment', () => {
  // Six rows in ~260k. They must still bucket somewhere rather than vanish.
  assert.equal(isTodaysWork({ job_id: 2, job_status: 2, requested_date_time: now() }), true);
  assert.equal(
    isTodaysWork({ job_id: 3, job_status: 2, requested_date_time: '2025-01-01 09:00:00' }), false,
  );
  assert.equal(isTodaysWork({ job_id: 4, job_status: 2 }), false, 'no date at all is not today');
});

test('a completed job is not today\'s work — completion removes it by status', () => {
  // The technician marking a job complete moves it to status 3 (or 5), which is
  // outside the active set entirely, so it leaves every bucket the same turn.
  assert.equal(isStarted(completedJob), false);
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'mobile-dashboard.service.js'), 'utf8',
  );
  const active = /const ACTIVE_STATUSES = '([^']+)'/.exec(source);
  assert.ok(active, 'the active status set must be declared in one place');
  const codes = active[1].split(',').map(Number);
  for (const closed of [3, 5, 6]) {
    assert.equal(codes.includes(closed), false,
      `status ${closed} is closed and must never be counted as an active job`);
  }
  assert.match(source, /statuses: STARTED_STATUSES/,
    'the list half must query the same started-status constant, not a literal');
});

test('the two source lists merge with started jobs first and no duplicates', () => {
  // The same job can legitimately appear in both lists (started AND booked for
  // today); it must be listed once, and the started copy is the one that wins.
  const merged = dedupeById([
    startedFutureJob,
    scheduledTodayJob,
    { ...scheduledTodayJob, job_status: 99 },   // duplicate id, later position
  ]);
  assert.deepEqual(merged.map((j) => j.job_id), [533336, 533337]);
  assert.equal(merged[0].job_status, 2, 'the started job leads');
  assert.equal(merged[1].job_status, 1, 'the first copy of a duplicate id wins');
  assert.deepEqual(dedupeById([{ job_id: null }, {}]), [], 'rows with no id are not jobs');
});

test('the activeToday count counts started jobs on any date, exactly once', () => {
  // The count half is SQL, so assert the SQL itself: a started job must be
  // counted by activeToday and must NOT also be counted by delayed/upcoming,
  // or `allJobs` (their sum) double-counts it.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'mobile-dashboard.service.js'), 'utf8',
  );
  const activeToday = /AS activeToday/.exec(source);
  assert.ok(activeToday, 'activeToday count must exist');
  const clause = source.slice(source.lastIndexOf('COUNT(', activeToday.index), activeToday.index);
  assert.match(clause, /\$\{WORK_DATE_SQL\} = CURDATE\(\)/,
    'today is decided by the work date — check-in for a started job, appointment otherwise');
  // All three date buckets must read the SAME expression, or they stop
  // partitioning and `allJobs` (their sum) double-counts or loses jobs.
  for (const bucket of ['`delayed`', 'upcoming']) {
    const marker = new RegExp(`AS ${bucket.replace(/`/g, '\\\\`')}`).exec(source);
    assert.ok(marker, `${bucket} count must exist`);
    const bucketClause = source.slice(source.lastIndexOf('COUNT(', marker.index), marker.index);
    assert.match(bucketClause, /\$\{WORK_DATE_SQL\}/,
      `${bucket} must bucket on the same work date as activeToday`);
  }
  assert.match(source, /WORK_DATE_SQL = `DATE\(CASE WHEN job_status IN \(\$\{STARTED_STATUSES\}\)/,
    'the work date must switch on the started statuses, not on a literal list');
});
