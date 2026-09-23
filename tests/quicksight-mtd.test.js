/*
 * QuickSight — MTD (services/quicksight/mtd.service.js + routes/admin/
 * quicksight/mtd.js).
 *
 * No database: the shared pool is replaced by tests/helpers/fake-pool.js, whose
 * handlers below play a tiny tbl_job / tbl_user. The REAL Manage Jobs export
 * (filter builder, fetchExportChunk, mapExportRow) and the REAL Employee
 * Performance loaders run on top of it, so what these tests pin is the thing
 * that would otherwise be invisible — which rows each of the five columns is
 * actually counting, and who they are credited to.
 *
 * The fake's phase-1 handler does not guess: it REBUILDS the predicate from the
 * statement the export emitted (the status list, the date column and window,
 * the vertical and zonal clauses) and answers exactly that question. So a
 * loader that asked for the wrong column or the wrong bucket comes back with
 * the wrong rows here, instead of with whatever the fixture felt like handing
 * over.
 *
 * What is pinned:
 *   - the five counts land on the right PERSON, who is the client's Primary
 *     SPOC — not whoever did the work;
 *   - a job whose client has no internal SPOC (no mapping, a deleted user, a
 *     technician account) lands on Unattributed and is never dropped;
 *   - rows + Unattributed = totals, exactly, per metric;
 *   - Completed reads checkout_date_time and Cancelled reads cancel_date_time,
 *     each with its own status pin and the whole end day included;
 *   - Ticket Created reads ticket_created_date_time at ANY status;
 *   - Open ignores the date window entirely — it is a snapshot of now;
 *   - In Progress is statuses 2 and 20 filtered out of the OPEN rows, so it can
 *     never exceed Open;
 *   - the vertical and zonal-manager filters narrow the read, parameterised;
 *   - a bad window is a 400, from the service and through the route;
 *   - sorting and paging, and the view key still gating it all;
 *   - read paths never write.
 *
 * resolveClientPrimarySpoc (services/job.service.js) is stubbed on the module
 * object: the rule itself is job.service's, and these tests only need to know
 * which clients it was asked about.
 *
 * Runner: TZ=UTC node --test --experimental-test-isolation=none tests/quicksight-mtd.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installFakePool } = require('./helpers/fake-pool');

/* ── the fake database ─────────────────────────────────────────────────────── */

const state = {};

function resetState() {
  state.jobs = new Map();       // job_id → raw export row (J.* + aliases)
  state.phase1 = [];            // every job_id the export could "find"
  state.users = new Map();      // user_id → { user_name, user_type_id, user_role }
  state.mapping = new Map();    // client_id → current Primary SPOC user_id
  state.verticalOf = new Map(); // job_id → the vertical its client is mapped to
  state.zmOf = new Map();       // job_id → its city's state_user (zonal manager)
  state.resolverCalls = [];
}
resetState();

/*
 * Parameters are POSITIONAL: the n-th '?' in the statement binds params[n]. So
 * the values a clause carries are found by counting the '?'s that PRECEDE it —
 * which is order-independent, unlike indexing the params array by hand, and
 * therefore cannot be broken by a clause being added somewhere else in
 * buildClauses.
 */
function bound(sql, params, clauseRe) {
  const m = sql.match(clauseRe);
  if (!m) return null;
  const before = (sql.slice(0, m.index).match(/\?/g) || []).length;
  const count = (m[0].match(/\?/g) || []).length;
  return params.slice(before, before + count);
}

