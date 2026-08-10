'use strict';

/*
 * The two ROUTE-level halves of the "stuck on Dialling" fix.
 *
 * ─── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * A web-mode ops call failed in a way the server could not see. The operator's
 * BROWSER leg was refused instantly (SIP 486), so Plivo never fetched our
 * answer URL, never dialled the receiver and never sent a single MPC status
 * callback. Two consequences, and this file pins one guard for each:
 *
 *   1. WITHOUT CALLBACKS THE PANEL LIED. The live-state poll read only our own
 *      rows, so every participant sat on "Dialling" through answer and through
 *      hangup, unrecoverably — nothing in the loop ever asked Plivo what was
 *      true. GET /admin/conferences/:id now reconciles against the provider
 *      first. Tested here: that it is actually CALLED on the poll, and that a
 *      provider blip degrades to stale data rather than a 500 — a panel that
 *      cannot answer is worse than one that is a beat behind.
 *
 *   2. THE BROWSER'S OWN FAILURE WAS NEVER RECORDED ANYWHERE. It existed only
 *      in the operator's console. POST /admin/calls/:jobCallerInfoId/web-failed
 *      is the server-side record of it. Tested here: end to end, owner-only,
 *      and idempotent — the FE may report the same failure twice and the second
 *      report must change nothing.
 *
 * ⚠ THE NON-VACUITY GUARD IS COPIED FROM tests/calls-web-start-route.test.js
 * ON PURPOSE. That file's first draft asserted "not a 500", got a 403 from the
 * permission middleware, and went green without the handler body ever running —
 * i.e. it would have passed carrying the very bug it was written for. Every
 * test below therefore asserts it got PAST requireClickToCallAction before
 * asserting anything about what happens after it, and the RBAC fixtures are
 * all three queries getEffectivePermissions makes, not just the last one.
 *
 * Non-destructive: fake pool, stubbed fetch, no network, no DB.
 * Runner: `node --test tests/conference-reconcile-route.test.js`.
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

process.env.PLIVO_AUTH_ID = 'MATEST0000000000TEST';
process.env.PLIVO_AUTH_TOKEN = 'testtoken';
process.env.PLIVO_CALLER_ID = '918041234567';
process.env.PLIVO_CALLBACK_BASE_URL = 'https://core.example.in';
process.env.PLIVO_ANSWER_TOKEN_SECRET = 'conference-reconcile-test-secret';
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret';

const CONF_ID = 88;
const JCI = 5001;
const OPERATOR_ID = 12;
const OTHER_USER_ID = 99;

/* ───────────────────────── mutable fake DB ─────────────────────────────── */

const scenario = {
  user: null,
  actions: [],
  conference: null,
  participants: [],
  // The ONE tbl_job_caller_info row /web-failed reports against. Mutated by the
  // fake pool when the handler's UPDATE fires, so the second report in the
  // idempotency test meets the row the first one actually left behind rather
  // than a fixture reset between them.
  call: null,
};

function freshUser(over = {}) {
  return { user_id: OPERATOR_ID, user_name: 'Ops Tester', user_role: 2, mobile_no: '9867890123', ...over };
}

// job_id null ⇒ an EMPTY roster and no job read, which keeps this file about
// reconciliation and failure reporting. The roster itself is pinned in
// tests/conference-routes.test.js.
function freshConference(over = {}) {
  return {
    id: CONF_ID,
    job_id: null,
    friendly_name: 'efxcrecon0001',
    mpc_uuid: null,
    provider: 'plivo',
    started_by_user_id: OPERATOR_ID,
    job_caller_info_id: JCI,
    status: 'live',
    started_on: '2026-08-07 15:00:00',
    ended_on: null,
    duration: null,
    end_reason: null,
    error: null,
    created_on: '2026-08-07 14:59:50',
    ...over,
  };
}

function freshCallRow(over = {}) {
  return { id: JCI, caller_id: OPERATOR_ID, caller_status: 'initiated', ...over };
}

