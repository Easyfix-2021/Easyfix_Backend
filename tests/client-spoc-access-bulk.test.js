/*
 * Characterization tests for svc.setContactAccessBulk.
 *
 * Bulk permission writes are worth pinning tightly because every failure mode
 * here is silent and wide:
 *
 *   • a missing tenant check lets a crafted contactIds array reach ANOTHER
 *     client's SPOCs — the route scope-checks the client, which says nothing
 *     about the ids in the body;
 *   • a full-column UPDATE resets overrides the operator never mentioned,
 *     wiping one person's deliberate exception across a 200-row bulk change;
 *   • a loop of single upserts is not atomic, so a mid-flight failure leaves a
 *     client half-migrated with nothing to indicate it.
 *
 * The fake pool records every (sql, params), so all three are checkable
 * offline with no database.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const OWNERSHIP = /^\s*SELECT id FROM tbl_client_contacts WHERE client_id = \?/i;
const UPSERT = /^\s*INSERT INTO easyfix_client_spoc_access/i;

// Which contact ids the ownership probe reports as belonging to the client.
// Mutable so a test can simulate ids from another tenant.
let ownedIds = [11, 12, 13];

const fake = installFakePool([
  [OWNERSHIP, () => ownedIds.map((id) => ({ id }))],
  [UPSERT, { affectedRows: 0 }],
]);
const svc = require('../services/client.service');

after(() => fake.restore());

const upsert = () => fake.calls.find((c) => UPSERT.test(c.sql));

test('one multi-row upsert, not a loop of single writes', async () => {
  fake.reset();
  ownedIds = [11, 12, 13];
  await svc.setContactAccessBulk(42, [11, 12, 13], { spocRole: 1 }, 99);

  const writes = fake.calls.filter((c) => UPSERT.test(c.sql));
  assert.equal(writes.length, 1, 'three SPOCs must be one statement, not three');
  // One VALUES tuple per contact.
  assert.equal((writes[0].sql.match(/\(\?, \?, \?, \?, \?, \?, \?, \?, NOW\(\)\)/g) || []).length, 3);
});

test('only contacts belonging to THIS client are written', async () => {
  fake.reset();
  // The caller asks for four ids; the DB says only two are this client's.
  ownedIds = [11, 12];
  const out = await svc.setContactAccessBulk(42, [11, 12, 777, 888], { spocRole: 1 }, 99);

  assert.equal(out.updated, 2);
  assert.equal(out.skipped, 2, 'ids from another tenant are skipped, not written');

  const ids = upsert().params.filter((_, i) => i % 8 === 0);
  assert.deepEqual(ids, [11, 12], 'the foreign ids must never reach the INSERT');
  assert.ok(!upsert().params.includes(777));
});

test('a request whose ids all belong elsewhere writes nothing at all', async () => {
  fake.reset();
  ownedIds = [];
  const out = await svc.setContactAccessBulk(42, [777, 888], { spocRole: 3 }, 99);
  assert.deepEqual(out, { updated: 0, skipped: 2 });
  assert.equal(upsert(), undefined, 'no INSERT should be issued');
});

test('an empty id list short-circuits before touching the database', async () => {
  fake.reset();
  const out = await svc.setContactAccessBulk(42, [], { spocRole: 1 }, 99);
  assert.deepEqual(out, { updated: 0 });
  assert.equal(fake.calls.length, 0, 'not even the ownership probe should run');
});

test('duplicate ids collapse so a contact cannot appear twice in one statement', async () => {
  fake.reset();
  ownedIds = [11];
  await svc.setContactAccessBulk(42, [11, 11, 11], { spocRole: 2 }, 99);
  assert.equal((upsert().sql.match(/NOW\(\)\)/g) || []).length, 1,
    'a repeated id must not produce a duplicate VALUES row');
});

/*
 * The partial-patch rule, and the reason bulk assignment is safe to use on a
 * whole client: "set everyone to Store SPOC" must not silently clear the one
 * person who has a deliberate invoicing override.
 */
test('a patch with no overrides updates the role only, leaving overrides intact', async () => {
  fake.reset();
  ownedIds = [11, 12];
  await svc.setContactAccessBulk(42, [11, 12], { spocRole: 1 }, 99);

  const sql = upsert().sql;
  assert.match(sql, /ON DUPLICATE KEY UPDATE[\s\S]*spoc_role = VALUES\(spoc_role\)/);
  for (const col of ['can_view_performance', 'can_view_invoicing', 'can_approve_estimates', 'can_view_all_stores']) {
    assert.ok(!new RegExp(`${col} = VALUES\\(${col}\\)`).test(sql),
      `${col} was not in the patch, so it must not appear in the UPDATE list`);
  }
});

test('an override the caller DID send is written, and only that one', async () => {
  fake.reset();
  ownedIds = [11];
  await svc.setContactAccessBulk(42, [11], { spocRole: 3, canViewInvoicing: false }, 99);

  const sql = upsert().sql;
  assert.match(sql, /can_view_invoicing = VALUES\(can_view_invoicing\)/,
    'the mentioned override must be updated');
  assert.ok(!/can_view_performance = VALUES/.test(sql),
    'an unmentioned override must stay untouched');
  // false → 0, and it lands in the can_view_invoicing slot (index 4 of 8).
  assert.equal(upsert().params[4], 0, 'false must persist as an explicit 0, not as null');
});

/*
 * null is not "absent" — it is the instruction to CLEAR an override back to
 * inherit. If it were treated as absent, an override could be set but never
 * undone.
 */
test('null clears an override rather than being ignored', async () => {
  fake.reset();
  ownedIds = [11];
  await svc.setContactAccessBulk(42, [11], { spocRole: 3, canViewPerformance: null }, 99);

  assert.match(upsert().sql, /can_view_performance = VALUES\(can_view_performance\)/,
    'an explicit null must still reach the UPDATE list');
  assert.equal(upsert().params[3], null, 'and must be written as NULL');
});

test('true persists as 1 and the acting user is recorded', async () => {
  fake.reset();
  ownedIds = [11];
  await svc.setContactAccessBulk(42, [11], { spocRole: 4, canViewAllStores: true }, 501);

  const p = upsert().params;
  assert.deepEqual(p.slice(0, 3), [11, 42, 4], 'contact, client, role');
  assert.equal(p[6], 1, 'canViewAllStores true → 1');
  assert.equal(p[7], 501, 'updated_by carries the acting admin');
  assert.match(upsert().sql, /updated_by = VALUES\(updated_by\)/);
});

test('every value travels as a bound parameter — nothing is interpolated', async () => {
  fake.reset();
  ownedIds = [11];
  await svc.setContactAccessBulk(42, [11], { spocRole: 3 }, 99);
  const sql = upsert().sql;
  // The only literals in the statement are column names and NOW().
  assert.ok(!/VALUES\s*\(\s*11\b/.test(sql), 'contact ids must not be inlined');
  assert.ok(!/\b42\b/.test(sql), 'the client id must not be inlined');
});
