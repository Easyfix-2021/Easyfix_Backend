/*
 * services/lms.service.js::setVideoLink stamps document.updated_on /
 * document.created_on (both DATETIME) with a bound Date, never SQL NOW()
 * (2026-09-16). db.js pool timezone '+05:30' stores a bound Date as the
 * IST wall clock regardless of host; NOW() takes the DB session's own
 * (SYSTEM) zone.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const S = { existingDoc: null };
const fake = installFakePool([
  [/SELECT id, training_video_id FROM training_videos/i, () => [{ id: 3, training_video_id: 77 }]],
  [/SELECT id FROM document WHERE id = \? AND document_type_id = 2/i, () => (S.existingDoc ? [S.existingDoc] : [])],
  [/^\s*UPDATE document SET/i, () => ({ affectedRows: 1 })],
  [/^\s*INSERT INTO document/i, () => ({ insertId: 501 })],
  [/^\s*UPDATE training_videos SET training_video_id/i, () => ({ affectedRows: 1 })],
]);
after(() => fake.restore());

const { setVideoLink } = require('../services/lms.service');

test('setVideoLink UPDATE (existing doc) binds updated_on as a Date, never NOW()', async () => {
  S.existingDoc = { id: 77 };
  const r = await setVideoLink(3, 'https://www.youtube.com/watch?v=abc12345678', 9);
  assert.equal(r.video_url, 'https://www.youtube.com/watch?v=abc12345678');

  const upd = fake.calls.find((c) => /UPDATE document SET/.test(c.sql));
  assert.ok(upd, 'the doc UPDATE ran');
  assert.doesNotMatch(upd.sql, /NOW\(\)/, 'updated_on must not be SQL NOW()');
  assert.ok(upd.params[2] instanceof Date, 'updated_on is the third bound value');
});

test('setVideoLink INSERT (no existing doc) binds created_on as a Date, never NOW()', async () => {
  S.existingDoc = null;
  fake.reset();
  await setVideoLink(3, 'https://www.youtube.com/watch?v=abc12345678', 9);

  const ins = fake.calls.find((c) => /INSERT INTO document/.test(c.sql));
  assert.ok(ins, 'the doc INSERT ran');
  assert.doesNotMatch(ins.sql, /NOW\(\)/, 'created_on must not be SQL NOW()');
  // (file_name, url, document_type_id, created_by, created_on)
  assert.ok(ins.params[3] instanceof Date, 'created_on is the fourth bound value');
});
