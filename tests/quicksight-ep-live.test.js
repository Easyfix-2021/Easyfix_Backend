/*
 * QuickSight — Employee Performance: the LIVE dashboard object
 * (services/quicksight/employee-performance/live.service.js) and its routes
 * (routes/admin/quicksight/employee-performance.js /live/*).
 *
 * compose.js and aggregate.js carry their own parity proofs, and the database
 * reads carry theirs (tests/quicksight-ep-sources.test.js,
 * tests/quicksight-ep-uploads.test.js). What is pinned HERE is the wiring,
 * where a mistake is silent:
 *
 *   - the live D IS compose() over the live sources + the stored uploads, with
 *     THAT month's emp detail (perMonth), and /live/summary IS
 *     aggregate.buildSummary of it — plus a meta object;
 *   - the uploaded emp detail is the only source of who exists: a month without
 *     one has no names, a window of several months shows only the people on
 *     every one of them, and every closed / open job still lands on a SPOC or on
 *     the Unattributed line (meta reconciles);
 *   - the window: default the current IST month, a month alone, clamp to
 *     today, max 3 months, and every refusal is a 400;
 *   - the cache: reused within 60 s, single-flight, replaced by a new upload
 *     batch or a save, bounded, failures never cached;
 *   - storage not set up: reads still answer, meta says so; uploads 503;
 *   - the view key gates the reads, the upload key the template and upload;
 *   - dryRun previews, dryRun=false commits; errors map to 400/409/503.
 *
 * No database: loadOpenJobs / loadClosedJobs / loadCrmCounts and loadUploads /
 * previewUpload / commitUpload are replaced on their module objects (the live
 * service and the router call them through those objects), resolvePeople and
 * compose are the REAL ones, and the two upload-bookkeeping SELECTs go to
 * tests/helpers/fake-pool.js. No network beyond 127.0.0.1.
 *
 * Runner: TZ=UTC node --test tests/quicksight-ep-live.test.js
 */

'use strict';

const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.S3_BUCKET_NAME = '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-ep-live-'));
process.env.QS_EMPLOYEE_PERFORMANCE_DIR = TMP;

const VIEW_KEY = 'isQuickSightEmployeePerformanceView';
const UPLOAD_KEY = 'isQuickSightEmployeePerformanceUpload';
const ALL_KEYS = ['ef-QuickSight', VIEW_KEY, UPLOAD_KEY];
const S = { perms: ALL_KEYS };

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('services/role.service', { getEffectivePermissions: async () => ({ menuIds: [], actionPermissions: S.perms }) });

/* ── the fake upload bookkeeping tables ────────────────────────────────────── */

const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE)\b/i;
const absent = () => Object.assign(new Error("Table 'easyfix_core.tbl_qs_ep_upload_batch' doesn't exist"),
  { code: 'ER_NO_SUCH_TABLE', errno: 1146 });

const state = {};
function resetState() {
  state.storage = 'ready';
  state.batchId = 7;
  state.calls = [];
  state.failClosed = null;          // an error the next loadClosedJobs throws
  state.sepRoster = null;           // September's emp detail rows, or null (not uploaded)
  state.preview = null;             // (buffer) => report | throws
  state.commit = null;              // (buffer, options) => result | throws
}
resetState();

const { installFakePool } = require('./helpers/fake-pool');
const fake = installFakePool([
  [/FROM tbl_qs_ep_upload_batch/, () => {
    if (state.storage === 'missing') throw absent();
    return state.batchId === null ? [] : [{
      batch_id: state.batchId, file_name: 'ep.xlsx', sheets: 'emp detail,time champ data', date_from: '2026-08-03',
      date_to: '2026-08-04', month_from: '2026-08', month_to: '2026-08', uploaded_by: 9,
      uploaded_on: '2026-09-16 18:30:00', uploaded_by_name: 'MIS User',
    }];
  }],
  [/COUNT\(DISTINCT work_date\)/, () => [
    { source: 'timechamp', date_from: '2026-08-03', date_to: '2026-08-04', days: 2, row_count: 2 },
    { source: 'ivr', date_from: '2026-08-03', date_to: '2026-08-03', days: 1, row_count: 1 },
  ]],
  [/FROM tbl_qs_ep_roster GROUP BY month/, () => [
    { source: 'secondaryTargets', month: '2026-08', row_count: 1 },
    { source: 'empDetail', month: '2026-08', row_count: 2 },
    { source: 'primaryTargets', month: '2026-08', row_count: 1 },
  ]],
]);

const express = require('express');
const ExcelJS = require('exceljs');
const sources = require('../services/quicksight/employee-performance/sources.service');
const uploads = require('../services/quicksight/employee-performance/uploads.service');
const live = require('../services/quicksight/employee-performance/live.service');
const agg = require('../services/quicksight/employee-performance/aggregate');
const { compose, isUnattributedKey } = require('../services/quicksight/employee-performance/compose');
const { UPLOAD_SHEETS } = require('../services/quicksight/employee-performance/upload-template');

const json = (x) => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setImmediate(r));
const inWindow = (d, from, to) => d >= from && d <= to;
const NOW = new Date('2026-09-17T06:30:00Z');    // 12:00 IST
const AUG = { from: '2026-08-01', to: '2026-08-31' };
const AUG_SEP = { from: '2026-08-01', to: '2026-09-15' };

/* ── the live sources (sources.service row shapes) ─────────────────────────── */

