const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { installFakePool } = require('./helpers/fake-pool');
const lifecycleService = require('../services/easyfixer-lifecycle.service');
const deepSkillService = require('../services/deep-skill.service');

const gateRow = {
  efr_id: 8379,
  efr_first_name: 'Rahul',
  efr_name: 'Rahul Kumar',
  efr_no: '9999999999',
  efr_profile_img: 'profiles/8379.jpg',
  efr_profile_perc: 100,
  efr_status: 1,
  efr_manager_id: null,
  is_technician_verified: 1,
  is_identity_details_verified_by_crm: 1,
  is_personal_details_verified_by_crm: 1,
  adhaar_card_number: '123412341234',
  pan_card_number: null,
  efr_service_type: null,
  efr_service_category: '1',
  user_id: 99,
  user_personal_details_filled: 1,
  user_is_personal_detail_filled: 1,
  user_is_released: 1,
};

const fake = installFakePool([
  [/FROM tbl_easyfixer e[\s\S]*LEFT JOIN tbl_user u/i, [gateRow]],
  [/FROM easyfixer_watched_video w/i, [{
    total: 1,
    done: 1,
    last_done: '2026-08-14 09:00:00',
  }]],
  [/FROM tbl_efr_deepskill_mapping/i, []],
]);

const originalReadProjection = lifecycleService.readProjection;
const originalLifecycleFromRow = lifecycleService.lifecycleFromRow;
const originalResolveImageUrlFromKey = deepSkillService.resolveImageUrlFromKey;

lifecycleService.readProjection = async () => 'NULL AS lifecycle_status';
lifecycleService.lifecycleFromRow = () => {
  throw new Error('authenticated lifecycle must not be re-derived');
};
deepSkillService.resolveImageUrlFromKey = async () => 'https://example.test/profiles/8379.jpg';

const registration = require('../services/mobile-registration.service');
const lms = require('../services/lms.service');

/*
 * The LMS flag probe is primed at BOOT (server.js) and cached for the process,
 * so it is not per-request work and must not be counted against the budget
 * below. Primed here for the same reason, against a fake that answers "both
 * columns present" — the shape production runs in.
 *
 * The budget itself is unchanged and still means what it did: three queries per
 * status call, and no second overdue-training query.
 */
async function primeLmsProbe() {
  const db = require('../db');
  const previous = db.pool.query;
  db.pool.query = async () => [[
    { t: 'courses', c: 'is_mandatory' },
    { t: 'training_videos', c: 'is_global' },
  ], []];
  lms.invalidateLmsSchemaCache();
  await lms.lmsFlagColumns();
  db.pool.query = previous;
  fake.reset();
}

after(() => {
  lifecycleService.readProjection = originalReadProjection;
  lifecycleService.lifecycleFromRow = originalLifecycleFromRow;
  deepSkillService.resolveImageUrlFromKey = originalResolveImageUrlFromKey;
  fake.restore();
});

test('status overlays the request lifecycle and locks jobs without another overdue query', async () => {
  await primeLmsProbe();
  const authenticatedLifecycle = {
    status: 'ACTIVE',
    jobsAllowed: true,
    trainingOverdue: true,
    capabilities: {
      receiveNewJobs: false,
      continueAssignedJobs: false,
      mutateAssignedJobs: false,
      markAttendance: false,
      claimMoney: true,
    },
  };

  const status = await registration.getStatus(8379, authenticatedLifecycle);

  assert.strictEqual(status.lifecycle, authenticatedLifecycle);
  assert.equal(status.lifecycle.trainingOverdue, true);
  assert.equal(status.lifecycle.capabilities.receiveNewJobs, false);
  assert.equal(status.jobsUnlocked, false,
    'the effective receiveNewJobs capability must override the persisted jobsAllowed bit');
  assert.deepEqual(status.checklist, {
    verified: true,
    panPresent: false,
    hasSkills: true,
    trainingComplete: true,
  }, 'PAN remains visible as payout readiness without affecting the lifecycle lock');

  assert.equal(fake.calls.length, 3, 'status keeps its existing bounded three-query budget');
  assert.ok(!fake.calls.some(({ sql }) => /FROM easyfixer_courses/i.test(sql)),
    'registration status must not perform a second overdue-training query');
});

test('verified technician with skills and training unlocks jobs without PAN', async () => {
  const callsBefore = fake.calls.length;
  const authenticatedLifecycle = {
    status: 'ACTIVE',
    jobsAllowed: true,
    trainingOverdue: false,
    capabilities: {
      receiveNewJobs: true,
      continueAssignedJobs: true,
      mutateAssignedJobs: true,
      markAttendance: true,
      claimMoney: true,
    },
  };

  const status = await registration.getStatus(8379, authenticatedLifecycle);

  assert.equal(status.jobsUnlocked, true);
  assert.deepEqual(status.checklist, {
    verified: true,
    panPresent: false,
    hasSkills: true,
    trainingComplete: true,
  });
  assert.equal(fake.calls.length - callsBefore, 3,
    'removing the PAN job gate must not add status queries');
});
