/*
 * Characterization tests for the client Performance book's SQL.
 *
 * These assert on the STATEMENTS the services emit, not on results, because
 * the two things most likely to break here are invisible at the API layer:
 *
 *   1. A window predicate that wraps an indexed column in a function. The page
 *      keeps returning correct numbers and simply gets slower and slower as a
 *      client's history grows — there is no failing assertion anywhere unless
 *      one is written against the SQL itself.
 *
 *   2. TAT drifting back into client-performance.service.js. The retired
 *      category × city-tier day count is gone; a test that fails the moment it
 *      reappears is cheaper than noticing two screens disagree in a review.
 *
 * The fake pool records every (sql, params), so both are checkable offline
 * with no database.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const CLIENT_LOOKUP = /^\s*SELECT client_id, client_name FROM tbl_client/i;

const fake = installFakePool([
  // forClientWindow resolves the client name before aggregating.
  [CLIENT_LOOKUP, [{ client_id: 42, client_name: 'Lenskart' }]],
  // closureStats destructures a single aggregate row; give it one. The VALUES
  // are irrelevant — every assertion below is about the SQL, not the numbers.
  [/SELECT\s+SUM\(CASE WHEN J\.job_status IN/i, [{ completed: 0, cancelled: 0, avg_age_days: null }]],
  // Everything else (the JOB_SELECT, the locality/stop lookups) returns no
  // rows, which is what an empty window looks like.
]);

const tat = require('../services/tat.service');
const perf = require('../services/client-performance.service');

after(() => fake.restore());

const SCOPE = { clientId: 42, from: '2026-08-01', to: '2026-08-20' };

/** The last statement matching `re`, or undefined. */
const lastMatching = (re) => [...fake.calls].reverse().find((c) => re.test(c.sql));

/* ── forClientWindow ─────────────────────────────────────────────── */

test('forClientWindow scopes to the client, completed statuses and a bounded window', async () => {
  fake.reset();
  await tat.forClientWindow(SCOPE);

  const q = lastMatching(/FROM tbl_job j/i);
  assert.ok(q, 'the engine should have run the JOB_SELECT');
  assert.match(q.sql, /j\.fk_client_id = \?/, 'must scope to one client');
  assert.match(q.sql, /j\.job_status IN \(3,5\)/, 'only completed jobs are scored');
  assert.match(q.sql, /j\.checkout_date_time >= \?/, 'window opens on a bare column');
  assert.match(q.sql, /j\.checkout_date_time < DATE_ADD\(\?, INTERVAL 1 DAY\)/,
    '`to` must be inclusive of the whole day');
  assert.deepEqual(q.params, [42, '2026-08-01', '2026-08-20']);
});

test('forClientWindow applies a reporting subtree only when one is given', async () => {
  fake.reset();
  await tat.forClientWindow({ ...SCOPE, reportingContactIds: [7, 9] });
  let q = lastMatching(/FROM tbl_job j/i);
  assert.match(q.sql, /j\.reporting_contact_id IN \(\?,\?\)/, 'subtree filter should be parameterised');
  assert.deepEqual(q.params, [42, '2026-08-01', '2026-08-20', 7, 9]);

  fake.reset();
  await tat.forClientWindow({ ...SCOPE, reportingContactIds: [] });
  q = lastMatching(/FROM tbl_job j/i);
  assert.ok(!/reporting_contact_id/.test(q.sql),
    'an empty subtree means all-stores access, not a filter matching nothing');
});

test('forClientWindow never interpolates caller input into SQL', async () => {
  fake.reset();
  await tat.forClientWindow({ ...SCOPE, from: "2026-08-01' OR 1=1 --" });
  const q = lastMatching(/FROM tbl_job j/i);
  assert.ok(!q.sql.includes('OR 1=1'), 'dates must travel as bound params, never inlined');
  assert.ok(q.params.includes("2026-08-01' OR 1=1 --"));
});

test('forClientWindow 404s for an unknown client rather than aggregating nothing', async () => {
  const missing = installFakePool([[CLIENT_LOOKUP, []]]);
  try {
    await assert.rejects(() => tat.forClientWindow(SCOPE), (e) => e.status === 404);
  } finally {
    missing.restore();
  }
});

/* ── the sargable window ─────────────────────────────────────────── */

/*
 * The regression these three guard against: writing the window as
 * `COALESCE(checkout_date_time, cancel_date_time) >= ?`. It reads better and
 * is completely correct — and it cannot use an index, because a column inside
 * a function is not sargable. The 2026-08-21 index migration would then buy
 * nothing at all.
 */
const COALESCE_IN_A_COMPARISON = /COALESCE\s*\(\s*J\.checkout_date_time[^)]*\)\s*(>=|<|>|<=)/i;

