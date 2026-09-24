/*
 * QuickSight — Employee Performance: server-side aggregation parity.
 *
 * services/quicksight/employee-performance/aggregate.js replaces the
 * dashboard's in-browser aggregation. The contract is that it returns the
 * numbers the dashboard shows — not "close", the same doubles, in the same
 * row order — so the oracle is the dashboard's OWN script, unedited, run in
 * node:vm (tests/fixtures/qs-ep-aggregate/dashboard-parity.js explains how the
 * page's rounded labels are turned back into exact values).
 *
 * The data is synthetic (tests/fixtures/qs-ep-aggregate/synthetic-d.js): the
 * real snapshot attributes revenue to named employees and is never committed.
 * The fixture is built to reach the page's quirks — a SPOC missing from a
 * zonal manager's byZm, a duplicated team member, a row vertical that is not a
 * filter option, string/null aging, float sums whose order shows in the last
 * bit — so a port that "tidies" one of them fails here.
 *
 * No DB, no network.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const agg = require('../services/quicksight/employee-performance/aggregate');
const { loadDashboard, compareRender, compareSorting, compareOptions } = require('./fixtures/qs-ep-aggregate/dashboard-parity');
const { syntheticD } = require('./fixtures/qs-ep-aggregate/synthetic-d');

const D = syntheticD();
const page = loadDashboard(`const D=${JSON.stringify(D)};`);
const report = (out) => `${out.length} mismatch(es):\n${out.slice(0, 20).join('\n')}`;

const RANGES = [
  { from: '', to: '' },
  { from: '2026-08-31', to: '2026-09-02' },   // crosses the month boundary
  { from: '2026-09-02', to: '' },
  { from: '', to: '2026-08-30' },
  { from: '2026-10-01', to: '2026-10-31' },   // selects no date at all
];

/* ── the oracle is not vacuous ─────────────────────────────────────────── */

test('the parity check fails when the API disagrees with the page', () => {
  // Positive control: the page renders the fixture, the API is handed a D with
  // one revenue cell and one open row changed. A comparison that could not see
  // a difference would pass everything below for free.
  const altered = syntheticD();
  altered.employees.Asha.daily[1].revenue += 0.01;
  altered.employees.Asha.openRows[0].aging = 3;
  altered.employees.Esha.productivity[0].working += 1;
  altered.txRows[0].ageSum += 1;
  const out = compareRender(page, altered, {});
  assert.ok(out.some((m) => m.includes('Total Revenue')), report(out));
  assert.ok(out.some((m) => m.includes('openJobRecord[0].aging')), report(out));
  assert.ok(out.some((m) => m.includes('txpanel[0].avgAging')), report(out));
  assert.ok(out.some((m) => m.includes('member "Esha"') && m.includes('productivity[0].working')), report(out));
  // …and the same comparison is clean on the D the page rendered.
  assert.deepEqual(compareRender(page, D, {}), []);
});

test('the fixture reaches the zonal-manager fallback quirk', () => {
  // Bharat has no byZm.Zed block: the page keeps his unsliced openRows, so the
  // Jobs Open KPI and the Open Job Record disagree. The API must too.
  const s = agg.buildSummary(D, { zm: 'Zed' });
  assert.equal(s.kpis.open, 3);
  assert.equal(s.openAging.total, 5);
  assert.deepEqual(agg.pageOpenJobs(D, { zm: 'Zed' }).rows.map((r) => r.jobId), [1001, 1002, 1003, 2001, 2002]);
});

/* ── parity ────────────────────────────────────────────────────────────── */

test('filter options match the page selects, fillEmployees() and monthDates()', () => {
  const out = compareOptions(page, D);
  assert.deepEqual(out, [], report(out));
});

test('named filter combinations match the page, member modals included', async (t) => {
  const combos = {
    'All': {},
    'one vertical': { vertical: 'Furniture' },
    'one zonal manager': { zm: 'Zed' },
    'zonal manager with a byZm block for every SPOC': { zm: 'Yan' },
    'one employee': { employee: 'Asha' },
    'one month': { month: '2026-09' },
    'custom date range': { from: '2026-08-31', to: '2026-09-02' },
    'vertical + zonal manager + month': { vertical: 'Furniture', zm: 'Unassigned', month: '2026-08' },
    'employee + custom range': { vertical: 'Sports', employee: 'Bharat', from: '2026-09-01', to: '2026-09-03' },
    'no date selected': { from: '2026-10-01', to: '2026-10-31' },
  };
  for (const [name, filters] of Object.entries(combos)) {
    await t.test(name, () => {
      const out = compareRender(page, D, filters);
      assert.deepEqual(out, [], report(out));
    });
  }
});

