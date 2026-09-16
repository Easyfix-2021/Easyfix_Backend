/*
 * tbl_deep_skill.image_gen_attempted_at is stamped with a BOUND Date, not
 * SQL NOW() (2026-09-16) — datetime column, same convention as every other
 * application timestamp in this repo (see tests/otp-attempt-cap.test.js).
 *
 * Runner: `node --test` (see npm test).
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/UPDATE tbl_deep_skill\s+SET image_gen_status = 'failed'/, { affectedRows: 1 }],
]);

const { markFailed, resetOrphanedPendingImageGens } = require('../services/deep-skill-image-gen.service');

after(() => { if (fake.restore) fake.restore(); });
beforeEach(() => { fake.calls.length = 0; });

test('markFailed() stamps image_gen_attempted_at with a bound Date, never NOW()', async () => {
  await markFailed(77, new Error('openai timeout'));

  const update = fake.calls.find((c) => /image_gen_status = 'failed'/.test(c.sql));
  assert.ok(update, 'positive control: the update ran');
  assert.doesNotMatch(update.sql, /NOW\(\)/);
  assert.ok(update.params[0] instanceof Date, 'image_gen_attempted_at is the first bound value');
  assert.ok(Math.abs(Date.now() - update.params[0].getTime()) < 60_000, 'and it is now');
  assert.equal(update.params[1], 77);
});

test('resetOrphanedPendingImageGens() reads the 10-minute staleness window off a bound Date, never NOW()', async () => {
  await resetOrphanedPendingImageGens();

  const update = fake.calls.find((c) => /image_gen_status = 'failed'/.test(c.sql));
  assert.ok(update, 'positive control: the orphan-reset UPDATE ran');
  assert.doesNotMatch(update.sql, /NOW\(\)/);
  assert.match(update.sql, /image_gen_attempted_at < \(\? - INTERVAL 10 MINUTE\)/);
  assert.equal(update.params.length, 1);
  assert.ok(update.params[0] instanceof Date, 'the staleness window compares against a bound Date');
  assert.ok(Math.abs(Date.now() - update.params[0].getTime()) < 60_000, 'and it is now');
});
