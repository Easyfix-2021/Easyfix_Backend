/*
 * QuickSight — Employee Performance: the LIVE DATABASE sources
 * (services/quicksight/employee-performance/sources.service.js).
 *
 * No database: the shared pool is replaced by tests/helpers/fake-pool.js, whose
 * handlers below play a tiny tbl_job / tbl_user / tbl_qs_ep_job_spoc. The real
 * Manage Jobs export (filter builder, fetchExportChunk, mapExportRow) and the
 * real productivity metrics SQL run on top of it, so these tests pin what the
 * owner decided the tab reads:
 *   - open jobs: statuses 0,1,2,9,10,15,20,21 and NO date filter at all;
 *   - closed jobs: statuses 3,5 on checkout_date_time, whole end day, parameterised;
 *   - CRM counts: per user per IST day, half-open windows;
 *   - a frozen SPOC beats the current mapping; no freeze table → the mapping;
 *   - 'null' / blank Zonal Manager → 'Unassigned' once composed;
 *   - people resolve per month, unattributed work is totalled, a month with no
 *     emp detail has no employees at all and a window of several months shows
 *     only the people on every one of them — with nothing ever dropped;
 *   - read paths never write; the capture job writes only missing rows.
 *
 * resolveClientPrimarySpoc (services/job.service.js) is stubbed on the module
 * object: the rule itself is job.service's, and these tests only need to know
 * which clients it was asked about.
 *
 * Runner: TZ=UTC node --test tests/quicksight-ep-sources.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool, makeFakePool } = require('./helpers/fake-pool');

/* ── the fake database ─────────────────────────────────────────────────────── */

const state = {};

function resetState() {
  state.jobs = new Map();         // job_id → raw export row (J.* + aliases)
  state.phase1 = [];              // job_ids the export's phase 1 "finds"
  state.freeze = new Map();       // job_id → spoc_user_id
  state.freezeError = null;       // thrown by any tbl_qs_ep_job_spoc read
  state.users = new Map();        // user_id → { user_name, user_type_id, user_role }
  state.metricRows = [];          // productivity metrics result
  state.mapping = new Map();      // client_id → current Primary SPOC user_id
  state.resolverCalls = [];
}
resetState();

const fake = installFakePool([
  [/^SHOW COLUMNS FROM tbl_client/, [{ Field: 'vertical_id' }]],
  [/^SELECT J\.job_id/, (sql, params) => {
    const limit = params[params.length - 1];
    const afterId = sql.includes('J.job_id < ?') ? params[params.length - 2] : Infinity;
    return state.phase1.filter((id) => id < afterId).sort((a, b) => b - a).slice(0, limit).map((job_id) => ({ job_id }));
  }],
  [/TJA1\.previous_efr\s+AS previousEfrId/, (sql, params) => params[params.length - 1]
    .map((id) => ({ ...state.jobs.get(id) })).sort((a, b) => b.job_id - a.job_id)],
  [/^INSERT INTO tbl_qs_ep_job_spoc/, (sql, params) => ({ affectedRows: params[0].length })],
  [/FROM tbl_qs_ep_job_spoc/, (sql, params) => {
    if (state.freezeError) throw state.freezeError;
    if (/LIMIT 1/.test(sql)) return [...state.freeze.keys()].slice(0, 1).map((job_id) => ({ job_id }));
    return params[0].filter((id) => state.freeze.has(id)).map((id) => ({ job_id: id, spoc_user_id: state.freeze.get(id) }));
  }],
  [/FROM tbl_job WHERE job_id IN/, (sql, params) => params[0]
    .map((id) => ({ job_id: id, fk_client_id: state.jobs.get(id).fk_client_id }))],
  [/FROM tbl_user WHERE user_id IN/, (sql, params) => params[0]
    .filter((id) => state.users.has(id)).map((id) => ({ user_id: id, ...state.users.get(id) }))],
  [/WITH filtered_jobs/, () => state.metricRows],
]);

const jobService = require('../services/job.service');
const jobExport = require('../services/job-export.service');
const productivity = require('../services/quicksight/quicksight-employee-productivity.service');
const sources = require('../services/quicksight/employee-performance/sources.service');
const { compose, isUnattributedKey } = require('../services/quicksight/employee-performance/compose');

const originalResolver = jobService.resolveClientPrimarySpoc;
before(() => {
  jobService.resolveClientPrimarySpoc = async (clientId) => {
    state.resolverCalls.push(clientId);
    return state.mapping.has(clientId) ? state.mapping.get(clientId) : null;
  };
});
after(() => {
  jobService.resolveClientPrimarySpoc = originalResolver;
  fake.restore();
});
beforeEach(() => {
  resetState();
  fake.reset();
});

const NOW = new Date('2026-04-29T12:00:00Z');
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|TRUNCATE)\b/i;

function rawJob(o) {
  return {
    job_id: o.id,
    job_status: o.status ?? 3,
    fk_client_id: o.client === undefined ? 10 : o.client,
    fk_checkout_by: o.aco ?? null,
    ticket_created_date_time: o.ticket ?? '2026-04-01 09:00:00',
    checkout_date_time: o.checkout ?? null,
    city_name: o.city === undefined ? 'Pune' : o.city,
    state_name: o.state === undefined ? 'Maharashtra' : o.state,
    client_name: o.clientName ?? 'Acme Furnishings',
    zonal_manager: o.zm === undefined ? 'ZM One' : o.zm,
    efr_name: o.tx ?? null,
    fk_easyfixter_id: o.txid ?? null,
    vertical_name: o.vertical ?? 'Furniture',
    due_to_type: o.dueTo ?? null,
    pending_reason_desc: o.reason ?? null,
    total_charge: o.charge ?? null,
    easyfix_charge: o.ef ?? null,
    fk_service_catg_id: 15,
    tier: 2,
    checkin_date_time: o.checkin ?? null,
    original_appointment_date_time: o.appt ?? null,
  };
}