const closed = (o) => ({
  jobId: o.jobId, clientId: 10, date: o.date, spoc: null, spocUserId: o.spoc ?? null, spocName: o.spocName ?? null,
  spocInternal: o.spocInternal ?? true, spocSource: 'mapping', charge: o.charge, margin: 12.5, client: o.client ?? 'Acme',
  tat: 1, sda: 0, zm: o.zm === undefined ? 'Zed' : o.zm, vertical: o.vertical ?? 'Furniture', tx: o.tx ?? null,
  txid: o.txid ?? null, aco: null, acoUserId: o.aco ?? null, acoName: o.acoName ?? null, acoInternal: true,
});
const open = (o) => ({
  jobId: o.jobId, clientId: 10, vertical: o.vertical ?? 'Furniture', state: 'MH', city: o.city ?? 'Pune', client: 'Acme',
  zm: 'Zed', tx: o.tx ?? null, txid: o.txid ?? null, aging: o.aging, dueTo: null, reason: null, spoc: null,
  spocUserId: o.spoc, spocName: o.spocName, spocInternal: true, spocSource: 'mapping',
});

// checkout DESC, as loadClosedJobs orders them
const CLOSED = [
  closed({ jobId: 105, date: '2026-09-03', spoc: 730, spocName: 'Paritoshik', spocInternal: false, charge: 300, vertical: 'Sports' }),
  closed({ jobId: 104, date: '2026-09-02', spoc: 700, spocName: 'Ritu Sangwan', charge: 900, aco: 710, acoName: 'Asha K' }),
  closed({ jobId: 103, date: '2026-08-05', spoc: 720, spocName: 'Johan', charge: 400, vertical: 'Sports', client: 'Beta' }),
  closed({ jobId: 102, date: '2026-08-04', spoc: 700, spocName: 'Ritu Sangwan', charge: 800, zm: null, aco: 700, acoName: 'Ritu Sangwan' }),
  closed({ jobId: 101, date: '2026-08-03', spoc: 700, spocName: 'Ritu Sangwan', charge: 1500, tx: 'Tech A', txid: '501', aco: 710, acoName: 'Asha K' }),
];
const OPEN = [
  open({ jobId: 203, spoc: null, spocName: null, aging: 1 }),
  open({ jobId: 202, spoc: 720, spocName: 'Johan', vertical: 'Sports', city: 'Delhi', aging: 10 }),
  open({ jobId: 201, spoc: 700, spocName: 'Ritu Sangwan', aging: 3, tx: 'Tech A', txid: '501' }),
];
const CRM = [
  { userId: 700, userName: 'Ritu Sangwan', internal: true, date: '2026-08-03', booked: 2, scheduled: 1, audit: 0, closed: 1, cancelled: 0, revenue: 1500 },
  { userId: 720, userName: 'Johan', internal: true, date: '2026-08-05', booked: 1, scheduled: 0, audit: 0, closed: 1, cancelled: 0, revenue: 400 },
  { userId: 700, userName: 'Ritu Sangwan', internal: true, date: '2026-09-02', booked: 3, scheduled: 2, audit: 1, closed: 1, cancelled: 1, revenue: 900 },
];

/* ── the stored uploads (loadUploads shape): August has emp detail, September has one only when state.sepRoster does ── */

const ROSTER_AUG = [
  { key: 'Ritu Sangwan', crmName: 'Ritu Sangwan', empId: 'E1', employeeName: 'Ritu S', rowLabels: 'Ritu', vertical: 'Furniture', team: 'Alpha' },
  { key: 'Asha', crmName: 'Asha', empId: 'E3', employeeName: 'Asha K', rowLabels: null, vertical: null, team: 'Alpha' },
];
const sepRoster = (keys) => ROSTER_AUG.filter((r) => keys.includes(r.key)).map((r) => ({ ...r, team: 'Beta' }));
const TARGETS_AUG = {
  spocs: ['Ritu Sangwan'],
  daily: { 'Ritu Sangwan': { '2026-08': 1000 } },
  monthly: { 'Ritu Sangwan': { '2026-08': 26000 } },
  total: { 'Ritu Sangwan': 26000 },
  personal: { Asha: { '2026-08': 200 } },
};
const TIMECHAMP = [
  { key: 'Ritu Sangwan', date: '2026-08-03', working: 9, productive: 8, away: 1 },
  { key: 'Asha', date: '2026-08-04', working: 8, productive: 6.5, away: 1.5 },
];
const IVR = [{ key: 'Ritu Sangwan', date: '2026-08-03', incoming: 10, outgoing: 5, missed: 1, aht: 120 }];
const emptyTargets = () => ({ spocs: [], daily: {}, monthly: {}, total: {}, personal: {} });

function fakeLoadUploads({ from, to }) {
  const months = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = m.slice(5) === '12' ? `${Number(m.slice(0, 4)) + 1}-01` : `${m.slice(0, 5)}${String(Number(m.slice(5)) + 1).padStart(2, '0')}`) months.push(m);
  const out = {
    storage: 'ready', window: { from, to }, months, rosterMonths: [], roster: {}, employees: [], targets: emptyTargets(),
    timechamp: [], ivr: [], hidden: { timechamp: [], ivr: [], primaryTargets: [], secondaryTargets: [] },
    resolveNames: () => new Map(),
  };
  if (state.storage === 'missing') return { ...out, storage: 'missing' };
  // One employee entry per person, gathering the team of each month they are on
  // (loadUploads: months ascend, the latest month's display/vertical win).
  const byKey = new Map();
  for (const m of months) {
    const roster = m === '2026-08' ? ROSTER_AUG : (m === '2026-09' ? state.sepRoster : null);
    if (!roster) continue;
    out.rosterMonths.push(m);
    out.roster[m] = roster;
    for (const r of roster) {
      if (!byKey.has(r.key)) byKey.set(r.key, { key: r.key, display: r.employeeName, vertical: r.vertical, teams: {} });
      const e = byKey.get(r.key);
      e.display = r.employeeName;
      e.vertical = r.vertical;
      e.teams[m] = r.team;
    }
  }
  out.employees = [...byKey.values()];
  if (months.includes('2026-08')) {
    out.targets = TARGETS_AUG;
    out.timechamp = TIMECHAMP.filter((r) => inWindow(r.date, from, to));
    out.ivr = IVR.filter((r) => inWindow(r.date, from, to));
    out.hidden.timechamp = [{ date: '2026-08-05', employeeId: 'E9', employeeName: 'Ghost' }];
  }
  return out;
}