test('every filter combination over the fixture matches the page', () => {
  const options = agg.buildOptions(D);
  let renders = 0;
  const out = [];
  for (const vertical of ['ALL', ...options.verticals]) {
    const employees = ['ALL', ...options.employees.filter((e) => vertical === 'ALL' || e.vertical === vertical).map((e) => e.value)];
    for (const employee of employees) {
      for (const zm of ['ALL', ...options.zonalManagers]) {
        for (const month of ['ALL', ...options.months.map((m) => m.value)]) {
          for (const range of RANGES) {
            compareRender(page, D, { vertical, employee, zm, month, ...range }, { out });
            renders++;
          }
        }
      }
    }
  }
  assert.equal(renders, 540);
  assert.deepEqual(out, [], report(out));
});

test('server-side sorting matches clicking the page headers, both directions', () => {
  const out = [];
  for (const filters of [{}, { zm: 'Zed' }, { vertical: 'Furniture', month: '2026-09' }]) compareSorting(page, D, filters, out);
  assert.deepEqual(out, [], report(out));
});

/* ── paging ────────────────────────────────────────────────────────────── */

test('paging slices the ordered rows and reports totals', () => {
  const all = agg.pageOpenJobs(D, {}, { pageSize: 200 });
  assert.equal(all.total, 7);
  const p2 = agg.pageOpenJobs(D, {}, { page: 2, pageSize: 3 });
  assert.deepEqual(p2.rows, all.rows.slice(3, 6));
  assert.equal(p2.totalPages, 3);
  assert.deepEqual(agg.pageOpenJobs(D, {}, { page: 9, pageSize: 3 }).rows, []);
  assert.equal(agg.pageOpenJobs(D, {}, { pageSize: 5000 }).pageSize, agg.MAX_PAGE_SIZE);
  assert.equal(agg.pageOpenJobs(D, {}, { page: 0, pageSize: -1 }).page, 1);
});

test('the unpaged lists are the pages laid end to end, same sort', () => {
  for (const [filters, sort] of [[{}, {}], [{ zm: 'Zed' }, { sortBy: 'client', sortDir: 'asc' }], [{ month: '2026-08' }, { sortBy: 'aging' }]]) {
    const paged = [1, 2, 3].flatMap((page) => agg.pageOpenJobs(D, filters, { ...sort, page, pageSize: 3 }).rows);
    assert.deepEqual(agg.listOpenJobs(D, filters, sort), paged);
  }
  const txPaged = [1, 2].flatMap((page) => agg.pageTechnicians(D, {}, { sortBy: 'avgAging', sortDir: 'asc', page, pageSize: 4 }).rows);
  assert.deepEqual(agg.listTechnicians(D, {}, { sortBy: 'avgAging', sortDir: 'asc' }), txPaged);
  assert.equal(agg.listTechnicians(D, {}).length, agg.pageTechnicians(D, {}).total);
});

test('an unknown sort key keeps the default order; sortDir defaults to desc like a first click', () => {
  const plain = agg.pageOpenJobs(D, {});
  const bogus = agg.pageOpenJobs(D, {}, { sortBy: 'constructor', sortDir: 'asc' });
  assert.deepEqual(bogus.rows, plain.rows);
  assert.equal(bogus.sortBy, null);
  const firstClick = agg.pageTechnicians(D, {}, { sortBy: 'total' });
  assert.equal(firstClick.sortDir, 'desc');
  assert.deepEqual(firstClick.rows.map((r) => r.total), [5, 5, 2, 2, 1, 1]);
});

/* ── multi-select semantics (beyond what the single-select page can express) ── */

test('several employees add up exactly like their single selections', () => {
  const both = agg.buildSummary(D, { employees: ['Asha', 'Chitra'] });
  const a = agg.buildSummary(D, { employees: ['Asha'] });
  const c = agg.buildSummary(D, { employees: ['Chitra'] });
  assert.equal(both.kpis.open, a.kpis.open + c.kpis.open);
  assert.equal(both.kpis.completed, a.kpis.completed + c.kpis.completed);
  assert.deepEqual(agg.pageOpenJobs(D, { employees: ['Chitra', 'Asha'] }).rows,
    [...agg.pageOpenJobs(D, { employees: ['Asha'] }).rows, ...agg.pageOpenJobs(D, { employees: ['Chitra'] }).rows]);
});

