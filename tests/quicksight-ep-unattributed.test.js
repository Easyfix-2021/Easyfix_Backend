/*
 * QuickSight — Employee Performance: the Unattributed BUCKET, end to end.
 *
 * THE INVARIANT THIS FILE EXISTS FOR. The owner's rule is that a name appears
 * for a month only if that month's emp detail lists it — and that hiding a
 * person NEVER hides their work. Those two pull against each other, and the
 * second one lost: with the people filtered out of D.primarySpocs and every KPI
 * computed over D.primarySpocs, a window whose roster was not uploaded read
 * meta.totals {closedJobs 2, revenue 20000, openJobs 3} and showed
 * {revenue 0, completed 0, open 0} on the tiles. The tab was complete in its
 * footnote and empty in its numbers.
 *
 * The repair is structural: compose() gives those rows their own entries in
 * D.employees / D.primarySpocs — one BUCKET per job vertical — so the existing
 * filters reach them and no summary layer has to add anything back. What is
 * pinned here is that the repair holds from both ends:
 *
 *   - with no employee filter, every KPI tile EQUALS meta.totals — for a window
 *     with no emp detail at all, and for one where the intersection rule hides
 *     somebody who owns jobs;
 *   - a bucket is never a PERSON: not a team member, not in the Team Members
 *     KPI, not an Employee option, not a member detail;
 *   - Vertical and Zonal Manager narrow a bucket the way they narrow a SPOC —
 *     the slices PARTITION the totals, neither dropping nor double-counting;
 *   - Current TX Performance lists a technician ONCE, with all of their jobs,
 *     even when half sit under a SPOC and half under a bucket;
 *   - meta.reconciled survives the last-bit drift between two summations of the
 *     same rupees, and the window cap counts calendar months.
 *
 * It is its own file because it cuts across compose.js, aggregate.js and
 * live.service.js at once; each of those has its own suite for its own rules
 * (parity, the golden workbook, the wiring), and this is the invariant that
 * only shows when the three are put together.
 *
 * No database: the three loaders and loadUploads are replaced on their module
 * objects, resolvePeople / compose / aggregate are the REAL ones, and the two
 * upload-bookkeeping SELECTs go to tests/helpers/fake-pool.js.
 *
 * Runner: TZ=UTC node --test --require ./tests/helpers/close-pool.js
 *         tests/quicksight-ep-unattributed.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.S3_BUCKET_NAME = '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-ep-unattributed-'));
process.env.QS_EMPLOYEE_PERFORMANCE_DIR = TMP;

const { installFakePool } = require('./helpers/fake-pool');
const fake = installFakePool([
  [/FROM tbl_qs_ep_upload_batch/, () => []],            // no upload batch committed
  [/COUNT\(DISTINCT work_date\)/, () => []],
  [/FROM tbl_qs_ep_roster GROUP BY month/, () => []],
]);

const sources = require('../services/quicksight/employee-performance/sources.service');
const uploads = require('../services/quicksight/employee-performance/uploads.service');
const live = require('../services/quicksight/employee-performance/live.service');
const agg = require('../services/quicksight/employee-performance/aggregate');
const { compose, UNATTRIBUTED, unattributedKey, isUnattributedKey } =
  require('../services/quicksight/employee-performance/compose');

const NOW = new Date('2026-09-17T06:30:00Z');          // 12:00 IST
const AUG = { from: '2026-08-01', to: '2026-08-31' };
const AUG_SEP = { from: '2026-08-01', to: '2026-09-15' };
const inWindow = (d, from, to) => d >= from && d <= to;

/* ── the rows the loaders would return (sources.service shapes) ────────────── */