// Phase 1 of the export: answer the WHERE the builder actually emitted.
function phase1Ids(sql, params) {
  const limit = params[params.length - 1];
  const afterId = /J\.job_id < \?/.test(sql) ? params[params.length - 2] : Infinity;

  const statuses = bound(sql, params, /J\.job_status IN \([?, ]+\)/);
  const vertical = bound(sql, params, /vm\.vertical_id = \?/);
  const zonal = bound(sql, params, /city\.state_user IN \([?, ]+\)/);
  const dateCol = (sql.match(/J\.(\w*date\w*) >= DATE\(\?\)/) || [])[1] || null;
  const window = dateCol === null ? null : [
    ...bound(sql, params, new RegExp(`J\\.${dateCol} >= DATE\\(\\?\\)`)),
    ...bound(sql, params, new RegExp(`J\\.${dateCol} < DATE\\(\\?\\) \\+ INTERVAL 1 DAY`)),
  ];

  const inWindow = (value) => {
    if (value === null || value === undefined) return false;
    const day = String(value).slice(0, 10);
    return day >= window[0] && day <= window[1];
  };

  return state.phase1
    .filter((id) => {
      const j = state.jobs.get(id);
      if (id >= afterId) return false;
      if (statuses !== null && !statuses.includes(Number(j.job_status))) return false;
      if (vertical !== null && state.verticalOf.get(id) !== vertical[0]) return false;
      if (zonal !== null && !zonal.includes(state.zmOf.get(id))) return false;
      if (dateCol !== null && !inWindow(j[dateCol])) return false;
      return true;
    })
    .sort((a, b) => b - a)
    .slice(0, limit)
    .map((job_id) => ({ job_id }));
}

const fake = installFakePool([
  [/^SHOW COLUMNS FROM tbl_client/, [{ Field: 'vertical_id' }]],
  [/^SELECT J\.job_id/, phase1Ids],
  [/TJA1\.previous_efr\s+AS previousEfrId/, (sql, params) => params[params.length - 1]
    .map((id) => ({ ...state.jobs.get(id) })).sort((a, b) => b.job_id - a.job_id)],
  // The freeze table exists and is empty: every closed job uses the CURRENT
  // mapping, which is the only rule MTD has (see the loadCancelledJobs note).
  [/FROM tbl_qs_ep_job_spoc/, []],
  [/FROM tbl_user WHERE user_id IN/, (sql, params) => params[0]
    .filter((id) => state.users.has(id)).map((id) => ({ user_id: id, ...state.users.get(id) }))],
]);

// The permission gate reads role.service; stub it before the router is built.
function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
const VIEW_KEY = 'isQuickSightMtdView';
const perms = { list: ['ef-QuickSight', VIEW_KEY] };
stub('services/role.service', { getEffectivePermissions: async () => ({ menuIds: [], actionPermissions: perms.list }) });

const express = require('express');
const jobService = require('../services/job.service');
const sources = require('../services/quicksight/employee-performance/sources.service');
const service = require('../services/quicksight/mtd.service');

const originalResolver = jobService.resolveClientPrimarySpoc;
let server;
let base;

