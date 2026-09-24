/*
 * QuickSight — the MTD Client Report (services/quicksight/mtd-report.service.js,
 * services/quicksight/mtd-comment-themes.js, and the two endpoints they hang
 * off in routes/admin/quicksight/mtd.js).
 *
 * No database: the shared pool is replaced by tests/helpers/fake-pool.js, whose
 * handlers below play a tiny tbl_job / tbl_user. The REAL Manage Jobs export
 * (filter builder, fetchExportChunk, mapExportRow) and the REAL Employee
 * Performance loaders run on top of it, so these tests pin what would
 * otherwise be invisible — which rows each KPI and each section is counting,
 * what it is dividing by, and what it is grouped on.
 *
 * ONE TEST PER KPI AND PER SECTION, plus the reconciliation habit this
 * codebase has: WHEREVER A SECTION SPLITS A TOTAL, THE PARTS PLUS ANY
 * REMAINDER MUST EQUAL IT. That is not a nicety here. Six of the eleven
 * sections are a different cut of the same jobs, so a row silently dropped
 * from one cut is a row the reader would never know was missing — the final
 * test asserts every one of those identities at once, over a fixture built so
 * that each of them is non-trivially true.
 *
 * The fixture is ONE month of jobs, seeded once in seedWorld(), designed so
 * that every arithmetic trap in the template is live:
 *   - a job created in the window and completed in it (in BOTH sets);
 *   - a job created before the window and completed in it (completed only);
 *   - a job created in the window and still open (created + open);
 *   - a job raised AFTER the window's end that is open (in neither);
 *   - an ENQUIRY raised in the window: created, but in no bucket at all;
 *   - a completed job outside TAT, so TAT % is not 100;
 *   - cancelled jobs spread across all four days-open bands;
 *   - a cancelled job with no reason picked and one with no usable comment;
 *   - a city with two different states on its rows, so the modal state wins;
 *   - a client with no internal SPOC, so the pickers have an Unattributed row.
 *
 * Runner: TZ=UTC node --test --experimental-test-isolation=none tests/quicksight-mtd-report.test.js
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
}
resetState();

/*
 * Parameters are POSITIONAL: the n-th '?' in the statement binds params[n]. So
 * the values a clause carries are found by counting the '?'s that PRECEDE it,
 * which cannot be broken by a clause being added somewhere else in
 * buildClauses. (Same helper as tests/quicksight-mtd.test.js.)
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
  const vertical = bound(sql, params, /vm\.vertical_id IN \([?, ]+\)/);
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
  // mapping, which is the only rule this report has.
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
const themes = require('../services/quicksight/mtd-comment-themes');
const report = require('../services/quicksight/mtd-report.service');

const originalResolver = jobService.resolveClientPrimarySpoc;
let server;
let base;

before(async () => {
  jobService.resolveClientPrimarySpoc = async (clientId) => (state.mapping.has(clientId) ? state.mapping.get(clientId) : null);
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
  report.invalidateMtdReportCache();
});

/* ── fixtures ──────────────────────────────────────────────────────────────── */

/*
 * 10:00 UTC is 15:30 IST — comfortably inside the day, and before the 23:00
 * IST cutoff, so "today" (the 22nd) is a PARTIAL day in every test below. That
 * is the state the tab is in for all but the last hour of any working day, so
 * it is the state the tests are written against.
 */
const NOW = new Date('2026-09-22T10:00:00Z');
const WINDOW = { from: '2026-09-01', to: '2026-09-22' };
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|TRUNCATE)\b/i;

/*
 * Aging — and therefore every days-open band, and TAT — is computed by the
 * export from these timestamps, not seeded directly, so the bands under test
 * are the export's own arithmetic rather than a number this file chose.
 * Pre-defined TAT for category 15 at tier 2 is 5 days, so a completed job is
 * "in TAT" exactly when it closed within 5 days of its ticket.
 */
const CLIENT_NAMES = { 10: 'Acme Furnishings', 20: 'Crest Retail', 30: 'Bharat Interiors' };

