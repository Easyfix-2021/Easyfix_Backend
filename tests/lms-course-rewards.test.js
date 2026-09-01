'use strict';
/*
 * Course-completion reward points (courses.reward_points → reward_points_ledger).
 *
 * The one test that matters most is "keys on the ENROLMENT, not the course".
 * uq_reward_award is UNIQUE (reason_code, ref_type, ref_id) and is NOT scoped
 * by easyfixer_id, so keying on course_id would let exactly ONE technician on
 * the platform ever be paid for a course and swallow every later award as a
 * duplicate — a bug that produces no error, no log line and no failed request,
 * and would be discovered only by a technician asking where his points went.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([[/./, []]]);
after(() => fake.restore());

const rewards = require('../services/rewards.service');
const properties = require('../services/properties.service');

/*
 * Earning is property-gated. setProperty writes through the real cache — the
 * fake pool absorbs the UPDATE, so nothing reaches a database.
 */
const setEarning = (v) => properties.setProperty('rewards.earn.enabled', v);
const lastInsert = () => fake.calls.map((c) => c.sql)
  .filter((s) => /INSERT INTO reward_points_ledger/i.test(s)).pop() || '';
const lastParams = () => (fake.calls.filter((c) => /INSERT INTO reward_points_ledger/i.test(c.sql)).pop() || {}).params || [];

test('the award keys on the ENROLMENT row, never the course', async () => {
  fake.reset();
  await rewards.awardCourseCompletions({ efrIds: [7] });
  const sql = lastInsert();
  assert.match(sql, /ec\.id/, 'ref_id must be easyfixer_courses.id');
  assert.doesNotMatch(sql, /'course',\s*ec\.course_id/,
    'keying on course_id pays exactly one technician platform-wide, silently');
});

test("it writes ref_type 'course' and the COURSE reason", async () => {
  fake.reset();
  await rewards.awardCourseCompletions({ efrIds: [7] });
  assert.match(lastInsert(), /'course'/);
  assert.equal(lastParams()[0], rewards.REASON.COURSE);
  assert.equal(rewards.REASON.COURSE, 'COURSE');
});

test('duplicates are ignored WITHOUT masking other errors', async () => {
  fake.reset();
  await rewards.awardCourseCompletions({ efrIds: [7] });
  const sql = lastInsert();
  assert.match(sql, /ON DUPLICATE KEY UPDATE/i);
  assert.doesNotMatch(sql, /INSERT\s+IGNORE/i,
    'INSERT IGNORE downgrades every error to a warning — a truncated or '
    + 'FK-violating row would vanish and the ledger would be silently short');
});

test('only completed enrolments of PAYING courses are eligible', async () => {
  fake.reset();
  await rewards.awardCourseCompletions({ efrIds: [7] });
  const sql = lastInsert();
  assert.match(sql, /ec\.completion_date IS NOT NULL/);
  assert.match(sql, /c\.reward_points > 0/);
  assert.match(sql, /c\.reward_points IS NOT NULL/);
});

test('an unscoped call writes NOTHING', async () => {
  fake.reset();
  const r = await rewards.awardCourseCompletions({});
  assert.equal(r.skipped, 'unscoped');
  assert.equal(lastInsert(), '',
    'both scopes absent would back-pay all history the first time an operator '
    + 'sets reward_points on an old course');
});

test('an EMPTY id list is a legitimate no-op, distinct from unscoped', async () => {
  fake.reset();
  const r = await rewards.awardCourseCompletions({ efrIds: [] });
  assert.equal(r.skipped, 'no-ids');
  assert.equal(lastInsert(), '');
});

test('the course-wide form narrows by course and needs no ids', async () => {
  fake.reset();
  await rewards.awardCourseCompletions({ courseId: 3 });
  const sql = lastInsert();
  assert.match(sql, /ec\.course_id = \?/);
  assert.doesNotMatch(sql, /ec\.easyfixer_id IN/);
});

test('non-numeric and negative ids are filtered out of the IN list', async () => {
  fake.reset();
  await rewards.awardCourseCompletions({ efrIds: [7, 'x', -3, 0, 9] });
  const sql = lastInsert();
  assert.match(sql, /ec\.easyfixer_id IN \(\?,\?\)/, 'only 7 and 9 survive');
});

test('the global earning pause stops the award', async () => {
  fake.reset();
  await setEarning('false');
  try {
    const r = await rewards.awardCourseCompletions({ efrIds: [7] });
    assert.equal(r.skipped, 'paused');
    assert.equal(lastInsert(), '');
  } finally {
    await setEarning('true');
  }
});

test('COURSE joins the frozen reason vocabulary without disturbing it', () => {
  for (const k of ['RATING', 'SDA', 'REFERRAL', 'CLAIM', 'CLAIM_REFUND', 'MANUAL']) {
    assert.equal(rewards.REASON[k], k, `${k} must be unchanged`);
  }
  assert.throws(() => { rewards.REASON.NEW_CODE = 'X'; },
    'the vocabulary is frozen on purpose');
});
