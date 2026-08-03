/*
 * Unit tests for the MANDATORY "Personal Email" on Add/Edit User.
 *
 * WHAT IS BEING PINNED
 * ────────────────────
 * The requiredness MATRIX, at the layer that actually decides:
 *
 *   Add User                          → REQUIRED
 *   Edit an ACTIVE user               → REQUIRED
 *   Edit an INACTIVE user             → not required
 *   The edit that DEACTIVATES a user  → not required
 *   Bulk update / bulk upload         → not required (enforcePersonalEmail:false)
 *
 * WHY AT THIS LAYER: requiredness lives in BOTH routes/admin/users.js (Joi) and
 * services/user.service.js, and the DEEPER one silently wins. That is not a
 * theory — loosening only the Joi schema for mobile_no left the API answering
 * "mobile_no is required" from a form that showed the field as optional. These
 * tests drive the SERVICE. The route's Joi is asserted in the same file below
 * by compiling the real schemas.
 *
 * NO DB, NO NETWORK: the mysql2 pool is replaced by tests/helpers/fake-pool,
 * which dispatches each SQL string to a canned result and records every
 * (sql, params) it saw. Nothing is ever written to a real database.
 * Runner: `node --test`.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// ── Fake DB ───────────────────────────────────────────────────────────────
// `me` is the tbl_user row updateUser loads; `contact` is the side-table row.
// Both are mutated per-test before calling the service.
let me = null;
let contact = null;

const ROUTES = [
  // Must come BEFORE the tbl_user routes — "tbl_user_personal_details" would
  // otherwise be a substring hazard.
  [/FROM tbl_user_personal_details/i, () => (contact ? [contact] : [])],
  [/INSERT INTO tbl_user_personal_details/i, () => ({ affectedRows: 1 })],
  [/FROM tbl_user_allowed_stages/i, []],
  [/SELECT role_id, role_name/i, [{ role_id: 2, role_name: 'Admin', role_status: 1, menu_ids: '' }]],
  [/FROM tbl_user\s+WHERE user_id/i, () => (me ? [me] : [])],
  // getUserById / listUsers — returning [] makes them resolve to null, which is
  // fine: these tests assert on validation, not on the projection.
  [/FROM tbl_user\s+u/i, []],
];

const fake = installFakePool(ROUTES, { stopOn: /UPDATE tbl_user SET/i });
const userService = require('../services/user.service');
after(() => fake.restore());

function activeRow(overrides = {}) {
  return {
    user_id: 501, user_type_id: 5, mobile_no: '9000000001', alternate_no: null,
    user_role: 2, city_id: 1,
    manage_clients: null, manage_cities: null, manage_states: null, manage_verticals: null,
    reporting_manager: null, user_status: 1, ...overrides,
  };
}

/*
 * Run updateUser and report which of the three outcomes happened:
 *   { rejected: '<message>' }  a 400/409 from the validation layer
 *   { reachedWrite: true }     validation passed and the UPDATE was attempted
 *                              (the fake pool's stop-sentinel fires there)
 *   { completed: value }       validation passed and no tbl_user column changed
 */
async function runUpdate(fields, opts) {
  try {
    const value = await userService.updateUser(501, fields, 99, opts);
    return { completed: value };
  } catch (e) {
    if (e.__stop) return { reachedWrite: true };
    return { rejected: e.message, status: e.status };
  }
}

// ── 1. Add User — personal_email is REQUIRED ──────────────────────────────

const CREATE_BASE = {
  user_name: 'Test User', official_email: 'test.user@easyfix.in', user_role: 2, createdBy: 99,
};

test('createUser REJECTS a missing personal_email — the service, not just the route, enforces it', async () => {
  for (const missing of [undefined, null, '', '   ']) {
    await assert.rejects(
      () => userService.createUser({ ...CREATE_BASE, personal_email: missing }),
      (e) => {
        assert.equal(e.status, 400, JSON.stringify(missing));
        assert.match(e.message, /personal_email is required/);
        return true;
      },
      `personal_email=${JSON.stringify(missing)} must be rejected`,
    );
  }
});

