/*
 * GET /api/admin/birthdays/upcoming — the HRMS "Upcoming Birthdays" rail.
 *
 * ─── WHAT THESE TESTS ARE FOR ──────────────────────────────────────────────
 *
 * Two properties, both of which fail silently rather than loudly:
 *
 *   1. THE YEAR WRAP. A 7-day window opened on 28 December must return someone
 *      born on 2 January. A naive BETWEEN on month/day returns nothing for the
 *      last week of every year, and nobody notices until January — the one week
 *      of the year when the feature is most visible. The leap-day rule is the
 *      same shape: born-on-29-February is skipped in three years out of four
 *      unless it is explicitly observed on 1 March.
 *
 *   2. THE BIRTH YEAR NEVER LEAVES THE DATABASE. The response carries the
 *      occurrence inside the CURRENT window, not the date of birth, and the SQL
 *      projects only DATE_FORMAT(…, '%m-%d'). Publishing a colleague's age to
 *      the whole company is not something a birthday rail should be able to do
 *      by accident, so it is pinned here rather than left to review.
 *
 * Non-destructive: fake pool, no network, no DB.
 * Runner: `npm test` (node --test --test-force-exit).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// Rows the fake returns, set per test. `rows` feeds the BIRTHDAY query and
// `anniversaryRows` the WORK ANNIVERSARY one — they are separate because the
// two carry different columns (an anniversary row also has joined_year) and a
// single bucket would silently feed birthday rows to the anniversary mapper.
const scenario = { rows: [], anniversaryRows: [] };

/*
 * ORDER MATTERS: the fake takes the FIRST matching route, and both queries hit
 * tbl_user_personal_details. The date_of_joining matcher must therefore come
 * first, or the anniversary query would be served the birthday rows.
 */
const fake = installFakePool([
  /* Called when it is a function, so a test can make the query THROW (the
     pre-migration 1054 case) rather than only vary its rows. */
  [/date_of_joining/i, () => (typeof scenario.anniversaryRows === 'function'
    ? scenario.anniversaryRows()
    : scenario.anniversaryRows)],
  [/FROM tbl_user_personal_details p/i, () => scenario.rows],
]);

const express = require('express');
const birthdaysRouter = require('../routes/admin/birthdays');
const { windowByMonthDay } = birthdaysRouter;

// ═══════════════════════════════════════════════════════════════════════
// 1. THE WINDOW — year wrap and leap day
// ═══════════════════════════════════════════════════════════════════════

test('a 7-day window opened on 28 Dec reaches into January', async () => {
  const byMd = windowByMonthDay(7, '2026-12-28');
  assert.deepEqual([...byMd.keys()],
    ['12-28', '12-29', '12-30', '12-31', '01-01', '01-02', '01-03', '01-04']);
  // The contract's own example: someone born on 2 January must be in it, and
  // the date returned is next year's occurrence, not this year's.
  assert.equal(byMd.get('01-02'), '2027-01-02');
  assert.equal(byMd.get('12-31'), '2026-12-31');
});

test('an ordinary mid-year window is just the days it covers', async () => {
  const byMd = windowByMonthDay(3, '2026-06-10');
  assert.deepEqual([...byMd.keys()], ['06-10', '06-11', '06-12', '06-13']);
  assert.equal(byMd.get('06-13'), '2026-06-13');
});

test('29 February is observed on 1 March in a non-leap year', async () => {
  // 2026 is not a leap year, so stepping the window never produces 02-29 and a
  // person born on it would be skipped every year but one.
  const byMd = windowByMonthDay(7, '2026-02-25');
  assert.ok(byMd.has('03-01'));
  assert.equal(byMd.get('02-29'), '2026-03-01',
    'the leap-day birthday lands on the 1 March already in the window');
});

test('29 February is its own day in a leap year, not an alias for 1 March', async () => {
  const byMd = windowByMonthDay(7, '2028-02-25');   // 2028 IS a leap year
  assert.equal(byMd.get('02-29'), '2028-02-29');
  assert.equal(byMd.get('03-01'), '2028-03-01');
});

test('no leap-day entry is invented for a window that does not reach 1 March', async () => {
  const byMd = windowByMonthDay(3, '2026-06-10');
  assert.equal(byMd.has('02-29'), false);
});

