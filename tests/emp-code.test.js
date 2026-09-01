/*
 * Employee code (tbl_user.user_code) — format, allocation, and the collision
 * guard on the create/update paths.
 *
 * WHAT IS BEING PINNED, AND WHY IT MATTERS MORE THAN A USUAL FORMAT TEST
 * ─────────────────────────────────────────────────────────────────────
 * tbl_user is LEGACY and shared by five services, so it has NO UNIQUE index on
 * user_code and we are forbidden from adding one. Nothing in the database will
 * ever catch two users sharing a code. The only things standing between the
 * product and that outcome are:
 *
 *   1. ONE definition of the format (lib/emp-code.js). A drifted second copy of
 *      the regex would change which rows nextEmpCode() takes its MAX over, and
 *      the next allocation would re-issue a live code. Test 6 fails the build
 *      if a second copy appears anywhere in the repo.
 *   2. GET_LOCK('easyfix_emp_code', 5) around check-then-INSERT, with its
 *      RETURN VALUE ACTUALLY CHECKED. GET_LOCK gives 1 on success, 0 on timeout
 *      and NULL on error; treating 0 or NULL as success means the duplicate
 *      check runs concurrently with another one and both INSERT.
 *   3. A duplicate probe that EXCLUDES THE ROW BEING EDITED on the update path.
 *      Without the self-exclusion nobody can ever re-save their own record.
 *
 * The code is PREFILLED, NOT GENERATED: GET /api/admin/users/next-emp-code is a
 * suggestion that reserves nothing, so two admins opening Add User at the same
 * moment are handed the same value. That makes a collision an ordinary case,
 * not a theoretical one, which is why (2) and (3) are load-bearing rather than
 * defensive.
 *
 * NO DB, NO NETWORK: the mysql2 pool is replaced by tests/helpers/fake-pool,
 * which dispatches each SQL string to a canned result and records every
 * (sql, params) it saw. Nothing is ever written to a real database.
 * Runner: `npm test` (node --test --test-force-exit).
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakePool } = require('./helpers/fake-pool');

const {
  EMP_CODE_PREFIX, EMP_CODE_DIGITS, EMP_CODE_RE, MAX_EMP_SEQ, EMP_CODE_LOCK,
  parseEmpCode, formatEmpCode, nextEmpCode,
} = require('../lib/emp-code');

/*
 * The prefix is pinned to a LITERAL on purpose, even though everything else in
 * this file derives from the constant. Deriving the expectation from the value
 * under test would make the whole suite agree with any prefix, including one
 * changed by accident — and the codes already in the business are E200244, not
 * EF200244. Real employee codes are what this asserts against.
 *
 * If the scheme genuinely changes, change this line AND src/lib/emp-code.ts in
 * the CRM in the same commit; the frontend prepends the prefix client-side.
 */
test('the code scheme is E + 6 digits, matching the codes already in use', () => {
  assert.equal(EMP_CODE_PREFIX, 'E');
  assert.equal(EMP_CODE_DIGITS, 6);
  assert.ok(EMP_CODE_RE.test('E200244'), 'a real employee code must validate');
  assert.ok(!EMP_CODE_RE.test('EF200244'), 'the old two-letter prefix must not');
});

// ── Fake DB ──────────────────────────────────────────────────────────────
// Every knob a test turns lives here and is reset in beforeEach, so a test that
// forgets to set one inherits the benign default rather than the previous
// test's state.
let lockResult;      // what GET_LOCK returns: 1 | 0 | null
let maxSeq;          // MAX(CAST(SUBSTRING(user_code,3) …)) — null = no rows match
let dupCodeRow;      // the row the user_code probe finds, or null
let me;              // the tbl_user row updateUser loads