const closed = (o) => ({
  jobId: o.jobId, clientId: 10, date: o.date, spoc: null, spocUserId: o.spoc ?? null, spocName: o.spocName ?? null,
  spocInternal: true, spocSource: 'mapping', charge: o.charge, margin: 10, client: o.client ?? 'Acme', tat: 1, sda: 1,
  zm: o.zm ?? 'Zed', vertical: o.vertical ?? 'Furniture', tx: o.tx ?? null, txid: o.txid ?? null,
  aco: null, acoUserId: o.spoc ?? null, acoName: o.spocName ?? null, acoInternal: true,
});
const open = (o) => ({
  jobId: o.jobId, clientId: 10, vertical: o.vertical ?? 'Furniture', state: 'MH', city: o.city ?? 'Pune',
  client: 'Acme', zm: o.zm ?? 'Zed', tx: o.tx ?? null, txid: o.txid ?? null, aging: o.aging, dueTo: null,
  reason: null, spoc: null, spocUserId: o.spoc ?? null, spocName: o.spocName ?? null, spocInternal: true,
  spocSource: 'mapping',
});
const person = (key, team, vertical) => ({ key, crmName: key, empId: key, employeeName: `${key} (display)`,
  rowLabels: null, vertical, team });

const RITU = 700;
const ASHA = 710;
const JOHAN = 720;                                      // never on an emp detail

/*
 * One fixture reaches every case below: a SPOC with her own jobs, a second
 * person on the same team (so "tick every option" has two to tick), a job whose
 * SPOC is on no emp detail, a job with no SPOC user at all, two verticals, two
 * zonal managers — and ONE technician (T1) working both an attributed and an
 * unattributed job, which is what used to split them into two table rows.
 */
const FIXTURE = {
  roster: {
    '2026-08': [person('Ritu Sangwan', 'Alpha', 'Furniture'), person('Asha', 'Alpha', 'Furniture')],
  },
  closed: [
    closed({ jobId: 1, date: '2026-08-05', spoc: RITU, spocName: 'Ritu Sangwan', charge: 5000, tx: 'Tech A', txid: 'T1' }),
    closed({ jobId: 2, date: '2026-08-06', spoc: JOHAN, spocName: 'Johan', charge: 3000, vertical: 'Sports', zm: 'Yan', tx: 'Tech A', txid: 'T1' }),
    closed({ jobId: 3, date: '2026-08-07', spoc: null, spocName: null, charge: 2000, tx: 'Tech B', txid: 'T2' }),
    closed({ jobId: 4, date: '2026-08-08', spoc: ASHA, spocName: 'Asha', charge: 1000, tx: 'Tech C', txid: 'T3' }),
  ],
  open: [
    open({ jobId: 11, spoc: RITU, spocName: 'Ritu Sangwan', aging: 3, tx: 'Tech A', txid: 'T1' }),
    open({ jobId: 12, spoc: JOHAN, spocName: 'Johan', aging: 10, vertical: 'Sports', zm: 'Yan', city: 'Delhi' }),
    open({ jobId: 13, spoc: null, spocName: null, aging: 1, tx: 'Tech B', txid: 'T2' }),
  ],
  crm: [],
};
// Read off the fixture, not recomputed from the code under test.
const FIXTURE_TOTALS = { closedJobs: 4, revenue: 11000, openJobs: 3 };

const state = {};
function load(fixture) {
  state.roster = fixture.roster;
  state.closed = fixture.closed;
  state.open = fixture.open;
  state.crm = fixture.crm || [];
}

const originals = {};
before(() => {
  for (const [mod, name] of [[sources, 'loadOpenJobs'], [sources, 'loadClosedJobs'], [sources, 'loadCrmCounts'],
    [uploads, 'loadUploads']]) {
    originals[name] = [mod, mod[name]];
  }
  sources.loadClosedJobs = async ({ from, to }) => state.closed.filter((r) => inWindow(r.date, from, to)).map((r) => ({ ...r }));
  sources.loadOpenJobs = async () => state.open.map((r) => ({ ...r }));
  sources.loadCrmCounts = async ({ from, to }) => state.crm.filter((r) => inWindow(r.date, from, to)).map((r) => ({ ...r }));
  uploads.loadUploads = async ({ from, to }) => {
    // loadUploads' shape, with only the months the fixture rosters.
    const byKey = new Map();
    const rosterMonths = [];
    const roster = {};
    for (const [m, rows] of Object.entries(state.roster)) {
      if (m < from.slice(0, 7) || m > to.slice(0, 7)) continue;
      rosterMonths.push(m);
      roster[m] = rows;
      for (const r of rows) {
        if (!byKey.has(r.key)) byKey.set(r.key, { key: r.key, display: r.employeeName, vertical: r.vertical, teams: {} });
        byKey.get(r.key).teams[m] = r.team;
      }
    }
    return {
      storage: 'ready', window: { from, to }, months: rosterMonths, rosterMonths, roster,
      employees: [...byKey.values()],
      targets: { spocs: [], daily: {}, monthly: {}, total: {}, personal: {} },
      timechamp: [], ivr: [],
      hidden: { timechamp: [], ivr: [], primaryTargets: [], secondaryTargets: [] },
      resolveNames: () => new Map(),
    };
  };
});