test('createUser REJECTS a malformed personal_email rather than storing an undeliverable address', async () => {
  for (const bad of ['not-an-email', 'nope@', '@example.com', 'a b@example.com']) {
    await assert.rejects(
      () => userService.createUser({ ...CREATE_BASE, personal_email: bad }),
      (e) => {
        assert.equal(e.status, 400, bad);
        assert.match(e.message, /not a valid email address/);
        return true;
      },
      `${bad} must be rejected`,
    );
  }
});

test('createUser REJECTS a personal_email inside one of OUR OWN Microsoft 365 domains', async () => {
  /*
   * The two fields sit adjacent on the Add User form. Copying the official
   * address across delivers the credential mail into the very mailbox it
   * unlocks; a typo onto a colleague's @easyfix.in address hands a working
   * credential for a brand-new mailbox to an uninvolved employee. Both are
   * shape-valid, so only a domain check catches them.
   */
  for (const own of ['test.user@easyfix.in', 'someone.else@EasyFix.in']) {
    await assert.rejects(
      () => userService.createUser({ ...CREATE_BASE, personal_email: own }),
      (e) => {
        assert.equal(e.status, 400, own);
        assert.match(e.message, /personal \(non-company\) address/);
        return true;
      },
      `${own} must be rejected`,
    );
  }
  // …and a genuine personal provider is untouched.
  assert.deepEqual(
    userService.normalisePersonalEmail('someone@gmail.com', { required: true }),
    { ok: true, value: 'someone@gmail.com' },
  );
});

test('createUser validates personal_email BEFORE touching the database — a bad payload costs no round-trip', async () => {
  fake.reset();
  await assert.rejects(() => userService.createUser({ ...CREATE_BASE, personal_email: '' }));
  assert.equal(fake.calls.length, 0, 'rejected before the role lookup and the duplicate probes');
});

// ── 2. Edit — the conditional requiredness matrix ─────────────────────────

test('EDIT an ACTIVE user with NO personal_email anywhere → REJECTED', async () => {
  me = activeRow(); contact = null;
  const r = await runUpdate({ alternate_no: '9111111111' });
  assert.equal(r.status, 400);
  assert.match(r.rejected, /personal_email is required when editing an active user/);
});

test('EDIT an ACTIVE user who ALREADY has one on record → allowed without re-sending it', async () => {
  me = activeRow(); contact = { personal_email: 'someone@gmail.com' };
  const r = await runUpdate({ alternate_no: '9111111111' });
  assert.equal(r.reachedWrite, true,
    '"required" means the row must not be LEFT without one — not that every PATCH must repeat it');
});

test('EDIT an ACTIVE user with an EXPLICITLY BLANK personal_email → REJECTED', async () => {
  me = activeRow(); contact = { personal_email: 'someone@gmail.com' };
  const r = await runUpdate({ alternate_no: '9111111111', personal_email: '' });
  assert.equal(r.status, 400);
  assert.match(r.rejected, /personal_email is required/,
    'clearing the address of an ACTIVE user is the same violation as never supplying one');
});

test('EDIT an INACTIVE user with no personal_email → ALLOWED', async () => {
  me = activeRow({ user_status: 0 }); contact = null;
  const r = await runUpdate({ alternate_no: '9111111111' });
  assert.equal(r.reachedWrite, true,
    '7,568 active users have none today; blocking the inactive path too would make them uneditable forever');
});

test('The edit that DEACTIVATES a user needs no personal_email — offboarding must never require chasing a leaver', async () => {
  me = activeRow(); contact = null;
  const r = await runUpdate({ is_active: false });
  assert.equal(r.reachedWrite, true);
});

test('REACTIVATING an inactive user follows the INACTIVE row (the matrix keys off the row as it stands)', async () => {
  me = activeRow({ user_status: 0 }); contact = null;
  const r = await runUpdate({ is_active: true });
  assert.equal(r.reachedWrite, true);
});

test('An edit that keeps an ACTIVE user active (is_active:true) still REQUIRES a personal email', async () => {
  me = activeRow(); contact = null;
  const r = await runUpdate({ is_active: true, alternate_no: '9111111111' });
  assert.equal(r.status, 400);
  assert.match(r.rejected, /personal_email is required/);
});

