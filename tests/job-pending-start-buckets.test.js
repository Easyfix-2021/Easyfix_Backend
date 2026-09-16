/*
 * My Orders → Pending to Start: six EXCLUSIVE tabs.
 *
 *   /admin/jobs?ptsState=cancel|reschedule|missed|today|future
 *   /admin/jobs/pending-start/counts → { all, cancel, reschedule, missed, today, future }
 *
 * WHAT IS ACTUALLY AT RISK
 *   Tabs that partition a set fail silently in two ways: a job lands in TWO
 *   tabs (the operator actions it twice, or the counts sum past the page), or
 *   in NONE (it simply disappears). Day-boundary bugs are the classic source of
 *   both, and IST-vs-UTC makes it worse: a container on UTC computing "today"
 *   from its own clock is 5½ hours wrong every evening.
 *
 * HOW IT IS PINNED — by EXECUTING the SQL the service emits, not by restating
 * the rule. compileFragment() below translates each emitted fragment into a JS
 * predicate over an in-memory job and REFUSES anything it does not recognise, so
 * a regression that changed an operator, dropped the status pin or moved a
 * comparison under a NOT fails loudly here instead of being followed. That is
 * the same technique tests/job-offer-state-filter.test.js uses for the offer
 * sub-state, and for the same reason: a test that re-derives the rule only
 * proves the test agrees with itself.
 *
 * Covered: every boundary the tabs meet at (yesterday 23:59:59, today
 * 00:00:00, today 23:59:59, tomorrow 00:00:00), NULL appointments, IST not UTC,
 * the priority order, exclusivity over every flag × date combination, the
 * counts' CASE being the filter fragments verbatim, and counts == list totals.
 *
 * Non-destructive: fake pool, no real DB. Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const scenario = { groups: [] };
const fake = installFakePool([
  [/AS pts_state, COUNT\(\*\) AS c/i, () => scenario.groups],
  [/^SELECT COUNT\(\*\) AS total/i, [{ total: 0 }]],
  [/SELECT 1 FROM tbl_job_offer LIMIT 1/i, [{ 1: 1 }]],
  [/FROM easyfix_properties/i, []],
  [/SHOW COLUMNS/i, []],
  [/FROM tbl_job_customer_request LIMIT 1/i, []],
  [/SELECT magic_link_delivery_status FROM tbl_job LIMIT 1/i, [{ magic_link_delivery_status: null }]],
]);

const jobSvc = require('../services/job.service');
const { PTS_STATE_VALUES, ptsStateSql, ptsStateCaseSql, istDayBounds, appRequestClause } = jobSvc;
const { listQuery, pendingStartCountsQuery, PENDING_START_COUNT_FILTERS } = require('../validators/job.validator');

beforeEach(() => { fake.reset(); scenario.groups = []; });

/* ── The interpreter ─────────────────────────────────────────────────────── */

/*
 * Bind the params INTO the SQL first (left to right, one per `?`), then map the
 * handful of shapes these fragments are allowed to use onto JS. Binding before
 * compiling keeps the placeholder order exact regardless of JS short-circuiting.
 *
 * Two-valued logic is EXACT here, not an approximation, and that is asserted
 * rather than assumed: the only NULL-able operand is requested_date_time, the
 * flags are COALESCEd and job_status is NOT NULL, and a test below proves no
 * date comparison ever sits under a NOT — the one place SQL's UNKNOWN would
 * diverge from JS false.
 */
function compileFragment({ sql, params }, alias = 'j') {
  let i = 0;
  let js = sql.replace(/\?/g, () => {
    assert.ok(i < params.length, 'ran out of params for: ' + sql);
    return JSON.stringify(params[i++]);
  });
  assert.equal(i, params.length, 'not every param was bound: ' + sql);
  const A = alias;
  const LIT = '("(?:[^"\\\\]|\\\\.)*"|\\d+)';
  js = js
    .replace(new RegExp(`COALESCE\\(${A}\\.is_cancelled_by_app, 0\\) = 1`, 'g'), '(row.cf === 1)')
    .replace(new RegExp(`COALESCE\\(${A}\\.is_rescheduled_by_app, 0\\) = 1`, 'g'), '(row.rf === 1)')
    .replace(new RegExp(`${A}\\.requested_date_time IS NULL`, 'g'), '(row.d === null)')
    .replace(new RegExp(`${A}\\.requested_date_time >= ${LIT}`, 'g'), '(row.d !== null && row.d >= $1)')
    .replace(new RegExp(`${A}\\.requested_date_time < ${LIT}`, 'g'), '(row.d !== null && row.d < $1)')
    .replace(new RegExp(`${A}\\.job_status = ${LIT}`, 'g'), '(row.status === $1)')
    .replace(/\bAND\b/g, '&&')
    .replace(/\bOR\b/g, '||')
    .replace(/\bNOT\b/g, '!');
  const leftover = js
    .replace(/"(?:[^"\\]|\\.)*"/g, '')
    .replace(/row\.(cf|rf|d|status)|null|===|!==|>=|<|&&|\|\||!|[()\s]|\d+/g, '');
  assert.equal(leftover, '', `unrecognised SQL left after compiling: ${leftover} — in ${sql}`);
  // eslint-disable-next-line no-new-func -- controlled, test-only: every token was matched above.
  return new Function('row', `return Boolean(${js});`);
}

