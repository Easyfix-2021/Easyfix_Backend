/*
 * Unit tests — Call Tracking, the tab-scoped GRAPHICAL VIEW.
 *
 * The charts used to be derived in the browser from `byUser`, so they described
 * ONE population — every call with a real caller — whichever table was on
 * screen. `getCallTrackingCharts(filters, grain)` recomputes them over the
 * ACTIVE tab's calls instead. What these tests guard, worst-first:
 *
 *   1. THE SCOPE ACTUALLY REACHES THE SQL. A grain that silently fell back to
 *      the whole window is the failure that looks completely fine: charts
 *      render, numbers are plausible, and they answer a different question than
 *      the rows underneath. Every scoped query must carry its grain's
 *      predicate — not just the first one.
 *   2. AN UNKNOWN GRAIN THROWS. The alternative — defaulting to 'job' — is the
 *      same silent-wrong-population bug wearing a different hat.
 *   3. STEPS ARE JOB-ONLY ON EVERY GRAIN. "Which step of the job lifecycle" is
 *      undefined without a job; the browser version folded those calls into an
 *      'Unknown' bar that was really "these had no job at all".
 *   4. TOP CALLERS ARE REAL CALLERS ON EVERY GRAIN. caller_id 0 means nobody
 *      here placed the call, so the Inbound grain must credit no one.
 *   5. THE PHANTOM CALLER. unique_callers counts DISTINCT NULLIF(caller_id, 0)
 *      — in the charts AND in the summary tile beside them. Counting the 0
 *      sentinel adds exactly one caller who does not exist to every window
 *      containing inbound traffic.
 *
 * No DB: the shared pool singleton is faked BEFORE the service loads, so every
 * statement is captured as a string and answered from the `S` fixture.
 *
 * Runner: `node --test`.
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { installFakePool } = require('./helpers/fake-pool');

const S = { totals: [{}], trend: [], parties: [], steps: [], callers: [] };

/*
 * Route order matters — the fake takes the FIRST matching pattern, and several
 * of these queries share fragments. unique_callers is unique to the two totals
 * queries; assignedFlag to steps; the bare `AS role,` to parties; `AS userId,`
 * to callers; and `AS day,` is left last precisely because the others also
 * select a day expression.
 */
const fake = installFakePool([
  [/AS unique_callers/, () => S.totals],
  [/AS assignedFlag/, () => S.steps],
  [/AS role, COUNT/, () => S.parties],
  [/AS userId,[\s\S]*AS connected/, () => S.callers],
  [/AS day,/, () => S.trend],
]);
after(() => fake.restore());

const service = require('../services/quicksight/quicksight-call-tracking.service');

const FILTERS = { dateFrom: '2026-08-01', dateTo: '2026-08-03' };

beforeEach(() => {
  fake.reset();
  S.totals = [{ calls: 10, connected: 6, total_duration_secs: 600, avg_duration_secs: 100, unique_jobs: 4, unique_callers: 2 }];
  S.trend = [];
  S.parties = [];
  S.steps = [];
  S.callers = [];
});

/** Every statement the fake saw, minus the ones a grain does not scope. */
const scopedSql = () => fake.calls.map((c) => c.sql);

test('every grain reaches the SQL — and reaches ALL FIVE queries, not just the first', async () => {
  const expected = {
    job: /AND COALESCE\(jci\.job_id, 0\) > 0/,
    user: /AND COALESCE\(jci\.caller_id, 0\) > 0/,
    direct: /NULLIF\(jci\.job_id, 0\) IS NULL[\s\S]*'OUT'/,
    inbound: /NULLIF\(jci\.job_id, 0\) IS NULL[\s\S]*'IN'/,
  };
  for (const [grain, re] of Object.entries(expected)) {
    fake.reset();
    await service.getCallTrackingCharts(FILTERS, grain);
    const sql = scopedSql();
    assert.equal(sql.length, 5, `${grain}: expected 5 aggregate queries, saw ${sql.length}`);
    for (const s of sql) {
      assert.match(s, re, `${grain}: a query ran WITHOUT the grain scope — that query describes the whole window`);
    }
  }
});