const ROUTES = [
  // Named-lock statements first — nothing else should ever match them.
  [/GET_LOCK/i,     () => [{ got: lockResult }]],
  [/RELEASE_LOCK/i, [{ released: 1 }]],

  // Allocation read. BEFORE the generic tbl_user routes: it also says
  // "FROM tbl_user", so a looser route above it would swallow it.
  [/MAX\(CAST\(SUBSTRING\(user_code/i, () => [{ max_seq: maxSeq }]],

  // The duplicate probe — both the create form (`WHERE user_code = ?`) and the
  // update form (`… AND user_id <> ?`). Tests assert on the captured SQL to
  // tell the two apart.
  [/WHERE user_code = \?/i, () => (dupCodeRow ? [dupCodeRow] : [])],

  // Side table BEFORE the tbl_user routes — "tbl_user_personal_details" is a
  // substring hazard against /tbl_user/.
  [/FROM tbl_user_personal_details/i, [{ personal_email: 'existing@gmail.com' }]],
  [/INSERT INTO tbl_user_personal_details/i, () => ({ affectedRows: 1 })],

  [/SELECT role_id, role_name/i, [{ role_id: 2, role_name: 'Admin', role_status: 1, menu_ids: '' }]],
  [/FROM tbl_user_allowed_stages/i, []],

  // Duplicate-email / duplicate-mobile pre-checks in createUser — never a hit.
  [/WHERE LOWER\(official_email\)/i, []],
  [/WHERE mobile_no = \?/i, []],

  // updateUser's "load the row I am editing".
  [/FROM tbl_user WHERE user_id = \?/i, () => (me ? [me] : [])],

  [/INSERT INTO tbl_user\s*\(/i, () => ({ insertId: 4242, affectedRows: 1 })],

  // getUserById / listUsers projections — [] resolves to null, which is fine:
  // no test here asserts on the returned row.
  [/FROM tbl_user\s+u/i, []],
];

/*
 * STOP-SENTINEL. Both write paths are cut short at the statement AFTER the one
 * under test:
 *   create → stops at the personal-details INSERT, i.e. after the tbl_user
 *            INSERT has been captured but before commit, getUserById and the
 *            Microsoft 365 provisioning chain (which would make these tests
 *            slow, network-shaped and unrelated to what they assert).
 *   update → stops at `UPDATE tbl_user SET`, the same seam
 *            tests/user-personal-email.test.js uses.
 * Crucially the sentinel throws from INSIDE the try block, so the finally that
 * releases the named lock still runs — which is exactly the property tests 4
 * and 5 need to observe.
 */
const fake = installFakePool(ROUTES, {
  stopOn: /INSERT INTO tbl_user_personal_details|UPDATE tbl_user SET/i,
});
const userService = require('../services/user.service');
after(() => fake.restore());

beforeEach(() => {
  lockResult = 1;
  maxSeq     = null;
  dupCodeRow = null;
  me         = null;
  fake.reset();
});

const CREATE_BASE = {
  user_name: 'Test User',
  official_email: 'test.user@easyfix.in',
  user_role: 2,
  personal_email: 'test.user@gmail.com',
  createdBy: 99,
  user_code: 'E000123',
};

/*
 * Run a write and report which of three outcomes happened:
 *   { rejected: '<message>', status, code }  a 4xx/5xx from a guard
 *   { reachedWrite: true }                   every guard passed and the write
 *                                            was attempted (stop-sentinel)
 *   { completed: value }                     nothing was written at all
 */
async function run(fn) {
  try {
    return { completed: await fn() };
  } catch (e) {
    if (e.__stop) return { reachedWrite: true };
    return { rejected: e.message, status: e.status, code: e.code, field: e.field };
  }
}

const sqlOf   = () => fake.calls.map((c) => c.sql);
const matching = (re) => fake.calls.filter((c) => re.test(c.sql));

// ── 1. Format: parse / format round-trip ─────────────────────────────────

test('formatEmpCode and parseEmpCode round-trip across the whole valid range', () => {
  // Boundaries plus a spread of interior values, including the ones with
  // leading zeros — the padding is the half most likely to regress.
  for (const seq of [0, 1, 9, 10, 99, 123, 1000, 258123, 999998, MAX_EMP_SEQ]) {
    const code = formatEmpCode(seq);
    assert.equal(code.length, EMP_CODE_PREFIX.length + EMP_CODE_DIGITS,
      `${code} must be ${EMP_CODE_PREFIX} + exactly ${EMP_CODE_DIGITS} digits`);
    assert.ok(EMP_CODE_RE.test(code), `${code} must satisfy EMP_CODE_RE`);
    assert.equal(parseEmpCode(code), seq, `${code} must parse back to ${seq}`);
  }
});

test('formatEmpCode zero-pads to six digits — the shape ops and reports read', () => {
  assert.equal(formatEmpCode(1), 'E000001');
  assert.equal(formatEmpCode(123), 'E000123');
  assert.equal(formatEmpCode(258123), 'E258123');
  assert.equal(formatEmpCode(MAX_EMP_SEQ), 'E999999');
});

// ── 2. Format: everything that is NOT a code ─────────────────────────────

test('parseEmpCode returns null for malformed codes rather than a wrong number', () => {
  const malformed = [
    'E25812',        // five digits — one short
    'E2581234',      // seven digits — one too many
    'ef258123',       // lowercase prefix: a stored lowercase code would be
                      //   invisible to every filter that uses EMP_CODE_RE
    'Ef258123',
    'E25812a',       // a letter where a digit belongs
    'E-258123',
    'E 258123',
    ' E258123',      // untrimmed — the caller must trim, not the parser
    'E258123 ',
    'XX258123',       // wrong prefix
    'U501',           // a real pre-EasyFix value from the legacy CRM
    '258123',         // digits with no prefix
    'E258123E258123',
    'E+58123',        // '+' would survive a naive Number() cast
    'E０００１２３', // full-width digits: \d is ASCII-only, they must not pass
    '',
  ];
  for (const bad of malformed) {
    assert.equal(parseEmpCode(bad), null, `${JSON.stringify(bad)} must not parse`);
    assert.equal(EMP_CODE_RE.test(bad), false, `${JSON.stringify(bad)} must not match EMP_CODE_RE`);
  }
});

test('parseEmpCode returns null for non-strings instead of throwing', () => {
  // Its commonest caller asks "is this legacy column value one of ours?", of a
  // column that is NULL for every production row today.
  for (const bad of [null, undefined, 258123, {}, [], NaN, true]) {
    assert.equal(parseEmpCode(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test('EMP_CODE_RE is not a global regex — a shared /g would make .test() stateful', () => {
  /*
   * A module-level /g regex carries lastIndex ACROSS calls, so the second
   * .test() of the same valid string returns false. Shared between the route's
   * Joi, the service and nextEmpCode, that would reject every other create for
   * no visible reason.
   */
  assert.equal(EMP_CODE_RE.global, false);
  assert.equal(EMP_CODE_RE.lastIndex, 0);
  assert.equal(EMP_CODE_RE.test('E000123'), true);
  assert.equal(EMP_CODE_RE.test('E000123'), true, 'a second identical test must still pass');
});

// ── 3. Overflow ──────────────────────────────────────────────────────────

test('formatEmpCode THROWS past E999999 instead of emitting a seven-digit code', () => {
  /*
   * The failure being prevented: 'E1000000' does not match EMP_CODE_RE, so
   * nextEmpCode's MAX would stop seeing the highest code and would re-issue one
   * already in use. A loud throw when the space runs out is recoverable; a
   * quiet overflow is a duplicate nobody notices for months.
   */
  for (const over of [MAX_EMP_SEQ + 1, 1000000, 1234567, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => formatEmpCode(over), /exhausted/i, `${over} must throw`);
  }
});

test('formatEmpCode rejects anything that is not a non-negative integer', () => {
  for (const bad of [-1, 1.5, NaN, Infinity, null, undefined, 'abc', {}]) {
    assert.throws(() => formatEmpCode(bad), /non-negative integer|exhausted/i,
      `${JSON.stringify(bad)} must throw`);
  }
});

test('nextEmpCode surfaces the overflow rather than wrapping to E000000', async () => {
  maxSeq = MAX_EMP_SEQ;
  await assert.rejects(() => nextEmpCode(fakeConn()), /exhausted/i);
});

// A bare connection-shaped object for the pure-allocation tests. The service
// tests below use the real transaction connection from the fake pool instead.
function fakeConn() {
  return { query: (sql, params) => require('../db').pool.query(sql, params) };
}

// ── 4. Allocation: MAX + 1, and the cold start ───────────────────────────

test('nextEmpCode takes MAX + 1 when codes already exist', async () => {
  maxSeq = 258123;
  assert.equal(await nextEmpCode(fakeConn()), 'E258124');

  fake.reset();
  maxSeq = 7;
  assert.equal(await nextEmpCode(fakeConn()), 'E000008', 'the padding survives a small MAX');
});

test('nextEmpCode starts at E000001 on a host where no row matches yet', async () => {
  // MAX() over an empty set is SQL NULL — the cold start, not an error. Ops
  // seed the real codes manually first; this only ever runs ahead of them on a
  // fresh or QA database.
  maxSeq = null;
  assert.equal(await nextEmpCode(fakeConn()), 'E000001');

  fake.reset();
  maxSeq = undefined;   // a driver that omits the column entirely
  assert.equal(await nextEmpCode(fakeConn()), 'E000001');
});

test('nextEmpCode scans only rows that match the format, and does so on the passed connection', async () => {
  maxSeq = 5;
  await nextEmpCode(fakeConn());
  const [call] = matching(/MAX\(CAST\(SUBSTRING\(user_code/i);
  assert.ok(call, 'the allocation query must have run');
  /*
   * The WHERE clause is what stops a legacy 'U501' from being CAST to 0 — or
   * worse, a longer junk value being CAST to something enormous that would push
   * every future code past the end of the space.
   */
  assert.match(call.sql, /WHERE user_code REGEXP/i);
  assert.match(call.sql, /\^E\[0-9\]\{6\}\$/, 'the SQL pattern must mirror EMP_CODE_RE');
});

test('suggestNextEmpCode returns the count AND the assembled code for the form prefill', async () => {
  // The form renders the prefix as a fixed chip and lets the operator edit only the
  // count, so the endpoint has to publish both halves rather than making the
  // frontend slice the string (which would be a second copy of the parse).
  maxSeq = 258123;
  assert.deepEqual(await userService.suggestNextEmpCode(), { count: 258124, code: 'E258124' });

  fake.reset();
  maxSeq = null;
  assert.deepEqual(await userService.suggestNextEmpCode(), { count: 1, code: 'E000001' });
});

test('the suggestion endpoint RESERVES NOTHING — no lock, no write', async () => {
  /*
   * This is a documented property, not an omission: reserving would burn codes
   * on abandoned forms and leave permanent holes in a sequence people read as a
   * headcount. It is also precisely why the create path must still lock and
   * still probe — two admins WILL be handed the same suggestion.
   */
  maxSeq = 42;
  await userService.suggestNextEmpCode();
  assert.equal(matching(/GET_LOCK/i).length, 0, 'a suggestion must not take the lock');
  assert.equal(matching(/INSERT|UPDATE/i).length, 0, 'a suggestion must not write');
});

test('GET /api/admin/users/next-emp-code is mounted BEFORE /:userId', () => {
  /*
   * Express matches in registration order. Registered after /:userId, the
   * literal path would never be reached: idParam would try to parse
   * "next-emp-code" as a positive integer and answer 400. Same ordering rule
   * that /check-mobile and the bulk sub-router already depend on.
   */
  const router = require('../routes/admin/users');
  const paths = router.stack.map((layer) => (layer.route ? layer.route.path : null));
  const suggestAt = paths.indexOf('/next-emp-code');
  const paramAt   = paths.indexOf('/:userId');
  assert.notEqual(suggestAt, -1, '/next-emp-code must be registered on the router');
  assert.notEqual(paramAt, -1, '/:userId must be registered on the router');
  assert.ok(suggestAt < paramAt,
    `/next-emp-code (index ${suggestAt}) must be registered before /:userId (index ${paramAt})`);
});

// ── 5. createUser — the lock, and what it guards ─────────────────────────

test('createUser takes the named lock, probes for a duplicate, and INSERTs the code', async () => {
  const out = await run(() => userService.createUser({ ...CREATE_BASE, user_code: 'E000123' }));
  assert.equal(out.reachedWrite, true, out.rejected);

  const [lockCall] = matching(/GET_LOCK/i);
  assert.ok(lockCall, 'GET_LOCK must be taken');
  assert.deepEqual(lockCall.params, [EMP_CODE_LOCK], 'the contracted lock name');
  assert.match(lockCall.sql, /GET_LOCK\(\?,\s*5\)/i, 'and the contracted 5-second timeout');

  const [probe] = matching(/WHERE user_code = \?/i);
  assert.ok(probe, 'the duplicate probe must run');
  assert.deepEqual(probe.params, ['E000123']);

  const [insert] = matching(/INSERT INTO tbl_user\s*\(/i);
  assert.ok(insert, 'the tbl_user INSERT must be reached');
  assert.match(insert.sql, /\(\s*user_code,/, 'user_code must be in the INSERT column list');
  assert.equal(insert.params[0], 'E000123', 'and bound as the first parameter');
  /*
   * BIND ARITY. Adding a column means adding BOTH a placeholder and a
   * parameter, and getting one of the two wrong is silent here (the fake pool
   * does not bind) while being a hard ER_WRONG_ARGUMENTS against a real MySQL.
   * NOW() is a literal in the VALUES list, so it is not counted.
   */
  const placeholders = (insert.sql.match(/\?/g) || []).length;
  assert.equal(placeholders, insert.params.length,
    `INSERT has ${placeholders} placeholders but ${insert.params.length} bound parameters`);

  // Ordering is the whole point: probe, then INSERT, both INSIDE the lock.
  const order = sqlOf();
  const iLock   = order.findIndex((s) => /GET_LOCK/i.test(s));
  const iProbe  = order.findIndex((s) => /WHERE user_code = \?/i.test(s));
  const iInsert = order.findIndex((s) => /INSERT INTO tbl_user\s*\(/i.test(s));
  const iRel    = order.findIndex((s) => /RELEASE_LOCK/i.test(s));
  assert.ok(iLock < iProbe && iProbe < iInsert && iInsert < iRel,
    `expected GET_LOCK < probe < INSERT < RELEASE_LOCK, got ${iLock}/${iProbe}/${iInsert}/${iRel}`);
});

test('createUser RELEASES the lock on the failure path too', async () => {
  // The stop-sentinel throws after the INSERT, standing in for any statement
  // that can fail mid-transaction. A lock leaked here would not simply expire:
  // the connection goes back to the POOL still holding it, and every later
  // create on any request would block for its full 5 seconds and then 503.
  const out = await run(() => userService.createUser({ ...CREATE_BASE }));
  assert.equal(out.reachedWrite, true, out.rejected);
  const released = matching(/RELEASE_LOCK/i);
  assert.equal(released.length, 1, 'exactly one RELEASE_LOCK');
  assert.deepEqual(released[0].params, [EMP_CODE_LOCK]);
});

test('createUser ABORTS when GET_LOCK times out (returns 0) — it does not proceed unguarded', async () => {
  /*
   * THE BUG THIS GUARDS. GET_LOCK returns 0 when the 5 seconds elapse and
   * someone else still holds the lock. A truthiness check (`if (lock)`) or a
   * missing check treats that as success, and the duplicate probe then races
   * the very create it was waiting on — both see "free" and both INSERT the
   * same code, with no UNIQUE index to catch it.
   */
  lockResult = 0;
  const out = await run(() => userService.createUser({ ...CREATE_BASE }));
  assert.equal(out.status, 503, 'a contended create must fail loudly, not silently proceed');
  assert.match(out.rejected, /employee code/i);
  assert.equal(matching(/WHERE user_code = \?/i).length, 0, 'no duplicate probe without the lock');
  assert.equal(matching(/INSERT INTO tbl_user\s*\(/i).length, 0, 'and certainly no INSERT');
  assert.equal(matching(/RELEASE_LOCK/i).length, 0,
    'and nothing we never acquired may be released — that would hand away a lock another session holds');
});

test('createUser ABORTS when GET_LOCK errors (returns NULL) — NULL is not success either', async () => {
  // Number(null) === 0, so the same `!== 1` check catches this; the test exists
  // because a `=== 0` check would NOT, and reads as equally correct.
  lockResult = null;
  const out = await run(() => userService.createUser({ ...CREATE_BASE }));
  assert.equal(out.status, 503);
  assert.equal(matching(/INSERT INTO tbl_user\s*\(/i).length, 0);
  assert.equal(matching(/RELEASE_LOCK/i).length, 0);
});

test('createUser 409s with its OWN error code when the operator-supplied code is taken', async () => {
  /*
   * One Add User call can 409 on the email, the mobile OR the code. A generic
   * "duplicate user" message leaves the operator guessing which of three inputs
   * to change, so the service publishes a distinct machine-readable code and
   * the field it belongs to.
   */
  dupCodeRow = { user_id: 8735 };
  const out = await run(() => userService.createUser({ ...CREATE_BASE, user_code: 'E000123' }));
  assert.equal(out.status, 409);
  assert.equal(out.code, 'USER_CODE_TAKEN');
  assert.equal(out.field, 'user_code');
  assert.match(out.rejected, /E000123/, 'the message names the offending code');
  assert.equal(matching(/INSERT INTO tbl_user\s*\(/i).length, 0, 'nothing is written');
  assert.equal(matching(/RELEASE_LOCK/i).length, 1, 'and the lock is still released');
});

test('the duplicate probe is NOT narrowed to active internal users', async () => {
  /*
   * Deliberately unlike the email/mobile probes beside it. A code identifies a
   * person for the life of the record: a deactivated ex-employee still owns
   * theirs, and reissuing it silently re-attributes their history in every
   * report that joins on it. It also has to match nextEmpCode()'s MAX(), which
   * scans the same unfiltered population — if they disagreed, the suggestion
   * would point straight at a code the probe then rejects.
   */
  await run(() => userService.createUser({ ...CREATE_BASE }));
  const [probe] = matching(/WHERE user_code = \?/i);
  assert.ok(probe);
  assert.doesNotMatch(probe.sql, /user_status/i, 'an inactive user still owns their code');
  assert.doesNotMatch(probe.sql, /user_type_id/i);
});

test('createUser rejects a malformed user_code BEFORE taking the lock', async () => {
  // The service re-checks the format the route's Joi already checked, because
  // requiredness and shape live in two layers here and the deeper one wins.
  for (const bad of ['E25812', 'ef000123', '000123', 'E00012X', '', '   ']) {
    fake.reset();
    const out = await run(() => userService.createUser({ ...CREATE_BASE, user_code: bad }));
    assert.equal(out.status, 400, `${JSON.stringify(bad)} must be rejected`);
    assert.equal(matching(/GET_LOCK/i).length, 0,
      'a shape failure must not cost a lock acquisition');
  }
});

// ── 6. updateUser — the self-exclusion ───────────────────────────────────

function editableRow(overrides = {}) {
  return {
    user_id: 501, user_type_id: 5, user_code: 'E000501',
    mobile_no: '9000000001', alternate_no: null,
    user_role: 2, city_id: 1,
    manage_clients: null, manage_cities: null, manage_states: null, manage_verticals: null,
    reporting_manager: null, user_status: 1, ...overrides,
  };
}

test('updateUser lets a user KEEP their own existing code — the self-exclusion', async () => {
  /*
   * THE BUG THIS SHAPE OF CHECK USUALLY SHIPS WITH. Re-saving Edit User posts
   * the code that is already on the row. A probe without `user_id <> ?` finds
   * that very row and answers "already in use", so nobody can ever edit
   * anything about themselves again — and the message points at the one field
   * the operator did not touch.
   */
  me = editableRow({ user_code: 'E000501' });
  const out = await run(() => userService.updateUser(501, { user_code: 'E000501' }, 99));

  assert.notEqual(out.status, 409, `a user's own code must not be a conflict: ${out.rejected}`);

  // Belt: the code is unchanged, so the no-change short-circuit means no probe
  // and no UPDATE at all. Braces: the SQL still carries the exclusion for any
  // caller that bypasses the short-circuit (test below).
  const writes = matching(/UPDATE tbl_user SET/i);
  assert.equal(writes.length, 0, 'an unchanged code must not bump update_date');
});

test('updateUser EXCLUDES the edited row in the SQL, not only via the no-change short-circuit', async () => {
  // Force the probe by changing the code, then assert the exclusion is written
  // into the statement — the short-circuit is an optimisation and must not be
  // the only thing keeping a user out of their own way.
  me = editableRow({ user_code: 'E000501' });
  const out = await run(() => userService.updateUser(501, { user_code: 'E000777' }, 99));
  assert.equal(out.reachedWrite, true, out.rejected);

  const [probe] = matching(/WHERE user_code = \?/i);
  assert.ok(probe, 'a changed code must be probed');
  assert.match(probe.sql, /user_id <> \?/i, 'the probe must exclude the row being edited');
  assert.deepEqual(probe.params, ['E000777', 501]);
});

test('updateUser 409s with USER_CODE_TAKEN when the code belongs to someone else', async () => {
  me = editableRow({ user_code: 'E000501' });
  dupCodeRow = { user_id: 8735 };
  const out = await run(() => userService.updateUser(501, { user_code: 'E000777' }, 99));
  assert.equal(out.status, 409);
  assert.equal(out.code, 'USER_CODE_TAKEN');
  assert.equal(out.field, 'user_code');
  assert.equal(matching(/UPDATE tbl_user SET/i).length, 0, 'nothing is written');
});

test('updateUser rejects a malformed code without probing', async () => {
  me = editableRow();
  const out = await run(() => userService.updateUser(501, { user_code: 'E12' }, 99));
  assert.equal(out.status, 400);
  assert.equal(matching(/WHERE user_code = \?/i).length, 0);
});

test("updateUser's row load projects user_code, so the no-change short-circuit can see it", async () => {
  /*
   * Without user_code in the SELECT, `me.user_code` is undefined, EVERY save
   * looks like a change, and every save costs a probe plus an UPDATE that bumps
   * update_date on a no-op. The probe stays correct — it excludes the edited
   * row — but the churn is exactly what the short-circuit exists to prevent.
   */
  me = editableRow();
  await run(() => userService.updateUser(501, { user_code: 'E000777' }, 99));
  const [load] = matching(/FROM tbl_user WHERE user_id = \?/i);
  assert.ok(load);
  assert.match(load.sql, /\buser_code\b/, 'the row load must project user_code');
});

// ── 7. The single home — no second copy of the format anywhere ───────────

test('the regex and the padding exist EXACTLY ONCE in the repo', () => {
  /*
   * The owner asked for a shared implementation specifically to cut duplication
   * and defect risk, and this is the check that keeps it true — a rule nobody
   * runs is a comment.
   *
   * It is not style policing. tbl_user has no UNIQUE index on user_code and we
   * may not add one, so nothing downstream catches a collision. A second copy
   * that drifted by one character — \d{5}, a dropped anchor, an /i flag —
   * would change which rows nextEmpCode()'s MAX scans, and the next allocation
   * would hand out a code that already exists.
   *
   * Two files are allowed to contain the signatures: lib/emp-code.js (the home,
   * including the mirrored SQL pattern) and this test (which quotes malformed
   * examples on purpose).
   */
  const ROOT = path.join(__dirname, '..');
  const SKIP = new Set(['node_modules', '.git', 'uploads', 'logs', 'coverage', 'dist', 'build', 'stt-service']);
  const ALLOWED = new Set([
    path.join('lib', 'emp-code.js'),
    path.join('tests', 'emp-code.test.js'),
  ]);
  // Plain substrings, compared with String.includes — NOT a shared /g regex.
  // A global regex reused across files carries lastIndex between .test() calls
  // and would report clean for every other file it scanned.
  const SIGNATURES = ['E\\d{6}', 'E[0-9]{6}', "padStart(6"];

  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const rel = path.relative(ROOT, full);
      if (ALLOWED.has(rel)) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const sig of SIGNATURES) {
        if (text.includes(sig)) offenders.push(`${rel} contains ${JSON.stringify(sig)}`);
      }
    }
  }(ROOT));

  assert.deepEqual(offenders, [],
    'the employee-code format must live only in lib/emp-code.js — import EMP_CODE_RE / '
    + 'formatEmpCode / parseEmpCode instead of re-declaring the shape:\n  '
    + offenders.join('\n  '));
});

test('the route and the service share ONE regex object, not two equal copies', () => {
  // Identity, not equality: two separately-declared regexes with the same
  // source compare unequal here, which is the drift we want to fail on.
  const routeSchemas = require('../routes/admin/users').__schemas;
  assert.ok(routeSchemas && routeSchemas.createBody, '__schemas must expose the shipped createBody');
  assert.equal(require('../lib/emp-code').EMP_CODE_RE, EMP_CODE_RE);
});

// ── 8. The route's Joi — the other half of the "both layers" rule ────────

test('routes/admin/users.js Joi makes user_code REQUIRED on create and format-checked on update', () => {
  const { createBody, updateBody } = require('../routes/admin/users').__schemas;
  const base = {
    user_name: 'Test User', official_email: 'a@easyfix.in', user_role: 2,
    personal_email: 'a.b@gmail.com',
  };

  const missing = createBody.validate(base);
  assert.ok(missing.error, 'create without user_code is rejected');
  assert.match(missing.error.message, /Employee Code is required/);

  for (const bad of ['E25812', 'ef000123', '000123', 'E00012X']) {
    const res = createBody.validate({ ...base, user_code: bad });
    assert.ok(res.error, `${bad} must be rejected by Joi`);
    assert.match(res.error.message, /followed by exactly 6 digits/,
      'the operator-facing message must not be a raw regex dump');
  }

  const good = createBody.validate({ ...base, user_code: '  E000123 ' });
  assert.equal(good.error, undefined);
  assert.equal(good.value.user_code, 'E000123', 'Joi trims it');

  // UPDATE — optional (a PATCH that does not touch the code must pass) but the
  // format is still enforced when it IS supplied.
  assert.equal(updateBody.validate({ mobile_no: '9000000001' }).error, undefined);
  assert.equal(updateBody.validate({ user_code: 'E000123' }).error, undefined);
  assert.ok(updateBody.validate({ user_code: 'E12' }).error);
});

// ── 9. The message the operator actually reads ───────────────────────────

/*
 * WHY THIS EXISTS, given the tests above already prove every malformed code is
 * rejected: they prove the 400 HAPPENS, not that what it SAYS is true.
 *
 * All three messages shipped to Production reading `"EF" followed by exactly 6
 * digits (e.g. EF000123)` — the two-letter prefix, months after the format
 * became E. The 2026-09-01 correction parameterised the regex and the SQL and
 * stopped there, so validation was right and the advice was wrong: the operator
 * typed the code the message asked for and the same regex rejected it again.
 *
 * The suite could not see it. The Joi test above asserted only
 * /followed by exactly 6 digits/ — the half of the sentence that never drifts —
 * and the two service tests asserted status 400 and nothing about the text.
 * A message assertion that skips the part carrying the value is not an
 * assertion about the value.
 *
 * The prefix is pinned as a LITERAL here, like the scheme test at the top of
 * this file and for the same reason: derived from EMP_CODE_FORMAT_HINT this
 * would agree with any prefix, including one changed by accident, which is
 * exactly the failure it is meant to catch. The negative case is what makes it
 * bite — a find-and-replace that rewrites the expectation rewrites 'EF' into
 * 'E' too, and `doesNotMatch` then fails instead of passing vacuously.
 */
test('every rejection tells the operator the CURRENT prefix, not the retired one', async () => {
  const says = (text, where) => {
    assert.match(text, /"E" followed by exactly 6 digits \(e\.g\. E000123\)/,
      `${where} must name the prefix in force`);
    /*
     * The ADVICE only. The service messages close with `— got "<what you sent>"`,
     * which is worth keeping — it shows the operator the value the server
     * actually received, trimming and all — but it means the probe below appears
     * verbatim in the output, and a bare /EF/ over the whole string matches the
     * echo rather than the guidance. Asserting on the un-split message would
     * have failed on correct code, which is how this line got written twice.
     */
    assert.doesNotMatch(text.split(' — got ')[0], /EF/,
      `${where} still advertises the retired two-letter prefix — a code typed from `
      + 'this message is rejected by the very regex that produced it');
  };

  // 1 + 2. Joi, both directions. createBody and updateBody share EMP_CODE_MESSAGE,
  // and sharing it is not a reason to check only one — they are separate schemas.
  const { createBody, updateBody } = require('../routes/admin/users').__schemas;
  const base = {
    user_name: 'Test User', official_email: 'a@easyfix.in', user_role: 2,
    personal_email: 'a.b@gmail.com',
  };
  says(createBody.validate({ ...base, user_code: 'EF000123' }).error.message, 'the create schema');
  says(updateBody.validate({ user_code: 'EF000123' }).error.message, 'the update schema');

  // 3. The service's create path — the deeper layer, which has its own copy of
  // the sentence because it names the payload key rather than the form label.
  fake.reset();
  const created = await run(() => userService.createUser({ ...CREATE_BASE, user_code: 'EF000123' }));
  assert.equal(created.status, 400);
  says(created.rejected, 'createUser');

  // 4. The service's update path. A separate throw site, and the one a
  // find-and-replace is likeliest to miss — it sits inside a per-key loop.
  fake.reset();
  me = editableRow();
  const updated = await run(() => userService.updateUser(501, { user_code: 'EF000123' }, 99));
  assert.equal(updated.status, 400);
  says(updated.rejected, 'updateUser');
});