test('closureStats filters on bare date columns, never a COALESCE comparison', async () => {
  fake.reset();
  await perf.closureStats(SCOPE);
  const q = fake.calls.at(-1);
  assert.ok(!COALESCE_IN_A_COMPARISON.test(q.sql),
    'a COALESCE in the WHERE makes the range non-sargable and defeats the indexes');
  assert.match(q.sql, /J\.checkout_date_time >= \?/, 'completed branch must test a bare column');
  assert.match(q.sql, /J\.cancel_date_time >= \?/, 'cancelled branch must test a bare column');
  // client, then (from,to) twice — once per branch.
  assert.deepEqual(q.params, [42, '2026-08-01', '2026-08-20', '2026-08-01', '2026-08-20']);
});

test('the two window branches are disjoint by status, so nothing is double counted', async () => {
  fake.reset();
  await perf.closureStats(SCOPE);
  const sql = fake.calls.at(-1).sql;
  assert.match(sql, /J\.job_status IN \(3,5\)[\s\S]*J\.checkout_date_time/,
    'the checkout branch must be guarded by the completed statuses');
  assert.match(sql, /J\.job_status = 6[\s\S]*J\.cancel_date_time/,
    'the cancel branch must be guarded by the cancelled status');
});

test('volume keeps COALESCE in the SELECT but out of the WHERE', async () => {
  fake.reset();
  await perf.volume(SCOPE, 6);
  const sql = fake.calls.at(-1).sql;
  assert.match(sql, /SELECT DATE_FORMAT\(COALESCE\(/i,
    'grouping by the closing date is fine — that runs on already-filtered rows');
  const where = sql.slice(sql.search(/\bWHERE\b/i));
  assert.ok(!COALESCE_IN_A_COMPARISON.test(where),
    'the filter itself must stay on bare columns');
});

test('volume clamps the month count instead of trusting the query string', async () => {
  fake.reset();
  await perf.volume(SCOPE, 999);
  assert.match(fake.calls.at(-1).sql, /INTERVAL 23 MONTH/, 'capped at 24 months');

  fake.reset();
  await perf.volume(SCOPE, -5);
  assert.match(fake.calls.at(-1).sql, /INTERVAL 5 MONTH/, 'a negative falls back to the 6-month default');
});

test('firstTimeFix asks only about completed jobs, so it needs one bare range', async () => {
  /*
   * firstTimeFix probes `SHOW TABLES LIKE 'linked_job'` first and returns
   * nulls when the table is absent, so this needs its OWN fake that reports
   * the table as present — otherwise the only statement recorded is the probe.
   */
  const withLinkedJob = installFakePool([
    [/^\s*SHOW TABLES LIKE 'linked_job'/i, [{ Tables_in_db: 'linked_job' }]],
    [/FROM tbl_job J/i, [{ completed: 0, first_time_fixed: 0 }]],
  ]);
  try {
    // Re-require through a fresh module registry so the once-per-process
    // linked_job probe re-runs against this fake instead of the outer one.
    delete require.cache[require.resolve('../services/client-performance.service')];
    const isolated = require('../services/client-performance.service');
    await isolated.firstTimeFix(SCOPE);

    const q = [...withLinkedJob.calls].reverse().find((c) => /FROM tbl_job J/i.test(c.sql));
    assert.ok(q, 'the aggregate should have run once the table was found');
    assert.match(q.sql, /J\.job_status IN \(3,5\)/);
    assert.match(q.sql, /J\.checkout_date_time >= \?/);
    assert.ok(!/cancel_date_time/.test(q.sql), 'a cancelled job cannot be a first-time fix');
    assert.match(q.sql, /LEFT JOIN \(SELECT DISTINCT parent_job_id FROM linked_job\)/,
      'DISTINCT is what makes "spawned a revisit" a per-job fact rather than a link count');
  } finally {
    withLinkedJob.restore();
    delete require.cache[require.resolve('../services/client-performance.service')];
  }
});

/* ── the retired definition stays retired ────────────────────────── */

test('client-performance.service contains no TAT computation at all', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../services/client-performance.service.js'), 'utf8',
  );
  // The old definition's fingerprints: the category ids and the tier CASE.
  assert.ok(!/fk_service_catg_id\s*=\s*15/.test(src),
    'the retired category × tier thresholds must not come back here');
  assert.ok(!/city\.tier/.test(src),
    'tier was rejected by the TAT spec (86 of 680 city rows have none)');
  assert.ok(!/\bin_tat\b/.test(src),
    'TAT belongs to services/tat.service.js and nowhere else');
});

test('the TAT engine exposes the windowed client mode the portal depends on', () => {
  assert.equal(typeof tat.forClientWindow, 'function');
  // forClient stays — it is what the admin TAT Calculator uses.
  assert.equal(typeof tat.forClient, 'function');
});