// A fixed "now": 2026-09-16 12:00 IST (06:30 UTC). Every boundary is relative to it.
const NOW = new Date('2026-09-16T06:30:00Z');
const BOUNDS = istDayBounds(NOW);
const TODAY = '2026-09-16';

const job = (d, { cf = 0, rf = 0, status = 1 } = {}) => ({ d, cf, rf, status });
const statesOf = (row, bounds = BOUNDS) =>
  PTS_STATE_VALUES.filter((s) => compileFragment(ptsStateSql(s, bounds))(row));

/* ── IST day bounds ──────────────────────────────────────────────────────── */

test('the day bounds are IST calendar days, as DATETIME literals', () => {
  assert.deepEqual(BOUNDS, { todayStart: `${TODAY} 00:00:00`, tomorrowStart: '2026-09-17 00:00:00' });
});

test('"today" rolls over at IST midnight — not at UTC midnight', () => {
  // 23:59:59 IST on the 16th is 18:29:59 UTC; one second later it is the 17th
  // in India while still the 16th on a UTC container clock.
  assert.equal(istDayBounds(new Date('2026-09-16T18:29:59Z')).todayStart, '2026-09-16 00:00:00');
  assert.equal(istDayBounds(new Date('2026-09-16T18:30:00Z')).todayStart, '2026-09-17 00:00:00');
  // And 00:30 IST on the 17th is still the 16th in UTC.
  assert.equal(istDayBounds(new Date('2026-09-16T19:00:00Z')).todayStart, '2026-09-17 00:00:00');
});

test('month and year ends roll over correctly', () => {
  assert.deepEqual(istDayBounds(new Date('2026-12-31T06:30:00Z')),
    { todayStart: '2026-12-31 00:00:00', tomorrowStart: '2027-01-01 00:00:00' });
});

/* ── Every boundary ──────────────────────────────────────────────────────── */

test('yesterday 23:59:59 is MISSED', () => {
  assert.deepEqual(statesOf(job('2026-09-15 23:59:59')), ['missed']);
});

test('today 00:00:00 is TODAY — the first second of the day is not missed', () => {
  assert.deepEqual(statesOf(job(`${TODAY} 00:00:00`)), ['today']);
});

test('today 23:59:59 is TODAY — the last second of the day is not future', () => {
  assert.deepEqual(statesOf(job(`${TODAY} 23:59:59`)), ['today']);
});

test('tomorrow 00:00:00 is FUTURE', () => {
  assert.deepEqual(statesOf(job('2026-09-17 00:00:00')), ['future']);
});

test('a job with NO appointment is MISSED — it needs attention, nothing will resolve it', () => {
  assert.deepEqual(statesOf(job(null)), ['missed']);
});

test('the far past and far future land where they should', () => {
  assert.deepEqual(statesOf(job('2025-01-01 10:00:00')), ['missed']);
  assert.deepEqual(statesOf(job('2027-06-01 10:00:00')), ['future']);
});

/* ── Priority: cancel → reschedule → missed → today → future ─────────────── */

test('a pending CANCEL outranks every date, including missed', () => {
  for (const d of [null, '2026-09-15 23:59:59', `${TODAY} 10:00:00`, '2026-09-17 00:00:00']) {
    assert.deepEqual(statesOf(job(d, { cf: 1 })), ['cancel'], `cancel with appointment ${d}`);
  }
});

