/*
 * GET /api/client/dashboard-range — the three range-scoped Home cards.
 *
 * The arithmetic here is the kind that looks obviously right and is quietly
 * wrong at the edges, so this pins the four properties that actually bite:
 *
 *   1. ONE COHORT. Every figure counts jobs RAISED in the window. If a query
 *      drifts onto a different date column the percentages stop reconciling —
 *      a share of cancellations means nothing against a denominator built from
 *      a different set of rows.
 *   2. `to` IS INCLUSIVE, via `< to + 1 day` rather than DATE(...) <=, so the
 *      index stays usable AND a job raised at 18:40 on the end date counts.
 *   3. AN EMPTY WINDOW IS ZEROES, NOT NaN. Every percentage divides by a count
 *      that can legitimately be 0.
 *   4. TOP-3 IS PRESENTATION, and reasonCount reports the real total — so the
 *      "+ N other reasons" line cannot become a lie.
 *
 * Handlers are invoked off the router stack; no HTTP server needed.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * Canned rows, RESTORED in beforeEach. Several tests mutate these to set up a
 * case, and without the restore the file passes only in its current order —
 * inserting a test anywhere above a mutation silently breaks the ones below,
 * which is exactly what happened when the Other-bucket tests were added.
 */
const DEFAULTS = {
  totalsRow: { total: 100, completed: 60, inProgress: 25, cancelled: 10, runningLate: 4, escalated: 3 },
  cityRows: [{ name: 'Bengaluru', jobs: 40, completed: 30 }, { name: 'Pune', jobs: 12, completed: 9 }],
  reasonRows: [
    { reason: 'Customer unavailable', n: 5 }, { reason: 'Duplicate', n: 3 },
    { reason: 'Out of scope', n: 1 },         { reason: 'Not recorded', n: 1 },
  ],
  prevRow: { total: 80, completed: 40, cancelled: 4 },
};
let totalsRow = DEFAULTS.totalsRow;
let cityRows = DEFAULTS.cityRows;
let reasonRows = DEFAULTS.reasonRows;
let prevRow = DEFAULTS.prevRow;

/*
 * The reporting hierarchy. /dashboard-range resolves it through
 * resolveClientHierarchy now, like every other surface on the page — it used
 * to expand self plus DIRECT reports with its own query, non-recursive, and
 * ignore the caller's role.
 *
 * ⚠ TWO ROUTES, NOT ONE. A single /FROM tbl_client_contacts/ pattern matches
 * BOTH the manager_id probe and the recursive subtree query, and the fake
 * dispatches on FIRST match — so the probe was answered with `{ id: 11 }`,
 * `me.manager_id` came back undefined, the SPOC resolved as TOP OF TREE and
 * every scope assertion below passed against an unscoped query.
 */
let me = { manager_id: 7 };                    // not top of the tree → scoped
let subtree = [{ id: 42 }, { id: 11 }];        // self + one direct report

const fake = installFakePool([
  [/SELECT manager_id FROM tbl_client_contacts/i, () => [me]],
  [/WITH RECURSIVE team/i, () => subtree],
  // DATE_SUB is unique to the prior-period count and must be matched BEFORE the
  // patterns below — the fake dispatches on FIRST match, and this query also
  // contains the tokens the totals/reasons routes look for.
  [/DATE_SUB/i, () => [prevRow]],
  // `AS runningLate` is UNIQUE to the totals query. Matching on `AS completed`
  // instead would also catch the cities query, which selects the same alias —
  // the fake dispatches on first match, so a loose pattern silently answers
  // the wrong question.
  [/AS runningLate/i, () => [totalsRow]],
  [/tbl_city/i, () => cityRows],
  [/action_taken_reason/i, () => reasonRows],
]);

const router = require('../routes/client/index');