test('isPersonalEmailRequiredOnUpdate is the ONE definition — route and service share it', () => {
  const f = userService.isPersonalEmailRequiredOnUpdate;
  assert.equal(f(1, undefined), true,  'active, status untouched');
  assert.equal(f(1, true),      true,  'active, staying active');
  assert.equal(f(1, false),     false, 'the deactivating edit');
  assert.equal(f(0, undefined), false, 'inactive');
  assert.equal(f(0, true),      false, 'reactivation');
  assert.equal(f(3, undefined), false, 'tombstoned (user_status 3) is not active');
});

// ── 3. Bulk paths are exempt, and only by asking ──────────────────────────

test('enforcePersonalEmail:false lets the BULK paths update an active user who has none', async () => {
  me = activeRow(); contact = null;
  const r = await runUpdate({ manage_cities: '5,10' }, { enforcePersonalEmail: false });
  assert.equal(r.reachedWrite, true,
    'bulk-update/bulk-upload carry no personal_email column — enforcing there collects nothing '
    + 'and would make every personal-email-less active user permanently un-bulk-updatable');
});

test('the exemption is OPT-IN — the default is the strict behaviour', async () => {
  me = activeRow(); contact = null;
  const r = await runUpdate({ manage_cities: '5,10' });   // no opts at all
  assert.equal(r.status, 400, 'a caller that forgets the flag gets the stricter rule, not the looser one');
});

// ── 4. Persistence shape ──────────────────────────────────────────────────

test('a supplied personal_email is normalised (trim + lowercase) and upserted with IST-bound timestamps', async () => {
  me = activeRow(); contact = null;
  fake.reset();
  await userService.updateUser(501, { personal_email: '  Someone.NEW@Gmail.COM ' }, 99);

  const write = fake.calls.find((c) => /INSERT INTO tbl_user_personal_details/i.test(c.sql));
  assert.ok(write, 'the side table is written');
  assert.match(write.sql, /ON DUPLICATE KEY UPDATE/i, 'upsert — one row per user, safe to re-save');
  assert.equal(write.params[0], 501);
  assert.equal(write.params[1], 'someone.new@gmail.com');
  assert.ok(write.params[2] instanceof Date, 'created_on bound as new Date() (IST via the pool), never SQL NOW()');
  assert.ok(write.params[3] instanceof Date, 'updated_on likewise');

  assert.equal(
    fake.calls.some((c) => /UPDATE tbl_user SET/i.test(c.sql)), false,
    'a personal-email-only edit must not bump tbl_user.update_date',
  );
});

test('re-saving the SAME personal_email is a no-op, not a write', async () => {
  me = activeRow(); contact = { personal_email: 'someone@gmail.com' };
  fake.reset();
  const row = await userService.updateUser(501, { personal_email: 'SOMEONE@gmail.com' }, 99);
  assert.equal(
    fake.calls.some((c) => /INSERT INTO tbl_user_personal_details/i.test(c.sql)), false,
    'unchanged value → no upsert, no updated_on churn',
  );
  assert.equal(row, null, 'getUserById is stubbed empty here; the assertion above is the point');
});

test('an INACTIVE user CAN have their personal email cleared', async () => {
  me = activeRow({ user_status: 0 }); contact = { personal_email: 'old@gmail.com' };
  fake.reset();
  await userService.updateUser(501, { personal_email: null }, 99);
  const write = fake.calls.find((c) => /INSERT INTO tbl_user_personal_details/i.test(c.sql));
  assert.ok(write);
  assert.equal(write.params[1], null, 'NULL, never the empty string');
});

test('createUser writes tbl_user and tbl_user_personal_details in ONE transaction', async () => {
  /*
   * personal_email is MANDATORY on create, so a committed tbl_user row without
   * one would violate the rule the moment it exists — and be indistinguishable
   * from a legacy row. The two statements must land together.
   */
  const src = require('fs').readFileSync(require.resolve('../services/user.service.js'), 'utf8');
  const create = src.slice(src.indexOf('async function createUser'), src.indexOf('async function updateUser'));
  assert.match(create, /beginTransaction\(\)/, 'create opens a transaction');
  assert.match(create, /upsertPersonalEmail\(r\.insertId, personalEmail\.value, conn\)/,
    'the side-table write runs on the SAME connection as the tbl_user INSERT');
  assert.match(create, /rollback\(\)/, 'and rolls back rather than leaving a half-created user');
});

