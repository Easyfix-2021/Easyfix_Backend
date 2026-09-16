/*
 * tbl_admin_deleted_archive.deleted_at is stamped with a BOUND Date, not SQL
 * NOW() (2026-09-16) — datetime column, same convention as every other
 * application timestamp in this repo (see tests/otp-attempt-cap.test.js).
 *
 * Runner: `node --test` (see npm test).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/SELECT \* FROM `tbl_user` WHERE `user_id` = \? LIMIT 1 FOR UPDATE/, [{ user_id: 1, user_status: 1 }]],
  [/SELECT COUNT\(\*\) AS n FROM/, [{ n: 0 }]],
  [/INSERT INTO tbl_admin_deleted_archive/, { insertId: 777 }],
]);

const { tombstoneDelete } = require('../services/entity-deletion.service');

after(() => { if (fake.restore) fake.restore(); });

test('tombstoneDelete() stamps deleted_at with a bound Date, never NOW()', async () => {
  const result = await tombstoneDelete('user', 1, 'duplicate account', { user_id: 9, user_name: 'Admin' });
  assert.equal(result.archiveId, 777, 'positive control: the archive insert ran and its id came back');

  const insert = fake.calls.find((c) => /INSERT INTO tbl_admin_deleted_archive/.test(c.sql));
  assert.doesNotMatch(insert.sql, /NOW\(\)/);
  const deletedAt = insert.params[insert.params.length - 1];
  assert.ok(deletedAt instanceof Date, 'deleted_at is the last bound value');
  assert.ok(Math.abs(Date.now() - deletedAt.getTime()) < 60_000, 'and it is now');
});
