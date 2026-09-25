'use strict';
/*
 * The I-Card's skills and "member since" (owner, 2026-09-25). A technician who
 * picked skills in the new app has them in tbl_efr_deepskill_mapping, not the
 * legacy efr_service_category CSV, so the card printed no skills; and one
 * activated outside the CRM flow has no profile_activation_date_time, so it
 * printed no member-since either.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { installFakePool } = require('./helpers/fake-pool');

let ROW; let SKILLS;
const fake = installFakePool([
  [/FROM tbl_efr_deepskill_mapping/, () => SKILLS],
  [/FROM tbl_easyfixer_rating_by_customer/, () => [{ avgRating: null }]],
  [/FROM tbl_easyfixer e/, () => [ROW]],
]);
const { getICard } = require('../services/mobile-profile-extra.service');

test('skills come from the deep-skill picks; the legacy CSV is only the fallback', async () => {
  ROW = { efr_id: 10792, efr_name: 'Harshit', efr_service_category: null, member_since: '2026-09-20 10:00:00' };
  SKILLS = [{ name: 'Plumbing Services', n: 3 }];
  assert.deepEqual((await getICard(10792)).serviceCategoryList, ['Plumbing Services']);

  ROW = { ...ROW, efr_service_category: 'Carpentry,Painting' };
  SKILLS = [];
  assert.deepEqual((await getICard(10792)).serviceCategoryList, ['Carpentry', 'Painting'], 'no deep skills → legacy column');
});

test('member since falls back from activation to auto-activation to the row creation', async () => {
  SKILLS = [];
  ROW = { efr_id: 10792, member_since: '2026-09-20 10:00:00' };
  assert.equal((await getICard(10792)).memberSince, '2026-09-20 10:00:00');
  const q = fake.calls.find((c) => /FROM tbl_easyfixer e/.test(c.sql));
  assert.match(q.sql, /COALESCE\(e\.profile_activation_date_time, e\.auto_activation_date, e\.insert_date\) AS member_since/);
});