const originals = {};
before(() => {
  for (const [mod, name] of [[sources, 'loadOpenJobs'], [sources, 'loadClosedJobs'], [sources, 'loadCrmCounts'],
    [uploads, 'loadUploads'], [uploads, 'previewUpload'], [uploads, 'commitUpload']]) {
    originals[name] = [mod, mod[name]];
  }
  sources.loadClosedJobs = async (args) => {
    state.calls.push(['loadClosedJobs', args]);
    await tick();
    if (state.failClosed) {
      const err = state.failClosed;
      state.failClosed = null;
      throw err;
    }
    return CLOSED.filter((r) => inWindow(r.date, args.from, args.to)).map((r) => ({ ...r }));
  };
  sources.loadOpenJobs = async (args) => {
    state.calls.push(['loadOpenJobs', args]);
    await tick();
    return OPEN.map((r) => ({ ...r }));
  };
  sources.loadCrmCounts = async (args) => {
    state.calls.push(['loadCrmCounts', args]);
    return CRM.filter((r) => inWindow(r.date, args.from, args.to)).map((r) => ({ ...r }));
  };
  uploads.loadUploads = async (args) => {
    state.calls.push(['loadUploads', args]);
    return fakeLoadUploads(args);
  };
  uploads.previewUpload = async (buffer, options) => {
    state.calls.push(['previewUpload', buffer, options]);
    return state.preview(buffer);
  };
  uploads.commitUpload = async (buffer, options) => {
    state.calls.push(['commitUpload', buffer, options]);
    return state.commit(buffer, options);
  };
});

let server;
let base;
before(async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = { user_id: 9, user_name: 'MIS User' }; next(); });
  app.use('/api/admin/quicksight/employee-performance', require('../routes/admin/quicksight/employee-performance'));
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ success: false, error: String(err && err.message) }); });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/admin/quicksight/employee-performance`;
});

after(async () => {
  for (const [name, [mod, fn]] of Object.entries(originals)) mod[name] = fn;
  fake.restore();
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  resetState();
  S.perms = ALL_KEYS;
  live.invalidateLiveCache();
  fake.reset();
});

const callsOf = (name) => state.calls.filter((c) => c[0] === name);
const builds = () => callsOf('loadClosedJobs').length;

async function get(p) {
  const res = await fetch(base + p);
  return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
}
async function ok(p) {
  const r = await get(p);
  assert.equal(r.status, 200, `${p} → ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.cache, 'no-store', `${p} is not cacheable`);
  assert.equal(r.body.success, true);
  return r.body.data;
}
async function postFile(p, { name = 'ep.xlsx', bytes = Buffer.from('PK not really a workbook') } = {}) {
  const fd = new FormData();
  if (name !== null) fd.append('file', new Blob([bytes]), name);
  const res = await fetch(base + p, { method: 'POST', body: fd });
  return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
}

/** What the live D must be: compose() over the same sources with the given employees. */
function expectedD(window, employees) {
  const rows = {
    openRows: OPEN,
    closedRows: CLOSED.filter((r) => inWindow(r.date, window.from, window.to)),
    crm: CRM.filter((r) => inWindow(r.date, window.from, window.to)),
  };
  const stored = fakeLoadUploads(window);
  const people = sources.resolvePeople({ rows, rosterByMonth: stored.roster, window });
  return {
    people,
    D: compose({
      window, employees, targets: stored.targets, openRows: people.openRows, closedRows: people.closedRows,
      crm: people.crm, timechamp: stored.timechamp, ivr: stored.ivr,
    }, { teamMode: 'perMonth' }),
  };
}

/* ── the composition ───────────────────────────────────────────────────────── */

