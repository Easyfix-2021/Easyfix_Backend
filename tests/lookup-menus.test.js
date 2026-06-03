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
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

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
