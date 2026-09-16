/*
 * tbl_deep_skill.inserted_on is stamped with a BOUND Date, not SQL NOW()
 * (2026-09-16) — datetime column, same convention as every other
 * application timestamp in this repo (see tests/otp-attempt-cap.test.js).
 *
 * Runner: `node --test` (see npm test).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/SELECT service_catg_id FROM tbl_service_catg/, [{ service_catg_id: 10 }]],
  [/SELECT deepskill_id FROM tbl_deep_skill\s+WHERE category_id/, []],
  [/INSERT INTO tbl_deep_skill/, { insertId: 900 }],
  [/INSERT INTO tbl_deepskill_options/, { affectedRows: 1 }],
  [/SELECT skill_option FROM tbl_deepskill_options/, []],
  [/FROM tbl_deep_skill ds/, [{ deepskill_id: 900 }]],
  [/SELECT id, skill_option, status FROM tbl_deepskill_options/, []],
]);

const { create } = require('../services/deep-skill.service');

after(() => { if (fake.restore) fake.restore(); });

test('create() stamps inserted_on with a bound Date, never NOW()', async () => {
  const row = await create({
    category_id: 10,
    service_type_id: 20,
    deepskill_name: 'Test Skill',
    options: [{ skill_option: 'Opt1' }],
    deepskill_image: 'Skills/existing.png', // non-empty ⇒ skips the auto-gen dispatch branch
  }, { user_id: 5 });
  assert.equal(row.deepskill_id, 900, 'positive control: the insert ran and its id came back');

  const insert = fake.calls.find((c) => /INSERT INTO tbl_deep_skill\b/.test(c.sql));
  assert.ok(insert, 'positive control: the deep-skill insert ran');
  assert.doesNotMatch(insert.sql, /NOW\(\)/);
  const insertedOn = insert.params[6];
  assert.ok(insertedOn instanceof Date, 'inserted_on is the seventh bound value');
  assert.ok(Math.abs(Date.now() - insertedOn.getTime()) < 60_000, 'and it is now');
});