test('the live D is compose(perMonth) over the live sources + stored uploads; summary is buildSummary of it', async () => {
  const { D, meta } = await live.buildLiveD({ ...AUG, now: NOW });

  const { D: want } = expectedD(AUG, [
    { key: 'Ritu Sangwan', display: 'Ritu S', vertical: 'Furniture', teams: { '2026-08': 'Alpha' } },
    { key: 'Asha', display: 'Asha K', vertical: null, teams: { '2026-08': 'Alpha' } },
  ]);
  assert.deepEqual(json(D), json(want));
  assert.deepEqual(json(agg.buildSummary(D, {})), json(agg.buildSummary(want, {})));

  // Positive controls: the numbers are the fixture's, not an empty D.
  const s = agg.buildSummary(D, {});
  // Ritu, then the Unattributed buckets — one per job vertical — carrying
  // Johan's Sports job and the SPOC-less Furniture one. The tiles therefore
  // show every job read, not just the ones a name could be put on.
  assert.deepEqual(D.primarySpocs, ['Ritu Sangwan', 'Unattributed — Furniture', 'Unattributed — Sports']);
  assert.deepEqual([s.kpis.revenue, s.kpis.completed, s.kpis.open], [2700, 3, 3]);
  assert.deepEqual([s.kpis.revenue, s.kpis.completed, s.kpis.open],
    [meta.totals.revenue, meta.totals.closedJobs, meta.totals.openJobs], 'the tiles ARE the raw totals');
  assert.deepEqual(D.dates[0], '2026-08-01');
  assert.equal(D.dates[D.dates.length - 1], '2026-08-31');
  assert.equal(D.employees['Ritu Sangwan'].productivity.find((x) => x.date === '2026-08-03').productive, 8);

  // The loaders got the window, and nothing was written.
  assert.deepEqual(callsOf('loadClosedJobs').map((c) => c[1]), [{ ...AUG, now: NOW }]);
  assert.deepEqual(callsOf('loadCrmCounts').map((c) => c[1]), [{ ...AUG, now: NOW }]);
  assert.deepEqual(callsOf('loadOpenJobs').map((c) => c[1]), [{ now: NOW }]);
  assert.deepEqual(callsOf('loadUploads').map((c) => [c[1].from, c[1].to]), [[AUG.from, AUG.to]]);
  assert.ok(fake.calls.length > 0, 'positive control: the bookkeeping SELECTs ran');
  assert.equal(fake.calls.some((c) => WRITE_RE.test(c.sql)), false, 'a live read never writes');

  // meta
  assert.equal(meta.from, AUG.from);
  assert.equal(meta.to, AUG.to);
  assert.equal(meta.jobsAsOf, NOW.toISOString());
  assert.ok(!Number.isNaN(Date.parse(meta.generatedAt)));
  assert.deepEqual(meta.uploads.lastBatch, {
    batchId: 7, fileName: 'ep.xlsx', sheets: ['emp detail', 'time champ data'], dateFrom: '2026-08-03', dateTo: '2026-08-04',
    monthFrom: '2026-08', monthTo: '2026-08', uploadedAt: '2026-09-16T13:00:00.000Z', uploadedBy: { userId: 9, name: 'MIS User' },
  });
  assert.deepEqual(meta.uploads.uploadedBy, { userId: 9, name: 'MIS User' });
  assert.equal(meta.uploads.uploadedAt, '2026-09-16T13:00:00.000Z');
  assert.equal(meta.uploads.storage, 'ready');
  assert.deepEqual(meta.uploads.coverage, {
    timechamp: { from: '2026-08-03', to: '2026-08-04', days: 2, rows: 2 },
    ivr: { from: '2026-08-03', to: '2026-08-03', days: 1, rows: 1 },
    empDetail: { months: ['2026-08'], rows: 2 },
    primaryTargets: { months: ['2026-08'], rows: 1 },
    secondaryTargets: { months: ['2026-08'], rows: 1 },
  });
  assert.deepEqual(meta.uploads.rosterMonthsInWindow, ['2026-08']);
  assert.deepEqual(meta.uploads.hidden.timechamp, { rows: 1, names: ['Ghost'] });
  assert.deepEqual(meta.months, [{ month: '2026-08', rosterUploaded: true, employees: 2, rosterSize: 2 }]);
  assert.deepEqual(meta.visibility, { mode: 'single', hidden: 0, missingMonths: [] });
  assert.deepEqual(meta.totals, { closedJobs: 3, revenue: 2700, openJobs: 3, crmRows: 2 });
  assert.deepEqual([meta.unattributed.closedJobs, meta.unattributed.revenue, meta.unattributed.openJobs], [1, 400, 2]);
  assert.deepEqual(meta.attributed, { closedJobs: 2, revenue: 2300, openJobs: 1 });
  assert.deepEqual(meta.bucketed, { closedJobs: 1, revenue: 400, openJobs: 2 }, 'what the buckets inside D carry');
  assert.equal(meta.reconciled, true);
  assert.deepEqual(meta.unattributed.users.map((u) => [u.userId, u.reasons]), [[720, ['not-on-roster']], [null, ['no-user']]]);
});

test('a window month with no emp detail names nobody for itself, and narrows nobody else', async () => {
  // August's emp detail is uploaded, September's is not (owner, 2026-09-18).
  // September names nobody and takes nobody away: August's own people keep
  // their August rows, while September's rows — and the open jobs the window
  // credits to its last month — go to Unattributed.
  const { D, meta } = await live.buildLiveD({ ...AUG_SEP, now: NOW });

  const stored = fakeLoadUploads(AUG_SEP);
  const AUG_PEOPLE = [
    { key: 'Ritu Sangwan', display: 'Ritu S', vertical: 'Furniture', teams: { '2026-08': 'Alpha' } },
    { key: 'Asha', display: 'Asha K', vertical: null, teams: { '2026-08': 'Alpha' } },
  ];
  const { D: want, people } = expectedD(AUG_SEP, AUG_PEOPLE);
  assert.deepEqual(json(live._internals.visibleEmployees(stored.employees, people)), json(AUG_PEOPLE),
    'the month with no emp detail narrows nobody: August\'s two people stay');
  assert.deepEqual(json(D), json(want));

  assert.deepEqual(meta.months, [
    { month: '2026-08', rosterUploaded: true, employees: 2, rosterSize: 2 },
    { month: '2026-09', rosterUploaded: false, employees: 0, rosterSize: 0 },
  ]);
  assert.deepEqual(meta.visibility, { mode: 'single', hidden: 0, missingMonths: ['2026-09'] },
    'one rostered month: the intersection rule narrows nothing, and the tab still says to upload September');

  // Nothing is lost: what August's people are not credited with is on the line,
  // and the tiles are the raw totals of BOTH months either way.
  assert.deepEqual(meta.totals, { closedJobs: 5, revenue: 3900, openJobs: 3, crmRows: 3 });
  assert.equal(meta.reconciled, true);
  assert.equal(meta.attributed.closedJobs + meta.unattributed.closedJobs, meta.totals.closedJobs);
  assert.equal(meta.attributed.revenue + meta.unattributed.revenue, meta.totals.revenue);
  assert.equal(meta.attributed.openJobs + meta.unattributed.openJobs, meta.totals.openJobs);
  assert.equal(meta.unattributed.openJobs, meta.totals.openJobs,
    'open jobs are credited to the window\'s last month, which has no emp detail');
  const s = agg.buildSummary(D, {});
  assert.deepEqual([s.kpis.revenue, s.kpis.completed, s.kpis.open],
    [meta.totals.revenue, meta.totals.closedJobs, meta.totals.openJobs], 'the tiles ARE the raw totals');
  assert.deepEqual(meta.unattributed.users.find((u) => u.userId === 700).reasons, ['roster-not-uploaded'],
    'Ritu is refused only for the month that has no emp detail');
});