test('ticking every option (2+) is Select All, so non-option row verticals stay visible', () => {
  // 'Easyfix' zonal and TX rows, and Farid ('Operations'), vanish under an
  // explicit `in` check over the two real verticals.
  assert.deepEqual(agg.buildSummary(D, { verticals: ['Sports', 'Furniture'] }), agg.buildSummary(D, {}));
  assert.deepEqual(agg.pageTechnicians(D, { verticals: ['Furniture', 'Sports'] }), agg.pageTechnicians(D, {}));
  assert.deepEqual(agg.buildSummary(D, { verticals: ['Furniture'], employees: ['Chitra', 'Asha'] }),
    agg.buildSummary(D, { verticals: ['Furniture'] }));
  assert.deepEqual(agg.buildSummary(D, { verticals: ['ALL'] }), agg.buildSummary(D, {}));
});

test('a lone option stays explicit, as on the page (only-SPOC ≠ Select All)', () => {
  // Sports has one SPOC. Page: Employee = Bharat hides Asha's Sports zonal row
  // (₹77 under Zed); Employee = Select All shows it.
  const explicit = agg.buildSummary(D, { verticals: ['Sports'], employees: ['Bharat'] });
  const all = agg.buildSummary(D, { verticals: ['Sports'] });
  assert.equal(explicit.zonal.rows.some((r) => r.zonalManager === 'Zed'), false);
  assert.equal(all.zonal.rows.find((r) => r.zonalManager === 'Zed').revenue, 77);
});

/* ── robustness ────────────────────────────────────────────────────────── */

test('txRows without their dates copy count as spanning D.dates', () => {
  const slim = syntheticD();
  slim.txRows.forEach((r) => { if (r.dates.length === slim.dates.length) delete r.dates; });
  for (const filters of [{}, { month: '2026-08' }, { from: '2026-10-01' }, { zm: 'Yan', verticals: ['Sports'] }]) {
    assert.deepEqual(agg.pageTechnicians(slim, filters), agg.pageTechnicians(D, filters));
  }
});

/*
 * The Current TX Performance grouping key is feed-dependent, and the parity
 * fixture cannot see it: build_data.py never emits an Unattributed bucket, so
 * the dashboard comparison only ever exercises the snapshot branch.
 */
test('technicians: the snapshot feed keeps the page\'s (spoc, tx, txid) grouping', () => {
  const d = syntheticD();
  // One technician, same TX ID and name, working under two different SPOCs.
  const base = d.txRows[0];
  d.txRows = [
    { ...base, spoc: 'Asha', total: 3, closed: 1, open: 2, ageSum: 9 },
    { ...base, spoc: 'Bharat', total: 5, closed: 2, open: 3, ageSum: 12 },
  ];
  const rows = agg.listTechnicians(d, {}, {});
  assert.equal(rows.length, 2, 'no Unattributed bucket: the page splits them, so we must too');
  assert.deepEqual(rows.map((r) => [r.spoc, r.total]), [['Asha', 3], ['Bharat', 5]]);
});

test('technicians: the live feed merges a technician across SPOCs, because the bucket splits them', () => {
  const d = syntheticD();
  // compose.js puts the bucket in primarySpocs; that is what marks the feed.
  d.primarySpocs = [...d.primarySpocs, 'Unattributed — Furniture'];
  const base = d.txRows[0];
  d.txRows = [
    { ...base, spoc: 'Asha', total: 3, closed: 1, open: 2, ageSum: 9 },
    { ...base, spoc: 'Unattributed — Furniture', total: 5, closed: 2, open: 3, ageSum: 12 },
  ];
  const rows = agg.listTechnicians(d, {}, {});
  assert.equal(rows.length, 1, 'one technician, one row — not two rows with the same TX ID and name');
  assert.deepEqual([rows[0].txId, rows[0].total, rows[0].closed, rows[0].open], [base.txid, 8, 3, 5]);
});

test('member detail: unknown and prototype names are null; only month and dates apply', () => {
  for (const name of ['Hari', 'Nobody', '__proto__', 'constructor', 'toString', undefined, 42]) {
    assert.equal(agg.memberDetail(D, {}, name), null, String(name));
  }
  const plain = agg.memberDetail(D, { month: '2026-09' }, 'Asha');
  const noisy = agg.memberDetail(D, { month: '2026-09', verticals: ['Sports'], zm: 'Yan', employees: ['Bharat'] }, 'Asha');
  assert.deepEqual(noisy, plain);
  assert.equal(plain.view, 'team');
  assert.equal(plain.revenue.rows.length, 3);
});