function seedJobs(list) {
  for (const o of list) {
    state.jobs.set(o.id, rawJob(o));
    state.phase1.push(o.id);
  }
}

const staff = (name, role = 13) => ({ user_name: name, user_type_id: 5, user_role: role });
const phase1Calls = () => fake.calls.filter((c) => /^SELECT J\.job_id/.test(c.sql));
const whereOf = (sql) => sql.slice(sql.indexOf('WHERE'), sql.indexOf('GROUP BY')).replace(/\s+/g, ' ').trim();

/* ── statuses ──────────────────────────────────────────────────────────────── */

test('the status sets are exactly the owner\'s Manage Jobs buckets', () => {
  assert.deepEqual([...sources.OPEN_STATUSES], [0, 1, 2, 9, 10, 15, 20, 21]);
  assert.deepEqual([...sources.CLOSED_STATUSES], [3, 5]);
});

test('the default window is the current IST month, 1st .. today', () => {
  // 20:00 UTC on 31 Aug is already 1 Sep in India.
  assert.deepEqual(sources.defaultWindow(new Date('2026-08-31T20:00:00Z')), { from: '2026-09-01', to: '2026-09-01' });
  assert.deepEqual(sources.defaultWindow(new Date('2026-09-17T06:00:00Z')), { from: '2026-09-01', to: '2026-09-17' });
});

/* ── open jobs ─────────────────────────────────────────────────────────────── */

test('open jobs: parameterised status IN (0,1,2,9,10,15,20,21) and NO date predicate of any kind', async () => {
  seedJobs([{ id: 11, status: 1, client: 10 }]);
  state.mapping.set(10, 700);
  state.users.set(700, staff('Ritu Sangwan'));
  await sources.loadOpenJobs({ now: NOW });

  const [p1] = phase1Calls();
  assert.equal(whereOf(p1.sql), 'WHERE J.job_status IN (?, ?, ?, ?, ?, ?, ?, ?)');
  assert.deepEqual(p1.params, [0, 1, 2, 9, 10, 15, 20, 21, 2000]);
  assert.doesNotMatch(p1.sql.slice(p1.sql.indexOf('WHERE')), /date_time|DATE_SUB|INTERVAL/i,
    'no window, not even the export\'s 6-month default');
  assert.equal(fake.calls.some((c) => WRITE_RE.test(c.sql)), false, 'a read path never writes');
});

test('open jobs: sheet values, blanks as null, aging measured to `now`, SPOC from the current mapping', async () => {
  seedJobs([
    { id: 12, status: 1, client: 10, ticket: '2026-04-19 00:00:00', zm: null, city: '', state: '  ', dueTo: 'Customer', reason: ' Reschedule ', tx: 'Tech A ', txid: 55 },
    { id: 11, status: 9, client: 20, ticket: '2026-04-28 00:00:00' },
  ]);
  state.mapping.set(10, 700);
  state.users.set(700, staff('Ritu Sangwan'));
  const rows = await sources.loadOpenJobs({ now: NOW });

  assert.deepEqual(rows.map((r) => r.jobId), [12, 11], 'newest job first, as the export');
  const r = rows[0];
  const sheet = jobExport.mapExportRow(state.jobs.get(12), 1, { now: NOW });
  assert.equal(r.aging, sheet.aging);
  assert.equal(r.aging, 10);
  const later = await sources.loadOpenJobs({ now: new Date('2026-05-02T12:00:00Z') });
  assert.equal(later[0].aging, 13, 'aging follows the `now` it is given');

  assert.equal(r.zm, null, "the export's literal 'null' Zonal Manager is no zonal manager");
  assert.equal(r.city, null);
  assert.equal(r.state, null);
  assert.equal(r.dueTo, 'Customer');
  assert.equal(r.reason, 'Reschedule');
  assert.equal(r.tx, 'Tech A ', 'Current TX Name stays raw');
  assert.equal(r.txid, '55');
  assert.equal(r.spoc, null, 'the employee key is resolvePeople\'s job');
  assert.deepEqual([r.spocUserId, r.spocName, r.spocInternal, r.spocSource], [700, 'Ritu Sangwan', true, 'mapping']);
  assert.deepEqual([rows[1].spocUserId, rows[1].spocName], [null, null], 'a client with no Primary SPOC');
});

/* ── closed jobs ───────────────────────────────────────────────────────────── */

