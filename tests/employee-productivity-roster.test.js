/*
 * Employee Productivity — WHO is in the table, and in WHAT ORDER.
 *
 * Two bugs are pinned here, both of which shipped silently for months because
 * the report had no way to say what it had left out.
 *
 * 1. THE ROSTER. The list was "active staff today"; the numbers beside it
 *    describe a DATE WINDOW. Those are different populations the moment
 *    somebody leaves. Measured on Production for 2026-09-01..29, six departed
 *    employees took 687 booked, 578 scheduled, 34 closed and Rs.72,860 of
 *    revenue out of the page, the KPI row, the chart and the export — while the
 *    KRA tile, which never looks at tbl_user, kept counting them.
 *
 * 2. THE ORDER. Paging happened in SQL on the user list, BEFORE metrics
 *    existed, so no metric column could ever be sorted on: the best it could
 *    have done is re-order the ten names alphabetical paging handed over.
 *
 * The ordering assertions run the real function. The structural ones are
 * source-level, deliberately: the property that matters is WHERE a predicate
 * sits — the scope guard has to be on BOTH halves of a union — and a fixture
 * would pass just as happily against one half plus a comment promising the
 * other.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVICE_PATH = path.join(
  __dirname, '..', 'services/quicksight/quicksight-employee-productivity.service.js',
);
const SERVICE = fs.readFileSync(SERVICE_PATH, 'utf8');
const JOB_SERVICE = fs.readFileSync(
  path.join(__dirname, '..', 'services/job.service.js'), 'utf8',
);

/* The sorter is pure and exported; requiring the module opens no connection
 * until a query runs, and none of these tests runs one. */
const { sortProductivityRows, SORTABLE_COLUMN_KEYS, DEFAULT_SORT_BY, DEFAULT_SORT_DIR } =
  require('../services/quicksight/quicksight-employee-productivity.service');

const row = (userName, over = {}) => ({
  userId: over.userId ?? Math.floor(Math.random() * 1e6),
  userName,
  isFormer: false,
  booked: 0, scheduled: 0, audit: 0, closedCount: 0, revenue: 0, cancelCount: 0,
  ...over,
});

/* ───────────────────────────── ORDERING ───────────────────────────── */

test('default order is revenue, highest first', () => {
  const rows = [row('Amit', { revenue: 12995 }), row('Zara', { revenue: 110925 }), row('Bob', { revenue: 0 })];
  const { key, dir } = sortProductivityRows(rows, undefined, undefined);
  assert.equal(key, 'revenue');
  assert.equal(dir, -1, 'descending — "most" is the interesting end');
  assert.deepEqual(rows.map((r) => r.userName), ['Zara', 'Amit', 'Bob']);
  assert.equal(DEFAULT_SORT_BY, 'revenue');
  assert.equal(DEFAULT_SORT_DIR, 'desc');
});

test('equal rows tie-break by name, so paging cannot duplicate or drop anyone', () => {
  // Most employees have revenue 0. Without a tie-break these keep their input
  // order, which is not stable across requests — so a page boundary landing
  // inside the block of zeros shows somebody twice and somebody not at all.
  const forward = [row('Charlie'), row('Alice'), row('Bhawana')];
  const reverse = [row('Bhawana'), row('Charlie'), row('Alice')];
  sortProductivityRows(forward, 'revenue', 'desc');
  sortProductivityRows(reverse, 'revenue', 'desc');
  assert.deepEqual(forward.map((r) => r.userName), ['Alice', 'Bhawana', 'Charlie']);
  assert.deepEqual(reverse.map((r) => r.userName), forward.map((r) => r.userName),
    'the same set must come back in the same order regardless of how it arrived');
});

test('the tie-break stays ascending even when the primary sort is ascending', () => {
  const rows = [row('Charlie'), row('Alice'), row('Bhawana')];
  sortProductivityRows(rows, 'revenue', 'asc');
  assert.deepEqual(rows.map((r) => r.userName), ['Alice', 'Bhawana', 'Charlie']);
});

test('every advertised column actually sorts', () => {
  const cases = {
    booked: 'booked', scheduled: 'scheduled', audit: 'audit',
    closed: 'closedCount', revenue: 'revenue', cancelled: 'cancelCount',
  };
  for (const [wire, field] of Object.entries(cases)) {
    const rows = [row('Low', { [field]: 1 }), row('High', { [field]: 99 })];
    sortProductivityRows(rows, wire, 'desc');
    assert.deepEqual(rows.map((r) => r.userName), ['High', 'Low'], `${wire} descending`);
    sortProductivityRows(rows, wire, 'asc');
    assert.deepEqual(rows.map((r) => r.userName), ['Low', 'High'], `${wire} ascending`);
  }
});