function handlerFor(path, method) {
  const layer = router.stack.find((e) => e.route && e.route.path === path && e.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

/*
 * ⚠ THE DEFAULT CALLER IS SCOPED (allStores: false), because that is the only
 * caller for whom the scope assertions below MEAN anything. allStores is the
 * role's "sees the whole client" switch, so an allStores fixture makes
 * "reporting_contact_id IN (...)" correctly absent and an assertion that it is
 * present tests nothing. The unrestricted case has its own test.
 */
const req = (from = '2026-07-01', to = '2026-08-25', allStores = false) => ({
  spoc: { id: 42, client_id: 133 },
  access: { allStores, grants: ['home'] },
  query: { from, to },
});

async function call(from, to, allStores = false) {
  const r = res();
  await handlerFor('/dashboard-range', 'get')(req(from, to, allStores), r, (e) => { throw e; });
  assert.equal(r.body?.success, true, JSON.stringify(r.body));
  return r.body.data;
}

beforeEach(() => {
  fake.reset();
  me = { manager_id: 7 };
  subtree = [{ id: 42 }, { id: 11 }];
  totalsRow = DEFAULTS.totalsRow;
  cityRows = DEFAULTS.cityRows;
  reasonRows = DEFAULTS.reasonRows;
  prevRow = DEFAULTS.prevRow;
});

/* The selected window, as opposed to the prior-period comparison. */
const jobQueries = () => fake.calls.filter((c) => /FROM tbl_job j/i.test(c.sql));
const currentWindow = () => jobQueries().filter((c) => !/DATE_SUB/i.test(c.sql));
const priorWindow = () => jobQueries().find((c) => /DATE_SUB/i.test(c.sql));

test('every CURRENT-window aggregate shares ONE cohort, on the creation date', async () => {
  await call('2026-07-01', '2026-08-25');
  // Three, not four. The category breakdown of ALL work was removed from the
  // Cancellations card on 2026-08-26 and its query went with it — an aggregate
  // that runs for a payload nobody renders is pure latency.
  assert.equal(currentWindow().length, 3, 'totals, cities, reasons');
  for (const q of currentWindow()) {
    assert.match(q.sql, /j\.ticket_created_date_time >= \?/,
      'a query on a different date column breaks every percentage on the card');
    assert.match(q.sql, /j\.reporting_contact_id IN \(/, 'team scope must be applied to all three');
  }
});

test('the prior-period count is the SAME LENGTH immediately before, and equally scoped', async () => {
  await call('2026-07-01', '2026-08-25');
  const q = priorWindow();
  assert.ok(q, 'the delta pill needs a comparison window');
  // Length and shift are computed in SQL on purpose: `from`/`to` are bare
  // calendar dates and the column is a zone-less IST DATETIME, so doing the
  // arithmetic in JS means parsing a date into an instant and back — the round
  // trip that moves a boundary by a day outside IST.
  assert.match(q.sql, /DATE_SUB\(\?, INTERVAL \(DATEDIFF\(\?, \?\) \+ 1\) DAY\)/,
    'same length as the selected window, not a hardcoded month');
  assert.match(q.sql, /ticket_created_date_time\s*<\s*\?/,
    'and it must END where the selected window begins, or the two overlap');
  assert.match(q.sql, /SUM\(CASE WHEN j\.job_status = 6/,
    'cancellations are a COLUMN of the prior aggregate now, not a filter on it');
  assert.match(q.sql, /j\.reporting_contact_id IN \(/,
    'an unscoped comparison would make every SPOC look better or worse than they are');
});

test('the Other bucket closes the gap the top 3 leave, exactly', async () => {
  // 10 cancelled across 4 reasons; the top 3 are 5 + 3 + 1 = 9.
  const d = await call();
  const top3 = d.cancellations.topReasons.reduce((a, r) => a + r.count, 0);
  assert.equal(d.cancellations.otherReasons.count, d.cancellations.cancelled - top3,
    'the four rows on the card must sum to the number in its title');
  assert.equal(d.cancellations.otherReasons.reasons, 1, '4 distinct reasons less the 3 shown');
});

test('Other is 0 — not negative — when every reason already fits', async () => {
  reasonRows = [{ reason: 'Customer unavailable', n: 6 }, { reason: 'Duplicate', n: 4 }];
  const d = await call();
  assert.equal(d.cancellations.otherReasons.count, 0, 'nothing left over');
  assert.equal(d.cancellations.otherReasons.reasons, 0);
  assert.ok(d.cancellations.otherReasons.count >= 0, 'a negative remainder would render as a row');
});

test('`to` is inclusive, and expressed so the index stays usable', async () => {
  await call('2026-07-01', '2026-08-25');
  const q = fake.calls.find((c) => /FROM tbl_job j/i.test(c.sql));
  assert.match(q.sql, /<\s*DATE_ADD\(\?, INTERVAL 1 DAY\)/,
    'DATE(created) <= ? would drop the index and still need the same fix');
  assert.doesNotMatch(q.sql, /DATE\(j\.ticket_created_date_time\)/);
});

test('percentages reconcile against the cohort total', async () => {
  const d = await call();
  assert.equal(d.performance.total, 100);
  assert.equal(d.cancellations.cancelled, 10);
  // Reason % is of CANCELLED, not of all work — the card asks "of these, why".
  assert.equal(d.cancellations.topReasons[0].pct, 50, '5 of 10 cancellations');
  assert.equal(d.cancellations.sharePct, undefined,
    'removed with the card row that rendered it — a field nobody reads is a field that drifts');
});

test('top reasons are capped at 3, and reasonCount keeps the remainder honest', async () => {
  const d = await call();
  assert.equal(d.cancellations.topReasons.length, 3);
  assert.equal(d.cancellations.reasonCount, 4,
    'the UI renders "+ N other reasons" off this; a capped count would understate it');
  assert.deepEqual(d.cancellations.topReasons.map((r) => r.reason),
    ['Customer unavailable', 'Duplicate', 'Out of scope']);
});

test('an EMPTY window returns zeroes, never NaN', async () => {
  totalsRow = { total: 0, completed: 0, inProgress: 0, cancelled: 0, runningLate: 0, escalated: 0 };
  cityRows = []; reasonRows = [];
  const d = await call();
  assert.equal(d.performance.total, 0);
  assert.equal(d.cancellations.cancelled, 0, 'every pct divides by a count that can be 0');
  assert.deepEqual(d.cancellations.topReasons, []);
  assert.deepEqual(d.cities, []);
});

test('a cancelled job with no recorded reason is LABELLED, not dropped', async () => {
  // "we don't know" is itself a finding when it is a large share of the total.
  totalsRow = { total: 10, completed: 0, inProgress: 0, cancelled: 4, runningLate: 0, escalated: 0 };
  reasonRows = [{ reason: 'Not recorded', n: 4 }];
  cityRows = [];
  const d = await call();
  assert.equal(d.cancellations.topReasons[0].reason, 'Not recorded');
  assert.equal(d.cancellations.topReasons[0].pct, 100);
  const q = fake.calls.find((c) => /action_taken_reason/i.test(c.sql));
  assert.match(q.sql, /LEFT JOIN action_taken_reason/i,
    'an INNER JOIN would silently drop every reason-less cancellation');
});

// ─── scope narrowing ──────────────────────────────────────────────────────

async function callWith(query, allStores = false) {
  const r = res();
  await handlerFor('/dashboard-range', 'get')(
    { spoc: { id: 42, client_id: 133 }, access: { allStores, grants: ['home'] }, query },
    r, (e) => { throw e; },
  );
  assert.equal(r.body?.success, true, JSON.stringify(r.body));
  return r.body.data;
}

test('?spoc narrows to that member — but ONLY inside the caller\'s own subtree', async () => {
  // The fake returns one direct report, id 11, so the subtree is [11, 42].
  const inside = await callWith({ from: '2026-07-01', to: '2026-08-25', spoc: 11 });
  assert.equal(inside.scope.spoc, 11);
  const q = fake.calls.find((c) => /AS runningLate/i.test(c.sql));
  assert.equal(q.params.filter((p) => p === 11).length, 1, 'the IN list should be just that member');
  assert.equal(q.params.includes(42), false, 'the caller drops out when narrowed to someone else');
});

test('a spoc OUTSIDE the subtree is ignored, not honoured and not an error', async () => {
  /*
   * The security property. Honouring it would let a Store SPOC read a peer's
   * book by guessing a contact id; erroring would confirm which ids exist.
   * Ignoring degrades to the caller's own scope, which is the safe answer.
   */
  fake.reset();
  const d = await callWith({ from: '2026-07-01', to: '2026-08-25', spoc: 9999 });
  assert.equal(d.scope.spoc, null, 'the response must not claim a scope it did not apply');
  const q = fake.calls.find((c) => /AS runningLate/i.test(c.sql));
  assert.equal(q.params.includes(9999), false, 'the foreign id must never reach the query');
  assert.ok(q.params.includes(42) && q.params.includes(11), 'falls back to the full subtree');
});

test('?city is applied to ALL four aggregates, or the percentages would lie', async () => {
  fake.reset();
  const d = await callWith({ from: '2026-07-01', to: '2026-08-25', city: 'Bengaluru' });
  assert.equal(d.scope.city, 'Bengaluru');
  const aggregates = fake.calls.filter((c) => /FROM tbl_job j/i.test(c.sql));
  assert.equal(aggregates.length, 4, 'three current-window aggregates plus the prior-period count');
  for (const q of aggregates) {
    assert.match(q.sql, /city_name = \?/,
      'a city-scoped numerator over a client-wide denominator is a wrong percentage');
    assert.ok(q.params.includes('Bengaluru'), 'and it must be a BOUND parameter');
  }
});

test('no city filter means no join at all — the common path stays cheap', async () => {
  fake.reset();
  await callWith({ from: '2026-07-01', to: '2026-08-25' });
  const totals = fake.calls.find((c) => /AS runningLate/i.test(c.sql));
  assert.doesNotMatch(totals.sql, /ci2\./, 'the address/city join is opt-in');
});

test('ONE prior-period query serves all three cards', async () => {
  await call();
  const prior = jobQueries().filter((c) => /DATE_SUB/i.test(c.sql));
  assert.equal(prior.length, 1,
    'three separate prior queries is three chances for one card to compare against a different fortnight');
  assert.match(prior[0].sql, /AS total/);
  assert.match(prior[0].sql, /AS completed/);
  assert.match(prior[0].sql, /AS cancelled/);
  assert.doesNotMatch(prior[0].sql, /GROUP BY/,
    'no per-city or per-reason breakdown — no card shows a delta at that grain');
});

test('previous is reported RAW, so each card owns its own direction', async () => {
  const d = await call();
  assert.deepEqual(d.previous, { total: 80, completed: 40, cancelled: 4 });
  /*
   * No deltas and no direction in the payload. The three cards DISAGREE about
   * what a rise means — more cancellations is worse, a higher completion rate
   * is better, and more work raised is neither — so a server-computed
   * "improvement" would have to bake one polarity in and every consumer would
   * inherit whichever way it guessed.
   */
  assert.equal(d.previous.delta, undefined);
  assert.equal(d.previous.trend, undefined);
  assert.equal(d.cancellations.previousCancelled, undefined,
    'moved to the shared previous block when Performance and Work-by-city needed it too');
});

test('an empty prior window is zeroes, not nulls — the cards must still render', async () => {
  prevRow = { total: 0, completed: 0, cancelled: 0 };
  const d = await call();
  assert.deepEqual(d.previous, { total: 0, completed: 0, cancelled: 0 });
  for (const v of Object.values(d.previous)) assert.ok(Number.isFinite(v));
});

test('the prior window is not filtered to one status — Performance needs all of it', async () => {
  await call();
  const prior = jobQueries().find((c) => /DATE_SUB/i.test(c.sql));
  assert.doesNotMatch(prior.sql, /WHERE[\s\S]*j\.job_status = 6/,
    'it once counted only cancellations; completion rate needs the whole cohort');
});

/*
 * ─── the scope this route used to resolve for itself ──────────────────────
 *
 * It ran its OWN self-plus-direct-reports query and ignored the caller's role,
 * so a Senior Leader's range cards covered a narrower book than the pulse
 * cards directly above them — the third bespoke scope on one screen.
 */

test('allStores is unrestricted here too — the same book the pulse cards count', async () => {
  await call('2026-07-01', '2026-08-25', true);
  for (const q of jobQueries()) {
    assert.doesNotMatch(q.sql, /reporting_contact_id IN \(/,
      'a Senior Leader sees the whole client on Home; these cards sit ON Home');
  }
});

test('no bespoke direct-reports query — resolveClientHierarchy is the one definition', async () => {
  await call('2026-07-01', '2026-08-25');
  assert.equal(fake.calls.filter((c) => /CAST\(manager_id AS UNSIGNED\)/i.test(c.sql)).length, 0,
    'the hand-rolled expansion was non-recursive: a manager two levels up saw half their book');
  assert.ok(fake.calls.some((c) => /WITH RECURSIVE team/i.test(c.sql)),
    'and the recursive resolver must actually be the one that ran');
});

test('an allStores SPOC may name any of the client\'s SPOCs', async () => {
  const d = await callWith({ from: '2026-07-01', to: '2026-08-25', spoc: 9999 }, true);
  assert.equal(d.scope.spoc, 9999, 'the response reports the scope it applied');
  const q = fake.calls.find((c) => /AS runningLate/i.test(c.sql));
  assert.ok(q.params.includes(9999),
    'someone who may already see the whole client is not spying by naming one of its SPOCs');
});