test('both months uploaded: the people on BOTH are shown, the one on only one is hidden, and the totals still add up', async () => {
  // September's emp detail lists Ritu but not Asha, so Asha is hidden for this
  // window — her A&CO jobs move to the Unattributed line rather than vanishing.
  state.sepRoster = sepRoster(['Ritu Sangwan']);
  const { D, meta } = await live.buildLiveD({ ...AUG_SEP, now: NOW });

  const stored = fakeLoadUploads(AUG_SEP);
  const { D: want, people } = expectedD(AUG_SEP, [
    { key: 'Ritu Sangwan', display: 'Ritu S', vertical: 'Furniture', teams: { '2026-08': 'Alpha', '2026-09': 'Beta' } },
  ]);
  assert.deepEqual(json(live._internals.visibleEmployees(stored.employees, people)),
    [{ key: 'Ritu Sangwan', display: 'Ritu S', vertical: 'Furniture', teams: { '2026-08': 'Alpha', '2026-09': 'Beta' } }]);
  assert.deepEqual(json(D), json(want));

  assert.deepEqual(D.primarySpocs.filter((n) => !isUnattributedKey(n)), ['Ritu Sangwan']);
  assert.ok(!('Asha' in D.employees), 'Asha is not on September\'s emp detail');
  assert.deepEqual(meta.months, [
    { month: '2026-08', rosterUploaded: true, employees: 1, rosterSize: 2 },
    { month: '2026-09', rosterUploaded: true, employees: 1, rosterSize: 1 },
  ]);
  assert.deepEqual(meta.visibility, { mode: 'intersection', hidden: 1, missingMonths: [] });

  // The named people carry their own jobs; the Unattributed buckets inside D
  // carry the rest, so no caller has to add anything back on top.
  const sum = (f) => D.primarySpocs.filter((n) => !isUnattributedKey(n))
    .reduce((a, n) => a + D.employees[n][f], 0);
  const whole = (f) => D.primarySpocs.reduce((a, n) => a + D.employees[n][f], 0);
  assert.equal(sum('revenue') + meta.unattributed.revenue, meta.totals.revenue, 'every closed rupee is somewhere');
  assert.equal(sum('completed') + meta.unattributed.closedJobs, meta.totals.closedJobs);
  assert.equal(sum('open') + meta.unattributed.openJobs, meta.totals.openJobs);
  assert.deepEqual([sum('revenue'), sum('completed'), sum('open')], [3200, 3, 1], 'positive control: Ritu carries her own jobs');
  assert.deepEqual([whole('revenue'), whole('completed'), whole('open')],
    [meta.totals.revenue, meta.totals.closedJobs, meta.totals.openJobs], 'D alone already totals to every job');
  assert.equal(meta.reconciled, true);
  assert.deepEqual(meta.unattributed.users.find((u) => u.userId === 710).reasons,
    ['not-on-every-roster', 'not-on-roster'],
    'Asha, the A&CO: on August\'s emp detail but not the window\'s, and on September\'s not at all');

  // September's emp detail listing BOTH of them hides nobody.
  state.sepRoster = sepRoster(['Ritu Sangwan', 'Asha']);
  live.invalidateLiveCache();
  const both = await live.buildLiveD({ ...AUG_SEP, now: NOW });
  assert.deepEqual(Object.keys(both.D.employees).filter((n) => !isUnattributedKey(n)).sort(),
    ['Asha', 'Ritu Sangwan']);
  assert.deepEqual(both.meta.visibility, { mode: 'intersection', hidden: 0, missingMonths: [] });
  assert.deepEqual(both.meta.months, [
    { month: '2026-08', rosterUploaded: true, employees: 2, rosterSize: 2 },
    { month: '2026-09', rosterUploaded: true, employees: 2, rosterSize: 2 },
  ]);
  assert.equal(both.meta.reconciled, true);
  assert.equal(both.D.employees.Asha.team, 'Beta', 'the latest month she is rostered for');
});

test('storage not set up: the reads still answer from the database, and meta says so', async () => {
  state.storage = 'missing';
  const { D, meta } = await live.buildLiveD({ ...AUG, now: NOW });
  assert.equal(meta.uploads.storage, 'missing');
  assert.equal(meta.uploads.lastBatch, null);
  assert.equal(meta.uploads.coverage, null);
  // No emp detail can have been uploaded, so the tab has no names to show — and
  // says which month to upload. The jobs are all read, all on Unattributed.
  assert.deepEqual(meta.months, [{ month: '2026-08', rosterUploaded: false, employees: 0, rosterSize: 0 }]);
  assert.deepEqual(meta.visibility, { mode: 'single', hidden: 0, missingMonths: ['2026-08'] });
  // No name to show — and every job still on the tiles, on the buckets.
  assert.deepEqual(D.primarySpocs.filter((n) => !isUnattributedKey(n)), []);
  assert.deepEqual(D.primarySpocs, ['Unattributed — Furniture', 'Unattributed — Sports']);
  const none = agg.buildSummary(D, {});
  assert.equal(none.kpis.teamSize, 0);
  assert.deepEqual(none.team.members, [], 'a bucket is not a team member');
  assert.deepEqual(agg.buildOptions(D).employees, [], 'and not an Employee option');
  assert.deepEqual([none.kpis.revenue, none.kpis.completed, none.kpis.open], [2700, 3, 3]);
  assert.deepEqual(meta.totals, { closedJobs: 3, revenue: 2700, openJobs: 3, crmRows: 2 });
  assert.deepEqual([meta.unattributed.closedJobs, meta.unattributed.revenue, meta.unattributed.openJobs], [3, 2700, 3]);
  assert.deepEqual(meta.attributed, { closedJobs: 0, revenue: 0, openJobs: 0 });
  assert.deepEqual(meta.bucketed, { closedJobs: 3, revenue: 2700, openJobs: 3 });
  assert.equal(meta.reconciled, true);

  // No upload ever committed (tables there, no batch row) is 'ready' with no last batch.
  state.storage = 'ready';
  state.batchId = null;
  const again = await live.buildLiveD({ ...AUG, now: NOW });
  assert.equal(again.meta.uploads.storage, 'ready');
  assert.equal(again.meta.uploads.lastBatch, null);
});

