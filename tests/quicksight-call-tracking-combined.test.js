/*
 * Unit tests — Call Tracking, the COMBINED (whole-window, per-user) grain.
 *
 * The By User tab has two aggregation grains: the existing (day × user) table
 * and `byUserCombined`, one row per caller for the whole window carrying the
 * per-day efficiency averages. What these tests guard, worst-first:
 *
 *   1. THE DENOMINATOR. "Per day" divides by ACTIVE days — the distinct days on
 *      which that user actually placed a call — never by the number of days in
 *      the selected range. Divide by range days and the column ranks people by
 *      attendance (weekends, leave, a mid-month joiner) instead of by how hard
 *      they worked on the days they worked.
 *   2. THE CAPPED-ROW TRAP. activeDays must come from COUNT(DISTINCT day) in
 *      SQL, not from counting a user's rows in `byUser` — that array is capped
 *      at ROW_CAP, so a capped response would under-count the denominator and
 *      INFLATE every average built on it. The fixtures below deliberately give
 *      byUser FEWER day-rows than the SQL's active_days so a JS-derived
 *      denominator would produce a visibly different (wrong) number.
 *   3. NULL, NOT ZERO/NaN/Infinity. No denominator means "cannot divide", which
 *      the FE renders as an em-dash. 0 would read as "this person did nothing".
 *   4. CONNECTED-ONLY TALK TIME. Avg duration per CALL averages over calls that
 *      connected (duration > 0) — a ring-out must not drag down talk time —
 *      while avg duration per DAY divides TOTAL talk time by active days.
 *   5. The two grains reconcile (same buildScope, same params) and the EXISTING
 *      byUser shape is untouched.
 *
 * No DB: the shared pool singleton is faked BEFORE the service loads, so every
 * statement is captured as a string and answered from the `S` fixture below.
 * The live reconciliation (Σ byUser.calls === Σ byUserCombined.calls on real
 * data) was verified separately, read-only, against the production window.
 *
 * Runner: `node --test`.
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { installFakePool } = require('./helpers/fake-pool');

/*
 * ONE installed fake serves every test; each test rewrites this scenario object
 * and the routed responses read it lazily.
 */
const S = {
  totals: [{}],
  jobs: [],
  userDays: [],
  userParties: [],
  userSteps: [],
  combined: [],
  combinedParties: [],
  combinedSteps: [],
  trend: [],
};

/*
 * Route order matters — the fake takes the FIRST matching pattern. The combined
 * grain is the only query selecting `active_days`, and the day-keyed breakdowns
 * are distinguished from the caller-keyed ones by the leading `AS day,`.
 */
const fake = installFakePool([
  [/AS active_days/, () => S.combined],
  [/AS unique_callers/, () => S.totals],
  [/MAX\(c\.client_name\)/, () => S.jobs],
  [/AS day,[\s\S]*AS userName/, () => S.userDays],
  [/AS day,[\s\S]*AS role/, () => S.userParties],
  [/AS day,[\s\S]*AS assignedFlag/, () => S.userSteps],
  [/jci\.job_id AS jobId/, () => []],
  [/jci\.caller_id AS userId,[\s\S]*AS role/, () => S.combinedParties],
  [/jci\.caller_id AS userId,[\s\S]*AS assignedFlag/, () => S.combinedSteps],
  [/AS day,/, () => S.trend],
]);
after(() => fake.restore());

const service = require('../services/quicksight/quicksight-call-tracking.service');
const { perDay, ACTIVE_DAYS, DAY_EXPR } = service._test;

/** A fully-populated combined SQL row, overridable per test. */
function combinedRow(over = {}) {
  return {
    userId: 7,
    userName: 'Priya',
    active_days: 3,
    calls: 12,
    connected: 9,
    total_duration_secs: 900,
    avg_duration_secs: 75,
    unique_jobs: 5,
    firstCallAt: '2026-07-02 10:15:00',
    lastCallAt: '2026-07-29 18:40:00',
    ...over,
  };
}

