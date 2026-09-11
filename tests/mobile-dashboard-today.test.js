const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dashboard = require('../services/mobile-dashboard.service');
const { OPEN_JOB_STATUSES } = require('../services/easyfixer-lifecycle.service');
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
const { dedupeById, isStarted, isTodaysWork, istDayOf } = dashboard._internals;

/*
 * "Now" in IST, because that is what the service means by today.
 *
 * This was `new Date().toISOString()`, which is UTC — and India is UTC+05:30
 * with no DST, so between 18:30 UTC and midnight UTC the UTC date string is
 * ONE DAY BEHIND the IST date isTodaysWork() compares it against. The suite
 * therefore passed for 18.5 hours a day and failed for 5.5 (00:00-05:30 IST),
 * which reads as a flaky test rather than a wrong helper. Same +5.5h idiom the
 * routes use to derive an IST `todayYmd`.
 */
const now = () => new Date(Date.now() + (5.5 * 60 * 60 * 1000))
  .toISOString().slice(0, 19).replace('T', ' ');

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
  const codes = dashboard._internals.ACTIVE_STATUSES.split(',').map(Number);
  assert.ok(codes.length > 0, 'the active set must be non-empty — an empty IN () would count nothing');
  for (const closed of [3, 5, 6]) {
    assert.equal(codes.includes(closed), false,
      `status ${closed} is closed and must never be counted as an active job`);
  }
  assert.match(source, /statuses: STARTED_STATUSES/,
    'the list half must query the same started-status constant, not a literal');
  assert.doesNotMatch(source, /statuses: '/,
    'no list may query a literal status set — "Today\'s Jobs" did, and kept 1,2,20 when the counts moved');
});

/*
 * EACH HOME TILE COUNTS WHAT THE BOOKINGS CHIP IT OPENS LISTS (2026-09-11).
 *
 * Open Jobs → All, Today's Jobs → Today, Delayed → Delayed. Production showed
 * Open Jobs 1 over a Bookings list of 5: the tiles counted (1, 2, 20) while the
 * list serves OPEN_JOB_STATUSES, so a revisit owed (10), an estimate pending with
 * the technician on site (15) and a job on hold (21) were listed and not counted.
 */
test('Home counts the statuses Bookings lists, and each tile uses its chip\'s rule', async () => {
  const { fetchDateCounts, ACTIVE_STATUSES } = dashboard._internals;
  assert.equal(ACTIVE_STATUSES, OPEN_JOB_STATUSES.join(','),
    'the active set IS the lifecycle\'s open set — read from it, never retyped');

  // A row whose date buckets sum to 1 while five jobs are open: only a DIRECT
  // count can put 5 on the tile. (The buckets drop sent-back jobs; Bookings does not.)
  const calls = [];
  const realQuery = pool.query;
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return [[{ activeToday: 1, delayed: 0, overdue: 0, upcoming: 0, allJobs: 5, actionRequired: 1 }], []];
  };
  let counts;
  try {
    counts = await fetchDateCounts(1736);
  } finally {
    pool.query = realQuery;
  }
  assert.equal(calls.length, 1, 'still one round trip');
  assert.deepEqual(calls[0].params, [1736]);
  assert.equal(counts.allJobs, 5, 'Open Jobs is the direct count, not activeToday + delayed + upcoming (1 here)');

  const clauseOf = (alias) => {
    const at = calls[0].sql.indexOf(`AS ${alias}`);
    assert.ok(at > 0, `the ${alias} count must exist`);
    return calls[0].sql.slice(calls[0].sql.lastIndexOf('COUNT(', at), at).replace(/\s+/g, ' ').trim();
  };
  assert.equal(clauseOf('allJobs'), `COUNT(CASE WHEN job_status IN (${OPEN_JOB_STATUSES.join(',')}) THEN 1 END)`,
    'every open job, with no date or send-back condition — exactly what GET /mobile/jobs lists');

  // Delayed = the Bookings Delayed chip's rule: late AND not begun.
  const overdue = clauseOf('overdue');
  assert.match(overdue, /requested_date_time < NOW\(\)/, 'late is keyed on the appointment');
  assert.match(overdue, /job_status NOT IN \(2, 10, 20\)/,
    'begun work is not late: in progress, pending to close, a revisit already worked');
  assert.match(overdue, /NOT \(job_status = 15 AND checkin_date_time IS NOT NULL\)/,
    'an estimate pending WITH a check-in is the technician on site, not late');
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
  // or the three date buckets stop partitioning the open jobs.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'mobile-dashboard.service.js'), 'utf8',
  );
  const activeToday = /AS activeToday/.exec(source);
  assert.ok(activeToday, 'activeToday count must exist');
  const clause = source.slice(source.lastIndexOf('COUNT(', activeToday.index), activeToday.index);
  assert.match(clause, /\$\{WORK_DATE_SQL\} = CURDATE\(\)/,
    'today is decided by the work date — check-in for a started job, appointment otherwise');
  // All three date buckets must read the SAME expression, or they stop
  // partitioning — a job counted twice, or in no bucket at all.
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


/*
 * THE DATE OF A STORED STAMP MUST NOT DEPEND ON THE SERVER'S TIMEZONE.
 *
 * These use FIXED strings and never read the clock, so they assert the same
 * thing in every zone — which is the whole point. The tests above could only
 * catch this bug while CI happened to run between 13:00 and 18:30 UTC, and they
 * did: two of them failed a deploy at 13:11 UTC and had passed at 10:24 UTC.
 *
 * The bug: db.js sets dateStrings:true, so a DATETIME arrives as an IST
 * wall-clock string. `new Date("2026-09-07 23:30:00")` reads it as the server's
 * LOCAL zone and Intl then converted that instant to IST — under a UTC
 * container, 23:30 IST became 05:00 the next day, and every job started after
 * 18:30 IST dropped out of "Today's Jobs".
 */
test('a stored IST stamp keeps its own date, whatever zone the server runs in', () => {
  assert.equal(istDayOf('2026-09-07 23:30:00'), '2026-09-07',
    'late evening must not roll into tomorrow — this is the reported bug');
  assert.equal(istDayOf('2026-09-07 00:15:00'), '2026-09-07',
    'and early morning must not roll back into yesterday');
  assert.equal(istDayOf('2026-09-07'), '2026-09-07', 'a bare DATE too');
  assert.equal(istDayOf('2026-09-07T18:53:00'), '2026-09-07', 'ISO-ish separator');
});

test('istDayOf still CONVERTS a real Date, because an instant is a different question', () => {
  // 2026-09-07T20:00:00Z is 2026-09-08 01:30 IST — a Date denotes an instant,
  // so asking which IST day it lands on is correct here. Only an already-IST
  // string must be read verbatim.
  assert.equal(istDayOf(new Date('2026-09-07T20:00:00Z')), '2026-09-08');
  assert.equal(istDayOf(null), null);
  assert.equal(istDayOf('not a date'), null);
});