test('the grain list and the scopes are the same set — a tab cannot be exported without SQL behind it', () => {
  /*
   * 'provider' is here even though its scope is the EMPTY string. That tab
   * regroups the window rather than narrowing it, so it has no predicate — but
   * the route's Joi enum is generated from these keys, so a tab missing from the
   * scope map is a tab whose charts 400.
   */
  assert.deepEqual([...service.CHART_GRAINS].sort(), ['direct', 'inbound', 'job', 'provider', 'user']);
});

test('an unknown grain THROWS rather than quietly charting the whole window', async () => {
  await assert.rejects(
    () => service.getCallTrackingCharts(FILTERS, 'everything'),
    (e) => e.status === 400 && /Unknown chart grain/.test(e.message),
  );
  assert.equal(fake.calls.length, 0, 'it must refuse before querying, not after');
});

test('steps are restricted to calls that HAVE a job — on every grain', async () => {
  for (const grain of service.CHART_GRAINS) {
    fake.reset();
    await service.getCallTrackingCharts(FILTERS, grain);
    const stepSql = scopedSql().find((s) => /AS assignedFlag/.test(s));
    assert.ok(stepSql, `${grain}: no steps query ran`);
    assert.match(
      stepSql,
      /AND COALESCE\(jci\.job_id, 0\) > 0/,
      `${grain}: the step chart would carry an 'Unknown' bar meaning "no job", not a lifecycle step`,
    );
  }
});

test('top callers exclude BOTH the 0 sentinel and every inbound row', async () => {
  /*
   * The sentinel alone is not enough and that is the whole point. Measured on
   * QA: inbound rows carry 22,336 distinct caller_ids against outbound's 535,
   * because the legacy writer stamps the id of whoever RANG US into the same
   * column. Only 11,170 of them are a literal 0 — the other 49,041 look like
   * perfectly good user ids, and 2,568 collide with a real one.
   */
  for (const grain of service.CHART_GRAINS) {
    fake.reset();
    await service.getCallTrackingCharts(FILTERS, grain);
    const callerSql = scopedSql().find((s) => /AS userId,[\s\S]*AS connected/.test(s));
    assert.ok(callerSql, `${grain}: no callers query ran`);
    assert.match(callerSql, /AND COALESCE\(jci\.caller_id, 0\) > 0/, `${grain}: caller_id 0 would rank as a person`);
    assert.match(callerSql, /<> 'IN'/, `${grain}: inbound rows would rank people who placed nothing`);
    assert.doesNotMatch(callerSql, /GROUP BY jci\.caller_id\b/,
      `${grain}: grouping on the raw column fans inbound out into thousands of phantom callers`);
  }
});

test('unique_callers counts only OUTBOUND callers — in the charts AND in the summary tile', async () => {
  await service.getCallTrackingCharts(FILTERS, 'inbound');
  const chartTotals = scopedSql().find((s) => /AS unique_callers/.test(s));
  // Direction-aware, not merely sentinel-aware — see the callers test above.
  assert.match(chartTotals, /COUNT\(DISTINCT CASE WHEN[\s\S]*?'IN' THEN NULL ELSE NULLIF\(jci\.caller_id, 0\) END\)\s+AS unique_callers/);

  // The same fix on /summary's Callers tile — read straight off the source so a
  // future edit cannot revert one without the other going red.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'services/quicksight/quicksight-call-tracking.service.js'),
    'utf8',
  );
  assert.equal(
    /COUNT\(DISTINCT jci\.caller_id\)/.test(src),
    false,
    'a bare COUNT(DISTINCT caller_id) counts the "nobody placed this" sentinel as a caller',
  );
  assert.equal(
    /COUNT\(DISTINCT NULLIF\(jci\.caller_id, 0\)\)/.test(src),
    false,
    'NULLIF alone still counts the 22,336 inbound ids that are not 0 and not users either',
  );
});