test('CANCEL outranks RESCHEDULE when a job carries both asks', () => {
  assert.deepEqual(statesOf(job(`${TODAY} 10:00:00`, { cf: 1, rf: 1 })), ['cancel']);
});

test('a pending RESCHEDULE outranks every date', () => {
  for (const d of [null, '2026-09-15 23:59:59', `${TODAY} 10:00:00`, '2026-09-17 00:00:00']) {
    assert.deepEqual(statesOf(job(d, { rf: 1 })), ['reschedule'], `reschedule with appointment ${d}`);
  }
});

/* ── Exclusivity, exhaustively ───────────────────────────────────────────── */

test('every status-1 job lands in EXACTLY ONE tab, over every flag × date combination', () => {
  const dates = [null, '2026-09-15 23:59:59', `${TODAY} 00:00:00`, `${TODAY} 23:59:59`, '2026-09-17 00:00:00'];
  for (const cf of [0, 1]) {
    for (const rf of [0, 1]) {
      for (const d of dates) {
        const s = statesOf(job(d, { cf, rf }));
        assert.equal(s.length, 1, `cf=${cf} rf=${rf} d=${d} matched ${JSON.stringify(s)}`);
      }
    }
  }
});

test('a job at any OTHER status is in no tab — the status pin is inside every fragment', () => {
  for (const status of [0, 2, 3, 6, 9]) {
    assert.deepEqual(statesOf(job(`${TODAY} 10:00:00`, { status })), [], `status ${status}`);
    assert.deepEqual(statesOf(job(`${TODAY} 10:00:00`, { status, cf: 1 })), [], `status ${status} + cancel flag`);
  }
});

test('no date comparison sits under a NOT — which is what keeps two-valued logic exact', () => {
  for (const s of PTS_STATE_VALUES) {
    const { sql } = ptsStateSql(s, BOUNDS);
    for (const m of sql.matchAll(/NOT \(([^)]*(?:\([^)]*\)[^)]*)*)\)/g)) {
      assert.doesNotMatch(m[1], /requested_date_time/, `${s}: a date test under NOT would be UNKNOWN on NULL`);
    }
  }
});

/* ── The two app-request buckets vs the appRequest filter ────────────────── */

test('ptsState=cancel IS appRequest=cancel — same SQL, same params', () => {
  assert.deepEqual(ptsStateSql('cancel', BOUNDS), appRequestClause('cancel'));
});

test('ptsState=reschedule EXCLUDES cancel-flagged jobs; appRequest=reschedule does not', () => {
  // The Technician Requests filter matches the reschedule flag alone, so a job
  // carrying both flags shows there while the CRM renders it as a
  // cancellation. The tabs must be exclusive, so this one excludes it.
  const both = job(`${TODAY} 10:00:00`, { cf: 1, rf: 1 });
  assert.equal(compileFragment(appRequestClause('reschedule'))(both), true,
    'appRequest=reschedule still includes a both-flags job — deliberately unchanged');
  assert.equal(compileFragment(ptsStateSql('reschedule', BOUNDS))(both), false);
});

test('an unknown state is no filter at all', () => {
  assert.equal(ptsStateSql('overdue', BOUNDS), null);
  assert.equal(ptsStateSql('', BOUNDS), null);
});

/* ── list() integration ──────────────────────────────────────────────────── */

const countQuery = () => fake.calls.find((c) => /^SELECT COUNT\(\*\) AS total/i.test(c.sql));
const dataQuery = () => fake.calls.find((c) => /LIMIT \? OFFSET \?/.test(c.sql));
const groupQuery = () => fake.calls.find((c) => /AS pts_state, COUNT\(\*\) AS c/.test(c.sql));
const filterHalf = (sql) => sql.slice(sql.indexOf('FROM tbl_job j')).replace(/GROUP BY pts_state\s*$/, '').trim();

test('list() applies the ptsState fragment with TODAY\'s IST bounds', async () => {
  const live = istDayBounds();
  await jobSvc.list({ status: 1, ptsState: 'today', limit: 10, offset: 0 });
  const expected = ptsStateSql('today', live);
  assert.ok(countQuery().sql.includes(expected.sql), 'the fragment must be in the WHERE verbatim');
  assert.deepEqual(countQuery().params, [1, ...expected.params]);
  assert.ok(dataQuery().sql.includes(expected.sql), 'and the data query must carry the same WHERE');
});

