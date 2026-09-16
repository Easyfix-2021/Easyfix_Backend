/*
 * mobile-job-lifecycle.service.js's submitQuestionnaire — regression coverage
 * for the NOW()-to-bound-Date conversion on tbl_questionaire_answer.update_date
 * (db.js pool is timezone: '+05:30'; a bound Date serializes as the IST wall
 * clock, SQL NOW() does not). No test file exercised this writer before.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/SELECT fk_questionaire_id, fk_easyfixter_id FROM tbl_job/i,
    () => [{ fk_questionaire_id: 9, fk_easyfixter_id: 42 }]],
  [/SELECT c_qd_ans_id FROM tbl_questionaire_answer/i, () => [{ c_qd_ans_id: 501 }]],
  [/^\s*UPDATE tbl_questionaire_answer/i, () => ({ affectedRows: 1 })],
]);

const { submitQuestionnaire } = require('../services/mobile-job-lifecycle.service');

after(() => fake.restore());

test('submitQuestionnaire binds update_date as a Date, never SQL NOW()', async () => {
  fake.reset();
  await submitQuestionnaire(100, 42, [{ questionId: 5, answer: true, remark: 'ok' }]);

  const upd = fake.calls.find((c) => /^\s*UPDATE tbl_questionaire_answer/i.test(c.sql));
  assert.ok(upd, 'the update must have run');
  assert.match(upd.sql, /update_date = \?/);
  assert.doesNotMatch(upd.sql, /update_date = NOW\(\)/);
  assert.ok(upd.params[2] instanceof Date, 'update_date is bound as a Date');
});