test('employee sorts by name, case-insensitively', () => {
  // A case-SENSITIVE compare puts every capitalised name above every lowercase
  // one — 'sameeksha sameeksha' would sort after 'Zara'.
  const rows = [row('Zara'), row('sameeksha sameeksha'), row('Abhishek')];
  sortProductivityRows(rows, 'employee', 'asc');
  assert.deepEqual(rows.map((r) => r.userName), ['Abhishek', 'sameeksha sameeksha', 'Zara']);
});

test('an unknown sort key falls back to the default instead of throwing', () => {
  // A stale bookmark naming a renamed column must still render the report.
  const rows = [row('Amit', { revenue: 10 }), row('Zara', { revenue: 20 })];
  const { key } = sortProductivityRows(rows, 'constructor', 'desc');
  assert.equal(key, DEFAULT_SORT_BY);
  assert.deepEqual(rows.map((r) => r.userName), ['Zara', 'Amit']);
});

test('the sortable allow-list is frozen and matches the visible columns', () => {
  assert.deepEqual(
    [...SORTABLE_COLUMN_KEYS].sort(),
    ['audit', 'booked', 'cancelled', 'closed', 'employee', 'revenue', 'scheduled'],
  );
});

/* ───────────────────────────── THE ROSTER ───────────────────────────── */

test('the roster is a union: active staff PLUS ex-staff who worked', () => {
  assert.match(SERVICE, /SELECT TU\.user_id, TU\.user_name, 0 AS is_former[\s\S]*?TU\.user_status = 1/,
    'half one: active employees');
  assert.match(SERVICE, /UNION ALL[\s\S]*?1 AS is_former[\s\S]*?TU\.user_status <> 1/,
    'half two: ex-employees');
  assert.match(SERVICE, /JOIN \(\$\{WORKED_IN_WINDOW\}\) W ON W\.actor = TU\.user_id/,
    'half two is gated on real activity, so a quiet range adds nobody');
});

test('zero-activity ACTIVE employees are still listed', () => {
  // "This person did nothing all month" is a finding. The active half must not
  // be gated on the worked-set, or the report stops being able to say it.
  const activeHalf = SERVICE.slice(
    SERVICE.indexOf('0 AS is_former'), SERVICE.indexOf('UNION ALL', SERVICE.indexOf('0 AS is_former')),
  );
  assert.ok(!activeHalf.includes('WORKED_IN_WINDOW'),
    'the ACTIVE half must not be joined to the worked-set');
});

test('BOTH halves of the union carry the scope predicate', () => {
  // SECURITY. forceOwnHierarchy pins a non-Admin to their own team, and this
  // predicate is what enforces it. The second half selects people by WHAT THEY
  // DID rather than who they report to, so without the guard a reporting
  // manager silently gains every ex-employee in the company.
  const uses = SERVICE.match(/\$\{scopePredicate\}/g) || [];
  assert.equal(uses.length, 2, 'the scope guard appears on both halves');
  const params = SERVICE.match(/\.\.\.scopeParams\(\)/g) || [];
  assert.equal(params.length, 2, 'and both halves bind its parameters');
});

test('the six activity sources match the six the table can display', () => {
  for (const col of ['fk_created_by', 'fk_scheduled_by', 'cancel_by',
                     'full_fillment_by', 'sent_by', 'updated_by']) {
    assert.ok(SERVICE.includes(col), `worked-set reads ${col}`);
  }
});

test('the NOT IN (1) role test is NULL-safe', () => {
  // In SQL, NULL NOT IN (1) is NULL, not TRUE — a user with no role set was
  // being dropped from this report with no resignation required.
  assert.ok(!/AND TU\.user_role NOT IN \(1\)(?!\s*\))/.test(SERVICE),
    'no bare NOT IN (1) remains');
  assert.match(SERVICE, /TU\.user_role IS NULL OR TU\.user_role NOT IN \(1\)/);
});

test('a reporting manager can see team members who have left', () => {
  const fn = SERVICE.slice(SERVICE.indexOf('async function findUsersByReportingManagerId'));
  const body = fn.slice(0, fn.indexOf('}'));
  assert.ok(!body.includes('user_status = 1'),
    'filtering this list to active users delivers the whole fix to Admins only');
  assert.match(body, /reporting_manager = \?/);
});

test('sorting happens BEFORE paging', () => {
  // The order is the fix. Slice first and no metric column can ever be sorted.
  const sortAt = SERVICE.indexOf('sortProductivityRows(allRows');
  const sliceAt = SERVICE.indexOf('allRows.slice(offset');
  assert.ok(sortAt > 0 && sliceAt > 0, 'both steps present');
  assert.ok(sortAt < sliceAt, 'sort must precede the page slice');
  assert.ok(!/ORDER BY TU\.user_name ASC\s*\n\s*LIMIT \? OFFSET \?/.test(SERVICE),
    'the roster query must no longer page in SQL');
});

test('the count comes from the same rows that are paged', () => {
  // A separate COUNT query that drifted by one predicate would print a total
  // the table cannot fill.
  assert.match(SERVICE, /const totalRecords = userRows\.length/);
});