/* ── the window ────────────────────────────────────────────────────────────── */

test('the window: default the current IST month, a month alone, clamped to today, and every refusal a 400', async () => {
  const w = (q) => live.resolveLiveWindow(q, NOW);
  assert.deepEqual(w({}), { from: '2026-09-01', to: '2026-09-17' });
  assert.deepEqual(w({ from: '', to: '', month: 'ALL' }), { from: '2026-09-01', to: '2026-09-17' });
  // Just before midnight IST on the 1st: still the new month.
  assert.deepEqual(live.resolveLiveWindow({}, new Date('2026-08-31T18:45:00Z')), { from: '2026-09-01', to: '2026-09-01' });
  assert.deepEqual(w({ month: '2026-08' }), { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(w({ month: '2026-09' }), { from: '2026-09-01', to: '2026-09-17' });
  assert.deepEqual(w({ from: '2026-09-01', to: '2026-09-30' }), { from: '2026-09-01', to: '2026-09-17' }, 'a future to reads up to today');
  assert.deepEqual(w({ from: '2026-08-10' }), { from: '2026-08-10', to: '2026-09-17' });
  assert.deepEqual(w({ to: '2026-08-20' }), { from: '2026-08-01', to: '2026-08-20' });
  assert.deepEqual(w({ from: '2026-06-01', to: '2026-08-31' }), { from: '2026-06-01', to: '2026-08-31' }, 'exactly 3 months');
  // The cap counts CALENDAR months, so a mid-month start reaches the end of its
  // third month and no further: June-July-August, never a fourth column.
  assert.deepEqual(w({ from: '2026-06-15', to: '2026-08-31', month: '2026-07' }), { from: '2026-06-15', to: '2026-08-31' });

  const refused = [
    [{ from: '2026-06-01', to: '2026-09-01' }, /at most 3 calendar months/],
    [{ from: '2026-06-15', to: '2026-09-14' }, /at most 3 calendar months/],
    [{ from: '2026-06-15', to: '2026-09-15' }, /at most 3 calendar months/],
    [{ from: '2026-08-10', to: '2026-08-09' }, /on or before/],
    [{ from: '2026-09-18' }, /after today/],
    [{ month: '2026-10' }, /after today/],
    [{ from: '2026-02-30', to: '2026-03-01' }, /real date/],
    [{ to: '2026-13-01' }, /real date/],
    [{ month: '2026-9' }, /month/],
    [{ from: '2026-08-01', to: '2026-08-31', month: '2026-09' }, /outside/],
  ];
  for (const [q, re] of refused) {
    assert.throws(() => w(q), (err) => err.status === 400 && re.test(err.message), JSON.stringify(q));
  }
  // buildLiveD refuses it before reading anything.
  await assert.rejects(live.buildLiveD({ from: '2026-01-01', to: '2026-08-31', now: NOW }), (err) => err.status === 400);
  assert.equal(builds(), 0);
  assert.equal(fake.calls.length, 0);

  // No window at all → the current month, as the loaders see it.
  const { meta } = await live.buildLiveD({ now: NOW });
  assert.deepEqual([meta.from, meta.to], ['2026-09-01', '2026-09-17']);
  assert.deepEqual(callsOf('loadClosedJobs')[0][1], { from: '2026-09-01', to: '2026-09-17', now: NOW });
});

/* ── the cache ─────────────────────────────────────────────────────────────── */

test('cache: reused within 60 s, shared by concurrent reads, expired after, replaced by a new upload batch', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
  try {
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => live.buildLiveD({ ...AUG, now: NOW })));
    assert.equal(builds(), 1, 'concurrent first reads share one build');
    assert.equal(a, b);
    assert.equal(b, c);

    mock.timers.tick(59 * 1000);
    assert.equal(await live.buildLiveD({ ...AUG, now: NOW }), a, 'within 60 s: the same object');
    assert.equal(builds(), 1);

    mock.timers.tick(2 * 1000);
    const expired = await live.buildLiveD({ ...AUG, now: NOW });
    assert.notEqual(expired, a);
    assert.equal(builds(), 2, 'after 60 s: rebuilt');

    state.batchId = 8;                     // an upload saved on ANY replica
    const fresh = await live.buildLiveD({ ...AUG, now: NOW });
    assert.equal(builds(), 3, 'a new upload batch replaces the entry');
    assert.equal(fresh.meta.uploads.lastBatch.batchId, 8);
    assert.equal(await live.buildLiveD({ ...AUG, now: NOW }), fresh);
    assert.equal(builds(), 3);

    live.invalidateLiveCache();            // a save on THIS replica
    await live.buildLiveD({ ...AUG, now: NOW });
    assert.equal(builds(), 4);

    // The batch id is read on every call, even on a hit.
    const batchReads = fake.calls.filter((x) => /FROM tbl_qs_ep_upload_batch/.test(x.sql)).length;
    assert.equal(batchReads, 8);
  } finally {
    mock.timers.reset();
  }
});

