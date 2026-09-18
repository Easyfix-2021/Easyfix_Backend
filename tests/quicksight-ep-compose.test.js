/*
 * QuickSight — Employee Performance: compose(), the JS port of build_data.py.
 *
 * THE GOLDEN. tests/fixtures/qs-ep/workbook.json is a SYNTHETIC workbook (every
 * name and number invented) as pandas.read_excel sees it; golden-d.json is what
 * the MIS build_data.py wrote for it. compose(fromWorkbookSheets(workbook),
 * {teamMode:'legacy'}) must reproduce that D: same keys in the same order, same
 * arrays, numbers within 1e-9. Regenerate both with
 * tests/fixtures/qs-ep/make_fixtures.py (it needs build_data.py and pandas).
 *
 * WHY THE FIXTURE IS SHAPED THE WAY IT IS. Every oddity in it is a rule
 * build_data.py applies silently and a port gets wrong silently: a SPOC whose
 * team changes between months (legacy teamSize 0), a duplicate CRM name (last
 * row wins, members list repeats it), a Row Label claimed twice (first claim
 * wins), a trailing-space technician name, blank cells, a text date, an
 * unparseable charge, an avg_age that is an exact half-way tie at 4 dp, two
 * target-less SPOCs tied for one team's lead, and more than 128 closed rows for
 * one SPOC so numpy's pairwise summation takes its recursive branch. Each was
 * checked by breaking that rule in compose.js and watching this test fail.
 *
 * The perMonth tests use hand-built NORMALISED inputs (the shape a DB adapter
 * produces), because that mode has no Python original to diff against.
 *
 * Runner: TZ=UTC node --test-reporter=spec tests/quicksight-ep-compose.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { compose, fromWorkbookSheets, TEAM_MODES, _internals: I } =
  require('../services/quicksight/employee-performance/compose');

const FIXTURES = path.join(__dirname, 'fixtures', 'qs-ep');
const workbook = require(path.join(FIXTURES, 'workbook.json'));
const golden = require(path.join(FIXTURES, 'golden-d.json'));
const numericGolden = require(path.join(FIXTURES, 'numeric-golden.json'));

const TOLERANCE = 1e-9;

/** Every path where `actual` differs from `expected` (key ORDER included). */
function diffPaths(expected, actual, tolerance, at = 'D', out = []) {
  if (out.length >= 25) return out;
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (!(expected === actual || Math.abs(expected - actual) <= tolerance)) {
      out.push(`${at}: expected ${expected}, got ${actual}`);
    }
    return out;
  }
  if (expected === null || actual === null || typeof expected !== 'object' || typeof actual !== 'object') {
    if (expected !== actual) out.push(`${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    return out;
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    out.push(`${at}: array vs object`);
    return out;
  }
  if (Array.isArray(expected)) {
    if (expected.length !== actual.length) out.push(`${at}: length ${expected.length} vs ${actual.length}`);
    for (let i = 0; i < Math.min(expected.length, actual.length); i += 1) {
      diffPaths(expected[i], actual[i], tolerance, `${at}[${i}]`, out);
    }
    return out;
  }
  const ek = Object.keys(expected);
  const ak = Object.keys(actual);
  if (JSON.stringify(ek) !== JSON.stringify(ak)) out.push(`${at}: keys ${JSON.stringify(ek)} vs ${JSON.stringify(ak)}`);
  for (const k of ek) {
    if (Object.prototype.hasOwnProperty.call(actual, k)) diffPaths(expected[k], actual[k], tolerance, `${at}.${k}`, out);
  }
  return out;
}

const plain = (v) => JSON.parse(JSON.stringify(v));
const legacyD = () => plain(compose(fromWorkbookSheets(workbook), { teamMode: 'legacy' }));

// ─── Golden parity with build_data.py ────────────────────────────────────────

test('legacy compose reproduces build_data.py on the synthetic workbook', () => {
  const diffs = diffPaths(golden, legacyD(), TOLERANCE);
  assert.deepEqual(diffs, [], `D differs from build_data.py:\n${diffs.join('\n')}`);
});

test('... and bit for bit, so a summation-order slip cannot hide inside the tolerance', () => {
  // Summing the SPOC's revenue left to right instead of numpy's pairwise order
  // moves it by ~1e-11: inside 1e-9, and exactly the drift that grows with real
  // volumes. IEEE doubles are deterministic in V8, so exact equality is a fair
  // bar. If a DELIBERATE fixture regeneration with another pandas/numpy breaks
  // only this test, find out which reduction changed before relaxing it.
  const diffs = diffPaths(golden, legacyD(), 0);
  assert.deepEqual(diffs, [], `D is not bit-identical to build_data.py:\n${diffs.join('\n')}`);
});

test('the golden still exercises the rules it was built to pin', () => {
  // If a regenerated fixture loses one of these, the parity test above stops
  // guarding that rule without failing. Fail here instead.
  const E = golden.employees;
  assert.equal(E.Cyra.teamSize, 0, 'SPOC whose first-month team is nobody\'s last-month team');
  assert.equal(E.Cyra.revView, 'member');
  assert.deepEqual(golden.teamMembers.Alpha.filter((n) => n === 'Elin').length, 2, 'duplicate CRM name repeats');
  assert.equal(golden.displayNames.Elin, 'Elin Brook', 'duplicate CRM name: last row wins');
  assert.ok(golden.txRows.some((t) => t.tx === 'Tech Alpha ') && golden.txRows.some((t) => t.tx === 'Tech Alpha'),
    'trailing-space TX name kept as its own row');
  const allOpen = Object.values(E).flatMap((e) => e.openRows);
  assert.ok(allOpen.some((r) => r.state === '\u2014' && r.city === '\u2014'), 'blank state/city become an em dash');
  assert.ok(allOpen.some((r) => r.state === ''), 'a whitespace-only state is blank, not an em dash');
  assert.ok(allOpen.some((r) => r.aging === 2.5), 'non-integral aging kept');
  assert.ok(golden.zonalManagers.includes('Unassigned'));
  assert.ok(E['Tara Quill'].clients.some((c) => c.avg_age === 0.0312), 'half-way tie rounded half-even');
  assert.ok(E['Tara Quill'].completed > 128, 'pairwise summation recursion reached');
  assert.equal(E['Bram O'].revPerf.find((r) => r.date === '2026-08-24').target, 200000 / 26, 'Row Label claimed first by Bram O');
  assert.equal(E.Mo.openRows[0].pmoc, 'Kai', 'lead tie broken by name');
  assert.equal(E.Juno.vertical, null);
});

test('compose is deterministic, never mutates its inputs and never reads the clock', () => {
  const inputs = fromWorkbookSheets(workbook);
  const before = JSON.stringify(inputs);
  const RealDate = global.Date;
  global.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) throw new Error('compose read the clock');
      super(...args);
    }

    static now() {
      throw new Error('compose read the clock');
    }
  };
  let a;
  let b;
  try {
    a = JSON.stringify(compose(inputs, { teamMode: 'legacy' }));
    b = JSON.stringify(compose(inputs, { teamMode: 'perMonth' }));
  } finally {
    global.Date = RealDate;
  }
  assert.equal(JSON.stringify(inputs), before);
  assert.equal(a, JSON.stringify(compose(inputs, { teamMode: 'legacy' })));
  assert.equal(b, JSON.stringify(compose(inputs, { teamMode: 'perMonth' })));
});

test('perMonth keeps the D shape the dashboard reads', () => {
  const D = plain(compose(fromWorkbookSheets(workbook), { teamMode: 'perMonth' }));
  assert.deepEqual(Object.keys(D), Object.keys(golden));
  const employeeKeys = Object.keys(golden.employees['Tara Quill']);
  for (const [name, e] of Object.entries(D.employees)) {
    assert.deepEqual(Object.keys(e), employeeKeys, name);
    for (const series of ['daily', 'productivity', 'revPerf']) assert.equal(e[series].length, D.dates.length, `${name}.${series}`);
  }
  assert.deepEqual(D.dates, golden.dates);
});

// ─── Numeric fidelity helpers ────────────────────────────────────────────────

function lcgValues(seed, n) {
  let s = seed;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    out.push([s, (s / 4294967296 - 0.5) * 10 ** (s % 10)]);
  }
  return out;
}

const sameFloat = (expected, actual) => (expected === null ? Number.isNaN(actual) : Object.is(expected, actual));

test('summation helpers are bit-identical to numpy, pandas groupby and Python', () => {
  for (const c of numericGolden.cases) {
    const pairs = lcgValues(c.seed, c.n);
    const values = pairs.map(([, v]) => v);
    const withNan = pairs.map(([s, v]) => (s % 7 === 0 ? NaN : v));
    assert.ok(sameFloat(c.sum, I.npSum(values)), `Series.sum n=${c.n}`);
    assert.ok(sameFloat(c.mean, I.npMean(withNan)), `Series.mean n=${c.n}`);
    assert.ok(sameFloat(c.pysum, I.naiveSum(values)), `sum() n=${c.n}`);
    if (!c.n) continue;
    const groups = new Map();
    pairs.forEach(([s], i) => {
      const k = `k${s % 3}`;
      if (!groups.has(k)) groups.set(k, I.kahanNew());
      I.kahanAdd(groups.get(k), withNan[i]);
    });
    assert.deepEqual([...groups.keys()], c.groupSum.map(([k]) => k), `groupby first-seen order n=${c.n}`);
    for (const [k, v] of c.groupSum) assert.ok(sameFloat(v, groups.get(k).sum), `groupby sum ${k} n=${c.n}`);
    for (const [k, v] of c.groupMean) assert.ok(sameFloat(v, I.kahanMean(groups.get(k))), `groupby mean ${k} n=${c.n}`);
  }
});

test('pyRound matches Python round(x, 4), including exact half-way ties', () => {
  for (const [x, expected] of numericGolden.round4) {
    assert.ok(Object.is(I.pyRound(x, 4), expected), `round(${x}, 4) = ${expected}, got ${I.pyRound(x, 4)}`);
  }
});

test('string order is Python code-point order, not UTF-16 order', () => {
  const astral = '\u{1F600}';          // surrogate pair D83D DE00
  const high = '\uFF21';               // FULLWIDTH A, above the surrogates in UTF-16
  assert.equal(I.cmpCodePoints(high, astral), -1);
  assert.equal(I.cmpCodePoints('a', 'b'), -1);
  assert.equal(I.cmpCodePoints('ab', 'a'), 1);
  assert.equal(I.pyFloatRepr(1e16), '1e+16');
  assert.equal(I.pyFloatRepr(0.00001), '1e-05');
  assert.equal(I.pyFloatRepr(12.5), '12.5');
});

// ─── The normalised-input contract ───────────────────────────────────────────

const roster = (key, teams, extra = {}) => ({ key, display: `${key} Display`, vertical: 'Furniture', teams, ...extra });

test('per-person daily inputs: first TimeChamp row, summed CRM, summed/averaged IVR', () => {
  const D = compose({
    window: { from: '2026-09-01', to: '2026-09-01' },
    employees: [roster('P', { '2026-09': 'T' })],
    timechamp: [
      { key: 'P', date: '2026-09-01', working: 9, productive: 7.5, away: 1 },
      { key: 'P', date: '2026-09-01', working: 1, productive: 1, away: 1 },
    ],
    crm: [
      { key: 'P', date: '2026-09-01', booked: 2, scheduled: 1, audit: 1, closed: 3, cancelled: 1 },
      { key: 'P', date: '2026-09-01', booked: 1, scheduled: null, audit: 0, closed: 1, cancelled: 0 },
    ],
    ivr: [
      { key: 'P', date: '2026-09-01', incoming: 10, outgoing: 10, missed: 5, aht: 100 },
      { key: 'P', date: '2026-09-01', incoming: 0, outgoing: 0, missed: 0, aht: 50 },
    ],
  }, { teamMode: 'perMonth' });
  assert.deepEqual(D.employees.P.productivity[0], {
    date: '2026-09-01', working: 9, productive: 7.5, away: 1, pct: (7.5 / 9) * 100, status: 'green',
    closed: 4, cancelled: 1, positive: 9, openJobs: 5, incoming: 10, outgoing: 10, missed: 5, missedPct: 25, avgEng: 75,
  });
});

test('blank job fields follow build_data.py, and an explicit window drops out-of-window closed rows', () => {
  const D = compose({
    window: { from: '2026-09-01', to: '2026-09-02' },
    employees: [roster('S', { '2026-09': 'T' })],
    targets: { spocs: ['S'] },
    openRows: [{ jobId: 1, spoc: 'S', client: 'C', state: null, city: null, zm: null, aging: null, tx: null, txid: null }],
    closedRows: [
      { spoc: 'S', charge: 100, margin: 10, date: '2026-09-01', client: 'C', tat: 1, sda: null, zm: 'Z' },
      { spoc: 'S', charge: 50, margin: null, date: '2026-09-02', client: 'C', tat: 0, sda: 1, zm: 'Z' },
      { spoc: 'S', charge: 999, margin: 90, date: '2026-08-31', client: 'C', tat: 0, sda: 0, zm: 'Z' },
    ],
  }, { teamMode: 'legacy' });
  const S = D.employees.S;
  assert.equal(S.revenue, 150);
  assert.equal(S.margin, 10, 'a null margin is skipped by the mean');
  assert.deepEqual(S.tatSda, [{ client: 'C', tat: 50, sda: 100 }]);
  assert.deepEqual(S.openRows[0], {
    jobId: '1', vertical: '', state: '\u2014', city: '\u2014', client: 'C', aging: 0,
    pendingDueTo: '\u2014', pendingReason: '\u2014', pmoc: 'S',
  });
  assert.deepEqual(D.zonalManagers, ['Unassigned', 'Z']);
  assert.deepEqual(D.unassigned, [{ spoc: 'S', date: '2026-09-02', count: 1 }]);
  assert.deepEqual(D.dates, ['2026-09-01', '2026-09-02']);
});

test('the window is derived from dated inputs when not given, and bad inputs are refused', () => {
  const D = compose({
    employees: [],
    closedRows: [{ spoc: 'x', charge: 1, date: '2026-09-03' }],
    ivr: [{ key: 'y', date: '2026-08-30' }],
  }, { teamMode: 'legacy' });
  assert.deepEqual(D.dates, ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03']);
  assert.deepEqual(D.months, ['2026-08', '2026-09']);
  assert.throws(() => compose({ employees: [] }), /no usable dates/);
  assert.throws(() => compose({ employees: [], window: { from: '2026-09-02', to: '2026-09-01' } }), /window/);
  assert.throws(() => compose({ employees: {} }), /employees must be an array/);
  assert.throws(() => compose({ employees: [], openRows: 'x', window: { from: '2026-09-01', to: '2026-09-01' } }),
    /openRows must be an array/);
  assert.throws(() => compose({ employees: [] }, { teamMode: 'weekly' }), /teamMode/);
  assert.deepEqual(TEAM_MODES, ['legacy', 'perMonth']);
  // An adapter bug must fail loudly, not leave rows silently unmatched.
  assert.throws(() => compose({ employees: [], closedRows: [{ spoc: 'x', date: '2026-02-30' }] }), /not YYYY-MM-DD/);
  assert.throws(() => compose({ employees: [], timechamp: [{ key: 'x', date: new Date('2026-09-01') }] }),
    /not YYYY-MM-DD/);
  assert.throws(() => compose({ employees: [], crm: [{ key: 'x', date: null }] }), /crm needs a date/);
});

// ─── perMonth: each date uses that month's roster ────────────────────────────

/*
 * Window 08-30 .. 09-02 (two August days, two September days).
 *   A  SPOC, Alpha both months          B  SPOC, Bravo both months
 *   M  member: Alpha in Aug, Bravo in Sep
 *   N  member: on the September roster only (Alpha)
 *   X  August roster only, blank team
 */
function perMonthInputs(overrides = {}) {
  return {
    window: { from: '2026-08-30', to: '2026-09-02' },
    employees: [
      roster('A', { '2026-08': 'Alpha', '2026-09': 'Alpha' }),
      roster('B', { '2026-08': 'Bravo', '2026-09': 'Bravo' }, { vertical: 'Sports' }),
      roster('M', { '2026-08': 'Alpha', '2026-09': 'Bravo' }, { vertical: null }),
      roster('N', { '2026-09': 'Alpha' }),
      roster('X', { '2026-08': '' }),
    ],
    targets: {
      spocs: ['A', 'B'],
      daily: { A: { '2026-08': 100, '2026-09': 200 }, B: { '2026-08': 10, '2026-09': 20 } },
      monthly: { A: { '2026-08': 2600, '2026-09': 5200 }, B: { '2026-08': 260, '2026-09': 520 } },
      total: { A: 7800, B: 780 },
      personal: { N: { '2026-08': 50, '2026-09': 60 } },
    },
    closedRows: [
      { spoc: 'A', charge: 1000, margin: 10, date: '2026-08-30', client: 'CA', tat: 1, sda: 1, zm: 'Z1', vertical: 'Furniture', aco: 'N' },
      { spoc: 'B', charge: 300, margin: 30, date: '2026-08-31', client: 'CB', tat: 1, sda: 1, zm: 'Z2', vertical: 'Sports', aco: 'N' },
      { spoc: 'A', charge: 2000, margin: 20, date: '2026-09-01', client: 'CA', tat: 0, sda: 1, zm: 'Z1', vertical: 'Furniture', aco: 'N' },
      { spoc: 'B', charge: 400, margin: 40, date: '2026-09-02', client: 'CB', tat: 0, sda: 0, zm: 'Z2', vertical: 'Sports', aco: 'M' },
    ],
    openRows: [
      { jobId: 'o1', spoc: 'A', client: 'CA', zm: 'Z1', aging: 3, tx: 'T', txid: '1' },
      { jobId: 'o2', spoc: 'B', client: 'CB', zm: 'Z2', aging: 1, tx: null, txid: null },
      { jobId: 'o3', spoc: 'B', client: 'CB', zm: 'Z2', aging: 9, tx: 'T', txid: '2' },
    ],
    timechamp: [
      { key: 'N', date: '2026-08-30', working: 8, productive: 8, away: 0 },
      { key: 'N', date: '2026-09-01', working: 9, productive: 7, away: 1 },
    ],
    ...overrides,
  };
}

test('perMonth: a member who changes team inherits each month\'s own lead', () => {
  const D = plain(compose(perMonthInputs(), { teamMode: 'perMonth' }));
  const M = D.employees.M;
  assert.deepEqual(M.daily.map((d) => d.target), [100, 100, 20, 20], 'Aug from A, Sep from B');
  assert.deepEqual(M.daily.map((d) => d.revenue), [1000, 0, 0, 400], 'A\'s August jobs, B\'s September jobs');
  assert.equal(M.revenue, 1400);
  assert.equal(M.completed, 2);
  assert.deepEqual(M.openRows.map((r) => [r.jobId, r.pmoc]), [['o2', 'B'], ['o3', 'B']], 'open jobs of the latest lead');
  assert.equal(M.team, 'Bravo');
  assert.equal(M.teamSize, 2);
  assert.equal(M.vertical, 'Sports', 'blank vertical takes the latest lead\'s');
  assert.equal(M.targetAchieved, (1400 / (2600 + 520)) * 100);
  assert.equal(M.margin, 25);
  assert.deepEqual(Object.keys(M.byZm), ['Z1', 'Z2']);
  assert.deepEqual(M.zonal, []);
  assert.deepEqual(D.teamMembers, { Alpha: ['A', 'N'], Bravo: ['B', 'M'] });
  assert.equal(D.employees.A.revView, 'team');
  assert.deepEqual(D.employees.A.daily.map((d) => d.revenue), [1000, 0, 2000, 0]);

  // legacy, same inputs: M keeps the August team's lead for the whole window
  const L = plain(compose(perMonthInputs(), { teamMode: 'legacy' }));
  assert.equal(L.employees.M.team, 'Alpha');
  assert.deepEqual(L.employees.M.daily.map((d) => d.revenue), [1000, 0, 2000, 0]);
  assert.deepEqual(L.employees.M.daily.map((d) => d.target), [100, 100, 200, 200]);
});

test('perMonth: people are hidden in the months they are not on the roster', () => {
  const D = plain(compose(perMonthInputs(), { teamMode: 'perMonth' }));
  const N = D.employees.N;
  assert.deepEqual(N.productivity.map((p) => p.working), [0, 0, 9, 0], 'August TimeChamp row hidden');
  assert.deepEqual(N.revPerf.map((r) => r.target), [0, 0, 60, 60], 'August personal target hidden');
  assert.deepEqual(N.revPerf.map((r) => r.achieved), [0, 0, 2000, 0], 'August A&CO revenue hidden');
  assert.deepEqual(N.daily.map((d) => d.target), [0, 0, 200, 200], 'inherits A only from September');
  assert.equal(N.revenue, 2000);

  const X = D.employees.X;
  assert.equal(X.team, '');
  assert.equal(X.teamSize, 0, 'a blank team is no team');
  assert.equal(X.revenue, 0);
  assert.ok(!Object.prototype.hasOwnProperty.call(D.teamMembers, ''));

  // A SPOC with a blank team leads nobody, even people who also have a blank team.
  const blank = perMonthInputs();
  blank.employees[1] = roster('B', { '2026-08': '', '2026-09': '' }, { vertical: 'Sports' });
  const D3 = plain(compose(blank, { teamMode: 'perMonth' }));
  assert.equal(D3.employees.X.revenue, 0);
  assert.equal(D3.employees.B.teamSize, 0);
  assert.equal(D3.employees.B.revView, 'member');
  assert.deepEqual(D3.employees.M.daily.map((d) => d.revenue), [1000, 0, 0, 0], 'Bravo has no September lead');

  // A SPOC dropped from the September roster loses September jobs and targets.
  const inputs = perMonthInputs();
  inputs.employees[0] = roster('A', { '2026-08': 'Alpha' });
  const D2 = plain(compose(inputs, { teamMode: 'perMonth' }));
  assert.deepEqual(D2.employees.A.daily.map((d) => [d.target, d.revenue]), [[100, 1000], [100, 0], [0, 0], [0, 0]]);
  assert.equal(D2.employees.A.open, 0);
  assert.equal(D2.unassigned.find((u) => u.spoc === 'A').count, 0);
  assert.equal(D2.employees.N.revenue, 0, 'Alpha has no September lead any more');
  assert.equal(D2.txRows.length, 2, 'technician rows stay global');
});

test('perMonth: a month with no roster at all has NOBODY on it — it inherits no earlier month', () => {
  const inputs = perMonthInputs();
  inputs.employees = inputs.employees
    .map((e) => ({ ...e, teams: Object.fromEntries(Object.entries(e.teams).filter(([m]) => m === '2026-08')) }))
    .filter((e) => Object.keys(e.teams).length);
  const D = plain(compose(inputs, { teamMode: 'perMonth' }));
  assert.ok(!('N' in D.employees), 'N was only ever on the September roster');
  // September's emp detail was never uploaded, so September is nobody's month:
  // its jobs and targets are on no block (live.service puts them on Unattributed).
  assert.deepEqual(D.employees.M.daily.map((d) => d.target), [100, 100, 0, 0], 'August from A, nothing in September');
  assert.deepEqual(D.employees.M.daily.map((d) => d.revenue), [1000, 0, 0, 0]);
  assert.equal(D.employees.M.team, 'Alpha', 'the latest month M IS rostered for');
  assert.deepEqual(D.employees.A.daily.map((d) => d.revenue), [1000, 0, 0, 0], 'A\'s own September jobs too');
  assert.equal(D.employees.A.open, 0, 'open jobs are credited by the last month, which has no roster');
  assert.deepEqual(D.primarySpocs, ['A', 'B'], 'August still shows its people');

  // The same window with September's emp detail uploaded: A is back for it.
  const full = plain(compose(perMonthInputs(), { teamMode: 'perMonth' }));
  assert.deepEqual(full.employees.A.daily.map((d) => d.revenue), [1000, 0, 2000, 0], 'positive control');
});

test('perMonth: a team lead is the largest target that month, ties by name', () => {
  const inputs = perMonthInputs();
  inputs.employees.push(roster('AA', { '2026-08': 'Bravo', '2026-09': 'Bravo' }));
  inputs.targets.spocs.push('AA');
  inputs.targets.monthly.AA = { '2026-08': 260, '2026-09': 9999 };
  inputs.targets.daily.AA = { '2026-08': 1, '2026-09': 2 };
  const D = plain(compose(inputs, { teamMode: 'perMonth' }));
  // August: AA and B tie at 260 -> 'AA' sorts first. September: AA's 9999 wins.
  assert.deepEqual(D.employees.M.daily.map((d) => d.target), [100, 100, 2, 2]);
  assert.deepEqual(D.teamMembers.Bravo, ['B', 'M', 'AA']);
});

// ─── The workbook adapter ────────────────────────────────────────────────────

test('fromWorkbookSheets refuses a workbook missing sheets or columns, naming them', () => {
  const broken = workbook.sheets
    .filter((s) => s.name !== 'ivr data record')
    .map((s) => (s.name === 'target list' ? { ...s, columns: s.columns.map((c) => (c === 'month' ? 'Month Name' : c)) } : s));
  assert.throws(() => fromWorkbookSheets(broken), (err) => {
    assert.deepEqual(err.problems, [
      "Sheet 'target list' is missing column(s): month",
      "Sheet 'ivr data record' is missing from the workbook.",
    ]);
    return true;
  });
  assert.throws(() => fromWorkbookSheets({}), /expected/);
});

test('fromWorkbookSheets resolves aliases the way canon_name does', () => {
  const inputs = fromWorkbookSheets(workbook);
  assert.ok(inputs.targets.spocs.includes('Tara Quill'), "'tara ' (a Row Label) resolves to the CRM name");
  assert.ok(inputs.targets.spocs.includes('Zed Unlisted'), 'an unknown name stays as typed');
  assert.equal(inputs.targets.total['Tara Quill'], 1300000 + 1560000 + 13000);
  assert.equal(inputs.targets.daily['Tara Quill']['2026-08'], 500, 'duplicate month: last row wins');
  assert.equal(inputs.employees.filter((e) => e.key === 'Elin').length, 2, 'roster rows keep duplicates');
  assert.deepEqual(inputs.window, { from: golden.dates[0], to: golden.dates[golden.dates.length - 1] });
});