/** A 30-day window — long enough that range-days vs active-days differ loudly. */
const WINDOW = { dateFrom: '2026-07-01', dateTo: '2026-07-30' };
const RANGE_DAYS = 30;

beforeEach(() => {
  fake.reset();
  S.totals = [{ calls: 0, connected: 0, total_duration_secs: 0, avg_duration_secs: null, unique_jobs: 0, unique_callers: 0 }];
  S.jobs = [];
  S.userDays = [];
  S.userParties = [];
  S.userSteps = [];
  S.combined = [];
  S.combinedParties = [];
  S.combinedSteps = [];
  S.trend = [];
});

// Collapse whitespace so SQL assertions read like the statement does.
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();
const sqlWith = (re) => flat((fake.calls.find((c) => re.test(c.sql)) || {}).sql || '');

// ─── The pure averaging helper ──────────────────────────────────────

test('perDay divides by the days given and rounds to the requested precision', () => {
  assert.equal(perDay(12, 3), 4);
  assert.equal(perDay(900, 3), 300);
  assert.equal(perDay(10, 3, 1), 3.3);
  assert.equal(perDay(12, 3, 1), 4);
  // Whole seconds by default — a talk-time cell has no use for 300.33.
  assert.equal(perDay(901, 3), 300);
});

test('perDay returns NULL — never 0, NaN or Infinity — when there is no denominator', () => {
  for (const days of [0, null, undefined, -2, NaN, 'x']) {
    const v = perDay(5, days);
    assert.equal(v, null, `expected null for activeDays=${String(days)}`);
    // The three values this guard exists to prevent ever reaching the UI.
    assert.notEqual(v, 0);
    assert.ok(!Number.isNaN(v));
    assert.notEqual(v, Infinity);
  }
  // A zero NUMERATOR is a real answer (0 calls on a day worked), not a null.
  assert.equal(perDay(0, 4), 0);
});

// ─── The denominator comes from SQL ─────────────────────────────────

test('activeDays is COUNT(DISTINCT <day>) in SQL — the day expression the (day,user) grain groups by', () => {
  assert.equal(ACTIVE_DAYS, `COUNT(DISTINCT ${DAY_EXPR}) AS active_days`);
  // Pinned literally too: a rename of DAY_EXPR must not silently re-point the
  // denominator at a different bucketing (e.g. UTC dates or datetimes).
  assert.match(ACTIVE_DAYS, /^COUNT\(DISTINCT DATE_FORMAT\(jci\.inserted_time, '%Y-%m-%d'\)\) AS active_days$/);
});

test('the combined query counts active days itself and groups by caller only', async () => {
  S.combined = [combinedRow()];
  await service.getCallTracking(WINDOW);

  const sql = sqlWith(/AS active_days/);
  assert.match(sql, /COUNT\(DISTINCT DATE_FORMAT\(jci\.inserted_time, '%Y-%m-%d'\)\) AS active_days/);
  assert.match(sql, /GROUP BY jci\.caller_id/);
  // One row per USER for the whole window — the day must NOT be in the grain.
  assert.doesNotMatch(sql, /GROUP BY DATE_FORMAT/);
});

test('avg calls per day divides by ACTIVE days, not by the days in the range', async () => {
  S.combined = [combinedRow({ calls: 12, active_days: 3 })];
  // The daily grain returns ONE day-row for this user — as a ROW_CAP-truncated
  // response would. A denominator counted off this array would be 1.
  S.userDays = [{ day: '2026-07-02', userId: 7, userName: 'Priya', calls: 4, connected: 3, total_duration_secs: 300, avg_duration_secs: 75, unique_jobs: 2 }];

  const { byUserCombined } = await service.getCallTracking(WINDOW);
  const row = byUserCombined[0];

  assert.equal(row.activeDays, 3);
  assert.equal(row.avgCallsPerDay, 4);                    // 12 / 3 active days
  assert.notEqual(row.avgCallsPerDay, 12 / RANGE_DAYS);   // NOT 0.4 (range days)
  assert.notEqual(row.avgCallsPerDay, 12);                // NOT 12 (capped rows)
});

