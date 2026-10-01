/*
 * Integration test — /api/shared/lookup/menus visibility filter.
 *
 * Runs against the pure helper `applyMenuFilter` exported via the
 * `_test` namespace on services/lookup.service.js. We deliberately do NOT
 * boot the HTTP layer or hit MySQL here — the SQL projection is a black-box
 * SELECT we trust; what changes per env is the post-query filter, and that
 * is what this suite locks down.
 *
 * Runner: Node's built-in `node --test` (no external dependency). Run via
 *   npm run test:menus
 *
 * Asserted contracts:
 *   1. Unset NEW_CRM_VISIBLE_MENU_IDS  →  every row passes through.
 *   2. Empty/whitespace-only value     →  treated as unset, no filter.
 *   3. Allowlist populated             →  only listed ids returned, all
 *                                          others are absent from the result.
 *   4. Allowlist + matching override   →  override email bypasses the filter
 *                                          regardless of allowlist contents.
 *   5. Allowlist + non-match email     →  filter still applies for non-allow
 *                                          users.
 *   6. Case-insensitive email match    →  override list lookup tolerates
 *                                          casing differences.
 *   7. Junk values in the env (alpha,  →  silently dropped from the parsed
 *      negatives, decimals)               set; remaining good ids still work.
 *   8. GET /menus (route handler)      →  Employee Hub → Approvals
 *                                          (url 'employeeLeaveApprovals') only
 *                                          for a caller with an ACTIVE direct
 *                                          report (owner, 2026-10-01).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// Fixtures for the route-level case (8). The direct-report fake answers the
// real SQL: it honours `reporting_manager = ?` and, only while the clause is
// written, `user_status = 1` — so dropping either is caught.
const MENU_ROWS = [
  { menu_id: 90, menu_name: 'Employee Hub', parent_menu: 0, url: 'javascript:;', menu_status: 1 },
  { menu_id: 91, menu_name: 'Attendance & Leaves', parent_menu: 90, url: 'employeeLeave', menu_status: 1 },
  { menu_id: 92, menu_name: 'Approvals', parent_menu: 90, url: 'employeeLeaveApprovals', menu_status: 1 },
];
const STAFF = [
  { user_id: 11, reporting_manager: 10, user_status: 1 }, // 10 has an active report
  { user_id: 13, reporting_manager: 12, user_status: 0 }, // 12's only report is inactive
];
const fake = installFakePool([
  [/FROM tbl_menu/, MENU_ROWS],
  [/FROM tbl_user WHERE reporting_manager = \?/, (sql, [mgr]) => STAFF.filter((u) => u.reporting_manager === mgr
    && (!/user_status = 1/.test(sql) || u.user_status === 1)).map(() => ({ 1: 1 }))],
  [/.*/, []],
]);
after(() => fake.restore());

// Snapshot the env keys we mutate so each test can save / restore cleanly.
const ENV_KEYS = ['NEW_CRM_VISIBLE_MENU_IDS', 'NEW_CRM_MENU_OVERRIDE_EMAILS'];
function snapshotEnv() {
  return ENV_KEYS.reduce((o, k) => ({ ...o, [k]: process.env[k] }), {});
}
function restoreEnv(snap) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

// The service module logs at module-load time. Squelch that one log so test
// output stays clean — we restore stdout after the require completes.
const origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
const { _test } = require('../services/lookup.service');
// eslint-disable-next-line global-require
const lookupRouter = require('../routes/shared/lookup');
process.stdout.write = origStdoutWrite;

const { applyMenuFilter } = _test;

// Fixture mirroring the real tbl_menu shape the route returns. The id set
// matches the production menu_id space the user shared on 2026-06-02.
const FIXTURE = [
  { menu_id: 1,  menu_name: 'Home',              parent_menu: 0,  url: 'home',     menu_status: 1 },
  { menu_id: 2,  menu_name: 'Jobs',              parent_menu: 0,  url: 'javascript:;', menu_status: 1 },
  { menu_id: 3,  menu_name: 'Manage Jobs',       parent_menu: 2,  url: 'job',      menu_status: 1 },
  { menu_id: 21, menu_name: 'Report',            parent_menu: 0,  url: 'javascript:;', menu_status: 1 },
  { menu_id: 22, menu_name: 'Complete Jobs',     parent_menu: 21, url: 'completedJobsReport', menu_status: 1 },
  { menu_id: 47, menu_name: 'My Orders',         parent_menu: 0,  url: 'javascript:;', menu_status: 1 },
  { menu_id: 48, menu_name: 'Unconfirmed',       parent_menu: 47, url: 'dashboardChecking?enumDesc=UnConfirmed', menu_status: 1 },
];

test('unset NEW_CRM_VISIBLE_MENU_IDS → all rows pass through', (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  delete process.env.NEW_CRM_VISIBLE_MENU_IDS;
  delete process.env.NEW_CRM_MENU_OVERRIDE_EMAILS;

  const out = applyMenuFilter(FIXTURE, { userEmail: 'anyone@example.com' });
  assert.equal(out.length, FIXTURE.length);
  assert.deepEqual(out.map((r) => r.menu_id).sort((a, b) => a - b), [1, 2, 3, 21, 22, 47, 48]);
});

test('empty / whitespace-only NEW_CRM_VISIBLE_MENU_IDS → treated as unset', (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  process.env.NEW_CRM_VISIBLE_MENU_IDS = '   ';
  delete process.env.NEW_CRM_MENU_OVERRIDE_EMAILS;

  const out = applyMenuFilter(FIXTURE);
  assert.equal(out.length, FIXTURE.length, 'whitespace value must not engage the filter');
});