const props = [
  { property_key: 'plivo.calling.enabled', property_value: 'true' },
  { property_key: 'voice.call.mode', property_value: 'web' },
];

const fake = installFakePool([
  [/FROM easyfix_properties/i, () => props],

  // ── RBAC resolves through the REAL services/role.service: THREE queries ──
  [/SELECT user_role FROM tbl_user/i, () => [{ user_role: scenario.user ? scenario.user.user_role : 2 }]],
  [/FROM tbl_role/i, () => [{ role_id: 2, role_name: 'Admin', role_status: 1, menu_ids: '1,2,3' }]],
  [/FROM role_menu_action/i, () => scenario.actions.map((a) => ({ action_name: a }))],

  // The conference-column probe in plivo-call-log.service. Present ⇒ post-migration.
  [/information_schema\.columns/i, () => [{ 1: 1 }]],

  // ── the conference + its legs ──
  [/FROM tbl_job_conference WHERE id = \?/i, () => (scenario.conference ? [scenario.conference] : [])],
  [/FROM tbl_plivo_call_log WHERE conference_id = \? ORDER BY/i, () => scenario.participants],

  // ── the call audit row /web-failed reports against ──
  [/FROM tbl_job_caller_info/i, () => (scenario.call ? [scenario.call] : [])],
  [/UPDATE tbl_job_caller_info/i, (sql) => {
    // Model what the guarded UPDATE really does, so the idempotency assertion
    // below is about the handler's behaviour and not about a fixture.
    if (scenario.call && /'failed'/.test(sql)) scenario.call.caller_status = 'failed';
    return { affectedRows: 1 };
  }],

  [/^UPDATE /i, () => ({ affectedRows: 1 })],
]);

/* ───────────────────────── app under test ──────────────────────────────── */

const express = require('express');
const properties = require('../services/properties.service');
const { invalidatePermissionsCache } = require('../services/role.service');
const conference = require('../services/plivo-conference.service');
const conferencesRouter = require('../routes/admin/conferences');
const callsRouter = require('../routes/admin/calls');

let server;
let baseUrl;
const realFetch = globalThis.fetch;

// Whatever GROUP A's reconcileParticipants does against Plivo, this file is
// about the WIRING: that the poll calls it, and that its failure is survivable.
// So it is stubbed per-test on the shared service object — the same object the
// router resolves the property from at call time.
const originalReconcile = conference.reconcileParticipants;
let reconcileCalls = [];
let reconcileImpl = null;

before(async () => {
  await properties.preload();

  conference.reconcileParticipants = async (conferenceId, pool) => {
    reconcileCalls.push({ conferenceId, gotPool: !!pool });
    if (reconcileImpl) return reconcileImpl(conferenceId, pool);
    return { ok: true, changed: false };
  };

  const app = express();
  app.use(express.json());
  // Stand-in for routes/admin/index.js — requireAuth / role / maskMobile are
  // that router's job, not these routers'.
  app.use((req, _res, next) => { req.user = { ...scenario.user }; next(); });
  app.use('/conferences', conferencesRouter);
  app.use('/calls', callsRouter);
  // Surfaces a thrown error as a 500 carrying its message, which is the shape
  // a scope/runtime slip takes in production.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(500).json({ success: false, error: String(err && err.message) }); });

  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Installed only after the app is listening: node's fetch serves both the
  // test client and the provider client, so the stub has to discriminate.
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(baseUrl)) return realFetch(url, init);
    return { status: 200, async text() { return '{}'; } };
  };
});

after(() => {
  globalThis.fetch = realFetch;
  if (originalReconcile === undefined) delete conference.reconcileParticipants;
  else conference.reconcileParticipants = originalReconcile;
  if (server) server.close();
  fake.restore();
});

beforeEach(() => {
  fake.reset();
  invalidatePermissionsCache();
  reconcileCalls = [];
  reconcileImpl = null;
  scenario.user = freshUser();
  scenario.actions = ['isClickToCall'];   // the SAME key that gates calling
  scenario.conference = freshConference();
  scenario.participants = [];
  scenario.call = freshCallRow();
});