after(() => {
  for (const [name, [mod, fn]] of Object.entries(originals)) mod[name] = fn;
  fake.restore();
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  load(FIXTURE);
  live.invalidateLiveCache();
  fake.reset();
});

const named = (D) => D.primarySpocs.filter((n) => !isUnattributedKey(n));
const buckets = (D) => D.primarySpocs.filter(isUnattributedKey);
/** The three KPI tiles that must equal the raw totals, in meta.totals' words. */
const tiles = (s) => ({ closedJobs: s.kpis.completed, revenue: s.kpis.revenue, openJobs: s.kpis.open });

/* ── 1. the tiles are the totals ───────────────────────────────────────────── */

test('a window with NO emp detail uploaded: no name is shown and every KPI tile is still the raw total', async () => {
  // The reviewers' probe, to the rupee: two closed jobs of 10,000 and three
  // open ones, in a month whose emp detail was never uploaded. Before the
  // buckets this returned kpis {revenue 0, completed 0, open 0, total 0}
  // beside meta.totals {closedJobs 2, revenue 20000, openJobs 3}.
  load({
    roster: {},
    closed: [
      closed({ jobId: 1, date: '2026-08-05', spoc: RITU, spocName: 'Ritu Sangwan', charge: 10000 }),
      closed({ jobId: 2, date: '2026-08-06', spoc: JOHAN, spocName: 'Johan', charge: 10000, vertical: 'Sports', zm: 'Yan' }),
    ],
    open: [
      open({ jobId: 11, spoc: RITU, spocName: 'Ritu Sangwan', aging: 3 }),
      open({ jobId: 12, spoc: JOHAN, spocName: 'Johan', aging: 10, vertical: 'Sports', zm: 'Yan' }),
      open({ jobId: 13, spoc: null, spocName: null, aging: 1 }),
    ],
  });
  const { D, meta } = await live.buildLiveD({ ...AUG, now: NOW });
  const s = agg.buildSummary(D, {});

  assert.deepEqual(meta.totals, { closedJobs: 2, revenue: 20000, openJobs: 3, crmRows: 0 });
  assert.deepEqual(named(D), [], 'nobody is named: the emp detail is not there');
  assert.deepEqual(tiles(s), { closedJobs: 2, revenue: 20000, openJobs: 3 }, 'and not one job is missing from the tiles');
  assert.equal(s.kpis.total, 5);
  assert.equal(s.kpis.completionRate, 40);
  assert.deepEqual(meta.bucketed, { closedJobs: 2, revenue: 20000, openJobs: 3 });
  assert.deepEqual(meta.attributed, { closedJobs: 0, revenue: 0, openJobs: 0 });
  assert.equal(meta.reconciled, true);

  // The tables agree with the tiles rather than being empty beside them.
  assert.equal(s.openAging.total, 3);
  assert.equal(agg.pageOpenJobs(D, {}).total, 3);
  assert.deepEqual(s.zonal.rows.map((r) => [r.zonalManager, r.closed, r.open, r.revenue]),
    [['Zed', 1, 2, 10000], ['Yan', 1, 1, 10000]]);
  assert.deepEqual(s.clients.map((c) => [c.client, c.total]), [['Acme', 5]]);
});

