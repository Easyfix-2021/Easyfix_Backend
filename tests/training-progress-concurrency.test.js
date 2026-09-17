const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const UPSERT = /^\s*INSERT INTO easyfixer_watched_video/i;
const fake = installFakePool([
  [UPSERT, { affectedRows: 2 }],
]);
const profile = require('../services/mobile-profile-extra.service');

after(() => fake.restore());

test('training progress is one atomic monotonic upsert', async () => {
  const result = await profile.setTrainingPercentage(8379, 3, 80);
  assert.deepEqual(result, { videoId: 3, watchedPercentage: 80 });
  assert.equal(fake.calls.length, 1, 'no UPDATE-then-INSERT race or follow-up read');
  assert.match(fake.calls[0].sql, /ON DUPLICATE KEY UPDATE/i);
  assert.match(fake.calls[0].sql, /GREATEST\(\s*COALESCE\(watched_percentage, 0\)/i);
  assert.match(fake.calls[0].sql, /VALUES\(watched_percentage\)/i);
  // db.js pool binds a Date as the IST wall clock; SQL NOW() takes the DB
  // session's own (SYSTEM) zone. update_date is DATETIME (2026-09-16); both
  // the VALUES() stamp and the conditional IF() stamp share one instant.
  assert.doesNotMatch(fake.calls[0].sql, /NOW\(\)/, 'update_date must not be SQL NOW()');
  assert.equal(fake.calls[0].params.length, 5);
  assert.deepEqual(fake.calls[0].params.slice(0, 3), [8379, 3, 80]);
  assert.ok(fake.calls[0].params[3] instanceof Date, 'update_date (VALUES) is the 4th bound value');
  assert.ok(fake.calls[0].params[4] instanceof Date, 'update_date (IF-branch) is the 5th bound value');
  assert.equal(fake.calls[0].params[3].getTime(), fake.calls[0].params[4].getTime());
});

test('a delayed lower replay uses the same monotonic statement and cannot overwrite progress', async () => {
  fake.reset();
  await profile.setTrainingPercentage(8379, 3, 20);
  assert.equal(fake.calls.length, 1);
  assert.match(
    fake.calls[0].sql,
    /watched_percentage = GREATEST\([\s\S]*VALUES\(watched_percentage\)/i,
  );
});
