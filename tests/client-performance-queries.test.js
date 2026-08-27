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

/* ── ?city= (2026-08-26) ─────────────────────────────────────────────
 *
 * Added so the client dashboard's Performance health card obeys the same city
 * chip its three neighbours do. Before this the card had to print a note
 * admitting the chip did not reach it, because /performance had no city
 * dimension and would have ignored the parameter silently.
 */

test('forClientWindow filters on city WITHOUT adding a join — JOB_SELECT already has one', async () => {
  fake.reset();
  await tat.forClientWindow({ ...SCOPE, city: 'Bengaluru' });

  const q = lastMatching(/FROM tbl_job j/i);
  assert.match(q.sql, /AND city\.city_name = \?/, 'the filter must apply');
  assert.ok(q.params.includes('Bengaluru'), 'and be a BOUND parameter, never interpolated');
  // The projection already reports city_name and tier, so the join exists.
  // A second one would silently double every scored row.
  const joins = q.sql.match(/LEFT JOIN tbl_city/gi) || [];
  assert.equal(joins.length, 1, 'exactly one tbl_city join — a duplicate would double-count');
});

test('an absent city adds no clause at all', async () => {
  fake.reset();
  await tat.forClientWindow(SCOPE);
  const q = lastMatching(/FROM tbl_job j/i);
  assert.doesNotMatch(q.sql, /city_name = \?/, 'no city means no predicate, not an empty string match');
  assert.deepEqual(q.params, [42, '2026-08-01', '2026-08-20']);
});

test('closureStats brings its OWN join when scoped by city', async () => {
  // Unlike the TAT engine these select FROM tbl_job with no address join, so a
  // clause referencing CI without the join is a 500 on an unknown alias.
  fake.reset();
  await perf.closureStats({ ...SCOPE, city: 'Pune' });
  const q = lastMatching(/SUM\(CASE WHEN J\.job_status IN/i);
  assert.ok(q, 'the aggregate should have run');
  assert.match(q.sql, /LEFT JOIN tbl_address AD/i, 'the join must travel with the clause');
  assert.match(q.sql, /LEFT JOIN tbl_city\s+CI/i, 'and reach tbl_city');
  assert.match(q.sql, /CI\.city_name = \?/, 'the predicate itself');
  assert.ok(q.params.includes('Pune'), 'bound, not interpolated');
});

test('EVERY scopeWhere consumer interpolates the join it is handed', () => {
  /*
   * Asserted against the SOURCE rather than by running each query, because
   * firstTimeFix short-circuits on a memoised `SHOW TABLES LIKE 'linked_job'`
   * probe and would need its own module registry to reach its SQL — a lot of
   * scaffolding to catch a one-token omission.
   *
   * This is the real failure mode: scopeWhere returns { clause, params, join }
   * and a caller that destructures the first two and forgets the third emits a
   * WHERE on an alias nothing joined. It 500s only when a city is actually
   * selected, so it would pass every unscoped test in this file.
   */
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'services/client-performance.service.js'), 'utf8');
  const consumers = src.match(/const \{[^}]*\} = scopeWhere\(/g) || [];
  assert.ok(consumers.length >= 2, 'expected closureStats and firstTimeFix at least');
  for (const c of consumers) {
    assert.match(c, /\bjoin\b/,
      `a scopeWhere consumer ignores the join it is given: ${c.trim()}`);
  }
  /*
   * And every FROM tbl_job J must carry it — scanned over CODE ONLY. The first
   * pass counted a comment that quotes "FROM tbl_job J" while explaining why
   * the join exists, and reported the docs as the bug.
   */
  const code = src.split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  }).join('\n');
  const bare = (code.match(/FROM tbl_job J(?!\$\{join\})/g) || []);
  assert.equal(bare.length, 0,
    `every FROM tbl_job J must interpolate the join; ${bare.length} do not`);
});