test('closed jobs: parameterised status IN (3,5) on checkout_date_time, the whole end day included', async () => {
  seedJobs([{ id: 21, checkout: '2026-04-03 11:00:00' }]);
  await sources.loadClosedJobs({ from: '2026-04-01', to: '2026-04-29', now: NOW });

  const [p1] = phase1Calls();
  assert.equal(whereOf(p1.sql),
    'WHERE J.job_status IN (?, ?) AND J.checkout_date_time >= DATE(?) AND J.checkout_date_time < DATE(?) + INTERVAL 1 DAY');
  assert.deepEqual(p1.params, [3, 5, '2026-04-01', '2026-04-29', 2000]);
  assert.doesNotMatch(p1.sql, /created_date_time|ticket_created|DATE_SUB/);
  assert.doesNotMatch(p1.sql, /'2026-04/, 'dates are bound, never inlined');
  assert.equal(fake.calls.some((c) => WRITE_RE.test(c.sql)), false, 'a read path never writes');
});

test('closed jobs: frozen SPOC preferred over the mapping; a frozen NULL stays unattributed', async () => {
  seedJobs([
    { id: 104, client: 30, checkout: '2026-04-05 10:00:00', charge: 400 },
    { id: 103, client: 20, checkout: '2026-04-05 12:00:00', charge: 300 },
    { id: 102, client: 10, checkout: '2026-04-04 09:00:00', charge: 200, aco: 710 },
    { id: 101, client: 10, checkout: '2026-04-06 09:00:00', charge: 100 },
  ]);
  state.freeze.set(101, 900);
  state.freeze.set(103, null);
  state.mapping.set(10, 700);
  state.mapping.set(20, 800);
  state.users.set(700, staff('Ritu Sangwan'));
  state.users.set(900, staff('Monika Kumari'));
  state.users.set(710, staff('Amit', 19));
  const rows = await sources.loadClosedJobs({ from: '2026-04-01', to: '2026-04-29', now: NOW });
  const byId = new Map(rows.map((r) => [r.jobId, r]));

  assert.deepEqual([byId.get(101).spocUserId, byId.get(101).spocSource, byId.get(101).spocName], [900, 'frozen', 'Monika Kumari'],
    'the frozen SPOC wins although client 10 is mapped to 700 today');
  assert.deepEqual([byId.get(103).spocUserId, byId.get(103).spocSource], [null, 'frozen'],
    'frozen as unattributed — never moved to the current mapping (800)');
  assert.deepEqual([byId.get(102).spocUserId, byId.get(102).spocSource], [700, 'mapping']);
  assert.deepEqual([byId.get(104).spocUserId, byId.get(104).spocSource], [null, 'mapping']);
  assert.deepEqual([...state.resolverCalls].sort(), [10, 30], 'the mapping is only asked about clients with an unfrozen job');
  assert.deepEqual([byId.get(102).acoUserId, byId.get(102).acoName, byId.get(102).acoInternal], [710, 'Amit', false],
    'A & CO = fk_checkout_by; a technician-role account is not internal staff');
});

test('closed jobs: no freeze table yet → every job silently uses the current mapping', async () => {
  seedJobs([{ id: 31, client: 10, checkout: '2026-04-02 10:00:00' }]);
  state.freezeError = Object.assign(new Error("Table 'easyfix.tbl_qs_ep_job_spoc' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 });
  state.mapping.set(10, 700);
  state.users.set(700, staff('Ritu Sangwan'));
  const rows = await sources.loadClosedJobs({ from: '2026-04-01', to: '2026-04-29', now: NOW });
  assert.deepEqual([rows[0].spocUserId, rows[0].spocSource], [700, 'mapping']);
});

test('closed jobs: a REAL freeze-table failure is not mistaken for "not installed"', async () => {
  seedJobs([{ id: 32, checkout: '2026-04-02 10:00:00' }]);
  state.freezeError = Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 });
  await assert.rejects(sources.loadClosedJobs({ from: '2026-04-01', to: '2026-04-29', now: NOW }), /Lock wait timeout/);
});

test('closed jobs: the sheet\'s own charge / margin / TAT / SDA, checkout day, and checkout-DESC order', async () => {
  seedJobs([
    { id: 41, checkout: '2026-04-03 11:30:00', charge: 1000, ef: 333, checkin: '2026-04-02 10:00:00', appt: '2026-04-02 00:00:00', zm: null },
    { id: 42, checkout: '2026-04-03 09:00:00', charge: null },
    { id: 40, checkout: '2026-04-03 11:30:00', charge: 50 },
  ]);
  const rows = await sources.loadClosedJobs({ from: '2026-04-01', to: '2026-04-29', now: NOW });
  assert.deepEqual(rows.map((r) => r.jobId), [41, 40, 42], 'checkout DESC, then job_id DESC');

  const r = rows[0];
  const sheet = jobExport.mapExportRow(state.jobs.get(41), 1);
  assert.equal(r.date, '2026-04-03');
  assert.equal(r.charge, sheet.totalCharge);
  assert.equal(r.margin, sheet.margin);
  assert.equal(r.margin, 33.3, 'float32 margin, as the sheet');
  assert.equal(r.tat, sheet.tatStatus);
  assert.equal(r.sda, sheet.sdaStatus);
  assert.equal(r.sda, 1);
  assert.equal(rows[2].charge, 0, 'no transaction row → 0, as the sheet');
  assert.equal(rows[2].margin, null);
});

test('closed jobs: large reads are keyset-chunked on job_id', async () => {
  const list = [];
  for (let id = 5001; id <= 7001; id += 1) list.push({ id, checkout: '2026-04-10 10:00:00' });
  seedJobs(list);
  const rows = await sources.loadClosedJobs({ from: '2026-04-01', to: '2026-04-29', now: NOW });
  assert.equal(rows.length, 2001);
  const calls = phase1Calls();
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[0].sql, /J\.job_id < \?/);
  assert.match(calls[1].sql, /J\.job_id < \?/);
  assert.equal(calls[1].params[calls[1].params.length - 2], 5001 + 1, 'the cursor is the last id of the first chunk');
});

test('closed jobs: a bad or oversized window is a 400, and a missing one is the current IST month', async () => {
  await assert.rejects(sources.loadClosedJobs({ from: '2026-02-30', to: '2026-03-01' }), (e) => e.status === 400);
  await assert.rejects(sources.loadClosedJobs({ from: '2026-04-10', to: '2026-04-01' }), (e) => e.status === 400);
  await assert.rejects(sources.loadClosedJobs({ from: '2024-01-01', to: '2026-04-01' }), (e) => e.status === 400);
  await sources.loadClosedJobs({ now: new Date('2026-09-17T06:00:00Z') });
  assert.deepEqual(phase1Calls()[0].params.slice(2, 4), ['2026-09-01', '2026-09-17']);
});