test('a window whose intersection HIDES a person: their jobs stay in every tile', async () => {
  // August lists both, September lists only Ritu, so Asha is hidden for the
  // window — and her August job and open job move to the buckets, not out of
  // the report.
  load({
    roster: {
      '2026-08': [person('Ritu Sangwan', 'Alpha', 'Furniture'), person('Asha', 'Alpha', 'Furniture')],
      '2026-09': [person('Ritu Sangwan', 'Alpha', 'Furniture')],
    },
    closed: [
      closed({ jobId: 1, date: '2026-08-05', spoc: RITU, spocName: 'Ritu Sangwan', charge: 5000 }),
      closed({ jobId: 2, date: '2026-08-06', spoc: ASHA, spocName: 'Asha', charge: 4000 }),
      closed({ jobId: 3, date: '2026-09-05', spoc: RITU, spocName: 'Ritu Sangwan', charge: 1000 }),
    ],
    open: [
      open({ jobId: 11, spoc: RITU, spocName: 'Ritu Sangwan', aging: 2 }),
      open({ jobId: 12, spoc: ASHA, spocName: 'Asha', aging: 4 }),
    ],
  });
  const { D, meta } = await live.buildLiveD({ ...AUG_SEP, now: NOW });
  const s = agg.buildSummary(D, {});

  assert.equal(meta.visibility.hidden, 1, 'positive control: somebody IS hidden');
  assert.deepEqual(named(D), ['Ritu Sangwan']);
  assert.deepEqual(tiles(s), { closedJobs: meta.totals.closedJobs, revenue: meta.totals.revenue, openJobs: meta.totals.openJobs });
  assert.deepEqual(tiles(s), { closedJobs: 3, revenue: 10000, openJobs: 2 });
  assert.deepEqual(meta.attributed, { closedJobs: 2, revenue: 6000, openJobs: 1 }, 'Ritu carries only her own');
  assert.deepEqual(meta.bucketed, { closedJobs: 1, revenue: 4000, openJobs: 1 }, 'Asha\'s are on the bucket');
  assert.equal(meta.reconciled, true);

  // Asked for August alone, Asha is on that month's emp detail and the same
  // jobs are hers: the buckets hold what the window hides, nothing more.
  live.invalidateLiveCache();
  const augOnly = await live.buildLiveD({ ...AUG, now: NOW });
  assert.deepEqual(named(augOnly.D).sort(), ['Asha', 'Ritu Sangwan']);
  assert.deepEqual(augOnly.meta.bucketed, { closedJobs: 0, revenue: 0, openJobs: 0 });
  assert.deepEqual(tiles(agg.buildSummary(augOnly.D, {})),
    { closedJobs: 2, revenue: 9000, openJobs: 2 });
});

/* ── 2. a bucket is not a person ───────────────────────────────────────────── */

test('a bucket is never a person: no team chip, no Team Members, no Employee option, no member detail', async () => {
  const { D } = await live.buildLiveD({ ...AUG, now: NOW });
  const s = agg.buildSummary(D, {});
  const options = agg.buildOptions(D);

  assert.deepEqual(buckets(D), [unattributedKey('Furniture'), unattributedKey('Sports')],
    'positive control: the buckets ARE in D.primarySpocs');
  assert.deepEqual(s.team.members.map((m) => m.key), ['Asha', 'Ritu Sangwan']);
  assert.deepEqual(s.team.teams, ['Alpha']);
  assert.equal(s.kpis.teamSize, 4, 'the two SPOCs\' uploaded team sizes, and nothing from the buckets');
  assert.deepEqual(options.employees.map((e) => e.value), ['Asha', 'Ritu Sangwan']);
  assert.deepEqual(options.verticals, ['Furniture'], 'a bucket\'s job vertical is not a Vertical option');
  for (const name of [UNATTRIBUTED, unattributedKey('Furniture'), unattributedKey('Sports')]) {
    assert.equal(agg.memberDetail(D, {}, name), null, name);
  }
  assert.notEqual(agg.memberDetail(D, {}, 'Ritu Sangwan'), null, 'positive control: a person still opens');

  // Ticking every option the tab OFFERS is "Select All", so the buckets are not
  // quietly dropped by an employee filter the user never narrowed.
  assert.deepEqual(agg.buildSummary(D, { employees: ['Asha', 'Ritu Sangwan'] }).kpis, s.kpis);
  // Choosing ONE person narrows to that person — buckets included in what goes.
  const onlyRitu = agg.buildSummary(D, { employees: ['Ritu Sangwan'] });
  assert.deepEqual(tiles(onlyRitu), { closedJobs: 1, revenue: 5000, openJobs: 1 });
});