test('avg talk time per day divides TOTAL talk time by active days', async () => {
  S.combined = [combinedRow({ total_duration_secs: 900, active_days: 3 })];
  const { byUserCombined } = await service.getCallTracking(WINDOW);
  assert.equal(byUserCombined[0].avgDurationPerDaySecs, 300);
  assert.notEqual(byUserCombined[0].avgDurationPerDaySecs, Math.round(900 / RANGE_DAYS));
});

test('activeDays is taken from the SQL column even when the daily grain returns MORE rows than it', async () => {
  // Pathological but decisive: 5 day-rows on screen, 4 distinct days in SQL
  // (a user id repeated by a display-name change would do it). The SQL wins.
  S.combined = [combinedRow({ calls: 20, active_days: 4 })];
  S.userDays = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'].map((day) => ({
    day, userId: 7, userName: 'Priya', calls: 4, connected: 3, total_duration_secs: 100, avg_duration_secs: 33, unique_jobs: 1,
  }));

  const { byUserCombined } = await service.getCallTracking(WINDOW);
  assert.equal(byUserCombined[0].activeDays, 4);
  assert.equal(byUserCombined[0].avgCallsPerDay, 5);   // 20 / 4, not 20 / 5
});

test('a zero denominator yields null averages, not 0 / NaN / Infinity', async () => {
  S.combined = [combinedRow({ calls: 0, connected: 0, total_duration_secs: 0, avg_duration_secs: null, active_days: 0 })];

  const { byUserCombined } = await service.getCallTracking(WINDOW);
  const row = byUserCombined[0];

  assert.equal(row.activeDays, 0);
  assert.equal(row.avgCallsPerDay, null);
  assert.equal(row.avgDurationPerDaySecs, null);
  // Same convention the report already uses for "nothing connected".
  assert.equal(row.avgDurationSecs, null);
  for (const v of [row.avgCallsPerDay, row.avgDurationPerDaySecs]) {
    assert.notEqual(v, 0);
    assert.ok(!Number.isNaN(v));
    assert.notEqual(v, Infinity);
  }
});

// ─── Connected-only talk time ───────────────────────────────────────

test('avg duration per CALL averages over connected calls only', async () => {
  S.combined = [combinedRow()];
  await service.getCallTracking(WINDOW);

  const sql = sqlWith(/AS active_days/);
  // The shared CALL_AGG expression — connected-only, and NULL when nothing
  // connected (so a ring-out neither drags the average down nor prints 0:00).
  assert.match(sql, /AVG\(CASE WHEN COALESCE\(jci\.duration, 0\) > 0 THEN jci\.duration END\)\) AS avg_duration_secs/);
  assert.match(sql, /COUNT\(CASE WHEN COALESCE\(jci\.duration, 0\) > 0 THEN 1 END\) AS connected/);
});

test('the two duration averages are different figures and both survive to the row', async () => {
  // 12 calls, only 9 connected, 900s of talk over 3 active days.
  //   per CALL = 900/9 = 100 (SQL, connected-only)   per DAY = 900/3 = 300
  S.combined = [combinedRow({ calls: 12, connected: 9, total_duration_secs: 900, avg_duration_secs: 100, active_days: 3 })];

  const { byUserCombined } = await service.getCallTracking(WINDOW);
  const row = byUserCombined[0];
  assert.equal(row.avgDurationSecs, 100);
  assert.equal(row.avgDurationPerDaySecs, 300);
  // Dividing total talk by ALL calls (including ring-outs) would be 75 — the
  // number this report deliberately does not print.
  assert.notEqual(row.avgDurationSecs, 75);
});

// ─── Scope reuse + reconciliation ───────────────────────────────────