/* ── CRM data ──────────────────────────────────────────────────────────────── */

test('CRM counts: the productivity metrics per user per IST day, half-open, internal users by default', async () => {
  state.metricRows = [{
    user_id: 700, day: '2026-04-02', booked: 2, scheduled: 1, estimate_sent: 1, estimate_approved: 1,
    estimate_rejected: 0, foh: 1, closed_count: 3, revenue: '5700.00', cancel_count: 1,
  }];
  state.users.set(700, staff('Ritu Sangwan'));
  const rows = await sources.loadCrmCounts({ from: '2026-04-01', to: '2026-04-29', now: NOW });
  assert.deepEqual(rows, [{
    userId: 700, userName: 'Ritu Sangwan', internal: true, date: '2026-04-02',
    booked: 2, scheduled: 1, audit: 3, closed: 3, cancelled: 1, revenue: 5700,
  }]);

  const m = fake.calls.find((c) => /WITH filtered_jobs/.test(c.sql));
  assert.doesNotMatch(m.sql, /BETWEEN/);
  for (const col of ['created_date_time', 'original_scheduling_date_time', 'cancel_date_time', 'full_fillment_created_time',
    'e.sent_on', 'e.action_on', 'jt.insert_date']) {
    assert.match(m.sql, new RegExp(`${col.replace('.', '\\.')} >= \\? AND ${col.replace('.', '\\.')} < \\?`), `${col} is half-open`);
    assert.match(m.sql, new RegExp(`DATE\\(${col.replace('.', '\\.')}\\) AS day`), `${col} is grouped by IST day`);
  }
  assert.match(m.sql, /GROUP BY user_id, day/);
  assert.match(m.sql, /IN \(SELECT iu\.user_id FROM tbl_user iu WHERE iu\.user_type_id = 5\)/);
  assert.deepEqual(m.params.slice(0, 4), [null, null, '2026-04-01 00:00:00', '2026-04-30 00:00:00']);
  assert.equal(m.params.length, 2 + 9 * 2);
});

test('CRM counts: explicit userIds are bound per branch', async () => {
  await sources.loadCrmCounts({ from: '2026-04-01', to: '2026-04-01', userIds: [700, 701] });
  const m = fake.calls.find((c) => /WITH filtered_jobs/.test(c.sql));
  assert.doesNotMatch(m.sql, /tbl_user iu/);
  assert.equal(m.params.length, 2 + 9 * 4);
  assert.deepEqual(m.params.slice(2, 6), [700, 701, '2026-04-01 00:00:00', '2026-04-02 00:00:00']);
});