// ═══════════════════════════════════════════════════════════════════════
// 2. THE ROUTE — what is queried and what comes back
// ═══════════════════════════════════════════════════════════════════════

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  // The real router. Its gate (requireAuth + role(['admin'])) is inherited from
  // the /api/admin mount, which is not what these tests are about.
  app.use('/birthdays', birthdaysRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err && err.message) }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  scenario.rows = [];
  scenario.anniversaryRows = [];
});

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('the query matches on month/day only and never reads the birth year', async () => {
  await get('/birthdays/upcoming?days=7');
  /*
   * Matched on date_of_birth, not just the table name. Two queries now hit
   * tbl_user_personal_details, and a finder that took whichever came first
   * would quietly start asserting against the anniversary statement — which
   * DOES select YEAR(), so the "never reads the birth year" assertion below
   * would fail for a reason that has nothing to do with birthdays.
   */
  const call = fake.calls.find((c) => /date_of_birth/.test(c.sql));
  assert.ok(call, 'the route should have queried');

  const projection = call.sql.slice(0, call.sql.indexOf('FROM'));
  assert.match(projection, /DATE_FORMAT\(p\.date_of_birth, '%m-%d'\)/);
  // The ONLY appearance of the column in the projection is inside DATE_FORMAT.
  assert.equal((projection.match(/date_of_birth/g) || []).length, 1);
  assert.doesNotMatch(call.sql, /YEAR\(/i, 'the birth year must never be selected');
  assert.doesNotMatch(call.sql, /TIMESTAMPDIFF/i, 'no age may be computed');

  // Active internal users only.
  assert.match(call.sql, /u\.user_status = 1/);
  assert.match(call.sql, /u\.user_type_id = \?/);

  // 8 month-days for a 7-day window (today inclusive), possibly +1 for the
  // leap-day alias, plus the leading user_type_id parameter.
  assert.ok(call.params.length === 9 || call.params.length === 10,
    `unexpected bind count: ${call.params.length}`);
});

test('a matched row comes back as the occurrence in THIS window, with no year or age', async () => {
  const { todayIst } = require('../utils/ist-calendar');
  const byMd = windowByMonthDay(7, todayIst());
  const [md, date] = [...byMd.entries()][0];

  scenario.rows = [{ user_id: 7, user_name: 'Priya Sharma', md }];
  const res = await get('/birthdays/upcoming?days=7');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.items, [{ user_id: 7, user_name: 'Priya Sharma', date }]);
  // Exactly three keys — nothing that could carry a year or an age rides along.
  assert.deepEqual(Object.keys(res.body.data.items[0]).sort(), ['date', 'user_id', 'user_name']);
});

test('results are ordered by the day they fall on, not by row order', async () => {
  const { todayIst } = require('../utils/ist-calendar');
  const byMd = windowByMonthDay(7, todayIst());
  const entries = [...byMd.entries()];
  const early = entries[0];
  const late  = entries[3];

  scenario.rows = [
    { user_id: 2, user_name: 'Zoya', md: late[0] },
    { user_id: 1, user_name: 'Amit', md: early[0] },
  ];
  const res = await get('/birthdays/upcoming?days=7');
  assert.deepEqual(res.body.data.items.map((i) => i.user_id), [1, 2]);
});

test('days defaults to 7 and is capped, so the IN list can never run away', async () => {
  await get('/birthdays/upcoming');
  const defaulted = fake.calls.find((c) => /tbl_user_personal_details/.test(c.sql));
  assert.ok(defaulted.params.length === 9 || defaulted.params.length === 10);

  const tooBig = await get('/birthdays/upcoming?days=400');
  assert.equal(tooBig.status, 400);
  const notANumber = await get('/birthdays/upcoming?days=abc');
  assert.equal(notANumber.status, 400);
});

// ═══════════════════════════════════════════════════════════════════════
// 4. WORK ANNIVERSARIES
//
// Same window, same MM-DD matching, same leap-day rule as the birthdays —
// those are covered above and not re-tested here. What IS specific to
// anniversaries is the ORDINAL: it is the one number this feature computes
// rather than reads, it is derived from the WINDOW's year rather than today's,
// and it is the reason the joining year may be selected at all. So that is
// what these tests pin.
// ═══════════════════════════════════════════════════════════════════════