/* ── 3. the filters partition the buckets ──────────────────────────────────── */

test('Vertical and Zonal Manager narrow a bucket the way they narrow a SPOC — the slices add back up', async () => {
  const { D, meta } = await live.buildLiveD({ ...AUG, now: NOW });
  const all = agg.buildSummary(D, {});
  assert.deepEqual(tiles(all), { ...FIXTURE_TOTALS });
  assert.deepEqual(tiles(all),
    { closedJobs: meta.totals.closedJobs, revenue: meta.totals.revenue, openJobs: meta.totals.openJobs });

  // Vertical: Furniture holds Ritu, Asha and the Furniture bucket; Sports holds
  // the Sports bucket alone. One bucket per job vertical is what makes this a
  // partition — a single lump row would be dropped whole by either choice.
  const furniture = agg.buildSummary(D, { verticals: ['Furniture'] });
  const sports = agg.buildSummary(D, { verticals: ['Sports'] });
  assert.deepEqual(tiles(furniture), { closedJobs: 3, revenue: 8000, openJobs: 2 });
  assert.deepEqual(tiles(sports), { closedJobs: 1, revenue: 3000, openJobs: 1 });
  assert.equal(furniture.kpis.revenue + sports.kpis.revenue, all.kpis.revenue);
  assert.equal(furniture.kpis.completed + sports.kpis.completed, all.kpis.completed);
  assert.equal(furniture.kpis.open + sports.kpis.open, all.kpis.open);

  // Zonal Manager: the same rows sliced the other way.
  const zed = agg.buildSummary(D, { zm: 'Zed' });
  const yan = agg.buildSummary(D, { zm: 'Yan' });
  assert.deepEqual(tiles(zed), { closedJobs: 3, revenue: 8000, openJobs: 2 });
  assert.deepEqual(tiles(yan), { closedJobs: 1, revenue: 3000, openJobs: 1 });
  assert.equal(zed.kpis.revenue + yan.kpis.revenue, all.kpis.revenue);
  assert.equal(zed.kpis.completed + yan.kpis.completed, all.kpis.completed);
  assert.equal(zed.kpis.open + yan.kpis.open, all.kpis.open);

  // Month and date range reach a bucket's rows for the same reason: its block
  // carries a `daily` row per date, exactly like a SPOC's.
  const oneDay = agg.buildSummary(D, { from: '2026-08-06', to: '2026-08-06' });
  assert.deepEqual([oneDay.kpis.revenue, oneDay.kpis.completed], [3000, 1], 'only the unattributed Sports job');
  assert.deepEqual(agg.buildSummary(D, { month: '2026-08' }).kpis, all.kpis);
});

/* ── 4. Current TX Performance ─────────────────────────────────────────────── */

test('Current TX Performance lists a technician ONCE, with every job of theirs', async () => {
  const { D } = await live.buildLiveD({ ...AUG, now: NOW });

  // The composed rows still carry the SPOC — that is what the Employee filter
  // reads — so T1 arrives as two rows, one under Ritu and one unattributed.
  assert.deepEqual(D.txRows.filter((r) => r.txid === 'T1').map((r) => r.spoc).sort(),
    ['Ritu Sangwan', UNATTRIBUTED], 'positive control: the raw material is two rows');

  const rows = agg.listTechnicians(D, {});
  assert.deepEqual(rows.map((r) => [r.txId, r.txName, r.total, r.closed, r.open]), [
    ['T1', 'Tech A', 3, 2, 1],      // Ritu's closed job + the unattributed one + Ritu's open one
    ['T2', 'Tech B', 2, 1, 1],
    ['T3', 'Tech C', 1, 1, 0],
  ]);
  assert.equal(new Set(rows.map((r) => r.txId)).size, rows.length, 'no TX ID appears twice');
  assert.equal(rows.reduce((s, r) => s + r.total, 0), 6, 'and every job with a TX is counted once');

  // The Employee filter still narrows the table: rows are filtered by SPOC
  // BEFORE they are grouped, so picking Ritu leaves only her share of T1.
  assert.deepEqual(agg.listTechnicians(D, { employees: ['Ritu Sangwan'] }).map((r) => [r.txId, r.total]),
    [['T1', 2]]);
  // …and so does Vertical, on each row's own vertical.
  assert.deepEqual(agg.listTechnicians(D, { verticals: ['Sports'] }).map((r) => [r.txId, r.total, r.closed]),
    [['T1', 1, 1]]);
});

