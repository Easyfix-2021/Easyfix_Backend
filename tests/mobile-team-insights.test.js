const test = require('node:test');
const assert = require('node:assert/strict');

const team = require('../services/mobile-team.service');
const profileDetails = require('../services/mobile-profile-details.service');

test('team profile labels direct reports credits as member earnings only', async () => {
  const original = profileDetails.getProfileDetails;
  profileDetails.getProfileDetails = async () => ({
    efrId: 7,
    name: 'Ramesh Kumar',
    mobile: '9876543210',
    photoUrl: 'profile-key',
    grade: 'A+',
    rating: 4.7,
    completedJobs: 348,
    skillCount: 21,
    categoryCount: 2,
    categories: ['AC', 'Appliances'],
    city: 'Gurgaon',
    memberSince: '2024-01-01',
  });
  const db = {
    async query(sql, params) {
      assert.match(sql, /member\.efr_manager_id = \?/);
      assert.match(sql, /et\.job_id IS NOT NULL/);
      assert.match(sql, /paid_job\.checkout_date_time >= \?/);
      assert.deepEqual(params, [7, '2026-08-01', '2026-09-01', 7]);
      return [[{ member_count: 4, member_earnings: 24800 }]];
    },
  };
  try {
    const result = await team.getTeamProfile(7, { month: '2026-08' }, db);
    assert.equal(result.team.memberEarnings, 24800);
    assert.equal(result.team.members, 4);
    assert.equal(result.categoriesCount, 2,
      'the Categories tile counts DISTINCT mapped categories, never deep skills (skillCount)');
    assert.equal(result.easyFixSince, '2024-01-01');
    assert.equal(Object.hasOwn(result, 'memberSince'), false);
    assert.equal(result.mobileMasked.endsWith('210'), true);
    assert.equal(Object.hasOwn(result.team, 'earnedYou'), false);
    assert.equal(Object.hasOwn(result, 'gradeEffect'), false);
  } finally {
    profileDetails.getProfileDetails = original;
  }
});

test('member list is one set-based metrics query plus count and stays bounded', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/ORDER BY COALESCE\(r\.rating/.test(sql)) return [[{
        efr_id: 21,
        efr_name: 'Sunil Yadav',
        efr_no: '9812343210',
        efr_profile_img: null,
        jobs_done: 18,
        on_time_jobs: 17,
        on_time_pct: 94,
        rating: 4.8,
        earnings: 11200,
      }]];
      return [[{ total: 1 }]];
    },
  };
  const result = await team.listMembers(7, { month: '2026-08', page: 2, limit: 100 }, db);
  assert.equal(calls.length, 2);
  assert.equal(result.limit, 50);
  assert.equal(result.items[0].name, 'Sunil Yadav');
  assert.equal(result.items[0].onTime, 17);
  assert.equal(result.items[0].earnings, 11200);
  assert.equal(Object.hasOwn(result.items[0], 'rework'), false);
  assert.equal(Object.hasOwn(result.items[0], 'teamUsed'), false);
  const dataCall = calls.find((call) => /ORDER BY COALESCE\(r\.rating/.test(call.sql));
  assert.match(dataCall.sql, /member\.efr_manager_id = \?/);
  assert.match(dataCall.sql, /et\.job_id IS NOT NULL/);
  assert.match(dataCall.sql, /paid_job\.checkout_date_time >= \?/);
  assert.match(dataCall.sql, /rated_job\.checkout_date_time >= \?/);
  assert.match(dataCall.sql, /COALESCE\(j\.on_time_pct, 0\) DESC/,
    'best-first sort may use percentage without exposing it as a job count');
  assert.deepEqual(dataCall.params.slice(-2), [50, 50]);
});

test('member detail returns uniform 404 before running metric queries when not a direct active report', async () => {
  let calls = 0;
  const db = {
    async query(sql) {
      calls += 1;
      assert.match(sql, /e\.efr_manager_id = \?/);
      return [[]];
    },
  };
  await assert.rejects(
    team.getMemberDetail(7, 999, { month: '2026-08' }, db),
    (error) => error.status === 404 && error.message === 'team member not found',
  );
  assert.equal(calls, 1);
});

test('member detail returns bounded paid jobs without unsupported commission claims', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT e\.efr_id/.test(sql)) return [[{
        efr_id: 21,
        efr_name: 'Sunil Yadav',
        efr_no: '9812343210',
        efr_profile_img: null,
        insert_date: '2026-03-01',
      }]];
      if (/AS jobs_done/.test(sql)) return [[{
        jobs_done: 18, on_time_jobs: 17, rating: 4.8, earnings: 11200,
      }]];
      if (/ORDER BY j\.checkout_date_time/.test(sql)) return [[{
        job_id: 88213,
        title: 'AC service',
        checkout_date_time: '2026-08-12',
        paid_amount: 450,
        job_rating: 5,
        on_time: 1,
      }]];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const result = await team.getMemberDetail(7, 21, { month: '2026-08' }, db);
  assert.equal(result.metrics.earnings, 11200);
  assert.equal(result.metrics.onTime, 17);
  assert.equal(result.lastJobs.length, 1);
  assert.equal(result.easyFixSince, '2026-03-01');
  assert.equal(Object.hasOwn(result, 'memberSince'), false);
  assert.equal(Object.hasOwn(result, 'earnedYou'), false);
  assert.equal(Object.hasOwn(result.metrics, 'gradeEffect'), false);
  const metricCall = calls.find((call) => /AS jobs_done/.test(call.sql));
  assert.match(metricCall.sql, /et\.job_id IS NOT NULL/);
  assert.match(metricCall.sql, /paid_job\.checkout_date_time >= \?/);
  assert.match(metricCall.sql, /member\.efr_manager_id = \?/,
    'the manager relation must be rechecked in the fact query');
  const jobsCall = calls.find((call) => /ORDER BY j\.checkout_date_time/.test(call.sql));
  assert.match(jobsCall.sql, /paid_job\.fk_easyfixter_id = \?/);
  assert.match(jobsCall.sql, /paid_job\.checkout_date_time >= \?/);
  assert.match(jobsCall.sql, /member\.efr_manager_id = \?/,
    'the manager relation must be rechecked in the bounded jobs query');
  assert.match(jobsCall.sql, /rated_job\.checkout_date_time >= \?/,
    'rating aggregation must stay inside the requested month');
});

test('mobile masking never returns the full number', () => {
  const masked = team._internals.maskMobile('+91 98765 43210');
  assert.notEqual(masked, '919876543210');
  assert.equal(masked.endsWith('210'), true);
});