/* ──────────────────────────── helpers ──────────────────────────────────── */

async function req(method, path, body) {
  const init = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await realFetch(`${baseUrl}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}
const post = (path, body) => req('POST', path, body);
const get = (path) => req('GET', path);

// Every test asserts this BEFORE anything else — see the header.
function assertReachedHandler(res, what) {
  assert.notEqual(res.status, 403,
    `${what}: the permission fixture is wrong — this test never reached the handler body`);
}

const legTerminalUpdates = () => fake.calls.filter(
  (c) => /UPDATE tbl_plivo_call_log/i.test(c.sql) && Array.isArray(c.params) && c.params.includes('failed'));
const auditFailedUpdates = () => fake.calls.filter(
  (c) => /UPDATE tbl_job_caller_info/i.test(c.sql) && /'failed'/.test(c.sql));

/* ═════════════ 1. THE POLL RECONCILES AGAINST THE PROVIDER ══════════════ */

test('the live-state poll reconciles against Plivo before it answers', async () => {
  const res = await get(`/conferences/${CONF_ID}`);

  assertReachedHandler(res, 'GET /conferences/:id');
  assert.equal(res.status, 200);
  assert.equal(reconcileCalls.length, 1, 'the poll must ask the provider, not just our own rows');
  assert.equal(reconcileCalls[0].conferenceId, CONF_ID);
  assert.equal(reconcileCalls[0].gotPool, true, 'the pool is passed, per the service contract');
});

test('a reconcile that MOVED something is re-read, so the poll answers with the new state', async () => {
  reconcileImpl = async () => {
    // Whatever it changed, it changed in the database — so the response must
    // come from a fresh read, not from the rows loaded before it ran.
    scenario.participants = [{
      id: 9101,
      conference_id: CONF_ID,
      target_kind: 'customer',
      target_id: null,
      display_name: 'Test Customer',
      number_prefix: '9812',
      status: 'answered',
      hangup_cause: null,
      added_by_user_id: OPERATOR_ID,
      joined_at: '2026-08-07 15:00:20',
      left_at: null,
      duration: null,
      created_on: '2026-08-07 15:00:05',
    }];
    return { ok: true, changed: true };
  };

  const res = await get(`/conferences/${CONF_ID}`);

  assertReachedHandler(res, 'GET /conferences/:id');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.participants.length, 1,
    'changed:true must trigger a re-read — otherwise the fix is one poll behind, forever');
  assert.equal(res.body.data.participants[0].status, 'answered',
    'the participant is no longer stuck on Dialling, which is the entire bug');
});

test('a provider blip degrades to stale DB state — it can never 500 the poll', async () => {
  reconcileImpl = async () => { throw new Error('plivo unreachable'); };

  const res = await get(`/conferences/${CONF_ID}`);

  assertReachedHandler(res, 'GET /conferences/:id');
  assert.equal(res.status, 200, 'a panel that cannot answer is worse than one a beat behind');
  assert.equal(res.body.success, true);
  assert.ok(res.body.data.conference, 'the DB state is still served');
});

test('a caller who may not read the conference never spends a provider round-trip', async () => {
  scenario.user = freshUser({ user_id: OTHER_USER_ID, user_role: 3 }); // not the starter, not Admin

  const res = await get(`/conferences/${CONF_ID}`);

  assert.equal(res.status, 403);
  assert.equal(reconcileCalls.length, 0, 'reconcile runs AFTER authZ, never before');
});

/* ═══════════ 2. POST /:jobCallerInfoId/web-failed — end to end ══════════ */

test('web-failed runs end to end and marks BOTH rows terminal with the reason', async () => {
  const res = await post(`/calls/${JCI}/web-failed`, { reason: 'SIP 486 Busy — browser leg refused' });

  assertReachedHandler(res, 'POST /calls/:jobCallerInfoId/web-failed');
  assert.notEqual(res.status, 500, `web-failed 500'd: ${res.body && res.body.error}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.jobCallerInfoId, JCI);
  assert.equal(res.body.data.recorded, true);
  assert.equal(res.body.data.alreadyTerminal, false);

  assert.equal(auditFailedUpdates().length, 1, 'the audit row stops sitting on initiated forever');
  const leg = legTerminalUpdates();
  assert.equal(leg.length, 1, 'the call-log leg is marked terminal through the existing service helper');
  assert.ok(leg[0].params.includes('SIP 486 Busy — browser leg refused'),
    'the browser\'s own diagnostic is what lands in hangup_cause — that is the whole point');
});