/* ─────────────── WHO GETS CREDIT FOR A CONFIRMED BOOKING ─────────────── */

test('confirming a job re-credits fk_created_by to the confirming user', () => {
  // A partner API authenticates AS a tbl_user, so create() writes that account
  // and the old COALESCE guard never fired: Decathlon's integration account
  // held all 79 bookings it raised while the ops staff who confirmed them got
  // nothing.
  assert.ok(!JOB_SERVICE.includes("fk_created_by = COALESCE(fk_created_by, ?)"),
    'the fill-if-empty guard is gone');
  assert.match(JOB_SERVICE, /sets\.push\('fk_created_by = \?'\)/,
    'it is a real assignment now');
});

test('the re-credit only fires on a genuine first confirmation', () => {
  // This is the status === BOOKED branch, i.e. EVERY transition into status 0.
  // A re-book, or a mobile ETA route passing the current status to ride the
  // extras path, must not reassign a booking somebody else already owns.
  assert.match(JOB_SERVICE, /const isFirstConfirmation =[\s\S]*?STATUS\.UNCONFIRMED[\s\S]*?STATUS\.ENQUIRY[\s\S]*?fk_created_by == null/);
  assert.match(JOB_SERVICE, /if \(bookedActorId && isFirstConfirmation\)/);
});

test('getJobMeta selects fk_created_by, or the guard silently inverts', () => {
  // undefined == null is TRUE, so a missing column scores every job as "no
  // creator" and turns the guarded re-credit into an unconditional overwrite.
  const meta = JOB_SERVICE.slice(JOB_SERVICE.indexOf('async function getJobMeta'));
  const select = meta.slice(0, meta.indexOf('FROM tbl_job WHERE job_id = ?'));
  assert.ok(select.includes('fk_created_by'),
    'getJobMeta must project fk_created_by for setStatus to test it');
});

/* ───────────────── SPOC REVENUE — FROZEN ATTRIBUTION ───────────────── */

test('SPOC revenue reads the frozen stamp, not the live mapping', () => {
  // Product rule: the SPOC who earns a job's revenue is decided WHEN THE JOB
  // IS BOOKED and never moves. Re-deriving it at report time meant the day a
  // client's SPOC changed, every closed job that client ever had re-credited
  // to the new person — last month's report stopped agreeing with last month.
  const fn = SERVICE.slice(SERVICE.indexOf('async function getSpocRevenue'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /TJ\.job_primary_spoc\s+AS userId/,
    'attribution comes off tbl_job.job_primary_spoc');
  assert.ok(!/FROM tbl_vertical_mapping TVM/.test(body),
    'the live mapping must not drive attribution any more');
  assert.match(body, /FROM tbl_job TJ/, 'the job is the base table');
});

test('a departed SPOC keeps the revenue they earned', () => {
  // tbl_user is a name lookup here, nothing more. Filtering it to active users
  // deleted a leaver's revenue from the report outright.
  const fn = SERVICE.slice(SERVICE.indexOf('async function getSpocRevenue'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!/tbl_user\s+TU\s+ON[^\n]*\n[^\n]*user_status = 1/.test(body),
    'no user_status filter on the name join');
  assert.match(body, /LEFT\s+JOIN tbl_user\s+TU\s+ON TU\.user_id\s+= TJ\.job_primary_spoc/);
});

test('Extras is counted in the totals but is not a SPOC', () => {
  // Dropping unstamped jobs would make the headline smaller than the revenue
  // it reports on — the exact failure this change removes.
  const fn = SERVICE.slice(SERVICE.indexOf('async function getSpocRevenue'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /const named = rows\.filter\(\(r\) => Number\(r\.userId\) > 0\)/);
  assert.match(body, /const spocCount\s+= spocs\.length/,
    'spocCount counts named SPOCs only');
  assert.match(body, /totalRevenue = spocs\.reduce[\s\S]{0,80}\+ extras\.revenue/,
    'totalRevenue includes Extras');
  assert.match(body, /totalJobs\s+= spocs\.reduce[\s\S]{0,90}\+ extras\.jobsCompleted/,
    'totalJobs includes Extras');
  assert.match(body, /return \{ spocs, extras,/, 'extras is returned to the FE');
});

test('the average divides by named SPOCs only', () => {
  // Extras is not a person. Averaging over it drags every SPOC down by a
  // phantom head.
  const fn = SERVICE.slice(SERVICE.indexOf('async function getSpocRevenue'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!/avgRevenue\s+= spocCount > 0\s*\?\s*Math\.round\(totalRevenue \/ spocCount\)/.test(body),
    'avgRevenue must not divide the Extras-inclusive total by the SPOC count');
  assert.match(body, /avgRevenue[\s\S]{0,140}spocs\.reduce[\s\S]{0,60}\/ spocCount/);
});
