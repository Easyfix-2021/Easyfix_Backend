const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { installFakePool } = require('./helpers/fake-pool');

/*
 * Team Profile "Categories" tile — regression guard.
 *
 * The tile used to render profile.skillCount (DISTINCT DEEP SKILLS), which is
 * one level below service categories in the category → service type → deep
 * skill → option model. A technician with a handful of categories therefore
 * showed ~98. The tile must read DISTINCT tbl_efr_deepskill_mapping.category_id.
 *
 * Fixture models exactly the sanity case from the bug report: a technician with
 * 3 categories and 40 deep skills, mapped over many more raw option rows.
 */
const CATEGORIES = 3;
const DEEP_SKILLS = 40;

const fake = installFakePool([
  // The one mapping-table read the profile composer issues.
  [/FROM tbl_efr_deepskill_mapping/i, [{
    skill_count: DEEP_SKILLS,
    category_count: CATEGORIES,
  }]],
  // Identity + memberSince reads — enough for the composed payload.
  [/FROM tbl_easyfixer e\s*\n?\s*LEFT JOIN tbl_city/i, [{
    efr_id: 3687,
    efr_name: 'Test Technician',
    efr_no: '9876543210',
    efr_cityId: 4,
    city_name: 'Gurugram',
    efr_service_category: 'AC,Appliances,Electrical',
  }]],
  [/SELECT insert_date, efr_email, efr_pin_no/i, [{
    insert_date: '2021-05-01 10:00:00',
    efr_email: 'tech@example.test',
    efr_pin_no: '122001',
  }]],
  // Lifetime status tally: 1627 completed jobs, one row per status code.
  [/SELECT j\.job_status, COUNT\(\*\) AS c/i, [
    { job_status: 3, c: 1600 },
    { job_status: 5, c: 27 },
  ]],
]);

const profileDetails = require('../services/mobile-profile-details.service');
const team = require('../services/mobile-team.service');

after(() => fake.restore());

test('profile-details counts DISTINCT categories separately from deep skills', async () => {
  const details = await profileDetails.getProfileDetails(3687);

  assert.equal(details.categoryCount, CATEGORIES,
    'categoryCount must be DISTINCT service categories, not deep skills');
  assert.equal(details.skillCount, DEEP_SKILLS,
    'skillCount keeps its deep-skill meaning for the Profile "Skills" tile');
  assert.notEqual(details.categoryCount, details.skillCount);

  const mappingReads = fake.calls.filter((c) => /tbl_efr_deepskill_mapping/i.test(c.sql));
  assert.equal(mappingReads.length, 1, 'one scan of the mapping table, not one per level');
  const [{ sql, params }] = mappingReads;
  assert.match(sql, /COUNT\(DISTINCT m\.category_id\)\s+AS category_count/i,
    'categories must be counted DISTINCT, never as raw mapping rows');
  assert.match(sql, /COUNT\(DISTINCT m\.parent_skill_id\)\s+AS skill_count/i);
  assert.match(sql, /m\.is_repairing = 1/i, 'only active mappings count');
  // No join = nothing can fan out and inflate either COUNT.
  assert.equal(/\bJOIN\b/i.test(sql), false, 'the count query must not join');
  assert.match(sql, /m\.easyfixer_id = \?/, 'technician is bound, not interpolated');
  assert.deepEqual(params, [3687]);
});

test('team profile renders the category count, not the deep-skill count', async () => {
  const db = {
    async query() {
      return [[{ member_count: 2, member_earnings: 1200 }]];
    },
  };
  const result = await team.getTeamProfile(3687, { month: '2026-08' }, db);

  assert.equal(result.categoriesCount, CATEGORIES);
  assert.notEqual(result.categoriesCount, DEEP_SKILLS,
    'the Categories tile must never show the deep-skill count again');
  assert.ok(result.categoriesCount <= 10,
    'plausibility: the platform has a single-digit number of service categories');
  // The jobs tile comes from the status-count engine, not the skill mapping —
  // it must be untouched by this fix.
  assert.equal(result.jobsDone, 1627);
});