/* ── 5. meta.reconciled ────────────────────────────────────────────────────── */

test('meta.reconciled: last-bit drift between two summations is not an alarm, a missing paisa is', async () => {
  // Nine jobs at ₹1000.10. compose() sums a block the way pandas does (numpy
  // pairwise) and the raw total is a left-to-right reduce, so the two differ in
  // the last bits — 9000.9 against 9000.900000000001. Under `===` this healthy
  // build reported itself broken.
  load({
    roster: {},
    closed: Array.from({ length: 9 }, (_, i) => closed({ jobId: i + 1, date: '2026-08-05', spoc: JOHAN, spocName: 'Johan', charge: 1000.10 })),
    open: [],
  });
  const { meta } = await live.buildLiveD({ ...AUG, now: NOW });
  assert.notEqual(meta.bucketed.revenue, meta.totals.revenue, 'positive control: the two sums are not bit-identical');
  assert.ok(Math.abs(meta.bucketed.revenue - meta.totals.revenue) < 1e-6);
  assert.equal(meta.reconciled, true, 'and that is not what the alarm is for');
  assert.equal(meta.bucketed.closedJobs, 9);

  const { sameMoney, REVENUE_EPSILON } = live._internals;
  assert.equal(REVENUE_EPSILON, 0.005, 'half a paisa');
  assert.equal(sameMoney(9000.9, 9000.900000000001), true);
  assert.equal(sameMoney(9000.9, 9000.904), true, 'rounding to the paisa is still the same money');
  assert.equal(sameMoney(9000.9, 9000.91), false, 'a paisa apart is a real difference');
  assert.equal(sameMoney(9000.9, 9100.9), false);
});

/* ── 6. the shape of a bucket, at the compose() level ──────────────────────── */