test('volume is scoped by city too, even though it ignores the window on purpose', async () => {
  fake.reset();
  await perf.volume({ ...SCOPE, city: 'Pune' }, 6);
  const q = lastMatching(/DATE_FORMAT\(COALESCE/i);
  assert.match(q.sql, /CI\.city_name = \?/,
    'a client-wide trend under city-scoped KPIs would be two populations on one card');
  assert.match(q.sql, /LEFT JOIN tbl_address AD/i, 'and it needs the join as well');
});

/* ── judgeAgainst: a null is NOT a pass (2026-08-26) ──────────────── */

test('judgeAgainst returns NULL when there is nothing to judge, never ok', () => {
  const targets = require('../services/client-target.service');
  assert.equal(targets.judgeAgainst('sla_pct', null, 90), null,
    'this returned ok — the SUCCESS state — so an unscored window rendered four green KPIs');
  assert.equal(targets.judgeAgainst('sla_pct', 85, null), null, 'no target is equally unjudgeable');
  // The real judgements are untouched.
  assert.equal(targets.judgeAgainst('sla_pct', 95, 90), 'ok');
  assert.equal(targets.judgeAgainst('sla_pct', 85, 90), 'watch', 'within 10% of the target');
  assert.equal(targets.judgeAgainst('sla_pct', 10, 90), 'risk');
  // Lower-is-better still reads the other way round.
  assert.equal(targets.judgeAgainst('avg_age_days', 2, 3), 'ok');
  assert.equal(targets.judgeAgainst('avg_age_days', 9, 3), 'risk');
});

/* ── first-time fix = SAME-DAY CLOSE (2026-08-27) ─────────────────────
 *
 * It used to mean "no child row in linked_job" — nobody came back. Measured
 * over a year of completed jobs on QA that rule scored 98.4% against an 85%
 * target, so it could not fail for anybody. The definition is whether the
 * technician checked in and checked out on the SAME DAY: 55.0%.
 *
 * The tests below pin BOTH halves, because changing one without the other is
 * the more damaging outcome: revisit was literally `100 - ftfr`, so a same-day
 * ftfr would have made it report 45% of jobs needing a second visit against a
 * target of 10%, when the real figure is 1.6%.
 */

/** Run firstTimeFix against a pool that reports linked_job present/absent. */
async function withFtf(routes, fn) {
  const iso = installFakePool(routes);
  try {
    delete require.cache[require.resolve('../services/client-performance.service')];
    const svc = require('../services/client-performance.service');
    const out = await fn(svc, iso);
    return out;
  } finally {
    iso.restore();
    delete require.cache[require.resolve('../services/client-performance.service')];
  }
}

test('first-time fix is measured on same-day check-in/check-out, not on linked_job', async () => {
  let q;
  await withFtf([
    [/^\s*SHOW TABLES LIKE 'linked_job'/i, [{ Tables_in_db: 'linked_job' }]],
    [/FROM tbl_job J/i, [{ completed: 0, first_time_fixed: 0, revisited: 0 }]],
  ], async (svc, iso) => {
    await svc.firstTimeFix(SCOPE);
    q = [...iso.calls].reverse().find((c) => /first_time_fixed/i.test(c.sql));
  });

  assert.ok(q, 'the aggregate should have run');
  assert.match(q.sql, /DATE\(J\.checkin_date_time\) = DATE\(J\.checkout_date_time\)/,
    'same DAY, not same timestamp — a visit that starts at 09:00 and ends at 17:00 is one visit');
  assert.match(q.sql, /J\.checkin_date_time IS NOT NULL/,
    'a job with no check-in was not fixed on a first visit that never happened');
  assert.doesNotMatch(q.sql, /first_time_fixed[\s\S]{0,80}parent_job_id IS NULL/,
    'ftfr must no longer be derived from the absence of a linked job');
});

test('revisit keeps the linked_job rule and is counted SEPARATELY, not 100 - ftfr', async () => {
  let out; let q;
  await withFtf([
    [/^\s*SHOW TABLES LIKE 'linked_job'/i, [{ Tables_in_db: 'linked_job' }]],
    // 100 completed: 55 closed same-day, 2 spawned a revisit.
    [/FROM tbl_job J/i, [{ completed: 100, first_time_fixed: 55, revisited: 2 }]],
  ], async (svc, iso) => {
    out = await svc.firstTimeFix(SCOPE);
    q = [...iso.calls].reverse().find((c) => /first_time_fixed/i.test(c.sql));
  });

  assert.match(q.sql, /parent_job_id IS NOT NULL/, 'revisit is still the linked_job fact');
  assert.equal(out.ftfrPct, 55);
  assert.equal(out.revisitPct, 2,
    'NOT 45 — the two measure different things, and coupling them would claim '
    + 'nearly half of all work needed a second visit');
  assert.notEqual(out.revisitPct, 100 - out.ftfrPct, 'the old derivation is gone');
});

test('without linked_job, first-time fix still works and revisit is NULL', async () => {
  let out; let q;
  await withFtf([
    [/^\s*SHOW TABLES LIKE 'linked_job'/i, []],   // table absent
    [/FROM tbl_job J/i, [{ completed: 40, first_time_fixed: 30, revisited: null }]],
  ], async (svc, iso) => {
    out = await svc.firstTimeFix(SCOPE);
    q = [...iso.calls].reverse().find((c) => /first_time_fixed/i.test(c.sql));
  });

  assert.ok(q, 'the aggregate must still run — ftfr no longer depends on that table');
  assert.doesNotMatch(q.sql, /JOIN \(SELECT DISTINCT parent_job_id FROM linked_job\)/,
    'no join to a table that does not exist');
  assert.equal(out.ftfrPct, 75, 'same-day close needs only two core tbl_job columns');
  assert.equal(out.revisitPct, null,
    'NULL, not 0 — "we cannot measure this" is not "nobody came back"');
  assert.equal(out.available, false, 'and the flag says which half is unmeasurable');
});

test('an empty window is nulls, never a fabricated 100%', async () => {
  let out;
  await withFtf([
    [/^\s*SHOW TABLES LIKE 'linked_job'/i, [{ Tables_in_db: 'linked_job' }]],
    [/FROM tbl_job J/i, [{ completed: 0, first_time_fixed: 0, revisited: 0 }]],
  ], async (svc) => { out = await svc.firstTimeFix(SCOPE); });

  assert.equal(out.ftfrPct, null, '0 of 0 is not 100% and is not 0%');
  assert.equal(out.revisitPct, null);
});
