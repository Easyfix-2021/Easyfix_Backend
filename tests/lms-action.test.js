const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * LMS action-home characterization tests.
 *
 * These pin the invariants whose failure is SILENT — the ones that produce a
 * plausible-looking screen rather than an error, which is the only failure
 * mode that actually reaches an operator:
 *
 *   1. City scope. A missing clause is a cross-state data leak, not a crash.
 *   2. The cache key BEING the scope. A global cache filtered per request
 *      serves one manager another manager's counters.
 *   3. propNumber's blank-string guard. Number('') is 0, not NaN — the exact
 *      coercion that silently disabled the rewards earn cycle in August. A 0
 *      here means "every module is stale".
 *   4. D1 suppressing D6 for the same module, so an overdue module is not
 *      counted twice in both the list and the denominator.
 *   5. The denominator only subtracting MODULE-grained detectors.
 *   6. The three-way "running normally" copy. Nothing assigned is not the
 *      same claim as everything needing attention.
 */

/*
 * The harness fixes its routes at install time, so one dispatching route is
 * installed over a mutable table. `scenario` is what each assembly test
 * swaps; everything else about the fake stays constant.
 */
let scenario = [];
const fake = installFakePool([[/.*/, (sql, params) => {
  for (const [re, rows] of scenario) if (re.test(sql)) return typeof rows === 'function' ? rows(sql, params) : rows;
  return [];
}]]);
const action = require('../services/lms-action.service');
const props = require('../services/properties.service');

after(() => fake.restore());

// ─── 1. City scope ───────────────────────────────────────────────────

test('scope: an unscoped caller (Admin/Finance) gets no clause at all', () => {
  const clauses = []; const params = [];
  action.applyCityScope(clauses, params, undefined);
  assert.deepEqual(clauses, []);
  assert.deepEqual(params, []);
});

test('scope: mode "none" blocks every row rather than returning all of them', () => {
  const clauses = []; const params = [];
  action.applyCityScope(clauses, params, { cities: { mode: 'none', ids: [] } });
  assert.deepEqual(clauses, ['1=0']);
  assert.deepEqual(params, []);
});

test('scope: mode "allow" binds one placeholder per city, never inlines ids', () => {
  const clauses = []; const params = [];
  action.applyCityScope(clauses, params, { cities: { mode: 'allow', ids: [7, 9, 11] } });
  assert.equal(clauses.length, 1);
  assert.match(clauses[0], /e\.efr_cityId IN \(\?,\?,\?\)/);
  assert.deepEqual(params, [7, 9, 11]);
});

test('scope: an "allow" with an EMPTY id list adds no clause — it must not silently widen', () => {
  // A region with zero active cities resolves to mode 'none' upstream in
  // lib/scope.js. If it ever arrived here as an empty allow, adding no clause
  // is wrong-but-visible; adding `IN ()` would be a syntax error. Pinned so a
  // future edit has to think about it.
  const clauses = []; const params = [];
  action.applyCityScope(clauses, params, { cities: { mode: 'allow', ids: [] } });
  assert.deepEqual(clauses, []);
});

// ─── 2. The cache key IS the scope ───────────────────────────────────

test('cache key: different city sets never share a cache entry', () => {
  const a = action.scopeKey({ cities: { mode: 'allow', ids: [1, 2] } });
  const b = action.scopeKey({ cities: { mode: 'allow', ids: [1, 3] } });
  const all = action.scopeKey(undefined);
  const none = action.scopeKey({ cities: { mode: 'none', ids: [] } });
  assert.notEqual(a, b, 'two different city sets must not collide');
  assert.notEqual(a, all, 'a scoped user must never read the unscoped entry');
  assert.notEqual(none, all, '"sees nothing" must never read "sees everything"');
  assert.equal(all, 'all');
  assert.equal(none, 'none');
});

test('cache key: the same city set is stable across calls', () => {
  const scope = { cities: { mode: 'allow', ids: [4, 5, 6] } };
  assert.equal(action.scopeKey(scope), action.scopeKey({ ...scope }));
});

// ─── 3. propNumber's blank-string guard ──────────────────────────────

test('propNumber: a BLANK property falls back — Number("") is 0, not NaN', () => {
  const original = props.getProperty;
  props.getProperty = () => '';
  try {
    // 0 here would mean "every module is stale, every day".
    assert.equal(action.propNumber('lms.action.stale.days', 7), 7);
  } finally { props.getProperty = original; }
});

test('propNumber: a MISSING property falls back', () => {
  const original = props.getProperty;
  props.getProperty = () => undefined;
  try {
    assert.equal(action.propNumber('lms.action.stale.pct', 30), 30);
  } finally { props.getProperty = original; }
});

test('propNumber: a real value wins, and 0 is honoured when explicitly set', () => {
  const original = props.getProperty;
  props.getProperty = () => '  0  ';
  try {
    assert.equal(action.propNumber('lms.action.stale.days', 7), 0,
      'an explicit 0 is a deliberate operator choice and must not be overridden');
  } finally { props.getProperty = original; }
});

