/*
 * dashboard_notification_log.createdAt/updateAt are stamped with a BOUND
 * Date, not SQL NOW() (2026-09-16) — both are datetime columns, same
 * convention as every other application timestamp in this repo (see
 * tests/otp-attempt-cap.test.js, tests/mobile-upload-document-created-on
 * .test.js).
 *
 * Runner: `node --test` (see npm test).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/INSERT INTO dashboard_notification_log/, { insertId: 501 }],
]);

const inbox = require('../services/notification-inbox.service');

after(() => { if (fake.restore) fake.restore(); });

test('create() stamps createdAt with a bound Date, never NOW()', async () => {
  const id = await inbox.create({ userId: 7, jobId: 100, title: 'Job assigned', desc: 'x', notifyTo: null });
  assert.equal(id, 501, 'positive control: the insert ran and its id came back');

  const insert = fake.calls.find((c) => /INSERT INTO dashboard_notification_log/.test(c.sql));
  assert.doesNotMatch(insert.sql, /NOW\(\)/);
  const createdAt = insert.params[5];
  assert.ok(createdAt instanceof Date, 'createdAt is the sixth bound value');
  assert.ok(Math.abs(Date.now() - createdAt.getTime()) < 60_000, 'and it is now');
});

test('markRead() stamps updateAt with a bound Date, never NOW()', async () => {
  fake.reset();
  await inbox.markRead(501);
  const update = fake.calls.find((c) => /UPDATE dashboard_notification_log SET status = 'read', updateAt = \?/.test(c.sql));
  assert.ok(update, 'positive control: the update ran');
  assert.doesNotMatch(update.sql, /NOW\(\)/);
  assert.ok(update.params[0] instanceof Date, 'updateAt is the first bound value');
});