test('the list accepts categoryId together with status=1', async () => {
  const { error } = listQuery.validate({ status: 1, categoryId: 5, ptsState: 'missed' });
  assert.equal(error, undefined);
  await jobSvc.list({ status: 1, categoryId: 5, ptsState: 'missed', limit: 10, offset: 0 });
  assert.match(countQuery().sql, /j\.fk_service_catg_id = \?/);
  assert.ok(countQuery().params.includes(5));
});

/* ── The counts ──────────────────────────────────────────────────────────── */

test('ONE grouped query — never one count per tab, never a page of rows', async () => {
  await jobSvc.getPendingStartCounts({});
  assert.equal(fake.calls.filter((c) => /AS pts_state/.test(c.sql)).length, 1);
  assert.equal(countQuery(), undefined);
  assert.equal(dataQuery(), undefined);
});

test('the CASE arms ARE the five filter fragments, verbatim, in priority order', async () => {
  await jobSvc.getPendingStartCounts({});
  const sql = groupQuery().sql;
  let cursor = 0;
  for (const s of PTS_STATE_VALUES) {
    const arm = `WHEN ${ptsStateSql(s, istDayBounds()).sql} THEN '${s}'`;
    const at = sql.indexOf(arm, cursor);
    assert.ok(at >= 0, `the ${s} arm must be the ${s} filter fragment, verbatim and after the previous arm`);
    cursor = at + arm.length;
  }
});

test('the CASE params bind BEFORE the WHERE params, in placeholder order', async () => {
  await jobSvc.getPendingStartCounts({ clientId: '12' });
  const { params } = groupQuery();
  const caseParams = ptsStateCaseSql(istDayBounds()).params;
  assert.deepEqual(params.slice(0, caseParams.length), caseParams);
  assert.deepEqual(params.slice(caseParams.length), [1, 12], 'then the status pin, then the filters');
});

test('the strip and the grid are the SAME where + params for the same filters', async () => {
  const filters = { q: 'bosch', categoryId: 5, cityId: '7,9', clientId: '3', zonalManagerId: '11', ownerId: 8 };
  await jobSvc.getPendingStartCounts(filters);
  const strip = groupQuery();
  const caseLen = ptsStateCaseSql(istDayBounds()).params.length;

  fake.reset();
  await jobSvc.list({ ...filters, status: 1, limit: 50, offset: 0 });
  const grid = countQuery();

  assert.equal(filterHalf(strip.sql), filterHalf(grid.sql), 'joins + WHERE must be identical text');
  assert.deepEqual(strip.params.slice(caseLen), grid.params, 'and bound identically');
  assert.match(filterHalf(strip.sql), /WHERE j\.job_status = \?/);
  assert.match(filterHalf(strip.sql), /j\.job_client_owner = \?/, 'ownerId reaches the WHERE');
});

test('ptsState and a stray status cannot reach the counts', async () => {
  await jobSvc.getPendingStartCounts({ ptsState: 'today', status: 3, statuses: '3,5' });
  const withJunk = groupQuery();
  fake.reset();
  await jobSvc.getPendingStartCounts({});
  assert.equal(withJunk.sql, groupQuery().sql);
  assert.deepEqual(withJunk.params, groupQuery().params);
});

test('the response is exactly the six keys, all = the sum of the five', async () => {
  scenario.groups = [
    { pts_state: 'cancel', c: 2 }, { pts_state: 'reschedule', c: 1 },
    { pts_state: 'missed', c: 7 }, { pts_state: 'today', c: 4 }, { pts_state: 'future', c: '9' },
  ];
  assert.deepEqual(await jobSvc.getPendingStartCounts({}),
    { all: 23, cancel: 2, reschedule: 1, missed: 7, today: 4, future: 9 });
});

test('an empty tab is 0, and an unplaceable NULL group is never counted in a tab', async () => {
  scenario.groups = [{ pts_state: 'today', c: 3 }, { pts_state: null, c: 1 }];
  assert.deepEqual(await jobSvc.getPendingStartCounts({}),
    { all: 3, cancel: 0, reschedule: 0, missed: 0, today: 3, future: 0 });
});