test('hostile filter values do not reach Object.prototype or throw', () => {
  for (const zm of ['constructor', '__proto__', 'hasOwnProperty']) {
    const s = agg.buildSummary(D, { zm });
    assert.equal(s.kpis.open, 0, zm);
    assert.equal(s.kpis.revenue, 0, zm);
    assert.deepEqual(s.zonal.rows, [], zm);
  }
  const s = agg.buildSummary(D, { employees: ['constructor'], verticals: [{}], month: 7, from: null });
  assert.equal(s.kpis.total, 0);
  assert.equal(s.dates.count, D.dates.length);
});

test('pure: a deep-frozen D gives the same answers', () => {
  const freeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
  const frozen = freeze(syntheticD());
  for (const filters of [{}, { zm: 'Zed' }, { verticals: ['Furniture'], month: '2026-09' }]) {
    assert.deepEqual(agg.buildSummary(frozen, filters), agg.buildSummary(D, filters));
    assert.deepEqual(agg.pageOpenJobs(frozen, filters, { sortBy: 'aging' }), agg.pageOpenJobs(D, filters, { sortBy: 'aging' }));
    assert.deepEqual(agg.pageTechnicians(frozen, filters, { sortBy: 'txName', sortDir: 'asc' }), agg.pageTechnicians(D, filters, { sortBy: 'txName', sortDir: 'asc' }));
    assert.deepEqual(agg.memberDetail(frozen, filters, 'Esha'), agg.memberDetail(D, filters, 'Esha'));
  }
  assert.deepEqual(agg.buildOptions(frozen), agg.buildOptions(D));
});

test('an empty or partial D yields zeros, not a throw', () => {
  for (const empty of [{}, { employees: {}, primarySpocs: ['X'], dates: ['2026-09-01'] }]) {
    const s = agg.buildSummary(empty, {});
    assert.deepEqual(s.kpis, { revenue: 0, target: 0, completed: 0, open: 0, total: 0, completionRate: 0, targetAchieved: 0, teamSize: 0 });
    assert.deepEqual(s.team, { name: 'All Teams', teams: [], members: [] });
    assert.equal(agg.pageOpenJobs(empty, {}).total, 0);
    assert.equal(agg.pageTechnicians(empty, {}).total, 0);
    assert.equal(agg.memberDetail(empty, {}, 'X'), null);
    assert.deepEqual(agg.buildOptions(empty).employees, []);
  }
});

/* ── the closed-job split columns ─────────────────────────────────────────── */

/*
 * compose.js puts compOem / compRet / compRel on every daily row: the current
 * dashboard's three Closed Jobs columns (OEM = Furniture + Sports, Retail
 * Maintenance, Relocation). The parity fixture and the page in assets/ are the
 * revision BEFORE those columns, so the tests here are the only ones that see
 * them. What has to hold: they are summed across the selected SPOCs exactly as
 * `completed` is, a Zonal Manager reads them off that SPOC's slice, and a D
 * without them reads 0 rather than NaN.
 */
function withSplits() {
  const d = syntheticD();
  const put = (e, oem, ret, rel) => e.daily.forEach((x, i) => {
    x.compOem = oem[i]; x.compRet = ret[i]; x.compRel = rel[i];
  });
  // Per day, the three never exceed that row's `completed` — the leftover is
  // the day's closed jobs in some other vertical (Easyfix, Admin, …).
  put(d.employees.Asha, [1, 2, 0, 2, 0], [0, 1, 1, 0, 0], [0, 0, 0, 1, 0]);    // completed [1,3,1,4,0]
  put(d.employees.Bharat, [1, 0, 0, 0, 1], [0, 0, 1, 0, 0], [1, 0, 0, 0, 0]);  // completed [2,0,1,0,1]
  put(d.employees.Chitra, [0, 0, 1, 0, 1], [0, 0, 1, 0, 0], [0, 0, 0, 1, 0]);  // completed [0,0,2,1,1]
  return d;
}

const splitsOf = (s) => s.daily.map((x) => [x.completed, x.compOem, x.compRet, x.compRel]);