test('reporting the SAME failure twice is idempotent — the second report writes nothing', async () => {
  const first = await post(`/calls/${JCI}/web-failed`, { reason: 'SIP 486 Busy' });
  assertReachedHandler(first, 'POST /calls/:jobCallerInfoId/web-failed');
  assert.equal(first.status, 200);
  assert.equal(first.body.data.alreadyTerminal, false);

  // The row is now 'failed' (the fake pool applied the handler's own UPDATE),
  // exactly as it would be when a re-mounted panel reports the same failure.
  const second = await post(`/calls/${JCI}/web-failed`, { reason: 'SIP 486 Busy' });
  assert.equal(second.status, 200, 'a duplicate report is a clean 200, never a 500');
  assert.equal(second.body.data.recorded, true);
  assert.equal(second.body.data.alreadyTerminal, true, 'and it says it changed nothing');

  assert.equal(auditFailedUpdates().length, 1, 'the audit row is written once, not twice');
  assert.equal(legTerminalUpdates().length, 1, 'and so is the leg — no double stamp, no corruption');
});

test('only the operator who STARTED the leg may report it — an Admin may not', async () => {
  // Deliberately an Admin (role_id 2), which /:id/hangup would allow. A failure
  // report is a first-person account of one browser; an Admin has none.
  scenario.user = freshUser({ user_id: OTHER_USER_ID, user_role: 2 });

  const res = await post(`/calls/${JCI}/web-failed`, { reason: 'SIP 486 Busy' });

  assert.equal(res.status, 403);
  assert.equal(auditFailedUpdates().length, 0, 'a refused report must not write');
  assert.equal(legTerminalUpdates().length, 0);
});

test('no calling permission at all cannot report a failure either', async () => {
  scenario.actions = [];

  const res = await post(`/calls/${JCI}/web-failed`, { reason: 'SIP 486 Busy' });

  assert.equal(res.status, 403, 'the same gate as every other route in this file');
  assert.equal(auditFailedUpdates().length, 0);
});

test('a missing or oversized reason is refused by the validator, not the handler', async () => {
  const empty = await post(`/calls/${JCI}/web-failed`, {});
  assertReachedHandler(empty, 'POST /calls/:jobCallerInfoId/web-failed (empty body)');
  assert.equal(empty.status, 400, 'a failure report with no reason records nothing worth having');

  const huge = await post(`/calls/${JCI}/web-failed`, { reason: 'x'.repeat(121) });
  assert.equal(huge.status, 400, '120 chars is the bound — an audit column is not a stack-trace sink');

  assert.equal(auditFailedUpdates().length, 0);
});

test('an unknown call is a 404 and a bad id a 400 — neither reaches a write', async () => {
  scenario.call = null;
  const missing = await post(`/calls/${JCI}/web-failed`, { reason: 'SIP 486 Busy' });
  assertReachedHandler(missing, 'POST /calls/:jobCallerInfoId/web-failed (missing row)');
  assert.equal(missing.status, 404);

  for (const bad of ['0', '-1', 'abc']) {
    const res = await post(`/calls/${bad}/web-failed`, { reason: 'SIP 486 Busy' });
    assert.equal(res.status, 400, `"${bad}" must not reach a query`);
  }

  assert.equal(auditFailedUpdates().length, 0);
  assert.equal(legTerminalUpdates().length, 0);
});