test('both grains are built from the SAME buildScope — identical filter params', async () => {
  S.combined = [combinedRow()];
  S.userDays = [{ day: '2026-07-02', userId: 7, userName: 'Priya', calls: 12, connected: 9, total_duration_secs: 900, avg_duration_secs: 100, unique_jobs: 5 }];

  await service.getCallTracking({
    ...WINDOW, clientId: [11, 12], provider: 'plivo', partyRole: 'Customer', callerId: [7],
  });

  const daily = fake.calls.find((c) => /AS day,[\s\S]*AS userName/.test(c.sql));
  const combined = fake.calls.find((c) => /AS active_days/.test(c.sql));
  assert.ok(daily && combined);
  // Same window, same client / caller / provider / party filters, same order.
  assert.deepEqual(combined.params, daily.params);
  // The provider clause is a fixed string, so prove it reached BOTH statements.
  assert.match(flat(combined.sql), /jci\.provider = 'plivo'/);
  assert.match(flat(daily.sql), /jci\.provider = 'plivo'/);
});

test('the grains reconcile — the mapping loses no calls between byUser and byUserCombined', async () => {
  // 2 users × 3 days = 20 + 14 calls, and the combined grain says the same.
  S.userDays = [
    { day: '2026-07-01', userId: 7, userName: 'Priya', calls: 8, connected: 6, total_duration_secs: 400, avg_duration_secs: 66, unique_jobs: 4 },
    { day: '2026-07-02', userId: 7, userName: 'Priya', calls: 7, connected: 5, total_duration_secs: 300, avg_duration_secs: 60, unique_jobs: 3 },
    { day: '2026-07-03', userId: 7, userName: 'Priya', calls: 5, connected: 4, total_duration_secs: 200, avg_duration_secs: 50, unique_jobs: 2 },
    { day: '2026-07-01', userId: 9, userName: 'Amit', calls: 9, connected: 7, total_duration_secs: 500, avg_duration_secs: 71, unique_jobs: 5 },
    { day: '2026-07-04', userId: 9, userName: 'Amit', calls: 5, connected: 3, total_duration_secs: 100, avg_duration_secs: 33, unique_jobs: 1 },
  ];
  S.combined = [
    combinedRow({ userId: 7, userName: 'Priya', calls: 20, connected: 15, total_duration_secs: 900, avg_duration_secs: 60, active_days: 3, unique_jobs: 7 }),
    combinedRow({ userId: 9, userName: 'Amit', calls: 14, connected: 10, total_duration_secs: 600, avg_duration_secs: 60, active_days: 2, unique_jobs: 5 }),
  ];

  const { byUser, byUserCombined } = await service.getCallTracking(WINDOW);
  const sum = (rows) => rows.reduce((a, r) => a + r.calls, 0);
  assert.equal(sum(byUser), 34);
  assert.equal(sum(byUserCombined), 34);
  assert.equal(sum(byUser), sum(byUserCombined));
  // The per-user averages use each user's OWN active-day count, never a shared
  // range-day denominator (which would be 34/30 spread across both).
  assert.equal(byUserCombined[0].avgCallsPerDay, 6.7);   // 20 / 3 active days
  assert.equal(byUserCombined[1].avgCallsPerDay, 7);     // 14 / 2 active days
});

test('the existing byUser shape is untouched — no combined-only keys leak into it', async () => {
  S.userDays = [{ day: '2026-07-02', userId: 7, userName: 'Priya', calls: 4, connected: 3, total_duration_secs: 300, avg_duration_secs: 75, unique_jobs: 2 }];
  S.combined = [combinedRow()];

  const { byUser, byUserCombined } = await service.getCallTracking(WINDOW);
  const dayRow = byUser[0];
  assert.equal(dayRow.day, '2026-07-02');
  for (const k of ['activeDays', 'avgCallsPerDay', 'avgDurationPerDaySecs']) {
    assert.equal(Object.hasOwn(dayRow, k), false, `byUser must not carry ${k}`);
  }
  // …and the combined grain carries no day, because it is not part of it.
  assert.equal(Object.hasOwn(byUserCombined[0], 'day'), false);
});

// ─── Nested breakdowns: one grouped query, stitched by caller_id ────