test('the three closed-job columns sum across the selected SPOCs, like completed', () => {
  const d = withSplits();

  assert.deepEqual(splitsOf(agg.buildSummary(d, {})), [
    [3, 2, 0, 1], [3, 2, 1, 0], [4, 1, 3, 0], [5, 2, 0, 2], [2, 2, 0, 0],
  ], 'Asha + Bharat + Chitra (Dev has no employee row)');

  // A vertical narrows the SPOCs, so it narrows the columns with them.
  assert.deepEqual(splitsOf(agg.buildSummary(d, { verticals: ['Furniture'] })), [
    [1, 1, 0, 0], [3, 2, 1, 0], [3, 1, 2, 0], [5, 2, 0, 2], [1, 1, 0, 0],
  ], 'Asha + Chitra');

  // …and a date range drops whole rows, never re-splits the ones it keeps.
  assert.deepEqual(splitsOf(agg.buildSummary(d, { from: '2026-09-01', to: '2026-09-02' })), [
    [4, 1, 3, 0], [5, 2, 0, 2],
  ]);

  // The columns are counts of the SAME closed jobs `completed` counts, so they
  // can never exceed it — but they do not have to add up to it either.
  const rows = agg.buildSummary(d, {}).daily;
  assert.ok(rows.every((x) => x.compOem + x.compRet + x.compRel <= x.completed));
  assert.ok(rows.some((x) => x.compOem + x.compRet + x.compRel < x.completed), 'a day with jobs in another vertical');
});

test('a Zonal Manager reads the three columns off that SPOC\'s slice', () => {
  const d = withSplits();
  // Asha's Zed slice is a subset of her day — one of her two 09-02 OEM jobs
  // was Yan's — and Bharat has no Zed block at all, so the page's fallback
  // contributes an empty daily list and no columns.
  d.employees.Asha.byZm.Zed.daily.forEach((x, i) => {
    x.compOem = [1, 2, 0, 1, 0][i]; x.compRet = [0, 1, 0, 0, 0][i]; x.compRel = [0, 0, 0, 1, 0][i];
  });
  assert.deepEqual(splitsOf(agg.buildSummary(d, { zm: 'Zed', employees: ['Asha'] })), [
    [1, 1, 0, 0], [3, 2, 1, 0], [0, 0, 0, 0], [4, 1, 0, 1], [0, 0, 0, 0],
  ], 'the slice, not the unsliced block');
});

test('a D whose daily rows stop at completed reads the three columns as 0', () => {
  // An older cached snapshot, or a legacy-composed D. The page's own `||0`.
  const rows = agg.buildSummary(syntheticD(), {}).daily;
  assert.deepEqual(rows.map((x) => [x.compOem, x.compRet, x.compRel]), rows.map(() => [0, 0, 0]));
});

/* ── month-aware rosters (owner decision: each month uses that month's team) ── */

test('D.teamsByMonth drives the team panel and Team Members KPI per selected month', () => {
  const withRoster = syntheticD();
  withRoster.teamsByMonth = {
    '2026-08': { team: { Asha: 'Alpha', Bharat: 'Beta' }, teamMembers: { Alpha: ['Asha', 'Esha'], Beta: ['Bharat', 'Gita'] } },
    '2026-09': { team: { Asha: 'Alpha', Bharat: 'Gamma' }, teamMembers: { Alpha: ['Asha', 'Esha', 'Farid'], Gamma: ['Bharat', 'Ishan'] } },
  };
  const aug = agg.buildSummary(withRoster, { month: '2026-08' });
  assert.deepEqual(aug.team.teams, ['Alpha', 'Beta']);
  assert.deepEqual(aug.team.members.map((m) => m.key), ['Asha', 'Bharat', 'Chitra', 'Esha', 'Gita']);
  assert.equal(aug.kpis.teamSize, 4);                      // Alpha 2 + Beta 2 + Chitra (no team) 0

  const sep = agg.buildSummary(withRoster, { month: '2026-09', employees: ['Bharat'] });
  assert.equal(sep.team.name, 'Gamma');
  assert.deepEqual(sep.team.members.map((m) => m.key), ['Bharat', 'Ishan']);
  assert.equal(sep.kpis.teamSize, 2);

  // Both months: the union, each person once.
  const both = agg.buildSummary(withRoster, { employees: ['Bharat'] });
  assert.equal(both.team.name, 'All Teams');
  assert.deepEqual(both.team.members.map((m) => m.key), ['Bharat', 'Gita', 'Ishan']);
  assert.equal(both.kpis.teamSize, 3);

  // No selected date: the latest month's roster.
  assert.deepEqual(agg.buildSummary(withRoster, { from: '2027-01-01', employees: ['Bharat'] }).team.teams, ['Gamma']);

  // Every other number is untouched by the roster.
  const { team: _t1, kpis: k1, ...rest1 } = aug;
  const { team: _t2, kpis: k2, ...rest2 } = agg.buildSummary(D, { month: '2026-08' });
  assert.deepEqual(rest1, rest2);
  assert.deepEqual({ ...k1, teamSize: 0 }, { ...k2, teamSize: 0 });
});