test('COUNTS == LIST TOTALS: the CASE classifies a job set exactly as the five filters list it', () => {
  /*
   * Executes both halves over one synthetic job set: the counts' CASE (arm by
   * arm, first match wins, as SQL evaluates it) and each tab's own filter. If
   * they disagree anywhere, a tab's badge and the rows under it disagree.
   */
  const jobs = [];
  const dates = [null, '2026-09-10 09:00:00', '2026-09-15 23:59:59', `${TODAY} 00:00:00`,
    `${TODAY} 13:00:00`, `${TODAY} 23:59:59`, '2026-09-17 00:00:00', '2026-10-01 10:00:00'];
  for (const cf of [0, 1]) for (const rf of [0, 1]) for (const d of dates) jobs.push(job(d, { cf, rf }));

  const caseSql = ptsStateCaseSql(BOUNDS);
  // Split the CASE back into its arms and bind each arm's share of the params.
  const arms = [];
  let p = 0;
  for (const m of caseSql.sql.matchAll(/WHEN (.+?) THEN '(\w+)'/g)) {
    const n = (m[1].match(/\?/g) || []).length;
    arms.push({ state: m[2], test: compileFragment({ sql: m[1], params: caseSql.params.slice(p, p + n) }) });
    p += n;
  }
  assert.equal(p, caseSql.params.length, 'every CASE param belongs to exactly one arm');
  const caseCounts = Object.fromEntries(PTS_STATE_VALUES.map((s) => [s, 0]));
  for (const row of jobs) {
    const hit = arms.find((a) => a.test(row));
    assert.ok(hit, `the CASE placed no arm for ${JSON.stringify(row)}`);
    caseCounts[hit.state] += 1;
  }

  const listCounts = Object.fromEntries(PTS_STATE_VALUES.map((s) => [
    s, jobs.filter((row) => compileFragment(ptsStateSql(s, BOUNDS))(row)).length,
  ]));
  assert.deepEqual(caseCounts, listCounts, 'the strip must count exactly what each tab lists');
  const sum = PTS_STATE_VALUES.reduce((a, s) => a + listCounts[s], 0);
  assert.equal(sum, jobs.length, 'and "all" must be every job, counted once');
});

/* ── The query schema ────────────────────────────────────────────────────── */

const validateQuery = (query) =>
  pendingStartCountsQuery.validate(query, { abortEarly: false, stripUnknown: true, convert: true });

test('every accepted key is the LIST\'s own rule, extracted — ownerId included', () => {
  assert.deepEqual([...PENDING_START_COUNT_FILTERS].sort(),
    ['categoryId', 'cityId', 'clientId', 'ownerId', 'q', 'zonalManagerId']);
  for (const key of PENDING_START_COUNT_FILTERS) {
    assert.deepEqual(pendingStartCountsQuery.extract(key).describe(), listQuery.extract(key).describe(), key);
  }
});

test('ptsState and the status pins are STRIPPED, not rejected', () => {
  const { error, value } = validateQuery({ q: 'x', ownerId: '8', ptsState: 'today', status: '1', limit: '50' });
  assert.equal(error, undefined);
  assert.deepEqual(Object.keys(value).sort(), ['ownerId', 'q']);
});

/* ── The XLSX export emits the SAME bucket ───────────────────────────────── */

test('the export binds list()\'s ptsState fragment to its J alias', () => {
  const { buildExportWhere } = require('../services/job-export.service');
  const r = buildExportWhere({ ptsState: 'future' });
  const expected = ptsStateSql('future', istDayBounds(), 'J');
  assert.ok(r.where.includes(expected.sql), 'the sheet must use the tab\'s own predicate');
  assert.ok(expected.params.every((v) => r.params.includes(v)), 'with the same IST bound');
  /*
   * The fragment pins status 1, so the export's "open jobs" STATUS default must
   * not be layered on top. Its 6-month created_date_time WINDOW default still
   * applies when no date range is sent — that is the export's existing rule for
   * every status-pinning filter, appRequest included, and is not changed here.
   */
  const defaults = r.appliedDefaults || [];
  assert.equal(defaults.some((d) => d.startsWith('status:')), false,
    'a pinned status means no "open jobs" status default is layered on');
});

test('the J-bound fragment classifies identically to the j-bound one', () => {
  for (const s of PTS_STATE_VALUES) {
    const lower = compileFragment(ptsStateSql(s, BOUNDS, 'j'), 'j');
    const upper = compileFragment(ptsStateSql(s, BOUNDS, 'J'), 'J');
    for (const row of [job(null), job(`${TODAY} 10:00:00`), job('2026-09-17 00:00:00', { rf: 1 })]) {
      assert.equal(upper(row), lower(row), `${s} differs between the list and the export`);
    }
  }
});