test('parties drop zero-call roles; steps fold by label and rank most-first', async () => {
  S.parties = [{ role: 'Customer', calls: 7 }, { role: 'Technician', calls: 0 }, { role: null, calls: 2 }];
  // Status 0 legitimately yields TWO labels via the assignment flag; every other
  // status must collapse to one entry however many flag rows it has.
  S.steps = [
    { status: 5, assignedFlag: 1, calls: 4 },
    { status: 5, assignedFlag: 0, calls: 3 },
    { status: 0, assignedFlag: 0, calls: 9 },
  ];
  const out = await service.getCallTrackingCharts(FILTERS, 'job');

  assert.deepEqual(out.parties.map((p) => p.name), ['Customer', 'Other'], 'a null role reads Other; a 0-call role is not a slice');
  assert.deepEqual(out.parties.map((p) => p.value), [7, 2]);

  assert.equal(out.steps.length, 2, 'status 5 must fold to ONE entry across both assignment flags');
  assert.equal(out.steps[0].calls, 9, 'ranked most-calls-first');
  assert.equal(out.steps[1].calls, 7, '4 + 3 folded');
});

test('the trend is gap-filled over the whole window, not only the days with calls', async () => {
  S.trend = [{ day: '2026-08-02', calls: 5, connected: 3, unique_jobs: 2 }];
  const out = await service.getCallTrackingCharts(FILTERS, 'job');
  assert.deepEqual(out.byDay.map((d) => d.day), ['2026-08-01', '2026-08-02', '2026-08-03']);
  assert.deepEqual(out.byDay.map((d) => d.calls), [0, 5, 0], 'a day with no calls is 0, not absent');
});

test('the grain travels back on the response so the FE can prove what it drew', async () => {
  const out = await service.getCallTrackingCharts(FILTERS, 'direct');
  assert.equal(out.grain, 'direct');
  assert.equal(out.totals.calls, 10);
  assert.equal(out.totals.connectRate, 60);
});

/*
 * ── THE INVARIANT ─────────────────────────────────────────────────────────
 *
 * caller_id is a tbl_user id ONLY on an outbound row. Measured on QA over
 * 2025-01-01..2026-08-26:
 *
 *   OUTBOUND  309,575 calls ·    535 distinct ids · 99.5% resolve to tbl_user
 *   INBOUND    60,211 calls · 22,336 distinct ids ·   91% resolve to NEITHER
 *
 * 535 is a staff roster; 22,336 is a customer base. So 49,041 inbound calls —
 * 13.7% of the By User grain — were credited to "callers", and because 2,568 of
 * those ids collide numerically with real tbl_user rows, 623 NAMED members of
 * staff appeared as having placed calls they never placed. The name is what made
 * it look right.
 *
 * These are source-level assertions because the defect is in the SHAPE of the
 * SQL and no fixture of rows can show it: grouping on the raw column returns a
 * plausible row set either way.
 */
const SRC = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'services/quicksight/quicksight-call-tracking.service.js'),
  'utf8',
);

test('the direction guard is defined ONCE and derived from DIRECTION', () => {
  assert.match(SRC, /const OUTBOUND_ONLY = ` AND \$\{DIRECTION\} <> 'IN'`;/);
  assert.match(SRC, /const REAL_CALLER = ` AND COALESCE\(jci\.caller_id, 0\) > 0\$\{OUTBOUND_ONLY\}`;/);
  assert.match(SRC, /const CALLER_ID_EXPR = `CASE WHEN \$\{DIRECTION\} = 'IN' THEN NULL ELSE NULLIF\(jci\.caller_id, 0\) END`;/);
});

test('no surface GROUPS BY the raw caller column — that is what fans inbound out', () => {
  const bad = SRC.match(/GROUP BY[^`]*?\bjci\.caller_id\b/g) || [];
  /*
   * The two per-user grains may: REAL_CALLER already excludes every inbound row
   * before the grouping happens, so caller_id there is only ever outbound. Their
   * four nested breakdowns likewise carry REAL_CALLER now — without it, an
   * inbound row whose phantom id collided with a real staff id was counted into
   * that person's parties/steps.
   */
  for (const g of bad) {
    assert.match(g, /^GROUP BY \$\{DAY_EXPR\}, jci\.caller_id|^GROUP BY jci\.caller_id/,
      `unexpected raw grouping: ${g}`);
  }
  const grainQueries = SRC.split('pool.query').filter((q) => /GROUP BY[^`]*jci\.caller_id/.test(q));
  for (const q of grainQueries) {
    assert.ok(/\$\{REAL_CALLER\}/.test(q),
      'a query grouping on the raw caller column without REAL_CALLER admits inbound rows');
  }
});