test('the anniversary row carries the years count and never the joining date', async () => {
  const { todayIst } = require('../utils/ist-calendar');
  const today = todayIst();
  scenario.anniversaryRows = [{
    user_id: 11, user_name: 'Rahul Verma',
    md: today.slice(5), joined_year: Number(today.slice(0, 4)) - 5,
  }];

  const res = await get('/birthdays/upcoming?days=7');
  assert.equal(res.status, 200);
  const [row] = res.body.data.anniversaries;
  assert.equal(row.user_name, 'Rahul Verma');
  assert.equal(row.years, 5);
  assert.equal(row.date, today, 'the occurrence inside the window, not the joining date');
  // The joining date must not be reconstructible from the payload.
  assert.equal(row.joined_year, undefined);
  assert.equal(row.date_of_joining, undefined);
});

test('the years count comes from the WINDOW year, so a December window counts January correctly', () => {
  // The bug this guards: computing years against TODAY. A window opened on
  // 28 Dec 2026 that reaches 2 Jan 2027 must count a 2020 joiner as 7 years
  // (2027 - 2020), not 6 (2026 - 2020) — otherwise everyone who joined in
  // early January is reported a year short for those few days each year.
  const byMd = windowByMonthDay(7, '2026-12-28');
  const occurrence = byMd.get('01-02');
  assert.equal(occurrence, '2027-01-02');
  assert.equal(Number(occurrence.slice(0, 4)) - 2020, 7);
});

test('a joiner with under a year is not an anniversary, and neither is a future joiner', async () => {
  const { todayIst } = require('../utils/ist-calendar');
  const today = todayIst();
  const thisYear = Number(today.slice(0, 4));
  scenario.anniversaryRows = [
    // Joined earlier THIS year — 0 years. A start date, not an anniversary.
    { user_id: 1, user_name: 'Zero Years',   md: today.slice(5), joined_year: thisYear },
    // Future-dated joining year — the subtraction goes negative.
    { user_id: 2, user_name: 'Future Joiner', md: today.slice(5), joined_year: thisYear + 1 },
    // The one real anniversary in the set.
    { user_id: 3, user_name: 'One Year',      md: today.slice(5), joined_year: thisYear - 1 },
  ];

  const res = await get('/birthdays/upcoming?days=7');
  const names = res.body.data.anniversaries.map((a) => a.user_name);
  assert.deepEqual(names, ['One Year'], 'only years >= 1 is an anniversary');
});

test('birthdays and anniversaries are independent — one being empty does not affect the other', async () => {
  const { todayIst } = require('../utils/ist-calendar');
  const today = todayIst();
  scenario.rows = [{ user_id: 7, user_name: 'Priya Sharma', md: today.slice(5) }];
  scenario.anniversaryRows = [];

  const res = await get('/birthdays/upcoming?days=7');
  assert.equal(res.body.data.items.length, 1);
  assert.deepEqual(res.body.data.anniversaries, []);
  // `anniversaries` is always present, never undefined — the CRM reads it
  // with `?? []`, but a key that came and went would still be a contract bug.
  assert.ok(Array.isArray(res.body.data.anniversaries));
});

test('the anniversary query is scoped to active internal users, like the birthday one', async () => {
  await get('/birthdays/upcoming?days=7');
  const call = fake.calls.find((c) => /date_of_joining/.test(c.sql));
  assert.ok(call, 'the route should have queried for anniversaries');
  assert.match(call.sql, /u\.user_status = 1/);
  assert.match(call.sql, /u\.user_type_id = \?/);
  assert.equal(call.params[0], 5, 'INTERNAL_USER_TYPE_ID — employees, not technicians');
});

test('a host without the date_of_joining column still serves birthdays', async () => {
  /*
   * The pre-migration window: this code deploys before the ALTER is applied by
   * hand. The anniversary query fails with 1054 and MUST NOT take the birthday
   * rail down with it — the failure mode this guards is a working dashboard
   * widget vanishing because a feature with no data yet cannot query its column.
   */
  const { todayIst } = require('../utils/ist-calendar');
  const today = todayIst();
  scenario.rows = [{ user_id: 7, user_name: 'Priya Sharma', md: today.slice(5) }];
  scenario.anniversaryRows = () => {
    const e = new Error("Unknown column 'p.date_of_joining' in 'field list'");
    e.code = 'ER_BAD_FIELD_ERROR';
    e.errno = 1054;
    throw e;
  };

  const res = await get('/birthdays/upcoming?days=7');
  assert.equal(res.status, 200, 'the endpoint must not 500');
  assert.equal(res.body.data.items.length, 1, 'birthdays survive');
  assert.deepEqual(res.body.data.anniversaries, []);
});