test('propNumber: a negative or non-numeric value falls back rather than poisoning a query', () => {
  const original = props.getProperty;
  try {
    props.getProperty = () => '-5';
    assert.equal(action.propNumber('k', 7), 7);
    props.getProperty = () => 'soon';
    assert.equal(action.propNumber('k', 7), 7);
  } finally { props.getProperty = original; }
});

// ─── 4-6. Assembly invariants, driven through the real builder ───────

/*
 * Drive buildActionHome with routed fakes so the assembly logic — not the
 * SQL — is what is under test. Each detector is matched by a fragment unique
 * to its own query.
 */
function useRows({ d1 = [], d3 = [], d4 = [], d5 = [], d6 = [], counters = {} }) {
  const c = { overdue: 0, pending: 0, paused_waiting: 0, active_modules: 0, ...counters };
  scenario = [
    [/GROUP BY ec\.course_id, c\.name\s+ORDER BY stuck_count DESC/i, d1],
    [/lifecycle_status = 'ASSESSMENT_FAILED'\s*(AND|$)/i, d3],
    [/COUNT\(DISTINCT ec\.easyfixer_id\) AS stuck_count,\s+GROUP_CONCAT/i, d4],
    [/lms_client_course_requirement/i, d5],
    [/HAVING assigned >= \? AND/i, d6],
    [/SUM\(ec\.due_date IS NOT NULL AND ec\.due_date < \?\) AS overdue/i, [c]],
    [/FROM tbl_easyfixer e\s+WHERE/i, [{ n: 0 }]],
    [/FROM tbl_city c/i, []],
    [/.*/, [{ n: 0 }]],
  ];
}

test('denominator: only MODULE-grained detectors reduce "running normally"', async () => {
  fake.reset();
  useRows({
    d1: [{ course_id: 1, course_name: 'A', stuck_count: 3, oldest_due: '2026-08-01', city_ids: '5' }],
    d4: [{ stuck_count: 9, city_ids: '5' }],           // technician-grained
    d3: [{ stuck_count: 2, city_ids: '5' }],           // technician-grained
    counters: { active_modules: 10 },
  });
  const r = await action._internals.buildActionHome(undefined);
  // 10 active, ONE module flagged (by D1). D3 and D4 are about people, not
  // modules — a module can run perfectly while one technician is stuck.
  assert.equal(r.summary.runningNormally, 9);
  assert.match(r.summary.runningNormallyText, /^9 modules running normally/);
});

test('denominator: D1 suppresses D6 for the same module, so it is not subtracted twice', async () => {
  fake.reset();
  useRows({
    d1: [{ course_id: 42, course_name: 'Dup', stuck_count: 3, oldest_due: '2026-08-01', city_ids: '5' }],
    d6: [{ course_id: 42, course_name: 'Dup', assigned: 20, done: 1, stuck_count: 19, city_ids: '5' }],
    counters: { active_modules: 5 },
  });
  const r = await action._internals.buildActionHome(undefined);
  const forty2 = r.rows.filter((x) => x.itemId === 42);
  assert.equal(forty2.length, 1, 'one module must produce one row, not two');
  assert.equal(forty2[0].detector, 'deadline_passed', 'overdue is the more urgent of the two');
  assert.equal(r.summary.runningNormally, 4, '5 active minus ONE flagged module');
});

test('running-normally copy: nothing assigned is NOT the same claim as everything on fire', async () => {
  fake.reset();
  useRows({ counters: { active_modules: 0 } });
  const r = await action._internals.buildActionHome(undefined);
  assert.equal(r.summary.runningNormally, 0);
  assert.match(r.summary.runningNormallyText, /No training is currently assigned/i);
});

test('running-normally copy: every module flagged reads as attention, never "0 running normally"', async () => {
  fake.reset();
  useRows({
    d1: [{ course_id: 1, course_name: 'A', stuck_count: 1, oldest_due: '2026-08-01', city_ids: '5' }],
    counters: { active_modules: 1 },
  });
  const r = await action._internals.buildActionHome(undefined);
  assert.match(r.summary.runningNormallyText, /Every module with live assignments needs attention/);
  assert.doesNotMatch(r.summary.runningNormallyText, /^0 modules/,
    '"0 modules are running normally" reads like a rendering bug on the one line whose job is to be believable');
});

test('unavailable detectors declare themselves instead of emitting a fake row', async () => {
  fake.reset();
  useRows({ counters: { active_modules: 3 } });
  const r = await action._internals.buildActionHome(undefined);
  assert.ok(r.unavailable.some((u) => u.key === 'session_48h'));
  assert.equal(r.rows.filter((x) => x.detector === 'session_48h').length, 0,
    'on a screen whose premise is "what you see is what needs doing", a placeholder row is worse than an absent one');
});

test('owner: several distinct owners collapse to a count, none falls back to the training team', () => {
  const { describeOwner } = action._internals;
  assert.equal(describeOwner([{ name: 'R. Kulkarni' }]), 'R. Kulkarni');
  assert.equal(describeOwner([{ name: 'A' }, { name: 'B' }]), '2 state managers');
  assert.equal(describeOwner([undefined, null]), 'Training team');
  assert.equal(describeOwner([{ name: 'A' }, { name: 'A' }]), 'A', 'the same owner twice is one owner');
});
