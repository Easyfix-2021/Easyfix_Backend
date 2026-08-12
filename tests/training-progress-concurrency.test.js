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
  assert.deepEqual(fake.calls[0].params, [8379, 3, 80]);
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