test('the caller FILTER and the drill selection read the derivation, not the column', () => {
  // Both had `jci.caller_id = ?` / buildInFilter on the raw column, so selecting
  // one user also selected every inbound row whose foreign id equalled theirs —
  // and the drill list then disagreed with the count that opened it.
  assert.match(SRC, /buildInFilter\(CALLER_ID_EXPR, filters\.callerId, params\)/);
  assert.match(SRC, /where \+= ` AND \$\{CALLER_ID_EXPR\} = \?`/);
  assert.equal(/where \+= ' AND jci\.caller_id = \?'/.test(SRC), false);
});

test('an inbound row can never carry a caller NAME or a user-flavoured kind', () => {
  assert.match(SRC, /CASE WHEN \$\{DIRECTION\} = 'IN' THEN NULL ELSE \$\{CALLER_NAME\} END AS callerName/);
  assert.match(SRC, /CASE WHEN \$\{DIRECTION\} = 'IN' THEN 'inbound' ELSE \$\{CALLER_KIND\} END AS callerKind/);
  // "Called By" on the By Job tab: 40,039 inbound calls DO carry a job.
  assert.match(SRC, /MAX\(CASE WHEN \$\{DIRECTION\} = 'IN' THEN NULL ELSE \$\{CALLER_NAME\} END\) AS userName/);
});

test('a caller-less row is named for what it is, never "User #0" or "Unattributed"', () => {
  assert.match(SRC, /'Incoming call'/);
  assert.match(SRC, /'Incoming caller'/);
  // The old fallback invented a user id for a call nobody here placed.
  assert.equal(/callerName: r\.callerName \|\| `User #\$\{n\(r\.callerUserId\)\}`/.test(SRC), false);
});