function rawJob(o) {
  return {
    job_id: o.id,
    job_status: o.status,
    fk_client_id: o.client === undefined ? 10 : o.client,
    fk_checkout_by: null,
    ticket_created_date_time: o.ticket ? `${o.ticket} 09:00:00` : null,
    checkout_date_time: o.checkout ? `${o.checkout} 17:30:00` : null,
    cancel_date_time: o.cancel ? `${o.cancel} 11:15:00` : null,
    cancel_comment: o.comment === undefined ? null : o.comment,
    cancelReason2: o.reason === undefined ? null : o.reason,
    cancel_by_user: o.cancelBy === undefined ? null : o.cancelBy,
    city_name: o.city === undefined ? 'Pune' : o.city,
    state_name: o.state === undefined ? 'Maharashtra' : o.state,
    // One NAME per client id, so the client picker's options are telling
    // apart three clients rather than three ids that all read the same.
    client_name: o.clientName === undefined ? CLIENT_NAMES[o.client === undefined ? 10 : o.client] : o.clientName,
    zonal_manager: 'ZM One',
    efr_name: null,
    fk_easyfixter_id: null,
    vertical_name: o.verticalName === undefined ? 'Furniture' : o.verticalName,
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
 * THE FIXTURE. Read the comment on each row: every one of them exists to make
 * one number in one section non-trivial.
 *
 * Window is 1..22 September. Clients: 10 → Ritu Sangwan, 20 → Vineet Jangid,
 * 30 → no Primary SPOC at all (the Unattributed picker row).
 */
function seedWorld() {
  seedJobs([
    /* ── completed (closed set): checkout inside the window ──────────────── */
    // created 2 Sep, closed 4 Sep → 2 days open → band 0-2 / 0-3, in TAT.
    { id: 101, status: 3, client: 10, ticket: '2026-09-02', checkout: '2026-09-04' },
    // created 1 Sep, closed 8 Sep → 7 days → band 6-9 both ways, OUT of TAT
    // (pre-defined TAT is 5). This is the row that keeps TAT % off 100.
    { id: 102, status: 5, client: 10, ticket: '2026-09-01', checkout: '2026-09-08' },
    // created BEFORE the window, closed inside it → completed but NOT created:
    // the reason ordersCreated and completed are not two views of one set.
    { id: 103, status: 3, client: 20, ticket: '2026-08-20', checkout: '2026-09-05', city: 'Mumbai', state: 'Maharashtra' },
    // a second Pune row carrying a DIFFERENT state, so the city table has to
    // pick the modal one rather than whichever row it met first.
    { id: 104, status: 3, client: 20, ticket: '2026-09-03', checkout: '2026-09-06', state: 'Karnataka' },
    // closed OUTSIDE the window — in no set at all.
    { id: 105, status: 3, client: 10, ticket: '2026-07-01', checkout: '2026-08-15' },

    /* ── cancelled: cancel date inside the window, one per days-open band ── */
    // 0 days → band 0-2 / 0-3.
    { id: 201, status: 6, client: 10, ticket: '2026-09-05', cancel: '2026-09-05', reason: 'Customer not reachable', comment: 'cx not responding since 2 days' },
    // 4 days → band 3-5 / 4-5.
    { id: 202, status: 6, client: 10, ticket: '2026-09-06', cancel: '2026-09-10', reason: 'Duplicate', comment: 'duplicate job, new job id created' },
    // 8 days → band 6-9 both ways.
    { id: 203, status: 6, client: 20, ticket: '2026-09-02', cancel: '2026-09-10', reason: 'Customer not reachable', comment: 'na' },
    // 12 days → band 9+ / 10-15. No reason picked at all.
    { id: 204, status: 6, client: 30, ticket: '2026-09-01', cancel: '2026-09-13', reason: null, comment: 'customer self installed the product' },
    // cancelled OUTSIDE the window.
    { id: 205, status: 6, client: 10, ticket: '2026-08-01', cancel: '2026-08-20' },

    /* ── open: the live backlog, no lower date bound ──────────────────────── */
    // raised inside the window and still open.
    { id: 301, status: 1, client: 10, ticket: '2026-09-15' },
    // raised BEFORE the window and still open — part of September's backlog.
    { id: 302, status: 9, client: 20, ticket: '2026-06-10', city: 'Mumbai', state: 'Maharashtra' },
    // raised AFTER the window's end: open now, but not open "as at 22 Sep".
    { id: 303, status: 2, client: 10, ticket: '2026-09-25' },

    // raised in the window and unconfirmed — open AND created, which is the
    // ordinary case and the one the two tiles are most often confused over.
    { id: 401, status: 9, client: 30, ticket: '2026-09-20' },

    /* ── created only ─────────────────────────────────────────────────────── */
    // An ENQUIRY (status 7): terminal, so it is in no bucket at all, yet its
    // ticket was raised in the window. The row that proves Orders created is
    // its own set rather than a slice of jobs in hand.
    { id: 402, status: 7, client: 10, ticket: '2026-09-18' },
  ]);
  state.mapping.set(10, 700);
  state.mapping.set(20, 800);
  state.users.set(700, staff('Ritu Sangwan'));
  state.users.set(800, staff('Vineet Jangid'));
}

const build = (over = {}) => report.buildMtdReport({ ...WINDOW, now: NOW, ...over });
const bucket = (list, key) => list.find((b) => b.key === key);
const named = (list, name) => list.find((e) => e.name === name);

/*
 * The fixture's own arithmetic, stated once so every test below can lean on
 * the same four numbers:
 *   created   101, 102, 104, 201, 202, 203, 204, 301, 401, 402  → 10
 *             (103, 302 raised before the window; 105, 205 long before;
 *              303 raised after it)
 *   completed 101, 102, 103, 104                                →  4
 *   cancelled 201, 202, 203, 204                                →  4
 *   open      301, 302, 401   (303 raised after `to`; 402 is an
 *             enquiry, which is terminal)                       →  3
 *   in hand   4 + 4 + 3                                         → 11
 */
const EXPECT = { created: 10, completed: 4, cancelled: 4, open: 3, inHand: 11 };

/* ══ the six KPI tiles ══════════════════════════════════════════════════════ */

test('KPI · Orders created counts the tickets RAISED in the window, and nothing else', async () => {
  seedWorld();
  const out = await build();

  assert.equal(out.kpis.ordersCreated, EXPECT.created);
  // It is its own set: jobs raised before the window are absent even when they
  // completed inside it, and a job raised inside it counts whatever became of
  // it afterwards.
  assert.equal(out.daily.totals.created, EXPECT.created, 'the Created bars are the same count');
  assert.notEqual(out.kpis.ordersCreated, out.kpis.inHand,
    'orders created is NOT a part of jobs in hand — see the service header');
  assert.equal(fake.calls.some((c) => WRITE_RE.test(c.sql)), false, 'a read path never writes');
});

test('KPI · Completed counts closures by CHECKOUT date, Cancelled by CANCEL date', async () => {
  seedWorld();
  const out = await build();

  assert.equal(out.kpis.completed, EXPECT.completed, '103 closed in-window though raised in August; 105 closed in August');
  assert.equal(out.kpis.cancelled, EXPECT.cancelled, '205 was cancelled in August');

  // Each set was read on its own date column, with its own status pin.
  const wheres = fake.calls.filter((c) => /^SELECT J\.job_id/.test(c.sql))
    .map((c) => c.sql.slice(c.sql.indexOf('WHERE'), c.sql.indexOf('GROUP BY')).replace(/\s+/g, ' ').trim());
  assert.equal(wheres.filter((w) => /J\.checkout_date_time >= DATE/.test(w)).length, 1);
  assert.equal(wheres.filter((w) => /J\.cancel_date_time >= DATE/.test(w)).length, 1);
  assert.equal(wheres.filter((w) => /J\.ticket_created_date_time >= DATE/.test(w)).length, 1);
});

test('KPI · Open is the live backlog raised on or before `to`, with NO start date', async () => {
  seedWorld();
  const out = await build();

  assert.equal(out.kpis.open, EXPECT.open, '302 was raised in June and still counts; 303 is raised after `to`');

  // Moving the START of the window cannot move it. Moving the END can.
  const narrower = await build({ from: '2026-09-20' });
  assert.equal(narrower.kpis.open, EXPECT.open, 'the open backlog ignores `from` entirely');
  const later = await build({ to: '2026-09-26' });
  assert.equal(later.kpis.open, EXPECT.open + 1, '303 (raised 25 Sep) joins the backlog once `to` reaches it');

  // The open read carries no date clause at all — it is a snapshot of now.
  const openRead = fake.calls.filter((c) => /^SELECT J\.job_id/.test(c.sql))
    .find((c) => !/>= DATE\(\?\)/.test(c.sql.slice(c.sql.indexOf('WHERE'), c.sql.indexOf('GROUP BY'))));
  assert.ok(openRead, 'one of the four reads filters on no date column');
});

test('KPI · Completion % is (completed + open) / jobs in hand — the exact complement of Cancelled %', async () => {
  seedWorld();
  const out = await build();

  assert.deepEqual(out.kpis.completionPct, { num: 7, den: 11, pct: 63.6 }, '(4 completed + 3 open) of 11 in hand');
  assert.deepEqual(out.kpis.cancelledPct, { num: 4, den: 11, pct: 36.4 });
  // THE identity the two tiles rest on: they are two halves of one whole, so
  // they must add to exactly 100 with no rounding gap.
  assert.equal(out.kpis.completionPct.num + out.kpis.cancelledPct.num, out.kpis.inHand);
  // The displayed halves add to 100 too, within the one decimal they are shown
  // at — they are rounded independently, so an exact-.5 split is the only case
  // that could put them a tenth apart.
  assert.ok(Math.abs(out.kpis.completionPct.pct + out.kpis.cancelledPct.pct - 100) <= 0.1);

  // And it is NOT the donut's rate, which leaves open jobs out entirely.
  assert.notEqual(out.kpis.completionPct.pct, out.completionVsCancellation.completionRate.pct);
});

test('KPI · TAT % divides by COMPLETED jobs, not by everything in hand', async () => {
  seedWorld();
  const out = await build();

  // 101 (2 days), 103 (16 days), 104 (3 days), 102 (7 days) against a
  // pre-defined TAT of 5 → two in, two out.
  assert.deepEqual(out.kpis.tatPct, { num: 2, den: 4, pct: 50 });
  assert.equal(out.kpis.tatPct.den, out.kpis.completed,
    'a cancelled or open job has no turnaround to have met');
});

test('KPI · a zero denominator is null, never 0%', async () => {
  // A window before every job in the fixture — including before the oldest
  // still-open one, which is the only way the open backlog is empty too.
  seedWorld();
  const out = await build({ from: '2026-05-01', to: '2026-05-10' });

  assert.equal(out.kpis.inHand, 0);
  assert.equal(out.kpis.completionPct.pct, null);
  assert.equal(out.kpis.tatPct.pct, null);
  assert.equal(out.kpis.cancelledPct.pct, null);
});

/* ══ section 1 — tickets created vs completed ═══════════════════════════════ */

test('section 1 · one bucket per day, created on the ticket date and completed on the closure date', async () => {
  seedWorld();
  const out = await build();

  assert.equal(out.daily.granularity, 'day');
  assert.equal(out.daily.buckets.length, 22, '1..22 September');
  assert.equal(out.daily.buckets[0].from, '2026-09-01');
  assert.equal(out.daily.buckets[21].to, '2026-09-22');

  const on = (ymd) => out.daily.buckets.find((b) => b.from === ymd);
  assert.equal(on('2026-09-01').created, 2, '102 and 204 raised on the 1st');
  assert.equal(on('2026-09-04').completed, 1, '101 closed on the 4th');
  assert.equal(on('2026-09-05').created, 1, '201 raised on the 5th');
  assert.equal(on('2026-09-05').completed, 1, '103 closed on the 5th');
  assert.equal(on('2026-09-18').created, 1, '402 — an enquiry still counts as a ticket raised');

  // The sum over the buckets IS the two KPI tiles — the chart and the tiles
  // cannot disagree.
  assert.equal(out.daily.totals.created, out.kpis.ordersCreated);
  assert.equal(out.daily.totals.completed, out.kpis.completed);
});

test('section 1 · the open-jobs line is the backlog at each day end, and is null before the first closure', async () => {
  seedWorld();
  const out = await build();
  const on = (ymd) => out.daily.buckets.find((b) => b.from === ymd);

  // The earliest closure in the window is the 4th, so the line starts on the
  // 3rd. Days before that are null, not zero: the window does not hold the
  // closures that would have to be subtracted from them.
  assert.equal(out.daily.openFrom, '2026-09-03');
  assert.equal(on('2026-09-01').open, null);
  assert.equal(on('2026-09-02').open, null);

  /*
   * End of the 3rd: raised on or before the 3rd and not yet closed —
   * 102 (closes the 8th), 103 (closes the 5th), 104 (raised the 3rd, closes
   * the 6th), 203 (raised the 2nd, cancelled the 10th), 204 (raised the 1st,
   * cancelled the 13th), 302 (raised in June, still open) = 6.
   * 101 raised the 2nd but closed ON the 4th, so it is still open on the 3rd.
   */
  assert.equal(on('2026-09-03').open, 7);
  // End of the 22nd: 301, 302 and 401 are still open.
  assert.equal(on('2026-09-22').open, 3);
  assert.equal(on('2026-09-22').open, out.kpis.open,
    'the last day of the line is the Open tile, by construction');
});

test('section 1 · today is a partial day, and the forecast averages the last two COMPLETE days', async () => {
  seedWorld();
  const out = await build();

  const today = out.daily.buckets.find((b) => b.from === '2026-09-22');
  assert.equal(today.partial, true, '15:30 IST is before the 23:00 cutoff');
  assert.equal(out.daily.buckets.find((b) => b.from === '2026-09-21').partial, false);

  // The last complete day is the 21st, so the forecast lands on the 22nd —
  // drawn over the part-day bar rather than past the end of the chart.
  assert.equal(out.daily.forecast.day, '2026-09-22');
  assert.equal(out.daily.forecast.beyondRange, false);
  assert.deepEqual(out.daily.forecast.basisDays, ['2026-09-20', '2026-09-21']);
  assert.equal(out.daily.forecast.window, 2);
  assert.equal(out.daily.forecast.created, 0.5, 'one ticket on the 20th, none on the 21st');
  assert.equal(out.daily.forecast.completed, 0);

  // After 23:00 IST the day is complete, and the forecast moves to tomorrow.
  const late = await build({ now: new Date('2026-09-22T17:45:00Z') });
  assert.equal(late.daily.buckets.find((b) => b.from === '2026-09-22').partial, false);
  assert.equal(late.daily.forecast.day, '2026-09-23');
  assert.equal(late.daily.forecast.beyondRange, true);

  // A range that does not run up to today gets no forecast at all.
  const past = await build({ to: '2026-09-15' });
  assert.equal(past.daily.forecast, null);
});

test('section 1 · a range longer than two months rolls up to weeks starting Monday', async () => {
  seedWorld();
  const out = await build({ from: '2026-07-01' });

  assert.equal(out.daily.granularity, 'week');
  assert.equal(new Date(`${out.daily.buckets[1].from}T00:00:00Z`).getUTCDay(), 1, 'weeks start on Monday');
  // The first bucket is clipped to the range's own start rather than running
  // back to the Monday before it.
  assert.equal(out.daily.buckets[0].from, '2026-07-01');
  assert.equal(out.daily.buckets[out.daily.buckets.length - 1].to, '2026-09-22');
  assert.equal(out.daily.forecast, null, 'no day-level forecast in the week view');
  assert.equal(out.daily.totals.completed, out.kpis.completed, 'the rollup still adds up');
});

/* ══ section 2 — completion vs cancellation ═════════════════════════════════ */

test('section 2 · the donut is completed / FINISHED jobs — open jobs are not in it', async () => {
  seedWorld();
  const out = await build();

  assert.deepEqual(out.completionVsCancellation, {
    completed: 4,
    cancelled: 4,
    finished: 8,
    completionRate: { num: 4, den: 8, pct: 50 },
  });
  assert.equal(out.completionVsCancellation.finished,
    out.kpis.completed + out.kpis.cancelled, 'the two halves are the whole');
  assert.equal(out.completionVsCancellation.finished + out.kpis.open, out.kpis.inHand,
    'finished plus open is everything in hand — nothing else is a job');
});

/* ══ sections 3 and 4 — by days open, and the breakdown tiles ═══════════════ */

test('section 3 · finished jobs split by days open, each band including its upper bound', async () => {
  seedWorld();
  const out = await build();

  // 101 2 days, 104 3 days, 102 7 days, 103 16 days.
  assert.equal(bucket(out.byDaysOpen.buckets, '0-2').completed, 1);
  assert.equal(bucket(out.byDaysOpen.buckets, '3-5').completed, 1);
  assert.equal(bucket(out.byDaysOpen.buckets, '6-9').completed, 1);
  assert.equal(bucket(out.byDaysOpen.buckets, '9+').completed, 1);
  // 201 0 days, 202 4 days, 203 8 days, 204 12 days.
  assert.deepEqual(out.byDaysOpen.buckets.map((b) => b.cancelled), [1, 1, 1, 1]);

  // A job is in exactly one band: the parts are the whole, both ways.
  assert.equal(out.byDaysOpen.totals.completed, out.kpis.completed);
  assert.equal(out.byDaysOpen.totals.cancelled, out.kpis.cancelled);
  assert.equal(out.byDaysOpen.buckets.reduce((a, b) => a + b.total, 0), out.byDaysOpen.totals.total);
  // Open jobs are NOT here — this section is about jobs that finished.
  assert.equal(out.byDaysOpen.totals.total, out.kpis.completed + out.kpis.cancelled);
});

test('section 4 · each tile carries its own cancel rate, and the worst is by RATE not by volume', async () => {
  seedWorld();
  const out = await build();

  for (const b of out.byDaysOpen.buckets) {
    assert.deepEqual(b.cancelRate, { num: b.cancelled, den: b.total, pct: b.total ? Math.round((b.cancelled / b.total) * 1000) / 10 : null });
  }
  assert.deepEqual(out.byDaysOpen.totals.cancelRate, { num: 4, den: 8, pct: 50 });

  // Every band here is 1 and 1, so the first is the worst; make the 6-9 band
  // genuinely worse and watch it move, which is the behaviour that matters.
  seedJobs([{ id: 206, status: 6, client: 10, ticket: '2026-09-02', cancel: '2026-09-10', reason: 'Duplicate', comment: 'duplicate' }]);
  report.invalidateMtdReportCache();
  const worse = await build();
  assert.equal(bucket(worse.byDaysOpen.buckets, '6-9').cancelRate.pct, 66.7, '2 cancelled of 3 finished');
  assert.equal(worse.byDaysOpen.worstBucket, '6-9');
});

/* ══ sections 5, 6 and 7 — why cancelled ════════════════════════════════════ */

test('section 5 · the scope is the cancelled jobs in view, split per days-open band', async () => {
  seedWorld();
  const out = await build();

  assert.equal(out.whyCancelled.cancelled, out.kpis.cancelled);
  assert.deepEqual(out.whyCancelled.buckets.map((b) => b.key), ['0-2', '3-5', '6-9', '9+'],
    'the SAME four bands section 3 uses, so clicking a tile filters this card');

  // Band by band, both breakdowns account for exactly the cancellations that
  // band holds. This is what lets the tab filter the card without refetching.
  out.byDaysOpen.buckets.forEach((b, i) => {
    assert.equal(out.whyCancelled.reasons.reduce((a, r) => a + r.byBucket[i], 0), b.cancelled);
    assert.equal(out.whyCancelled.themes.reduce((a, t) => a + t.byBucket[i], 0), b.cancelled);
  });
});

test('section 6 · cancel reasons group on the picked reason, prefix stripped, biggest first', async () => {
  seedWorld();
  const out = await build();

  assert.deepEqual(out.whyCancelled.reasons.map((r) => [r.name, r.total]), [
    ['Customer not reachable', 2],   // 201 and 203
    ['(No reason picked)', 1],       // 204 — never dropped, always its own row
    ['Duplicate', 1],                // 202
  ]);
  assert.ok(out.whyCancelled.reasons.every((r) => !/^cancel\s*-\s*:/i.test(r.name)),
    "the export's 'Cancel - :' prefix is not part of the reason");
  assert.equal(out.whyCancelled.reasons.reduce((a, r) => a + r.total, 0), out.kpis.cancelled);
});

test("section 7 · comment themes are themes.py's, by its names and its first-match order", async () => {
  seedWorld();
  const out = await build();

  assert.deepEqual(out.whyCancelled.themes.map((t) => [t.name, t.total]), [
    ['Customer not responding / unreachable', 1],       // 201
    ['Customer self-installed / self-assembled', 1],    // 204
    ['Duplicate / already booked job', 1],              // 202
    ['No reason in comment', 1],                        // 203 — the comment is 'na'
  ]);
  // Every name the tab can show is one of the fourteen the MIS engine has.
  assert.equal(out.whyCancelled.themeNames.length, 14);
  for (const t of out.whyCancelled.themes) assert.ok(themes.THEMES.includes(t.name), `${t.name} is a known theme`);
  assert.equal(out.whyCancelled.themes.reduce((a, t) => a + t.total, 0), out.kpis.cancelled);

  // First match wins, in the RULES order rather than the display order: a
  // comment that says both "duplicate" and "reschedule" is a duplicate.
  assert.equal(themes.themeOf('Cancel - :duplicate job, please reschedule later'),
    'Duplicate / already booked job');
  // A comment that is only a phone number, or only filler, has no reason in it.
  assert.equal(themes.themeOf('9876543210'), 'No reason in comment');
  assert.equal(themes.themeOf('please cancel this job'), 'No reason in comment');
  assert.equal(themes.themeOf(null), 'No reason in comment');
  assert.equal(themes.themeOf('the sofa was blue'), 'Other');
});

/* ══ section 8 — city-wise ══════════════════════════════════════════════════ */

test('section 8 · orders created and completed per city, with the modal state beside it', async () => {
  seedWorld();
  const out = await build();
  const city = (name) => out.cities.find((c) => c.city === name);

  // Pune carries Maharashtra on most of its rows and Karnataka on one (104):
  // the state shown is the one MOST of the city's jobs say, not the first seen.
  assert.equal(city('Pune').state, 'Maharashtra');
  assert.equal(city('Mumbai').state, 'Maharashtra');
  assert.equal(city('Pune').completed, 3, '101, 102, 104');
  assert.equal(city('Mumbai').completed, 1, '103');

  // Both columns add back to their KPI tile — a city table that loses a row
  // loses it silently, so this is the check that matters.
  assert.equal(out.cities.reduce((a, c) => a + c.created, 0), out.kpis.ordersCreated);
  assert.equal(out.cities.reduce((a, c) => a + c.completed, 0), out.kpis.completed);
});

test('section 8 · a job with no city is kept under its own label, never dropped', async () => {
  seedWorld();
  seedJobs([{ id: 110, status: 3, client: 10, ticket: '2026-09-10', checkout: '2026-09-11', city: '', state: null }]);
  const out = await build();

  const blank = out.cities.find((c) => c.city === report.BLANK_CITY);
  assert.equal(blank.completed, 1);
  assert.equal(blank.state, null);
  assert.equal(out.cities.reduce((a, c) => a + c.completed, 0), out.kpis.completed);
});

/* ══ sections 9 and 10 — jobs by status and aging ═══════════════════════════ */

test('section 9 · the matrix rows ARE the KPI tiles, and its grand total is jobs in hand', async () => {
  seedWorld();
  const out = await build();
  const row = (s) => out.statusAging.rows.find((r) => r.status === s);

  assert.deepEqual(out.statusAging.rows.map((r) => r.status), ['completed', 'cancelled', 'open']);
  assert.equal(row('completed').total, out.kpis.completed);
  assert.equal(row('cancelled').total, out.kpis.cancelled);
  assert.equal(row('open').total, out.kpis.open);
  assert.equal(out.statusAging.grand, out.kpis.inHand);

  // Both marginals of the matrix agree with its cells — a cell miscounted into
  // the wrong column would still add up down the side, so both are checked.
  assert.equal(out.statusAging.rows.reduce((a, r) => a + r.total, 0), out.statusAging.grand);
  assert.equal(out.statusAging.columnTotals.reduce((a, n) => a + n, 0), out.statusAging.grand);
  out.statusAging.columnTotals.forEach((n, b) => {
    assert.equal(out.statusAging.rows.reduce((a, r) => a + r.counts[b], 0), n);
  });
});

test('section 10 · six days-open bands, DIFFERENT from section 3\'s four, each including its upper bound', async () => {
  seedWorld();
  const out = await build();
  const at = (status, key) => out.statusAging.rows.find((r) => r.status === status)
    .counts[out.statusAging.buckets.findIndex((b) => b.key === key)];

  assert.deepEqual(out.statusAging.buckets.map((b) => b.key), ['0-3', '4-5', '6-9', '10-15', '16-30', '30+']);
  // 101 2 days and 104 3 days both land in 0-3 here, while section 3 puts them
  // in two different bands. That divergence is the point of having both.
  assert.equal(at('completed', '0-3'), 2);
  assert.equal(bucket(out.byDaysOpen.buckets, '0-2').completed, 1);

  assert.equal(at('completed', '6-9'), 1, '102, 7 days');
  assert.equal(at('completed', '16-30'), 1, '103, 16 days — the band includes its lower bound');
  assert.equal(at('cancelled', '0-3'), 1, '201, 0 days');
  assert.equal(at('cancelled', '4-5'), 1, '202, 4 days');
  assert.equal(at('cancelled', '10-15'), 1, '204, 12 days');
  // Open jobs age to NOW, so 302 (raised 10 June) is far past 30 days.
  assert.equal(at('open', '30+'), 1);
  assert.equal(at('open', '6-9'), 1, '301, raised 15 Sep, 7 days ago');
  assert.equal(at('open', '0-3'), 1, '401, raised 20 Sep, 2 days ago');
});

/* ══ section 11 — the job list ══════════════════════════════════════════════ */

test('section 11 · the list behind a cell is exactly that cell, and the default is every open job', async () => {
  seedWorld();
  const all = await report.getMtdJobs({ ...WINDOW, now: NOW });
  assert.equal(all.cell.total, EXPECT.inHand, 'no status and no band is every job in hand');
  assert.equal(all.total, EXPECT.inHand);

  const open = await report.getMtdJobs({ ...WINDOW, now: NOW, status: 'open' });
  assert.equal(open.cell.total, EXPECT.open);
  assert.deepEqual(open.data.map((j) => j.jobId).sort(), [301, 302, 401]);
  assert.ok(open.data.every((j) => j.status === 'open'));

  // One cell of the matrix, checked against the number that cell shows.
  const built = await build();
  const cell = await report.getMtdJobs({ ...WINDOW, now: NOW, status: 'completed', bucket: '0-3' });
  assert.equal(cell.cell.total, built.statusAging.rows[0].counts[0]);
  assert.deepEqual(cell.data.map((j) => j.jobId).sort(), [101, 104]);

  // Days open descending by default, with the job id breaking ties, so a page
  // boundary can never repeat or lose a row.
  const days = open.data.map((j) => j.daysOpen);
  assert.deepEqual(days, [...days].sort((a, b) => b - a));
  assert.ok(open.data.every((j) => typeof j.jobStatus === 'string' && j.jobStatus.length > 0));
});

test('section 11 · the search box narrows the list but not the cell it is inside', async () => {
  seedWorld();
  const out = await report.getMtdJobs({ ...WINDOW, now: NOW, status: 'open', q: '301' });

  assert.equal(out.cell.total, EXPECT.open, 'the cell is still the whole cell');
  assert.equal(out.total, 1, 'one job matches the search');
  assert.deepEqual(out.data.map((j) => j.jobId), [301]);

  // A status substring matches too — the template searches both columns.
  const byStatus = await report.getMtdJobs({ ...WINDOW, now: NOW, status: 'open', q: 'pending to start' });
  assert.deepEqual(byStatus.data.map((j) => j.jobId), [301]);
  const unconfirmed = await report.getMtdJobs({ ...WINDOW, now: NOW, status: 'open', q: 'unconfirmed' });
  assert.deepEqual(unconfirmed.data.map((j) => j.jobId).sort(), [302, 401]);
});

test('section 11 · paging is over the whole cell, and a page past the end is empty', async () => {
  seedWorld();
  const p1 = await report.getMtdJobs({ ...WINDOW, now: NOW, size: 4, page: 1 });
  const p2 = await report.getMtdJobs({ ...WINDOW, now: NOW, size: 4, page: 2 });
  const p9 = await report.getMtdJobs({ ...WINDOW, now: NOW, size: 4, page: 9 });

  assert.equal(p1.total, EXPECT.inHand);
  assert.equal(p1.totalPages, 3);
  assert.equal(p1.data.length, 4);
  assert.equal(p9.data.length, 0, 'a page past the end is an empty page, not a 404');
  // No row is on two pages and none is missing between them.
  const ids = [...p1.data, ...p2.data].map((j) => j.jobId);
  assert.equal(new Set(ids).size, ids.length);
});

/* ══ the filter pickers ═════════════════════════════════════════════════════ */

test('the three pickers narrow every section, and their option counts ignore their own selection', async () => {
  seedWorld();
  const out = await build();

  const ritu = named(out.filters.spocs, 'Ritu Sangwan');
  const acme = named(out.filters.clients, 'Acme Furnishings');
  assert.ok(ritu && acme);
  // A client with no internal Primary SPOC is still an option, under the same
  // label the per-SPOC table beside it uses.
  assert.ok(named(out.filters.spocs, 'Unattributed'), 'client 30 has no SPOC and is not dropped');

  // Eleven jobs in hand, over three clients: 10 → Ritu (5), 20 → Vineet (4),
  // 30 → nobody (2).
  assert.deepEqual(out.filters.spocs.map((s) => [s.name, s.jobs]),
    [['Ritu Sangwan', 5], ['Vineet Jangid', 4], ['Unattributed', 2]]);
  assert.deepEqual(out.filters.clients.map((c) => [c.name, c.jobs]),
    [['Acme Furnishings', 5], ['Crest Retail', 4], ['Bharat Interiors', 2]]);

  const picked = await build({ clientIds: [10] });
  assert.equal(picked.kpis.completed, 2, '101 and 102');
  assert.equal(picked.kpis.cancelled, 2, '201 and 202');
  assert.equal(picked.kpis.open, 1, '301');
  assert.equal(picked.kpis.inHand, 5);
  assert.equal(picked.statusAging.grand, picked.kpis.inHand, 'the sections follow the picker');

  // Counts beside the CLIENT options are taken with the client picker off, so
  // the other two clients still show what ticking them would add rather than
  // the zero they have while unticked.
  assert.deepEqual(picked.filters.clients.map((c) => [c.name, c.jobs]),
    out.filters.clients.map((c) => [c.name, c.jobs]));
  assert.equal(named(picked.filters.clients, 'Acme Furnishings').jobs, acme.jobs);
  // Counts beside the SPOC options DO follow the client picker, because that
  // is a different dimension: only Ritu's jobs are left.
  assert.deepEqual(picked.filters.spocs.map((s) => [s.name, s.jobs]), [['Ritu Sangwan', ritu.jobs]]);

  // An empty pick is not "match nothing" — it is the picker's cleared state.
  const cleared = await build({ clientIds: [] });
  assert.equal(cleared.kpis.inHand, out.kpis.inHand);
  assert.equal(cleared.scope.clientIds, null);
});

/* ══ reconciliation ═════════════════════════════════════════════════════════ */

test('EVERY section that splits a total adds back to it, and the service says so', async () => {
  seedWorld();
  const out = await build();

  // The service's own check, which is what the log and the response carry.
  assert.equal(out.reconciled, true, JSON.stringify(out.checks));
  for (const [name, ok] of Object.entries(out.checks)) assert.equal(ok, true, `check "${name}" failed`);

  // ...and the same identities asserted here independently, so a bug in the
  // service's checks cannot pass itself.
  const k = out.kpis;
  assert.equal(k.completed + k.cancelled + k.open, k.inHand);
  assert.equal(k.completionPct.num + k.cancelledPct.num, k.inHand);
  assert.equal(out.daily.totals.created, k.ordersCreated);
  assert.equal(out.daily.totals.completed, k.completed);
  assert.equal(out.byDaysOpen.buckets.reduce((a, b) => a + b.completed, 0), k.completed);
  assert.equal(out.byDaysOpen.buckets.reduce((a, b) => a + b.cancelled, 0), k.cancelled);
  assert.equal(out.whyCancelled.reasons.reduce((a, r) => a + r.total, 0), k.cancelled);
  assert.equal(out.whyCancelled.themes.reduce((a, t) => a + t.total, 0), k.cancelled);
  assert.equal(out.cities.reduce((a, c) => a + c.created, 0), k.ordersCreated);
  assert.equal(out.cities.reduce((a, c) => a + c.completed, 0), k.completed);
  assert.equal(out.statusAging.grand, k.inHand);
  assert.equal(out.jobCount === undefined ? out.jobs.length : out.jobCount, k.inHand);

  // Positive control: every one of those totals is carrying real work, so the
  // identities above are not passing because both sides happen to be zero.
  assert.ok(k.ordersCreated > 0 && k.completed > 0 && k.cancelled > 0 && k.open > 0);
  assert.ok(out.whyCancelled.reasons.length > 1 && out.whyCancelled.themes.length > 1);
  assert.ok(out.cities.length > 1);
});

/* ══ the route ══════════════════════════════════════════════════════════════ */

test('the endpoints answer the report and the job list, gated by the view key, never cached', async () => {
  seedWorld();
  const qs = `startDate=${WINDOW.from}&endDate=${WINDOW.to}`;

  const res = await fetch(`${base}/report?${qs}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.success, true);
  // Every block the tab needs is on one response.
  for (const key of ['kpis', 'daily', 'completionVsCancellation', 'byDaysOpen',
    'whyCancelled', 'cities', 'statusAging', 'filters', 'reconciled']) {
    assert.ok(body.data[key] !== undefined, `the report carries ${key}`);
  }
  assert.equal(body.data.jobs, undefined, 'the job list is its own endpoint');
  assert.equal(typeof body.data.jobCount, 'number');

  const jobs = await (await fetch(`${base}/jobs?${qs}&status=open`)).json();
  assert.equal(jobs.success, true);
  assert.equal(jobs.data.data.length, EXPECT.open);
  assert.equal(jobs.data.cell.total, EXPECT.open);

  // The two older endpoints still answer exactly what they answered before.
  const table = await (await fetch(`${base}?${qs}`)).json();
  assert.ok(Array.isArray(table.data.data), 'the per-SPOC table is untouched');
  assert.ok(table.data.totals.ticketCreated >= 0);
  const summary = await (await fetch(`${base}/summary?${qs}`)).json();
  assert.equal(summary.data.totals.completed, EXPECT.completed);

  // Without the view key, nothing.
  perms.list = ['ef-QuickSight'];
  assert.equal((await fetch(`${base}/report?${qs}`)).status, 403);
  assert.equal((await fetch(`${base}/jobs?${qs}`)).status, 403);
});

test('the route refuses an impossible window, and accepts a picker either way it is spelt', async () => {
  seedWorld();

  const bad = await fetch(`${base}/report?startDate=2026-02-30&endDate=2026-03-01`);
  assert.equal(bad.status, 400);
  const reversed = await fetch(`${base}/report?startDate=2026-09-22&endDate=2026-09-01`);
  assert.equal(reversed.status, 400);

  // ?clientId=10,20 and ?clientId=10&clientId=20 are the same filter.
  const qs = `startDate=${WINDOW.from}&endDate=${WINDOW.to}`;
  const commas = await (await fetch(`${base}/report?${qs}&clientId=10,20`)).json();
  const repeats = await (await fetch(`${base}/report?${qs}&clientId=10&clientId=20`)).json();
  assert.deepEqual(commas.data.kpis, repeats.data.kpis);
  assert.deepEqual(commas.data.scope.clientIds.sort(), [10, 20]);
  assert.equal(commas.data.kpis.inHand, 9, 'client 30 (jobs 204 and 401) drops out');

  // A CLEARED picker means every option — not the id 0, which is a real
  // selection (the jobs carrying no client at all).
  const cleared = await (await fetch(`${base}/report?${qs}&clientId=&vertical=`)).json();
  assert.equal(cleared.data.scope.clientIds, null);
  assert.equal(cleared.data.scope.verticals, null);
  assert.equal(cleared.data.kpis.inHand, EXPECT.inHand);

  // ...and something that is neither is refused rather than quietly ignored.
  assert.equal((await fetch(`${base}/report?${qs}&clientId=abc`)).status, 400);
  assert.equal((await fetch(`${base}/jobs?${qs}&bucket=7-8`)).status, 400);
  assert.equal((await fetch(`${base}/jobs?${qs}&status=pending`)).status, 400);
});