test('compose: one bucket per job vertical, holding nothing that belongs to a person', () => {
  // Pure inputs, no loaders: the bucket's SHAPE is compose's own contract.
  const inputs = {
    window: { from: '2026-08-01', to: '2026-08-02' },
    employees: [{ key: 'Ritu Sangwan', display: 'Ritu S', vertical: 'Furniture', teams: { '2026-08': 'Alpha' } }],
    targets: {
      spocs: ['Ritu Sangwan'],
      daily: { 'Ritu Sangwan': { '2026-08': 1000 } },
      monthly: { 'Ritu Sangwan': { '2026-08': 26000 } },
      total: { 'Ritu Sangwan': 26000 },
      personal: {},
    },
    closedRows: [
      { spoc: 'Ritu Sangwan', charge: 100, date: '2026-08-01', client: 'Acme', zm: 'Zed', vertical: 'Furniture', aco: 'Ritu Sangwan' },
      { spoc: UNATTRIBUTED, charge: 200, date: '2026-08-01', client: 'Acme', zm: 'Zed', vertical: null, aco: UNATTRIBUTED },
      { spoc: UNATTRIBUTED, charge: 300, date: '2026-08-02', client: 'Beta', zm: 'Yan', vertical: 'Sports', aco: UNATTRIBUTED },
    ],
    openRows: [{ jobId: 9, spoc: UNATTRIBUTED, vertical: 'Sports', client: 'Beta', aging: 4, zm: 'Yan' }],
    // A TimeChamp / CRM day filed under the literal name must not become a
    // bucket's "productivity": there is no person there to be productive.
    timechamp: [{ key: UNATTRIBUTED, date: '2026-08-01', working: 9, productive: 9, away: 0 }],
    crm: [{ key: UNATTRIBUTED, date: '2026-08-01', booked: 5, scheduled: 5, audit: 0, closed: 5, cancelled: 0 }],
    ivr: [],
  };
  const D = compose(inputs, { teamMode: 'perMonth' });

  assert.deepEqual(D.primarySpocs, ['Ritu Sangwan', UNATTRIBUTED, unattributedKey('Sports')],
    'a blank job vertical keys the bucket as the bare label');
  assert.deepEqual(D.verticals, ['Furniture'], 'and "Sports" is a job vertical, not a Vertical option');
  const blank = D.employees[UNATTRIBUTED];
  const sports = D.employees[unattributedKey('Sports')];
  assert.equal(blank.vertical, null);
  assert.equal(sports.vertical, 'Sports');
  assert.deepEqual([blank.revenue, blank.completed, blank.open], [200, 1, 0]);
  assert.deepEqual([sports.revenue, sports.completed, sports.open], [300, 1, 1]);
  for (const b of [blank, sports]) {
    assert.deepEqual(b.productivity, [], 'no TimeChamp / CRM / IVR row is a bucket\'s');
    assert.deepEqual(b.revPerf, []);
    assert.equal(b.team, '');
    assert.equal(b.teamSize, 0);
    assert.equal(b.targetAchieved, 0);
    assert.deepEqual(b.daily.map((x) => x.target), [0, 0], 'a bucket has no target to miss');
    assert.equal(b.revView, 'member');
  }
  assert.deepEqual(D.displayNames[unattributedKey('Sports')], UNATTRIBUTED, 'both buckets read as one label');
  assert.deepEqual(sports.openRows.map((r) => r.pmoc), [UNATTRIBUTED], 'and so does the PMOC column');
  assert.equal(D.employees['Ritu Sangwan'].daily[0].target, 1000, 'positive control: a person still has hers');

  // Zonal Manager reaches a bucket through byZm, exactly as it reaches a SPOC.
  assert.deepEqual(Object.keys(sports.byZm), ['Yan']);
  assert.equal(sports.byZm.Yan.revenue, 300);

  // legacy mode is the build_data.py port and must stay untouched: the old MIS
  // workbook has no such rows, and a bucket there would be an invention.
  assert.deepEqual(compose(inputs, { teamMode: 'legacy' }).primarySpocs, ['Ritu Sangwan']);
});

/* ── 7. the window cap ─────────────────────────────────────────────────────── */

test('the range cap counts CALENDAR months, so the rule the user is told is the rule enforced', () => {
  const w = (q) => live.resolveLiveWindow(q, NOW);
  const { lastAllowedTo } = live._internals;

  // Three calendar months from from's own, whatever day it starts on.
  assert.equal(lastAllowedTo('2026-06-01'), '2026-08-31');
  assert.equal(lastAllowedTo('2026-06-15'), '2026-08-31');
  assert.equal(lastAllowedTo('2026-06-30'), '2026-08-31');
  assert.equal(lastAllowedTo('2025-12-31'), '2026-02-28', 'across a year end, into a short month');

  assert.deepEqual(w({ from: '2026-06-15', to: '2026-08-31' }), { from: '2026-06-15', to: '2026-08-31' });
  assert.deepEqual(w({ from: '2026-08-31', to: '2026-09-01' }), { from: '2026-08-31', to: '2026-09-01' });

  // The window the duration cap used to allow: 92 days, but June, July, August
  // AND September — four months of emp detail behind a promise of three.
  for (const q of [{ from: '2026-06-15', to: '2026-09-01' }, { from: '2026-06-15', to: '2026-09-14' },
    { from: '2026-06-30', to: '2026-09-29' }]) {
    assert.throws(() => w(q), (err) => err.status === 400 && /at most 3 calendar months/.test(err.message)
      && /2026-08-31/.test(err.message), JSON.stringify(q));
  }
});