test('parties / steps are ONE grouped query each, restricted to the returned caller ids', async () => {
  S.combined = [
    combinedRow({ userId: 7, userName: 'Priya' }),
    combinedRow({ userId: 9, userName: 'Amit' }),
  ];
  S.combinedParties = [
    { userId: 7, role: 'Customer', calls: 8 },
    { userId: 7, role: 'Technician', calls: 4 },
    { userId: 9, role: 'Customer', calls: 6 },
  ];
  S.combinedSteps = [
    { userId: 7, status: 1, assignedFlag: 1, calls: 8 },
    { userId: 7, status: 0, assignedFlag: 0, calls: 4 },
    { userId: 9, status: 2, assignedFlag: 1, calls: 6 },
  ];

  const { byUserCombined } = await service.getCallTracking(WINDOW);

  // NOT N+1: two users, still exactly one parties query and one steps query.
  const partyQueries = fake.calls.filter((c) => /jci\.caller_id AS userId,[\s\S]*AS role/.test(c.sql) && !/AS day,/.test(c.sql));
  const stepQueries = fake.calls.filter((c) => /jci\.caller_id AS userId,[\s\S]*AS assignedFlag/.test(c.sql) && !/AS day,/.test(c.sql));
  assert.equal(partyQueries.length, 1);
  assert.equal(stepQueries.length, 1);
  // Restricted to exactly the caller ids the grain returned, parameterised.
  assert.match(flat(partyQueries[0].sql), /AND jci\.caller_id IN \(\?,\?\)/);
  assert.deepEqual(partyQueries[0].params.slice(-2), [7, 9]);

  // Stitched by caller_id onto the right rows.
  assert.deepEqual(byUserCombined[0].parties, [
    { role: 'Customer', calls: 8 }, { role: 'Technician', calls: 4 },
  ]);
  assert.deepEqual(byUserCombined[1].parties, [{ role: 'Customer', calls: 6 }]);

  // "Majority job status" = the top folded step for THAT caller.
  assert.equal(byUserCombined[0].topStatus, 1);
  assert.equal(byUserCombined[0].topStatusCalls, 8);
  assert.ok(byUserCombined[0].topStatusLabel.length > 0);
  assert.equal(byUserCombined[1].topStatus, 2);
  assert.equal(byUserCombined[1].topStatusCalls, 6);
});

// ─── XLSX ───────────────────────────────────────────────────────────

test('toXlsx adds the By User (Combined) and Other Calls sheets for the combined grain and leaves the first two alone', () => {
  const data = {
    byJob: [],
    byUser: [{ day: '2026-07-02', userName: 'Priya', calls: 4, avgDurationSecs: null, steps: [], parties: [] }],
    byUserCombined: [{
      userId: 7, userName: 'Priya', activeDays: 3, calls: 12, connected: 9, connectRate: 75,
      totalDurationSecs: 900, avgDurationSecs: 100, uniqueJobs: 5,
      avgCallsPerDay: 4, avgDurationPerDaySecs: 300,
      topStatusLabel: 'Scheduled', topStatusCalls: 8, steps: [], parties: [{ role: 'Customer', calls: 12 }],
    }],
  };
  const { sheets } = service.toXlsx(data);

  assert.deepEqual(sheets.map((s) => s.name), ['By Job', 'Daily By User', 'By User (Combined)', 'Other Calls']);
  const combined = sheets[2];
  const keys = combined.columns.map((c) => c.key);
  // Active Days sits BEFORE the averages it is the denominator of.
  assert.ok(keys.indexOf('activeDays') < keys.indexOf('avgCallsPerDay'));
  assert.ok(keys.indexOf('activeDays') < keys.indexOf('avgDurationPerDaySecs'));
  assert.equal(combined.rows[0].avgCallsPerDay, 4);
  assert.equal(combined.rows[0].partiesLabel, 'Customer (12)');

  // A response without the new array (an older cached payload) must not throw.
  assert.doesNotThrow(() => service.toXlsx({ byJob: [], byUser: [] }));
});