test('cache: bounded (least recently used goes), and a failed build is never cached', async () => {
  const windows = [
    { from: '2026-08-01', to: '2026-08-31' }, { from: '2026-07-01', to: '2026-07-31' },
    { from: '2026-06-01', to: '2026-06-30' }, { from: '2026-05-01', to: '2026-05-31' },
  ];
  for (const w of windows) await live.buildLiveD({ ...w, now: NOW });
  assert.equal(builds(), 4);
  assert.equal(live._internals.cacheSize(), live.CACHE_MAX_ENTRIES);
  await live.buildLiveD({ ...windows[3], now: NOW });
  assert.equal(builds(), 4, 'the newest entry is still there');
  await live.buildLiveD({ ...windows[0], now: NOW });
  assert.equal(builds(), 5, 'the oldest one was evicted');

  state.failClosed = Object.assign(new Error('more than 200000 jobs match — narrow the date range'), { status: 422 });
  await assert.rejects(live.buildLiveD({ from: '2026-04-01', to: '2026-04-30', now: NOW }), (err) => err.status === 422);
  const retried = await live.buildLiveD({ from: '2026-04-01', to: '2026-04-30', now: NOW });
  assert.equal(retried.meta.from, '2026-04-01', 'the next read builds again');
});

/* ── routes: reads ─────────────────────────────────────────────────────────── */

test('/live reads answer aggregate.js over the live D, with meta on options and summary', async () => {
  const qs = `from=${AUG.from}&to=${AUG.to}`;
  const summary = await ok(`/live/summary?${qs}&vertical=Furniture&v=123`);
  const { D, meta } = await live.buildLiveD(AUG);       // the entry the route built
  assert.equal(builds(), 1);
  const { meta: gotMeta, ...rest } = summary;
  assert.deepEqual(rest, json(agg.buildSummary(D, { verticals: ['Furniture'], ...AUG })));
  assert.deepEqual(gotMeta, json(meta));
  assert.equal(rest.kpis.revenue, 2300, 'positive control');

  const options = await ok(`/live/options?${qs}`);
  const { meta: optionsMeta, ...optionsRest } = options;
  assert.deepEqual(optionsRest, json(agg.buildOptions(D)));
  assert.deepEqual(optionsMeta, json(meta));
  assert.deepEqual(optionsRest.employees.map((e) => e.value), ['Ritu Sangwan']);

  assert.deepEqual(await ok(`/live/open-jobs?${qs}&sortBy=aging&sortDir=asc&pageSize=1`),
    json(agg.pageOpenJobs(D, AUG, { sortBy: 'aging', sortDir: 'asc', pageSize: 1 })));
  assert.deepEqual(await ok(`/live/technicians?${qs}&employee=Ritu%20Sangwan`),
    json(agg.pageTechnicians(D, { employees: ['Ritu Sangwan'], ...AUG }, {})));
  assert.deepEqual(await ok(`/live/member?${qs}&name=Asha&month=2026-08`),
    json(agg.memberDetail(D, { month: '2026-08', ...AUG }, 'Asha')));
  assert.equal(builds(), 1, 'every read shares the one build');

  const missing = await get(`/live/member?${qs}&name=Nobody`);
  assert.equal(missing.status, 404);
  assert.equal(missing.cache, 'no-store');
  assert.equal(missing.body.details.code, 'MEMBER_NOT_FOUND');
});

test('/live window over HTTP: default the current IST month, month alone, and bad windows are 400s', async () => {
  const def = sources.defaultWindow(new Date());
  const summary = await ok('/live/summary');
  assert.deepEqual([summary.meta.from, summary.meta.to], [def.from, def.to]);
  assert.deepEqual([summary.dates.from, summary.dates.to], [def.from, def.to]);

  const aug = await ok('/live/options?month=2026-08');
  assert.deepEqual([aug.meta.from, aug.meta.to], ['2026-08-01', '2026-08-31']);

  const bad = [
    '/live/summary?from=2026-08-10&to=2026-08-01',
    '/live/summary?from=2026-01-01&to=2026-08-31',
    '/live/summary?from=2026-02-30&to=2026-03-01',
    '/live/summary?from=2099-01-01',
    '/live/summary?from=2026-08-01&to=2026-08-31&month=2026-07',
    '/live/options?month=2026-8',
    '/live/open-jobs?sortBy=total',
    '/live/technicians?pageSize=0',
    '/live/member',
  ];
  const before = builds();
  for (const p of bad) {
    const r = await get(p);
    assert.equal(r.status, 400, `${p} → ${r.status}`);
    assert.equal(r.cache, 'no-store', p);
    assert.equal(r.body.error, 'Validation failed', p);
    assert.ok(Array.isArray(r.body.details) && r.body.details.length, p);
  }
  assert.equal(builds(), before, 'a refused window reads nothing');
  assert.match((await get('/live/summary?from=2026-01-01&to=2026-08-31')).body.details[0].message,
    /at most 3 calendar months/);

  state.failClosed = Object.assign(new Error('more than 200000 jobs match — narrow the date range'), { status: 422 });
  const tooMany = await get('/live/summary?from=2026-04-01&to=2026-04-30');
  assert.equal(tooMany.status, 422);
  assert.match(tooMany.body.error, /narrow the date range/);
});

/* ── routes: permissions ───────────────────────────────────────────────────── */

