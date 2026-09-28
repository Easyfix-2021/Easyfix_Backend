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

  /*
   * FOUR since 2026-09-10, not three. The onboarding gate gained its second
   * half: a mandatory course can hold a document or an assessment, which
   * `mandatoryVideoIdsSql` (kind = 'video') cannot see, so a technician was
   * reported training-complete without passing a mandatory assessment.
   *
   * The original assertion below forbade ANY easyfixer_courses read from this
   * path. Its stated intent — the test's own name — is narrower: no second
   * OVERDUE query, because overdue arrives on the authenticated lifecycle
   * snapshot and re-deriving it here would be both slower and able to
   * disagree with the value the caller was handed. That intent is preserved
   * and made explicit, rather than the budget being quietly raised: exactly
   * one courses read is allowed, it must be the completion half, and it must
   * not touch the columns overdue is computed from.
   */
  assert.equal(fake.calls.length, 4,
    'status keeps a bounded budget: three, plus the mandatory-content half of the gate');

  const courseReads = fake.calls.filter(({ sql }) => /FROM easyfixer_courses/i.test(sql));
  assert.equal(courseReads.length, 1,
    'exactly one — a second would mean overdue is being re-derived here');
  assert.match(courseReads[0].sql, /lc\.kind <> 'video'/,
    'the one permitted courses read is the non-video half of the training gate');
  assert.ok(!/due_date|completion_date/i.test(courseReads[0].sql),
    'registration status must not perform a second overdue-training query — overdue\n'
    + '  comes from the authenticated lifecycle snapshot, and a local re-derivation\n'
    + '  can disagree with the value the caller was given');
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
  assert.equal(fake.calls.length - callsBefore, 4,
    'removing the PAN job gate must not add status queries. The fourth is the\n'
    + '  mandatory-content half of the training gate, added deliberately in\n'
    + '  2026-09-10 — see the budget note above.');
});

/*
 * THE STATUS ROW MUST CARRY dob_present AND serviceable_pincodes_present
 * (QA, 2026-09-25). profileCompletion.fromRow() reads both, but fetchGateRow
 * never selected them — so since 4c78898 (2026-09-02) every status call
 * reported the DOB missing and the Work Area incomplete, whatever was stored,
 * and Gate 1 could never complete from this endpoint. The SQL is asserted,
 * not just the flags: a fake row can carry any column the query never asks for.
 */
test('the status query computes dob_present and serviceable_pincodes_present, and the flags reach the response', async () => {
  await primeLmsProbe();
  fake.reset();
  gateRow.dob_present = 1;
  gateRow.serviceable_pincodes_present = 1;
  try {
    const status = await registration.getStatus(8379, {
      status: 'ACTIVE', jobsAllowed: true, capabilities: { receiveNewJobs: true, claimMoney: true },
    });
    const gate = fake.calls.find((c) => /FROM tbl_easyfixer e[\s\S]*LEFT JOIN tbl_user u/i.test(c.sql));
    assert.ok(gate, 'positive control: the status row query ran');
    assert.match(gate.sql, /AS dob_present/, 'the status row must compute dob_present');
    assert.match(gate.sql, /AS serviceable_pincodes_present/, 'the status row must compute serviceable_pincodes_present');
    assert.equal(status.flags.dobPresent, true);
    assert.equal(status.flags.serviceablePincodesPresent, true);
    assert.equal(status.flags.workAreaComplete, true);
  } finally {
    delete gateRow.dob_present;
    delete gateRow.serviceable_pincodes_present;
  }
});