test('allowlist populated → only listed ids returned, hidden ones absent', (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  process.env.NEW_CRM_VISIBLE_MENU_IDS = '1,2,3,47,48';
  delete process.env.NEW_CRM_MENU_OVERRIDE_EMAILS;

  const out = applyMenuFilter(FIXTURE, { userEmail: 'somebody@channelplay.in' });
  const ids = out.map((r) => r.menu_id).sort((a, b) => a - b);
  assert.deepEqual(ids, [1, 2, 3, 47, 48], 'visible set must match allowlist exactly');

  // Hidden ids MUST NOT appear in the response (this is the core assertion).
  for (const hiddenId of [21, 22]) {
    assert.equal(
      out.some((r) => r.menu_id === hiddenId), false,
      `hidden menu_id ${hiddenId} leaked into response`,
    );
  }
});

test('allowlist + matching override email → user sees every row', (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  process.env.NEW_CRM_VISIBLE_MENU_IDS = '1,2,3';                       // very strict
  process.env.NEW_CRM_MENU_OVERRIDE_EMAILS = 'qa@channelplay.in,super@example.com';

  const out = applyMenuFilter(FIXTURE, { userEmail: 'super@example.com' });
  assert.equal(out.length, FIXTURE.length, 'override email must bypass the allowlist entirely');
});

test('allowlist + email NOT in override → filter still applies', (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  process.env.NEW_CRM_VISIBLE_MENU_IDS = '1,2';
  process.env.NEW_CRM_MENU_OVERRIDE_EMAILS = 'qa@channelplay.in';

  const out = applyMenuFilter(FIXTURE, { userEmail: 'random.user@channelplay.in' });
  assert.deepEqual(out.map((r) => r.menu_id).sort((a, b) => a - b), [1, 2]);
});

test('email match is case-insensitive', (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  process.env.NEW_CRM_VISIBLE_MENU_IDS = '1';
  process.env.NEW_CRM_MENU_OVERRIDE_EMAILS = 'QA@Channelplay.IN';

  const out = applyMenuFilter(FIXTURE, { userEmail: 'qa@channelplay.in' });
  assert.equal(out.length, FIXTURE.length, 'override email match must ignore case');
});

test('junk values in env (alpha / negative / decimal) are silently dropped', (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  process.env.NEW_CRM_VISIBLE_MENU_IDS = '1, abc, -5, 2.5, 2, , 3';
  delete process.env.NEW_CRM_MENU_OVERRIDE_EMAILS;

  const out = applyMenuFilter(FIXTURE, { userEmail: 'someone@example.com' });
  // Only positive integers 1, 2, 3 survive parsing. 2.5 → Number('2.5')=2.5
  // → !Number.isInteger → dropped. -5 → dropped (> 0 filter). 'abc' → NaN
  // → dropped. Empty entry → dropped.
  assert.deepEqual(out.map((r) => r.menu_id).sort((a, b) => a - b), [1, 2, 3]);
});

test('userEmail omitted → filter still applies (no implicit bypass)', (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  process.env.NEW_CRM_VISIBLE_MENU_IDS = '1,2';
  process.env.NEW_CRM_MENU_OVERRIDE_EMAILS = 'anyone@example.com';

  // No userEmail passed (anonymous-shaped call) — must NOT match the override
  // list. Filter must still narrow the response.
  const out = applyMenuFilter(FIXTURE, {});
  assert.deepEqual(out.map((r) => r.menu_id).sort((a, b) => a - b), [1, 2]);
});

// ─── 8. GET /menus — Approvals needs an active direct report ─────────
/** Run the real GET /menus handler off router.stack (house pattern — keeps requireAuth out). */
async function getMenus(user) {
  const layer = lookupRouter.stack.find((l) => l.route && l.route.path === '/menus' && l.route.methods.get);
  assert.ok(layer, 'GET /menus must be registered');
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  let failure = null;
  await layer.route.stack.at(-1).handle({ method: 'GET', query: {}, user }, res, (e) => { failure = e; });
  if (failure) throw failure;
  return res.body.data.map((m) => m.url);
}

test('menus: Approvals is kept for a caller with an active direct report', async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  delete process.env.NEW_CRM_VISIBLE_MENU_IDS;
  fake.calls.length = 0;
  assert.deepEqual(await getMenus({ user_id: 10, official_email: 'rh@easyfix.in' }), ['javascript:;', 'employeeLeave', 'employeeLeaveApprovals']);
  const q = fake.calls.find((c) => /reporting_manager = \?/.test(c.sql));
  assert.deepEqual(q.params, [10], 'asked about the CALLER');
});

test('menus: Approvals is dropped — and only it — with no direct report, or only an inactive one', async (t) => {
  const snap = snapshotEnv();
  t.after(() => restoreEnv(snap));
  delete process.env.NEW_CRM_VISIBLE_MENU_IDS;
  for (const userId of [14, 12, 11]) {
    assert.deepEqual(await getMenus({ user_id: userId, official_email: 'x@easyfix.in' }), ['javascript:;', 'employeeLeave'], `user ${userId}`);
  }
});

test('hasDirectReports: a non-numeric principal id (technician efr:…) is never a manager — no query, no NaN SQL', async () => {
  const { hasDirectReports } = require('../services/lookup.service');
  fake.calls.length = 0;
  assert.equal(await hasDirectReports('efr:123'), false);
  assert.equal(await hasDirectReports(undefined), false);
  assert.equal(fake.calls.length, 0);
  await hasDirectReports(1);
  const q = fake.calls.find((c) => /reporting_manager = \?/.test(c.sql));
  assert.match(q.sql, /user_type_id = 5/, 'same population as the Approvals list (findDescendantUserIds)');
});
