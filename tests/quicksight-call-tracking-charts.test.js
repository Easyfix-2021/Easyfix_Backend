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
  [/jci\.caller_id AS userId/, () => S.callers],
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
  assert.deepEqual([...service.CHART_GRAINS].sort(), ['direct', 'inbound', 'job', 'user']);
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

test('top callers always require a REAL caller — the Inbound tab credits nobody', async () => {
  for (const grain of service.CHART_GRAINS) {
    fake.reset();
    await service.getCallTrackingCharts(FILTERS, grain);
    const callerSql = scopedSql().find((s) => /jci\.caller_id AS userId/.test(s));
    assert.ok(callerSql, `${grain}: no callers query ran`);
    assert.match(callerSql, /AND COALESCE\(jci\.caller_id, 0\) > 0/, `${grain}: caller_id 0 would rank as a person`);
  }
});

test('unique_callers excludes the 0 sentinel — in the charts AND in the summary tile', async () => {
  await service.getCallTrackingCharts(FILTERS, 'inbound');
  const chartTotals = scopedSql().find((s) => /AS unique_callers/.test(s));
  assert.match(chartTotals, /COUNT\(DISTINCT NULLIF\(jci\.caller_id, 0\)\)\s+AS unique_callers/);

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