test('the paginated Employee Productivity report keeps its legacy BETWEEN, one row per user', async () => {
  const pf = { dateMode: 'original', verticalId: null, zonalManagerId: null, startDate: '2026-04-01', endDate: '2026-04-30', userId: null, rmTeamUserIds: [-1] };
  // A page that has a user, so the report reaches its metrics query.
  const local = makeFakePool([
    [/SELECT TU\.user_id, TU\.user_name/, [{ user_id: 700, user_name: 'Ritu' }]],
    [/COUNT\(TU\.user_id\)/, [{ total: 1 }]],
  ]);
  const db = require('../db');
  const saved = db.pool.query;
  db.pool.query = local.pool.query;
  try {
    await productivity.getEmployeeProductivity({ pf, page: 1, size: 50 });
  } finally {
    db.pool.query = saved;
  }
  const m = local.calls.find((c) => /WITH filtered_jobs/.test(c.sql));
  assert.equal((m.sql.match(/BETWEEN \? AND \?/g) || []).length, 9);
  assert.doesNotMatch(m.sql, /DATE\(|AS day|>= \?/);
  assert.match(m.sql, /GROUP BY user_id\s+ORDER BY user_id$/);
});

/* ── resolvePeople ─────────────────────────────────────────────────────────── */

const AUG_SEP = { from: '2026-08-01', to: '2026-09-30' };
const ROSTER = {
  '2026-08': [
    { crmName: 'Ritu Sangwan', employeeName: 'Ritu S', rowLabel: 'Ritu', empId: 'E1', vertical: 'Furniture', team: 'Alpha' },
    { crmName: 'Johan', employeeName: 'Vineet Jangid', rowLabels: null, empId: 'E2', vertical: '0', team: 'Alpha' },
  ],
  '2026-09': [
    { crmName: 'Ritu Sangwan', employeeName: 'Ritu S', rowLabels: 'Ritu', empId: 'E1', vertical: 'Furniture', team: 'Beta' },
  ],
};
const closed = (o) => ({
  jobId: o.jobId, clientId: 10, date: o.date, spoc: null, spocUserId: o.spoc ?? null, spocName: o.spocName ?? null,
  spocInternal: o.spocInternal ?? true, spocSource: 'mapping', charge: o.charge ?? 100, margin: 10, client: 'Acme',
  tat: 1, sda: 1, zm: o.zm === undefined ? 'ZM One' : o.zm, vertical: o.vertical ?? 'Furniture', tx: null, txid: null,
  aco: null, acoUserId: o.aco ?? null, acoName: o.acoName ?? null, acoInternal: o.acoInternal ?? true,
});
const open = (o) => ({
  jobId: o.jobId, clientId: 10, vertical: o.vertical ?? 'Furniture', state: null, city: 'Pune', client: 'Acme',
  zm: null, tx: null, txid: null, aging: 2, dueTo: null, reason: null, spoc: null, spocUserId: o.spoc,
  spocName: o.spocName, spocInternal: o.spocInternal ?? true, spocSource: 'mapping',
});

test('resolvePeople: each month uses THAT month\'s emp detail, by CRM name or its aliases, trimmed and case-insensitive', () => {
  const out = sources.resolvePeople({
    window: AUG_SEP,
    rosterByMonth: ROSTER,
    rows: {
      closedRows: [
        closed({ jobId: 1, date: '2026-08-10', spoc: 700, spocName: '  ritu   SANGWAN ', aco: 710, acoName: 'ritu s', charge: 1000 }),
        closed({ jobId: 2, date: '2026-09-05', spoc: 720, spocName: 'Johan', aco: 700, acoName: 'Ritu Sangwan', charge: 500 }),
        closed({ jobId: 3, date: '2026-09-06', spoc: 730, spocName: 'Ritu', spocInternal: false, charge: 300 }),
        closed({ jobId: 4, date: '2026-08-11', spoc: null, charge: 200 }),
      ],
      openRows: [open({ jobId: 9, spoc: 700, spocName: 'Ritu Sangwan' }), open({ jobId: 8, spoc: 720, spocName: 'Johan' })],
      crm: [
        { userId: 700, userName: 'Ritu Sangwan', internal: true, date: '2026-08-10', booked: 1, scheduled: 2, audit: 0, closed: 3, cancelled: 0 },
        { userId: 720, userName: 'Johan', internal: true, date: '2026-08-12', booked: 4, scheduled: 0, audit: 0, closed: 0, cancelled: 1 },
        { userId: 720, userName: 'Johan', internal: true, date: '2026-09-12', booked: 5, scheduled: 1, audit: 2, closed: 0, cancelled: 0 },
      ],
    },
  });

  // Johan is on August's emp detail but not on September's, so this two-month
  // window does not show him at all (owner decision 7) — every row of his,
  // August's included, is on the Unattributed line.
  assert.deepEqual(out.employees, [
    { key: 'Ritu Sangwan', display: 'Ritu S', vertical: 'Furniture', teams: { '2026-08': 'Alpha', '2026-09': 'Beta' } },
  ]);
  assert.deepEqual(out.closedRows.map((r) => [r.jobId, r.spoc, r.aco]), [
    [1, 'Ritu Sangwan', 'Ritu Sangwan'],        // A&CO matched through the EMPLOYE NAME alias
    [2, 'Unattributed', 'Ritu Sangwan'],        // Johan is not on September's emp detail
    [3, 'Unattributed', 'Unattributed'],        // a non-staff account named like a Row Label
    [4, 'Unattributed', 'Unattributed'],        // no SPOC at all
  ]);
  assert.deepEqual(out.openRows.map((r) => r.spoc), ['Ritu Sangwan', 'Unattributed'], 'open jobs use the LAST month\'s roster');
  assert.deepEqual(out.crm.map((r) => [r.key, r.date]), [['Ritu Sangwan', '2026-08-10']]);

  const u = out.unattributed;
  assert.equal(u.label, 'Unattributed');
  assert.deepEqual([u.closedJobs, u.revenue, u.openJobs], [3, 1000, 1]);
  assert.deepEqual([u.acoJobs, u.acoRevenue], [2, 500]);
  assert.deepEqual(u.crm, { rows: 2, booked: 9, scheduled: 1, audit: 2, closed: 0, cancelled: 1 });
  const johan = u.users.find((x) => x.userId === 720);
  assert.deepEqual([johan.reasons, johan.months, johan.closedJobs, johan.revenue, johan.openJobs, johan.crmRows],
    [['not-on-every-roster', 'not-on-roster'], ['2026-08', '2026-09'], 1, 500, 1, 2],
    'August: on that month\'s emp detail but not the window\'s. September: not on it at all');
  assert.deepEqual(u.users.find((x) => x.userId === 730).reasons, ['not-internal']);
  assert.deepEqual(u.users.find((x) => x.userId === null).reasons, ['no-user']);
  assert.deepEqual(out.months, [
    { month: '2026-08', rosterUploaded: true, employees: 1, rosterSize: 2 },
    { month: '2026-09', rosterUploaded: true, employees: 1, rosterSize: 1 },
  ]);
  assert.deepEqual(out.visibility,
    { mode: 'intersection', hidden: 1, missingMonths: [] });

  // August alone: the same emp detail, and Johan is one of its people.
  const aug = sources.resolvePeople({
    window: { from: '2026-08-01', to: '2026-08-31' },
    rosterByMonth: ROSTER,
    rows: { closedRows: [closed({ jobId: 1, date: '2026-08-10', spoc: 720, spocName: 'Johan', charge: 1000 })] },
  });
  assert.deepEqual(aug.employees.map((e) => e.key), ['Ritu Sangwan', 'Johan']);
  assert.equal(aug.closedRows[0].spoc, 'Johan');
  assert.deepEqual(aug.visibility, { mode: 'single', hidden: 0, missingMonths: [] });
  assert.deepEqual(aug.months, [{ month: '2026-08', rosterUploaded: true, employees: 2, rosterSize: 2 }]);
});

test('resolvePeople → compose: attributed + unattributed = every job, and a null Zonal Manager is "Unassigned"', () => {
  const closedRows = [
    closed({ jobId: 1, date: '2026-08-10', spoc: 700, spocName: 'Ritu Sangwan', charge: 1000, zm: null }),
    closed({ jobId: 2, date: '2026-09-05', spoc: 720, spocName: 'Johan', charge: 500 }),
  ];
  const openRows = [open({ jobId: 9, spoc: 700, spocName: 'Ritu Sangwan' })];
  const people = sources.resolvePeople({ window: AUG_SEP, rosterByMonth: ROSTER, rows: { closedRows, openRows, crm: [] } });
  const D = compose({
    window: AUG_SEP, employees: people.employees, targets: {}, openRows: people.openRows,
    closedRows: people.closedRows, crm: people.crm, timechamp: [], ivr: [],
  });
  // compose() now carries the unattributed rows ITSELF, as bucket entries in
  // D.primarySpocs (one per job vertical), so the sum over the NAMED people is
  // what people.unattributed completes — and the sum over everything, buckets
  // included, is already the whole.
  const named = D.primarySpocs.filter((n) => !isUnattributedKey(n));
  const sumOf = (names, f) => names.reduce((a, n) => a + D.employees[n][f], 0);
  assert.deepEqual(named, ['Ritu Sangwan']);
  assert.deepEqual(D.primarySpocs.filter(isUnattributedKey), ['Unattributed — Furniture']);
  assert.equal(sumOf(named, 'revenue') + people.unattributed.revenue, 1500);
  assert.equal(sumOf(named, 'completed') + people.unattributed.closedJobs, 2);
  assert.equal(sumOf(D.primarySpocs, 'revenue'), 1500, 'Johan\'s 500 is on the bucket, not lost');
  assert.equal(sumOf(D.primarySpocs, 'completed'), 2);
  assert.ok(D.zonalManagers.includes('Unassigned'));
  assert.ok(!D.zonalManagers.includes('null'));
});

test('resolvePeople: two staff accounts sharing a roster name are both credited, and flagged', () => {
  const out = sources.resolvePeople({
    window: { from: '2026-09-01', to: '2026-09-30' },
    rosterByMonth: ROSTER,
    rows: { closedRows: [
      closed({ jobId: 1, date: '2026-09-02', spoc: 700, spocName: 'Ritu Sangwan' }),
      closed({ jobId: 2, date: '2026-09-03', spoc: 701, spocName: 'RITU SANGWAN' }),
    ] },
  });
  assert.deepEqual(out.closedRows.map((r) => r.spoc), ['Ritu Sangwan', 'Ritu Sangwan']);
  assert.deepEqual(out.warnings, [{ type: 'shared-name', month: '2026-09', key: 'Ritu Sangwan', userIds: [700, 701] }]);
});

/*
 * Owner decisions 6 and 7: the uploaded emp detail is the ONLY source of who
 * exists. Nobody is invented from a job SPOC or a CRM user, a month without an
 * emp detail shows nobody (and inherits no other month's), and a window of
 * several months shows only the people on every one of them. What such a month
 * or such a person did is never lost: it goes to the Unattributed line, which
 * is what keeps the tab's totals whole.
 */

const SEP_ONLY = { from: '2026-09-01', to: '2026-09-17' };
const noRosterRows = () => ({
  closedRows: [
    closed({ jobId: 1, date: '2026-09-02', spoc: 700, spocName: 'RITU', charge: 1000, aco: 750, acoName: 'Sahil' }),
    closed({ jobId: 2, date: '2026-09-03', spoc: 740, spocName: 'Neeraj', charge: 500 }),
  ],
  openRows: [open({ jobId: 9, spoc: 741, spocName: 'neeraj ' })],
  crm: [{ userId: 700, userName: 'RITU', internal: true, date: '2026-09-02', booked: 1, scheduled: 0, audit: 0, closed: 0, cancelled: 0 }],
});

test('resolvePeople: a month with no emp detail has NO employees — its rows count, on the Unattributed line', () => {
  const out = sources.resolvePeople({
    window: SEP_ONLY,
    rosterByMonth: { '2026-08': ROSTER['2026-08'] },     // August is uploaded but outside the window: it lends nothing
    rows: noRosterRows(),
  });

  assert.deepEqual(out.employees, [], 'no name is invented from the jobs, the CRM or an earlier month');
  assert.deepEqual(out.closedRows.map((r) => [r.spoc, r.aco]),
    [['Unattributed', 'Unattributed'], ['Unattributed', 'Unattributed']]);
  assert.deepEqual(out.openRows.map((r) => r.spoc), ['Unattributed']);
  assert.deepEqual(out.crm, []);

  // Nothing is dropped: every job, rupee and CRM row is on the line.
  const u = out.unattributed;
  assert.deepEqual([u.closedJobs, u.revenue, u.openJobs], [2, 1500, 1]);
  assert.deepEqual([u.acoJobs, u.acoRevenue], [2, 1500]);
  assert.deepEqual(u.crm, { rows: 1, booked: 1, scheduled: 0, audit: 0, closed: 0, cancelled: 0 });
  assert.deepEqual([...new Set(u.users.filter((x) => x.userId !== null).flatMap((x) => x.reasons))],
    ['roster-not-uploaded'], 'nobody is refused for any other reason: the month simply has no roster');

  assert.deepEqual(out.months, [{ month: '2026-09', rosterUploaded: false, employees: 0, rosterSize: 0 }]);
  assert.deepEqual(out.visibility, { mode: 'single', hidden: 0, missingMonths: ['2026-09'] },
    'the tab tells the user which month to upload');
  assert.deepEqual(out.warnings, []);

  // No emp detail anywhere at all is the same answer.
  const bare = sources.resolvePeople({ window: SEP_ONLY, rows: noRosterRows() });
  assert.deepEqual(bare.employees, []);
  assert.deepEqual(bare.visibility, { mode: 'single', hidden: 0, missingMonths: ['2026-09'] });
});

test('resolvePeople: a window month with no emp detail names nobody for ITSELF, and narrows nobody else', () => {
  const rows = {
    closedRows: [
      closed({ jobId: 1, date: '2026-08-10', spoc: 700, spocName: 'Ritu Sangwan', charge: 1000 }),
      closed({ jobId: 2, date: '2026-09-05', spoc: 700, spocName: 'Ritu Sangwan', charge: 500 }),
    ],
    openRows: [open({ jobId: 9, spoc: 700, spocName: 'Ritu Sangwan' })],
    crm: [{ userId: 700, userName: 'Ritu Sangwan', internal: true, date: '2026-08-10', booked: 2, scheduled: 0, audit: 0, closed: 0, cancelled: 0 }],
  };
  // August has an emp detail, September has none (owner, 2026-09-18): September
  // simply names nobody — it does not take August's people away. August's rows
  // keep their owner; September's, and the open jobs the window credits to its
  // last month, go to Unattributed.
  const out = sources.resolvePeople({
    window: AUG_SEP, rosterByMonth: { '2026-08': ROSTER['2026-08'] }, rows,
  });
  assert.deepEqual(out.employees.map((e) => e.key), ['Ritu Sangwan', 'Johan']);
  assert.deepEqual(out.closedRows.map((r) => r.spoc), ['Ritu Sangwan', 'Unattributed']);
  assert.deepEqual(out.openRows.map((r) => r.spoc), ['Unattributed'],
    'open jobs are credited to the window\'s last month, which has no emp detail');
  assert.deepEqual(out.crm.map((r) => r.key), ['Ritu Sangwan']);
  assert.deepEqual([out.unattributed.closedJobs, out.unattributed.revenue, out.unattributed.openJobs], [1, 500, 1]);
  assert.deepEqual(
    [...new Set(out.unattributed.users.filter((x) => x.userId !== null).flatMap((x) => x.reasons))],
    ['roster-not-uploaded'],
    'nobody is refused for not being on every roster: only September has none');
  assert.deepEqual(out.months, [
    { month: '2026-08', rosterUploaded: true, employees: 2, rosterSize: 2 },
    { month: '2026-09', rosterUploaded: false, employees: 0, rosterSize: 0 },
  ]);
  assert.deepEqual(out.visibility,
    { mode: 'single', hidden: 0, missingMonths: ['2026-09'] },
    'one rostered month: the intersection rule narrows nothing');

  // Upload September's emp detail with the same two people and both months show them.
  const both = sources.resolvePeople({
    window: AUG_SEP,
    rosterByMonth: { '2026-08': ROSTER['2026-08'], '2026-09': ROSTER['2026-08'].map((r) => ({ ...r, team: 'Beta' })) },
    rows,
  });
  assert.deepEqual(both.employees.map((e) => [e.key, e.teams]), [
    ['Ritu Sangwan', { '2026-08': 'Alpha', '2026-09': 'Beta' }],
    ['Johan', { '2026-08': 'Alpha', '2026-09': 'Beta' }],
  ]);
  assert.deepEqual(both.closedRows.map((r) => r.spoc), ['Ritu Sangwan', 'Ritu Sangwan']);
  assert.deepEqual(both.openRows.map((r) => r.spoc), ['Ritu Sangwan']);
  assert.deepEqual(both.crm.map((r) => r.key), ['Ritu Sangwan']);
  assert.deepEqual([both.unattributed.closedJobs, both.unattributed.revenue, both.unattributed.openJobs], [0, 0, 0]);
  assert.deepEqual(both.months, [
    { month: '2026-08', rosterUploaded: true, employees: 2, rosterSize: 2 },
    { month: '2026-09', rosterUploaded: true, employees: 2, rosterSize: 2 },
  ]);
  assert.deepEqual(both.visibility,
    { mode: 'intersection', hidden: 0, missingMonths: [] },
    'everyone is on both emp details: nobody is hidden');
});

test('resolvePeople → compose: hiding a person MOVES their numbers to Unattributed, it never loses them', () => {
  // Johan is on August's emp detail only, so the August-September window hides
  // him — including his August job, which the same window credits him for when
  // it is asked for August alone.
  const rows = {
    closedRows: [
      closed({ jobId: 1, date: '2026-08-10', spoc: 700, spocName: 'Ritu Sangwan', charge: 1000, aco: 700, acoName: 'Ritu Sangwan' }),
      closed({ jobId: 2, date: '2026-08-11', spoc: 720, spocName: 'Johan', charge: 700, aco: 720, acoName: 'Johan' }),
      closed({ jobId: 3, date: '2026-09-05', spoc: 700, spocName: 'Ritu Sangwan', charge: 500, aco: 700, acoName: 'Ritu Sangwan' }),
      closed({ jobId: 4, date: '2026-09-06', spoc: 760, spocName: 'Nobody At All', charge: 300 }),
    ],
    openRows: [
      open({ jobId: 9, spoc: 700, spocName: 'Ritu Sangwan' }),
      open({ jobId: 8, spoc: 720, spocName: 'Johan' }),
      open({ jobId: 7, spoc: null, spocName: null }),
    ],
    crm: [],
  };
  const totals = {
    revenue: rows.closedRows.reduce((s, r) => s + r.charge, 0),
    completed: rows.closedRows.length,
    open: rows.openRows.length,
  };

  const people = sources.resolvePeople({ window: AUG_SEP, rosterByMonth: ROSTER, rows });
  assert.deepEqual(people.employees.map((e) => e.key), ['Ritu Sangwan'], 'Johan is hidden');
  assert.equal(people.visibility.hidden, 1);

  const D = compose({
    window: AUG_SEP, employees: people.employees, targets: {}, openRows: people.openRows,
    closedRows: people.closedRows, crm: people.crm, timechamp: [], ivr: [],
  }, { teamMode: 'perMonth' });
  // The named people, then the Unattributed buckets compose() builds for the
  // rows resolvePeople could not place: the two together are every job.
  const named = D.primarySpocs.filter((n) => !isUnattributedKey(n));
  const sumOf = (names, f) => names.reduce((a, n) => a + D.employees[n][f], 0);
  const sum = (f) => sumOf(named, f);
  const u = people.unattributed;

  assert.deepEqual(named, ['Ritu Sangwan']);
  assert.equal(sum('revenue') + u.revenue, totals.revenue, 'every rupee is on a person or on Unattributed');
  assert.equal(sum('completed') + u.closedJobs, totals.completed);
  assert.equal(sum('open') + u.openJobs, totals.open);
  assert.deepEqual([sum('revenue'), u.revenue], [1500, 1000], 'positive control: Johan\'s 700 is IN the 1000');
  // …and the buckets hold exactly that 1000, so nothing has to be added back in
  // at the summary layer: D itself already totals to every job.
  assert.deepEqual([sumOf(D.primarySpocs, 'revenue'), sumOf(D.primarySpocs, 'completed'), sumOf(D.primarySpocs, 'open')],
    [totals.revenue, totals.completed, totals.open]);
  assert.equal(u.users.find((x) => x.userId === 720).revenue, 700);

  // August alone: Johan is on that month's emp detail, so the same job is his.
  // (loadClosedJobs returns only the window's jobs, so the fixture does too.)
  const AUG = { from: '2026-08-01', to: '2026-08-31' };
  const augRows = { ...rows, closedRows: rows.closedRows.filter((r) => r.date <= AUG.to) };
  const aug = sources.resolvePeople({ window: AUG, rosterByMonth: ROSTER, rows: augRows });
  const augD = compose({
    window: AUG, employees: aug.employees, targets: {},
    openRows: aug.openRows, closedRows: aug.closedRows, crm: aug.crm, timechamp: [], ivr: [],
  }, { teamMode: 'perMonth' });
  assert.equal(augD.employees.Johan.revenue, 700);
  assert.equal(aug.unattributed.revenue, 0);
});

test('resolvePeople: the window is required', () => {
  assert.throws(() => sources.resolvePeople({ rows: {} }), TypeError);
});

/* ── the SPOC freeze capture ───────────────────────────────────────────────── */

const SEP17 = new Date('2026-09-17T06:00:00Z');

test('capture: no freeze table → skipped cleanly, nothing read from the export, nothing written', async () => {
  state.freezeError = Object.assign(new Error("Table doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 });
  const r = await sources.captureSpocFreeze({ now: SEP17 });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /tbl_qs_ep_job_spoc does not exist/);
  assert.equal(phase1Calls().length, 0);
  assert.equal(fake.calls.some((c) => WRITE_RE.test(c.sql)), false);
});

test('capture: freezes only jobs with no row, with the current mapping, first capture wins', async () => {
  seedJobs([
    { id: 201, client: 10, checkout: '2026-09-02 10:00:00' },
    { id: 202, client: 10, checkout: '2026-09-02 11:00:00' },
    { id: 203, client: 99, checkout: '2026-09-03 10:00:00' },
  ]);
  state.freeze.set(202, 900);
  state.mapping.set(10, 700);
  const r = await sources.captureSpocFreeze({ now: SEP17 });

  const [p1] = phase1Calls();
  assert.equal(whereOf(p1.sql),
    'WHERE J.job_status IN (?, ?) AND J.checkout_date_time >= DATE(?) AND J.checkout_date_time < DATE(?) + INTERVAL 1 DAY');
  assert.deepEqual(p1.params, [3, 5, '2026-08-01', '2026-09-17', 5000], 'default: since the 1st of the previous IST month');

  const inserts = fake.calls.filter((c) => WRITE_RE.test(c.sql));
  assert.equal(inserts.length, 1);
  assert.match(inserts[0].sql, /^INSERT INTO tbl_qs_ep_job_spoc \(job_id, spoc_user_id, captured_on\) VALUES \? ON DUPLICATE KEY UPDATE job_id = job_id$/);
  const values = inserts[0].params[0];
  assert.deepEqual(values.map((v) => [v[0], v[1]]).sort((a, b) => a[0] - b[0]), [[201, 700], [203, null]]);
  assert.ok(values.every((v) => v[2] instanceof Date));
  assert.deepEqual([r.skipped, r.scanned, r.alreadyFrozen, r.captured, r.capturedWithoutSpoc], [false, 3, 1, 2, 1]);
  assert.ok(!state.resolverCalls.includes(undefined));
});

test('capture: a real probe failure propagates; a bad `since` is a 400', async () => {
  state.freezeError = Object.assign(new Error('Too many connections'), { code: 'ER_CON_COUNT_ERROR', errno: 1040 });
  await assert.rejects(sources.captureSpocFreeze({ now: SEP17 }), /Too many connections/);
  state.freezeError = null;
  await assert.rejects(sources.captureSpocFreeze({ since: '2026-13-01', now: SEP17 }), (e) => e.status === 400);
  await assert.rejects(sources.captureSpocFreeze({ since: '2026-09-18', now: SEP17 }), (e) => e.status === 400);
});
