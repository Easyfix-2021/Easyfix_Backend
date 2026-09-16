/*
 * tbl_plivo_call_log.call_analysis_generated_at is stamped with a BOUND Date,
 * not SQL NOW() (2026-09-16) — datetime column, same convention as every
 * other application timestamp in this repo (see tests/otp-attempt-cap
 * .test.js). Sibling writers of the same column (routes/admin/calls.js) are
 * covered separately; this is the teleprompter post-call path's own write.
 *
 * Dependencies are stubbed via require.cache — mirrors the pattern in
 * tests/mobile-upload-document-created-on.test.js — so the test drives only
 * the DB write, not Sophy/teleprompter session plumbing.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/UPDATE tbl_plivo_call_log/, { affectedRows: 1 }],
]);

const session = {
  flow: 'default',
  question_list_json: '[]',
  asked_sequence_json: '[]',
  transcript: 'customer: hello\noperator: hi',
  call_uuid: 'CU-123',
  caller_user_id: 42,
};

for (const [rel, exports] of [
  ['../services/teleprompter.service', {
    getSession: async () => session,
    saveResult: async () => {},
  }],
  ['../services/teleprompter-flows', {
    resolveFlow: () => ({ coverage: () => ({}), mapResult: async () => null }),
  }],
  ['../services/call-analysis-mode.service', {
    analyzeCall: async () => ({ analysis: { overall_score: 8 } }),
    MODE_TRANSCRIPT: 'transcript',
  }],
  ['../services/caller-scorecard.service', {
    rollupForCaller: async () => {},
  }],
]) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { processCompleted } = require('../services/teleprompter-postcall.service');

after(() => { if (fake.restore) fake.restore(); });

test('processCompleted() stamps call_analysis_generated_at with a bound Date, never NOW()', async () => {
  await processCompleted('sess-1');

  const update = fake.calls.find((c) => /UPDATE tbl_plivo_call_log/.test(c.sql));
  assert.ok(update, 'positive control: the analysis update ran');
  assert.doesNotMatch(update.sql, /NOW\(\)/);
  const generatedAt = update.params[1];
  assert.ok(generatedAt instanceof Date, 'call_analysis_generated_at is the second bound value');
  assert.ok(Math.abs(Date.now() - generatedAt.getTime()) < 60_000, 'and it is now');
  assert.equal(update.params[2], 'CU-123');
});