before(async () => {
  jobService.resolveClientPrimarySpoc = async (clientId) => {
    state.resolverCalls.push(clientId);
    return state.mapping.has(clientId) ? state.mapping.get(clientId) : null;
  };
  const app = express();
  app.use((req, _res, next) => { req.user = { user_id: 9, user_name: 'MIS User' }; next(); });
  app.use('/api/admin/quicksight/mtd', require('../routes/admin/quicksight/mtd'));
  app.use((err, _req, res, _next) => { res.status(500).json({ success: false, error: String(err && err.message) }); });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/admin/quicksight/mtd`;
});
after(async () => {
  jobService.resolveClientPrimarySpoc = originalResolver;
  fake.restore();
  if (server) await new Promise((r) => server.close(r));
});
beforeEach(() => {
  resetState();
  fake.reset();
  perms.list = ['ef-QuickSight', VIEW_KEY];
  service.invalidateMtdCache();
});

/* ── fixtures ──────────────────────────────────────────────────────────────── */

const NOW = new Date('2026-09-22T06:00:00Z');
const WINDOW = { from: '2026-09-01', to: '2026-09-22' };
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|TRUNCATE)\b/i;

function rawJob(o) {
  return {
    job_id: o.id,
    job_status: o.status,
    fk_client_id: o.client === undefined ? 10 : o.client,
    fk_checkout_by: null,
    ticket_created_date_time: o.ticket ? `${o.ticket} 09:00:00` : null,
    checkout_date_time: o.checkout ? `${o.checkout} 17:30:00` : null,
    cancel_date_time: o.cancel ? `${o.cancel} 11:15:00` : null,
    city_name: 'Pune',
    state_name: 'Maharashtra',
    client_name: 'Acme Furnishings',
    zonal_manager: 'ZM One',
    efr_name: null,
    fk_easyfixter_id: null,
    vertical_name: 'Furniture',
    due_to_type: null,
    pending_reason_desc: null,
    total_charge: o.charge ?? null,
    easyfix_charge: null,
    fk_service_catg_id: 15,
    tier: 2,
    checkin_date_time: null,
    original_appointment_date_time: null,
  };
}

function seedJobs(list) {
  for (const o of list) {
    state.jobs.set(o.id, rawJob(o));
    state.phase1.push(o.id);
    if (o.verticalId !== undefined) state.verticalOf.set(o.id, o.verticalId);
    if (o.zmId !== undefined) state.zmOf.set(o.id, o.zmId);
  }
}

const staff = (name, role = 13) => ({ user_name: name, user_type_id: 5, user_role: role });

/*
 * The whole fixture, once. Five clients cover the four ways a job is credited
 * and the three ways it is not:
 *   10 → Ritu Sangwan (internal staff)      20 → Vineet Jangid (internal staff)
 *   30 → no Primary SPOC mapping at all     40 → a TECHNICIAN account (role 19)
 *   50 → a mapping pointing at a user that no longer exists
 */
function seedWorld() {
  seedJobs([
    { id: 101, status: 1, client: 10, ticket: '2026-09-02' },                          // open
    { id: 102, status: 2, client: 10, ticket: '2026-09-03' },                          // open + in progress
    { id: 103, status: 3, client: 20, ticket: '2026-09-04', checkout: '2026-09-10' },  // completed
    { id: 104, status: 6, client: 30, ticket: '2026-09-05', cancel: '2026-09-06' },    // cancelled
    { id: 105, status: 20, client: 20, ticket: '2026-08-31' },                         // open + in progress, ticket OUTSIDE
    { id: 106, status: 9, client: 40, ticket: '2026-09-09' },                          // open, technician SPOC
    { id: 107, status: 5, client: 10, ticket: '2026-09-01', checkout: '2026-09-11' },  // completed
    { id: 108, status: 3, client: 10, ticket: '2026-07-01', checkout: '2026-08-15' },  // completed OUTSIDE
    { id: 109, status: 6, client: 10, ticket: '2026-09-06', cancel: '2026-09-07' },    // cancelled
    { id: 110, status: 6, client: 50, ticket: '2026-09-09', cancel: '2026-09-08' },    // cancelled, deleted SPOC
  ]);
  state.mapping.set(10, 700);
  state.mapping.set(20, 800);
  state.mapping.set(40, 710);
  state.mapping.set(50, 900);          // 900 is never inserted into state.users
  state.users.set(700, staff('Ritu Sangwan'));
  state.users.set(800, staff('Vineet Jangid'));
  state.users.set(710, staff('Amit Kumar', 19));
}

const phase1Calls = () => fake.calls.filter((c) => /^SELECT J\.job_id/.test(c.sql));
const whereOf = (sql) => sql.slice(sql.indexOf('WHERE'), sql.indexOf('GROUP BY')).replace(/\s+/g, ' ').trim();
/*
 * The one phase-1 call whose WHERE mentions this column — the WHERE, not the
 * whole statement: the export's FROM clause names several lifecycle columns in
 * its joins, so matching the full SQL picks whichever read ran first.
 */
const callWhere = (re) => {
  const hits = phase1Calls().filter((c) => re.test(whereOf(c.sql)));
  assert.equal(hits.length, 1, `expected exactly one phase-1 read filtering on ${re}`);
  return hits[0];
};

/* ── the five counts ───────────────────────────────────────────────────────── */

test('the five counts land on the client\'s Primary SPOC, one row per person', async () => {
  seedWorld();
  const out = await service.buildMtd({ ...WINDOW, now: NOW });

  assert.deepEqual(out.rows, [
    // Ritu owns client 10: tickets 101 102 107 109 · open 101 102 · in progress
    // 102 · completed 107 (108 checked out in August) · cancelled 109.
    { userId: 700, name: 'Ritu Sangwan', ticketCreated: 4, inProgress: 1, open: 2, completed: 1, cancelled: 1 },
    // Vineet owns client 20: ticket 103 only (105's ticket is August's) · open
    // 105 · in progress 105 · completed 103 · nothing cancelled.
    { userId: 800, name: 'Vineet Jangid', ticketCreated: 1, inProgress: 1, open: 1, completed: 1, cancelled: 0 },
  ], 'default order is biggest book of business first');

  assert.deepEqual(out.totals, { ticketCreated: 8, inProgress: 2, open: 4, completed: 2, cancelled: 3 });
  assert.equal(fake.calls.some((c) => WRITE_RE.test(c.sql)), false, 'a read path never writes');
});

test('In Progress is statuses 2 and 20 filtered out of the OPEN rows, never a second read', async () => {
  seedWorld();
  const out = await service.buildMtd({ ...WINDOW, now: NOW });

  // The rule, which is what must never drift: In Progress is a SUBSET of Open.
  assert.deepEqual([...sources.IN_PROGRESS_STATUSES], [2, 20]);
  for (const s of sources.IN_PROGRESS_STATUSES) {
    assert.ok(sources.OPEN_STATUSES.includes(s), `status ${s} must be inside the Open bucket`);
  }
  for (const row of [...out.rows, out.unattributed]) {
    assert.ok(row.inProgress <= row.open, `${row.name}: In Progress cannot exceed Open`);
  }
  assert.ok(out.totals.inProgress <= out.totals.open);

  // Four reads for five columns: In Progress costs no query of its own, and no
  // statement anywhere pins IN (2, 20).
  assert.equal(phase1Calls().length, 4);
  assert.equal(phase1Calls().some((c) => /J\.job_status IN \(\?, \?\)/.test(c.sql)
    && c.params[0] === 2 && c.params[1] === 20), false);
});

/* ── who is nobody ─────────────────────────────────────────────────────────── */

test('a job with no internal SPOC lands on Unattributed — mapping missing, user deleted, or not staff', async () => {
  seedWorld();
  const out = await service.buildMtd({ ...WINDOW, now: NOW });

  assert.deepEqual(out.unattributed, {
    userId: null,
    name: 'Unattributed',
    // tickets 104 (client 30, no mapping) 106 (client 40, technician) 110
    // (client 50, deleted user) · open 106 · cancelled 104 and 110.
    ticketCreated: 3, inProgress: 0, open: 1, completed: 0, cancelled: 2,
  });
  assert.equal(out.unattributed.name, sources.UNATTRIBUTED, 'the same label Employee Performance uses');
  assert.deepEqual(out.rows.map((r) => r.userId), [700, 800],
    'a technician account and a deleted user are never rows of their own');
});

test('rows + Unattributed equal the totals, exactly, for every one of the five counts', async () => {
  seedWorld();
  const out = await service.buildMtd({ ...WINDOW, now: NOW });

  for (const metric of service.METRICS) {
    const summed = out.rows.reduce((a, r) => a + r[metric], 0) + out.unattributed[metric];
    assert.equal(summed, out.totals[metric], `${metric}: every job is on a person or on Unattributed`);
    assert.equal(out.attributed[metric], out.rows.reduce((a, r) => a + r[metric], 0));
  }
  assert.equal(out.reconciled, true);

  // Positive control: the Unattributed line is carrying real work, so the
  // identity above is not passing because both sides happen to be zero.
  assert.deepEqual(
    [out.unattributed.ticketCreated, out.unattributed.open, out.unattributed.cancelled], [3, 1, 2]);
});

/* ── which column each set is read on ──────────────────────────────────────── */

test('Completed is checkout_date_time and Cancelled is cancel_date_time, each on its own statuses', async () => {
  seedWorld();
  await service.buildMtd({ ...WINDOW, now: NOW });

  const completed = callWhere(/checkout_date_time/);
  assert.equal(whereOf(completed.sql),
    'WHERE J.job_status IN (?, ?) AND J.checkout_date_time >= DATE(?) AND J.checkout_date_time < DATE(?) + INTERVAL 1 DAY');
  assert.deepEqual(bound(completed.sql, completed.params, /J\.job_status IN \(\?, \?\)/),
    [...sources.CLOSED_STATUSES]);

  const cancelled = callWhere(/cancel_date_time/);
  assert.equal(whereOf(cancelled.sql),
    'WHERE J.job_status IN (?) AND J.cancel_date_time >= DATE(?) AND J.cancel_date_time < DATE(?) + INTERVAL 1 DAY');
  assert.deepEqual(bound(cancelled.sql, cancelled.params, /J\.job_status IN \(\?\)/),
    [...sources.CANCELLED_STATUSES]);
  assert.deepEqual([...sources.CANCELLED_STATUSES], [6]);

  // The whole end day, both of them, and never an inlined date.
  for (const call of [completed, cancelled]) {
    assert.deepEqual(call.params.slice(-3, -1), [WINDOW.from, WINDOW.to]);
    assert.doesNotMatch(whereOf(call.sql), /'2026-09/, 'dates are bound, never inlined');
    assert.doesNotMatch(whereOf(call.sql), /DATE_SUB|INTERVAL 6 MONTH/, 'no default window is imposed');
  }

  // Neither column is read by the other set, which is the mistake that would
  // make Cancelled a copy of Completed and nobody able to see it — the two
  // sets are the same SHAPE, on deliberately different days.
  assert.doesNotMatch(whereOf(completed.sql), /cancel_date_time/);
  assert.doesNotMatch(whereOf(cancelled.sql), /checkout_date_time/);
});

test('Ticket Created is ticket_created_date_time at ANY status, not created_date_time', async () => {
  seedWorld();
  await service.buildMtd({ ...WINDOW, now: NOW });

  const ticket = callWhere(/ticket_created_date_time/);
  assert.equal(whereOf(ticket.sql),
    'WHERE J.ticket_created_date_time >= DATE(?) AND J.ticket_created_date_time < DATE(?) + INTERVAL 1 DAY');
  assert.doesNotMatch(whereOf(ticket.sql), /job_status/,
    'pinning a bucket here would drop the tickets that were closed or cancelled inside the window');
  // "Booking Date" is a different column and a different day.
  assert.doesNotMatch(whereOf(ticket.sql), /J\.created_date_time/);
});

test('Open ignores the date window entirely — it is a snapshot of what is open NOW', async () => {
  seedWorld();
  const september = await service.buildMtd({ ...WINDOW, now: NOW });

  const open = phase1Calls().find((c) => !/date_time/.test(whereOf(c.sql)));
  assert.equal(whereOf(open.sql), `WHERE J.job_status IN (${sources.OPEN_STATUSES.map(() => '?').join(', ')})`);
  assert.deepEqual(open.params, [...sources.OPEN_STATUSES, 2000]);
  assert.doesNotMatch(open.sql.slice(open.sql.indexOf('WHERE')), /date_time|DATE_SUB|INTERVAL/i,
    'no window, not even the export\'s own 6-month default');

  // Move the window to a month in which none of these jobs did anything: the
  // four windowed columns empty out and Open does not move at all.
  service.invalidateMtdCache();
  const june = await service.buildMtd({ from: '2026-06-01', to: '2026-06-30', now: NOW });
  assert.deepEqual(june.totals,
    { ticketCreated: 0, inProgress: 2, open: 4, completed: 0, cancelled: 0 });
  assert.equal(june.totals.open, september.totals.open);
  assert.equal(june.totals.inProgress, september.totals.inProgress);
});

/* ── the two filters ───────────────────────────────────────────────────────── */

test('the vertical and zonal-manager filters narrow every read, parameterised', async () => {
  seedJobs([
    { id: 201, status: 1, client: 10, ticket: '2026-09-02', verticalId: 4, zmId: 61 },
    { id: 202, status: 1, client: 10, ticket: '2026-09-03', verticalId: 7, zmId: 61 },
    { id: 203, status: 3, client: 20, ticket: '2026-09-04', checkout: '2026-09-10', verticalId: 4, zmId: 62 },
    { id: 204, status: 6, client: 20, ticket: '2026-09-05', cancel: '2026-09-06', verticalId: 4, zmId: 61 },
  ]);
  state.mapping.set(10, 700);
  state.mapping.set(20, 800);
  state.users.set(700, staff('Ritu Sangwan'));
  state.users.set(800, staff('Vineet Jangid'));

  const all = await service.buildMtd({ ...WINDOW, now: NOW });
  assert.deepEqual(all.totals, { ticketCreated: 4, inProgress: 0, open: 2, completed: 1, cancelled: 1 });
  assert.deepEqual(all.scope, { verticalId: null, zonalManagerId: null });

  // Vertical 4 drops 202 (vertical 7) from every column it appears in.
  service.invalidateMtdCache();
  fake.reset();
  const vertical = await service.buildMtd({ ...WINDOW, verticalId: 4, now: NOW });
  assert.deepEqual(vertical.totals, { ticketCreated: 3, inProgress: 0, open: 1, completed: 1, cancelled: 1 });
  assert.deepEqual(vertical.scope, { verticalId: 4, zonalManagerId: null });
  for (const call of phase1Calls()) {
    assert.match(call.sql, /EXISTS \(SELECT 1 FROM tbl_vertical_mapping vm WHERE vm\.client_id = J\.fk_client_id AND vm\.vertical_id = \?\)/);
    assert.deepEqual(bound(call.sql, call.params, /vm\.vertical_id = \?/), [4], 'the id is bound, never inlined');
  }

  // Zonal manager 61 drops 203 (city owned by 62) from Completed.
  service.invalidateMtdCache();
  fake.reset();
  const zonal = await service.buildMtd({ ...WINDOW, zonalManagerId: 61, now: NOW });
  assert.deepEqual(zonal.totals, { ticketCreated: 3, inProgress: 0, open: 2, completed: 0, cancelled: 1 });
  assert.deepEqual(zonal.scope, { verticalId: null, zonalManagerId: 61 });
  for (const call of phase1Calls()) {
    assert.deepEqual(bound(call.sql, call.params, /city\.state_user IN \(\?\)/), [61]);
  }

  // Both together, and the rows still reconcile under a filter.
  service.invalidateMtdCache();
  const both = await service.buildMtd({ ...WINDOW, verticalId: 4, zonalManagerId: 61, now: NOW });
  assert.deepEqual(both.totals, { ticketCreated: 2, inProgress: 0, open: 1, completed: 0, cancelled: 1 });
  assert.equal(both.reconciled, true);

  // 0 is the pickers' "All" sentinel, not a vertical nobody is mapped to.
  service.invalidateMtdCache();
  fake.reset();
  const allAgain = await service.buildMtd({ ...WINDOW, verticalId: 0, zonalManagerId: 0, now: NOW });
  assert.deepEqual(allAgain.totals, all.totals);
  assert.equal(phase1Calls().some((c) => /vm\.vertical_id|city\.state_user/.test(c.sql)), false);
});

/* ── sorting, paging, summary ──────────────────────────────────────────────── */

test('sorting and paging follow the named key, with a total order and totals over the whole set', async () => {
  seedWorld();

  const desc = await service.getMtdTable({ ...WINDOW, now: NOW });
  assert.deepEqual(desc.sort, { sortBy: 'ticketCreated', sortDir: 'desc' });
  assert.deepEqual(desc.data.map((r) => r.userId), [700, 800]);
  assert.deepEqual([desc.total, desc.pageNumber, desc.pageSize, desc.totalPages], [2, 1, 50, 1]);

  const byName = await service.getMtdTable({ ...WINDOW, sortBy: 'name', sortDir: 'desc', now: NOW });
  assert.deepEqual(byName.data.map((r) => r.name), ['Vineet Jangid', 'Ritu Sangwan']);

  const page2 = await service.getMtdTable({ ...WINDOW, size: 1, page: 2, now: NOW });
  assert.deepEqual(page2.data.map((r) => r.userId), [800]);
  assert.deepEqual([page2.total, page2.totalPages], [2, 2]);
  // Paging never narrows the reconciliation half: it is the WHOLE set, always.
  assert.deepEqual(page2.totals, desc.totals);
  assert.deepEqual(page2.unattributed, desc.unattributed);

  const past = await service.getMtdTable({ ...WINDOW, size: 1, page: 9, now: NOW });
  assert.deepEqual(past.data, [], 'a page past the end is empty, not page 1 again');

  const summary = await service.getMtdSummary({ ...WINDOW, now: NOW });
  assert.deepEqual(summary.totals, desc.totals);
  assert.deepEqual(summary.unattributed, desc.unattributed);
  assert.equal(summary.people, 2);
  assert.equal(summary.data, undefined, 'the KPI half carries no rows');
});

test('sorting a cached build never mutates it', async () => {
  seedWorld();
  const first = await service.getMtdTable({ ...WINDOW, now: NOW });
  await service.getMtdTable({ ...WINDOW, sortBy: 'name', sortDir: 'asc', now: NOW });
  const again = await service.getMtdTable({ ...WINDOW, now: NOW });
  assert.deepEqual(again.data.map((r) => r.userId), first.data.map((r) => r.userId));
  assert.equal(phase1Calls().length, 4, 'and the three calls shared ONE build');
});

/* ── the window ────────────────────────────────────────────────────────────── */

test('a bad window is a 400, and a missing one is the current IST month', async () => {
  seedWorld();
  for (const w of [
    { from: '2026-02-30', to: '2026-03-01' },   // not a real calendar day
    { from: '2026-09-10', to: '2026-09-01' },   // from after to
    { from: '2024-01-01', to: '2026-09-01' },   // longer than the loaders allow
    { from: 'last month', to: '2026-09-01' },
  ]) {
    await assert.rejects(service.buildMtd({ ...w, now: NOW }), (e) => e.status === 400, JSON.stringify(w));
    await assert.rejects(service.getMtdTable({ ...w, now: NOW }), (e) => e.status === 400);
    await assert.rejects(service.getMtdSummary({ ...w, now: NOW }), (e) => e.status === 400);
  }

  const out = await service.buildMtd({ now: new Date('2026-09-17T06:00:00Z') });
  assert.deepEqual(out.window, { from: '2026-09-01', to: '2026-09-17' }, 'MTD: the 1st .. today, IST');
  assert.deepEqual(service.defaultWindow(new Date('2026-08-31T20:00:00Z')), { from: '2026-09-01', to: '2026-09-01' },
    '20:00 UTC on 31 August is already 1 September in India');
});

/* ── the route ─────────────────────────────────────────────────────────────── */

const get = (qs) => fetch(`${base}${qs}`);

test('the route answers the table and the summary, and gates on the view key', async () => {
  seedWorld();
  const res = await get(`?startDate=${WINDOW.from}&endDate=${WINDOW.to}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.success, true);
  assert.deepEqual(body.data.data.map((r) => r.name), ['Ritu Sangwan', 'Vineet Jangid']);
  assert.deepEqual(body.data.totals, { ticketCreated: 8, inProgress: 2, open: 4, completed: 2, cancelled: 3 });
  assert.equal(body.data.unattributed.name, 'Unattributed');
  assert.equal(body.data.reconciled, true);

  const summary = await (await get(`/summary?startDate=${WINDOW.from}&endDate=${WINDOW.to}`)).json();
  assert.deepEqual(summary.data.totals, body.data.totals);

  // No dates at all is the current IST month, 1st .. today — what MTD means.
  // Compared against defaultWindow() rather than a literal, so the assertion
  // does not start failing on the 1st of next month.
  const bare = await (await get('')).json();
  assert.deepEqual(bare.data.window, service.defaultWindow());
  assert.deepEqual(bare.data.scope, { verticalId: null, zonalManagerId: null });
  assert.deepEqual(bare.data.sort, { sortBy: 'ticketCreated', sortDir: 'desc' });
  assert.deepEqual([bare.data.pageNumber, bare.data.pageSize], [1, 50]);

  perms.list = ['ef-QuickSight'];
  assert.equal((await get('')).status, 403, 'the family key alone is not enough');
  perms.list = [];
  assert.equal((await get('')).status, 403);
});

test('the route 400s a bad window and a bad parameter, rather than reporting the wrong month', async () => {
  seedWorld();
  for (const qs of [
    '?startDate=2026-02-30&endDate=2026-03-01',
    '?startDate=2026-09-10&endDate=2026-09-01',
    '?startDate=2024-01-01&endDate=2026-09-01',
    '?startDate=yesterday',
    '?sortBy=revenue',
    '?sortDir=sideways',
    '?size=5000',
    '?page=0',
  ]) {
    const res = await get(qs);
    assert.equal(res.status, 400, qs);
    assert.equal((await res.json()).success, false);
  }
  assert.equal(phase1Calls().length, 0, 'a refused request never touches the database');
});