// ── 4b. The still-PENDING migration must not take Manage Users down ───────

/*
 * tbl_user_personal_details ships as a PENDING migration, so there is a real
 * window in which this code is live and the table is absent. The READ side is
 * fail-soft (one blank column, not a dead screen); the WRITE side is not, but
 * it reports an actionable 503 instead of an opaque ER_NO_SUCH_TABLE 500 —
 * silently accepting and discarding a MANDATORY value the operator just typed
 * is the one outcome worse than either.
 */
function withMissingContactTable(fn) {
  const db = require('../db');
  const realQuery = db.pool.query;
  db.pool.query = async (sql, params) => {
    if (/tbl_user_personal_details/i.test(String(sql))) {
      const e = new Error("Table 'easyfix_core.tbl_user_personal_details' doesn't exist");
      e.code = 'ER_NO_SUCH_TABLE';
      e.errno = 1146;
      throw e;
    }
    return realQuery(sql, params);
  };
  return Promise.resolve(fn()).finally(() => { db.pool.query = realQuery; });
}

test('a MISSING side table blanks the column instead of 500-ing every read', async () => {
  await withMissingContactTable(async () => {
    assert.equal(await userService.loadPersonalEmail(501), null, 'single read is fail-soft');
    assert.equal((await userService.loadPersonalEmails([501, 502])).size, 0, 'batched read likewise');
  });
});

test('a MISSING side table still lets an INACTIVE user be edited — the matrix exempts that path', async () => {
  me = activeRow({ user_status: 0 }); contact = null;
  await withMissingContactTable(async () => {
    const r = await runUpdate({ alternate_no: '9111111111' });
    assert.equal(r.reachedWrite, true,
      'getUserById feeds the list, every PATCH, the repair endpoint and both bulk paths — '
      + 'a hard dependency here takes the whole Manage Users surface down, not one field');
  });
});

test('a MISSING side table fails the WRITE loudly, with a message naming the migration', async () => {
  await withMissingContactTable(async () => {
    await assert.rejects(
      () => userService.upsertPersonalEmail(501, 'someone@gmail.com'),
      (e) => {
        assert.equal(e.status, 503, 'not an opaque 500');
        assert.match(e.message, /2026-08-03-create-tbl-user-personal-details\.sql/);
        return true;
      },
      'a mandatory value the operator typed must never be silently discarded',
    );
  });
});

// ── 5. The route's Joi — the OTHER half of the "both layers" rule ─────────

test('routes/admin/users.js Joi makes personal_email REQUIRED on create and format-checked on update', () => {
  // The SHIPPED schemas, via the router's test-only __schemas handle — not a
  // re-declared copy, which would keep passing after someone edited the real one.
  const captured = require('../routes/admin/users').__schemas;

  // CREATE — required, and the format is enforced.
  const missing = captured.createBody.validate({
    user_name: 'Test User', official_email: 'a@easyfix.in', user_role: 2,
  });
  assert.ok(missing.error, 'create without personal_email is rejected by Joi too');
  assert.match(missing.error.message, /personal_email/);

  const bad = captured.createBody.validate({
    user_name: 'Test User', official_email: 'a@easyfix.in', user_role: 2, personal_email: 'nope',
  });
  assert.ok(bad.error, 'malformed personal_email is rejected');

  const good = captured.createBody.validate({
    user_name: 'Test User', official_email: 'a@easyfix.in', user_role: 2, personal_email: '  A.B@Gmail.com ',
  });
  assert.equal(good.error, undefined);
  assert.equal(good.value.personal_email, 'a.b@gmail.com', 'Joi trims + lowercases it');

  // UPDATE — Joi cannot know the target row's status, so it owns FORMAT only.
  // Presence is decided by the route handler + the service (tested above).
  assert.equal(captured.updateBody.validate({ mobile_no: '9000000001' }).error, undefined,
    'absence is legal at the Joi layer — an inactive-user edit must reach the handler');
  assert.ok(captured.updateBody.validate({ personal_email: 'nope' }).error,
    'but a malformed value never reaches the service');
  assert.equal(captured.updateBody.validate({ personal_email: '' }).error, undefined,
    "'' is the clear-it signal; whether it is ALLOWED is the handler's/service's call");
});
