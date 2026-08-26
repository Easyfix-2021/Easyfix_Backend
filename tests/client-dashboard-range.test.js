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

let totalsRow = { total: 100, completed: 60, inProgress: 25, cancelled: 10, runningLate: 4, escalated: 3 };
let cityRows = [{ name: 'Bengaluru', jobs: 40, completed: 30 }, { name: 'Pune', jobs: 12, completed: 9 }];
let reasonRows = [
  { reason: 'Customer unavailable', n: 5 }, { reason: 'Duplicate', n: 3 },
  { reason: 'Out of scope', n: 1 },         { reason: 'Not recorded', n: 1 },
];
let catRows = [{ label: 'Carpentry Services', n: 96 }, { label: 'Other', n: 4 }];

const fake = installFakePool([
  [/FROM tbl_client_contacts/i, [{ id: 11 }]],          // one direct report
  // `AS runningLate` is UNIQUE to the totals query. Matching on `AS completed`
  // instead would also catch the cities query, which selects the same alias —
  // the fake dispatches on first match, so a loose pattern silently answers
  // the wrong question.
  [/AS runningLate/i, () => [totalsRow]],
  [/tbl_city/i, () => cityRows],
  [/action_taken_reason/i, () => reasonRows],
  [/tbl_service_catg/i, () => catRows],
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

const req = (from = '2026-07-01', to = '2026-08-25') => ({
  spoc: { id: 42, client_id: 133 },
  access: { allStores: true, grants: ['home'] },
  query: { from, to },
});

async function call(from, to) {
  const r = res();
  await handlerFor('/dashboard-range', 'get')(req(from, to), r, (e) => { throw e; });
  assert.equal(r.body?.success, true, JSON.stringify(r.body));
  return r.body.data;
}

beforeEach(() => fake.reset());

test('every aggregate shares ONE cohort window, on the creation date', async () => {
  await call('2026-07-01', '2026-08-25');
  const aggregates = fake.calls.filter((c) => /FROM tbl_job j/i.test(c.sql));
  assert.equal(aggregates.length, 4, 'totals, cities, reasons, categories');
  for (const q of aggregates) {
    assert.match(q.sql, /j\.ticket_created_date_time >= \?/,
      'a query on a different date column breaks every percentage on the card');
    assert.match(q.sql, /j\.reporting_contact_id IN \(/, 'team scope must be applied to all four');
  }
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
  assert.equal(d.cancellations.sharePct, 10, '10 of 100');
  // Reason % is of CANCELLED, not of all work — the card asks "of these, why".
  assert.equal(d.cancellations.topReasons[0].pct, 50, '5 of 10 cancellations');
  assert.equal(d.cancellations.categories[0].pct, 96, '96 of 100 jobs');
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
  cityRows = []; reasonRows = []; catRows = [];
  const d = await call();
  assert.equal(d.performance.total, 0);
  assert.equal(d.cancellations.sharePct, 0, 'every pct divides by a count that can be 0');
  assert.deepEqual(d.cancellations.topReasons, []);
  assert.deepEqual(d.cities, []);
  assert.ok(Number.isFinite(d.cancellations.sharePct));
});

test('a cancelled job with no recorded reason is LABELLED, not dropped', async () => {
  // "we don't know" is itself a finding when it is a large share of the total.
  totalsRow = { total: 10, completed: 0, inProgress: 0, cancelled: 4, runningLate: 0, escalated: 0 };
  reasonRows = [{ reason: 'Not recorded', n: 4 }];
  cityRows = []; catRows = [];
  const d = await call();
  assert.equal(d.cancellations.topReasons[0].reason, 'Not recorded');
  assert.equal(d.cancellations.topReasons[0].pct, 100);
  const q = fake.calls.find((c) => /action_taken_reason/i.test(c.sql));
  assert.match(q.sql, /LEFT JOIN action_taken_reason/i,
    'an INNER JOIN would silently drop every reason-less cancellation');
});

// ─── scope narrowing ──────────────────────────────────────────────────────

async function callWith(query) {
  const r = res();
  await handlerFor('/dashboard-range', 'get')(
    { spoc: { id: 42, client_id: 133 }, access: { allStores: true, grants: ['home'] }, query },
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
  assert.equal(aggregates.length, 4);
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