test("byOther's parties breakdown does NOT use IN (...) on the nullable key", () => {
  /*
   * NULL never satisfies IN, and every inbound row now carries a NULL caller —
   * an IN restriction would silently drop the whole inbound half of that tab's
   * "To Whom" column. Same family as the NOT IN + NULL trap.
   */
  const block = SRC.slice(SRC.indexOf('let partiesByOther'), SRC.indexOf('Daily trend, GAP-FILLED'));
  assert.match(block, /\$\{CALLER_ID_EXPR\} AS userId/);
  assert.equal(/jci\.caller_id IN \(/.test(block), false,
    'IN (...) on a nullable key drops every inbound row from its own breakdown');
});

/*
 * ── THE ▶ BUTTON MUST BE ABLE TO DELIVER ──────────────────────────────────
 *
 * Reported from production: the Recording column offered a play button that
 * answered "No recording available for this call" on every press.
 *
 * recordingFlag used to be `recording IS NOT NULL AND TRIM(recording) <> ''` —
 * "the column holds something" — while GET /admin/calls/:id/recording needs an
 * https URL, one of OUR S3 keys, or a Plivo call it can lazily pull by uuid. A
 * Kaleyra row whose column holds anything else offered a button and 404'd. The
 * same mismatch ran the other way: a Plivo row with an EMPTY column but a live
 * unique_id printed "No" while the endpoint would have pulled the file happily.
 */
test('recordingFlag matches what the playback endpoint can actually serve', () => {
  const m = SRC.match(/CASE\s*\n\s*WHEN jci\.recording LIKE 'http%'[\s\S]*?END AS recordingFlag/);
  assert.ok(m, 'the recordingFlag CASE moved or was reverted');
  const flag = m[0];
  assert.match(flag, /LIKE 'http%'/, 'an external URL is handed straight back by the endpoint');
  assert.match(flag, /LIKE 'CallRecordings\/%'/, 'our own S3 key is presigned');
  assert.match(flag, /AND NULLIF\(TRIM\(jci\.unique_id\), ''\) IS NOT NULL/,
    'a Plivo call with a uuid is lazily pullable — offering no button there hides a working recording');

  // The old predicate must be gone, in both spellings.
  assert.equal(
    /jci\.recording IS NOT NULL AND TRIM\(jci\.recording\) <> '' THEN 1 ELSE 0 END AS recordingFlag/.test(SRC),
    false,
    '"the column is non-empty" is not "playback will work" — that is the reported bug',
  );
});

test('recordingFlag does NOT hard-reference the migration-gated recording_url column', () => {
  /*
   * routes/admin/calls.js reads tbl_plivo_call_log.recording_url inside a
   * try/catch precisely because the column is behind a migration. A hard
   * reference in this projection would 500 the entire drill-down on a
   * pre-migration deploy, to gain a case the Plivo arm already covers.
   */
  const m = SRC.match(/CASE\s*\n\s*WHEN jci\.recording LIKE 'http%'[\s\S]*?END AS recordingFlag/);
  assert.equal(/recording_url/.test(m[0]), false);
});

/*
 * ── THE BY PROVIDER GRAIN ─────────────────────────────────────────────────
 *
 * "How many calls went through Plivo and how many through Kaleyra, and how many
 * of each came from the new CRM versus the old one."
 *
 * The stack half rests on a fact verified in the source of every stack that
 * writes this table: in EasyFix_API (entity/Contact.java:100) and
 * API_AngularClientDashboard (domain/Contact.java) the `provider` field is
 * @Transient, so it is not in Hibernate's INSERT column list and those stacks
 * CANNOT write it. A stamped provider therefore means the new backend wrote the
 * row. That is a structural guarantee, not a heuristic, and these tests pin the
 * expression that depends on it.
 */
test('the stack split reads the TRIMMED provider value, and only via IS NULL', () => {
  // Built from the two labelled constants, not from inline literals, so the
  // values the SQL emits and the values STACKS exports cannot drift apart.
  assert.match(SRC, /const STACK = `CASE WHEN \$\{PROVIDER_VALUE\} IS NULL THEN '\$\{STACK_OLD\}' ELSE '\$\{STACK_NEW\}' END`;/);
  assert.deepEqual([...service.STACKS].sort(), ['New CRM', 'Old CRM']);
  /*
   * IS NULL / IS NOT NULL, never = '' or <> ''. PROVIDER_VALUE already folds
   * NULL / empty / whitespace into one state, and a definite null test is the
   * one comparison three-valued logic cannot turn into a silent NULL — the trap
   * notPlivo exists to document.
   */
  assert.match(SRC, /\[STACK_NEW\]: ` AND \$\{PROVIDER_VALUE\} IS NOT NULL`/);
  assert.match(SRC, /\[STACK_OLD\]: ` AND \$\{PROVIDER_VALUE\} IS NULL`/);
});

test('the grain groups by the SAME expressions it selects', () => {
  // A GROUP BY that drifts from the projection is how a grain starts reporting
  // buckets that do not match their own labels.
  const m = SRC.match(/SELECT \$\{PROVIDER_RULE\.label\} AS provider,[\s\S]*?ORDER BY calls DESC`/);
  assert.ok(m, 'the byProvider query moved');
  assert.match(m[0], /GROUP BY \$\{PROVIDER_RULE\.label\}, \$\{STACK\}, \$\{DIRECTION\}/);
  // No predicate of its own: this grain partitions the window, so it must
  // reconcile with totals exactly.
  assert.equal(/\$\{NO_JOB\}|\$\{REAL_CALLER\}/.test(m[0]), false,
    'a predicate here would stop the tab reconciling with the KPI band');
});

test('the drill key comes from the SAME vendor test as the label', () => {
  /*
   * providerKey is what the drill-down sends as the `provider` filter, and
   * `provider` is what the cell prints. Deriving them from one test is what
   * stops a row drilling into a vendor other than the one it names — the exact
   * failure PROVIDER_RULE.label's own comment describes for ' plivo'.
   */
  assert.match(SRC, /CASE WHEN \$\{PROVIDER_RULE\.isPlivo\} THEN '\$\{PROVIDER_STAMP_PLIVO\}' ELSE '\$\{PROVIDER_STAMP_KALEYRA\}' END AS providerKey/);
});

test('the stack selection is read off a frozen allow-list, never interpolated', () => {
  assert.match(SRC, /if \(STACK_CLAUSE\[selection\.stack\]\) where \+= STACK_CLAUSE\[selection\.stack\];/);
  assert.match(SRC, /STACKS,/, 'the route generates its Joi enum from this export');
});