test('the view key gates the live reads; the upload key gates the template and the upload', async () => {
  S.perms = ['ef-QuickSight', VIEW_KEY];
  state.preview = () => ({ blocking: false });
  assert.equal((await get(`/live/summary?from=${AUG.from}&to=${AUG.to}`)).status, 200, 'positive control: viewing works');
  for (const [p, send] of [['/live/template', () => get('/live/template')], ['/live/upload?dryRun=true', () => postFile('/live/upload?dryRun=true')],
    ['/live/upload?dryRun=false', () => postFile('/live/upload?dryRun=false')]]) {
    const r = await send();
    assert.equal(r.status, 403, p);
    assert.match(r.body.error, new RegExp(UPLOAD_KEY), p);
  }
  assert.equal(callsOf('previewUpload').length + callsOf('commitUpload').length, 0, 'nothing reached the upload service');

  S.perms = ['ef-QuickSight', UPLOAD_KEY];
  for (const p of ['/live/options', '/live/summary', '/live/open-jobs', '/live/technicians', '/live/member?name=Asha', '/live/template']) {
    const r = await get(p);
    assert.equal(r.status, 403, p);
    assert.match(r.body.error, new RegExp(VIEW_KEY), p);
  }
});

/* ── routes: template and upload ───────────────────────────────────────────── */

test('/live/template streams the 5-sheet upload workbook', async () => {
  const res = await fetch(`${base}/live/template`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-disposition'), /employee-performance-upload-template\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const names = wb.worksheets.map((ws) => ws.name);
  for (const sheet of UPLOAD_SHEETS) assert.ok(names.includes(sheet), sheet);
});

test('upload: a dry run (also the default) previews; dryRun=false commits and drops the live cache', async () => {
  const report = { fileSha256: 'abc', blocking: false, errors: [], warnings: ['w'], sheets: [], overwrites: [], months: [] };
  state.preview = () => report;
  state.commit = () => ({ batchId: 8, saved: { empDetail: 2, primaryTargets: 1, secondaryTargets: 0, timechamp: 2, ivr: 1 }, sheets: ['emp detail'], preview: report });
  const bytes = Buffer.from('PK the workbook bytes');

  for (const p of ['/live/upload?dryRun=true', '/live/upload']) {
    const r = await postFile(p, { bytes });
    assert.equal(r.status, 200, `${p} ${JSON.stringify(r.body)}`);
    assert.equal(r.cache, 'no-store');
    assert.deepEqual(r.body.data, report);
  }
  const previews = callsOf('previewUpload');
  assert.equal(previews.length, 2);
  assert.ok(previews.every((c) => Buffer.isBuffer(c[1]) && c[1].equals(bytes)), 'the file bytes reach the preview');
  assert.equal(callsOf('commitUpload').length, 0, 'a preview never saves');

  await live.buildLiveD(AUG);
  assert.equal(builds(), 1);
  const saved = await postFile('/live/upload?dryRun=false', { bytes, name: 'MIS Sept.XLSX' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.message, 'Employee Performance uploads saved');
  assert.equal(saved.body.data.batchId, 8);
  const [commit] = callsOf('commitUpload');
  assert.ok(commit[1].equals(bytes));
  assert.deepEqual(commit[2], { userId: 9, fileName: 'MIS Sept.XLSX' });
  await live.buildLiveD(AUG);
  assert.equal(builds(), 2, 'the save dropped the cached build (same batch id on this fake)');
});

test('upload errors: 503 storage, 400 with the preview, 409 busy, wrong file, no file, too large', async () => {
  const missing = Object.assign(new Error(uploads.STORAGE_MISSING_MESSAGE), { status: 503, code: 'QS_EP_STORAGE_MISSING' });
  state.preview = () => { throw missing; };
  state.commit = () => { throw missing; };
  for (const p of ['/live/upload?dryRun=true', '/live/upload?dryRun=false']) {
    const r = await postFile(p);
    assert.equal(r.status, 503, p);
    assert.deepEqual(r.body, { success: false, error: uploads.STORAGE_MISSING_MESSAGE, details: { code: 'QS_EP_STORAGE_MISSING' } }, p);
  }

  const preview = { blocking: true, errors: [], warnings: [], sheets: [{ name: 'emp detail', errorCount: 1 }], overwrites: [], months: [] };
  state.commit = () => { throw Object.assign(new Error('The file has errors — fix them and upload again'), { status: 400, preview }); };
  const blocked = await postFile('/live/upload?dryRun=false');
  assert.equal(blocked.status, 400);
  assert.deepEqual(blocked.body.details, { code: 'QS_EP_UPLOAD_BLOCKED', preview });

  state.preview = () => { throw Object.assign(new Error('The file is not a readable .xlsx workbook (bad zip)'), { status: 400 }); };
  const unreadable = await postFile('/live/upload');
  assert.deepEqual(unreadable.body, { success: false, error: 'The file is not a readable .xlsx workbook (bad zip)' });

  state.commit = () => { throw Object.assign(new Error('Another Employee Performance upload is being saved — try again in a moment'), { status: 409 }); };
  const busy = await postFile('/live/upload?dryRun=false');
  assert.equal(busy.status, 409);
  assert.equal(busy.body.details.code, 'QS_EP_UPLOAD_BUSY');

  const calls = state.calls.length;
  for (const [label, send, re] of [
    ['data.js', () => postFile('/live/upload', { name: 'data.js' }), /\.xlsx/],
    ['.xls', () => postFile('/live/upload', { name: 'old.xls' }), /\.xlsx/],
    ['no file', () => postFile('/live/upload', { name: null }), /Choose/],
    ['too large', () => postFile('/live/upload', { bytes: Buffer.alloc(15 * 1024 * 1024 + 1) }), /too large \(max 15 MB\)/],
    ['bad dryRun', () => postFile('/live/upload?dryRun=maybe'), /Validation failed/],
  ]) {
    const r = await send();
    assert.equal(r.status, 400, label);
    assert.match(r.body.error, re, label);
  }
  assert.equal(state.calls.length, calls, 'refused before the upload service');
});
