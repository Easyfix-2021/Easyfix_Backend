const test = require('node:test');
const { after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

/*
 * VERIFY FIRST, TRAIN BEFORE OFFERS (owner, 2026-09-30).
 *
 * Replaced "no activation out of TRAINING_PENDING until mandatory training is
 * done". CRM activation never refuses: a technician who still owes mandatory
 * training is VERIFIED and held in TRAINING_PENDING (efr_status 0, no offers);
 * finishing training then moves a verified technician straight to work.
 * Exercised through the real transition() with a fake connection. "Complete"
 * is mobile-registration.fetchTrainingCompletedTime, stubbed per test.
 */

const { pool } = require('../db');
const lifecycle = require('../services/easyfixer-lifecycle.service');
const registration = require('../services/mobile-registration.service');
const registrationPush = require('../services/registration-status-push.service');

const original = {
  query: pool.query,
  getConnection: pool.getConnection,
  fetchTrainingCompletedTime: registration.fetchTrainingCompletedTime,
  notify: registrationPush.notifyRegistrationStatusChanged,
};

let row;
let trainingDone;
let trainingLookups;
let calls;

function baseRow(overrides = {}) {
  return {
    efr_id: 77,
    efr_status: 0,
    is_technician_verified: null,
    efr_manager_id: 0,
    user_id: 5,
    adhaar_card_number: '123412341234',
    efr_profile_img: 'k',
    is_identity_details_verified_by_crm: 1,
    efr_profile_perc: 100,
    user_personal_details_filled: 1,
    user_is_personal_detail_filled: 1,
    lifecycle_status: 'TRAINING_PENDING',
    lifecycle_version: 3,
    lifecycle_source: 'SYSTEM',
    lifecycle_changed_at: '2026-09-20 10:00:00',
    ...overrides,
  };
}

beforeEach(() => {
  row = baseRow();
  trainingDone = null;
  trainingLookups = 0;
  calls = [];
  lifecycle._internals.resetSchemaProbeForTests();
  pool.query = async (sql, params = []) => {
    if (/information_schema\.columns/i.test(sql) && /tbl_easyfixer_lifecycle_status_log/i.test(sql)) {
      return [[{ column_count: params.length, history_count: 1 }]];
    }
    return [[]];
  };
  pool.getConnection = async () => ({
    async beginTransaction() { calls.push('begin'); },
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT e\.efr_id/i.test(sql)) return [[{ ...row }]];
      if (/FROM tbl_easyfixer_lifecycle_status_log/i.test(sql)) {
        return [[{ pause_count: 0, reapplication_count: 0 }]];
      }
      if (/^\s*(UPDATE|INSERT)/i.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`unexpected query: ${sql}`);
    },
    async commit() { calls.push('commit'); },
    async rollback() { calls.push('rollback'); },
    release() {},
  });
  registration.fetchTrainingCompletedTime = async () => {
    trainingLookups += 1;
    return trainingDone;
  };
  registrationPush.notifyRegistrationStatusChanged = async () => ({ delivered: false });
});

after(() => {
  pool.query = original.query;
  pool.getConnection = original.getConnection;
  registration.fetchTrainingCompletedTime = original.fetchTrainingCompletedTime;
  registrationPush.notifyRegistrationStatusChanged = original.notify;
  lifecycle._internals.resetSchemaProbeForTests();
});

const lifecycleWrites = () => calls.filter((c) => (
  typeof c === 'object' && /UPDATE tbl_easyfixer SET .*lifecycle_status = \?/is.test(c.sql)
));
const activate = () => lifecycle.activateFromVerification(77, { final_accept_comment: 'ok' }, { user_id: 9 });

/** The efr_status value the lifecycle write stamped, read by column position. */
function efrStatusWritten() {
  const [write] = lifecycleWrites();
  const sql = write.sql;
  const at = sql.indexOf('efr_status = ?');
  assert.ok(at > 0, 'the lifecycle write must set efr_status');
  return write.params[(sql.slice(0, at).match(/\?/g) || []).length];
}
const verifiedFlagWritten = () => calls.some((c) => typeof c === 'object' && /is_technician_verified = 1/.test(c.sql));

test('activation with training outstanding VERIFIES and holds in TRAINING_PENDING — never refuses', async () => {
  for (const status of ['TRAINING_PENDING', 'UNDER_VERIFICATION', null]) {
    row = baseRow({ lifecycle_status: status, efr_status: 1 });
    calls = [];
    trainingDone = null;
    const result = await activate();
    assert.equal(result.lifecycle.status, 'TRAINING_PENDING', String(status));
    assert.ok(verifiedFlagWritten(), `${status}: the verification is recorded`);
    assert.equal(lifecycleWrites().length, 1, String(status));
    assert.equal(efrStatusWritten(), 0, `${status}: held off work — efr_status 0, or it reads back ACTIVE`);
    assert.ok(calls.includes('commit'), String(status));
  }
});

test('activation with training done goes to work as before', async () => {
  for (const status of ['TRAINING_PENDING', 'UNDER_VERIFICATION', null]) {
    row = baseRow({ lifecycle_status: status });
    calls = [];
    trainingDone = '2026-09-25 12:00:00';
    const result = await activate();
    assert.equal(result.lifecycle.status, 'ACTIVE', String(status));
    assert.equal(efrStatusWritten(), 1, String(status));
  }
});

test('finishing training moves a VERIFIED technician straight to work', async () => {
  row = baseRow({ lifecycle_status: 'TRAINING_PENDING', is_technician_verified: 1, efr_status: 0 });
  const result = await lifecycle.finalizeTrainingCompletion(77);
  assert.equal(result.lifecycle.status, 'ACTIVE');
  assert.equal(result.transitionedFrom, 'TRAINING_PENDING');
  assert.equal(efrStatusWritten(), 1);
});

test('working technicians are never asked for training: an operational move to ACTIVE skips the rule', async () => {
  // PAUSED -> ACTIVE is a resume, not an activation; 15% of QA's working
  // technicians have not watched the video and must not be blocked by it.
  row = baseRow({ lifecycle_status: 'PAUSED', is_technician_verified: 1, efr_status: 1 });
  trainingDone = null;
  const result = await lifecycle.transition(77, { status: 'ACTIVE', source: 'CRM', reasonCode: 'RESUME', reason: 'resume' }, { user_id: 9 });
  assert.equal(result.lifecycle.status, 'ACTIVE');
  assert.equal(trainingLookups, 0, 'the rule never runs for a working technician');
});

test('the automatic post-training exit still advances TRAINING_PENDING -> UNDER_VERIFICATION', async () => {
  // finalizeTrainingCompletion moves unconditionally — its CALLER
  // (lms.settleTrainingCompletion) decides on the mandatory definition. It is
  // not an activation, so the activation rule must not intercept it.
  trainingDone = null;
  const result = await lifecycle.finalizeTrainingCompletion(77);
  assert.equal(result.changed, true);
  assert.equal(result.lifecycle.status, 'UNDER_VERIFICATION');
  assert.equal(result.transitionedFrom, 'TRAINING_PENDING');
  assert.equal(trainingLookups, 0);
  assert.equal(lifecycleWrites().length, 1);
});

/*
 * Gate 1 decides entry into TRAINING_PENDING on the SAME definition (owner,
 * 2026-09-28). It used lms.isTrainingComplete (ASSIGNED courses): with no
 * mandatory course assigned a registrant skipped TRAINING_PENDING, and the
 * activation rule above never got to run.
 */
test('Gate 1: mandatory training outstanding → TRAINING_PENDING, even with no course assigned', async () => {
  const lms = require('../services/lms.service');
  const saved = { assign: lms.assignMandatoryCourses, complete: lms.isTrainingComplete };
  lms.assignMandatoryCourses = async () => ({ assigned: 0 });
  lms.isTrainingComplete = async () => { throw new Error('Gate 1 must not ask the assigned-courses question'); };
  try {
    for (const [done, expected] of [[null, 'TRAINING_PENDING'], ['2026-09-25 12:00:00', 'UNDER_VERIFICATION']]) {
      row = baseRow({ lifecycle_status: 'REGISTRATION_INCOMPLETE' });
      calls = [];
      trainingDone = done;
      const result = await lifecycle.finalizeMobileRegistrationGate1(77);
      assert.equal(result.lifecycle.status, expected, `completedAt=${done}`);
    }
  } finally {
    lms.assignMandatoryCourses = saved.assign;
    lms.isTrainingComplete = saved.complete;
  }
});

/*
 * The mandatory-course INSERT must run BEFORE transition() takes the
 * technician's row lock (QA 2026-09-30, efrId 10798). easyfixer_courses has a
 * foreign key to tbl_easyfixer, and the INSERT runs on the pool, not on the
 * locking connection — inside the lock it waited on that very row until
 * innodb_lock_wait_timeout (50 s), and every identity save that finalized
 * Gate 1 reported failure to the app.
 */
test('Gate 1: mandatory courses are assigned before the row lock, never inside it', async () => {
  const lms = require('../services/lms.service');
  const saved = lms.assignMandatoryCourses;
  const order = [];
  lms.assignMandatoryCourses = async () => {
    order.push(calls.some((c) => c === 'begin') ? 'assign-inside-lock' : 'assign-before-lock');
    return { assigned: 1 };
  };
  try {
    row = baseRow({ lifecycle_status: 'REGISTRATION_INCOMPLETE' });
    calls = [];
    await lifecycle.finalizeMobileRegistrationGate1(77);
    assert.deepEqual(order, ['assign-before-lock']);
    assert.ok(calls.includes('begin'), 'positive control: the transition did open its transaction');
  } finally {
    lms.assignMandatoryCourses = saved;
  }
});

test('Gate 1: nothing stored + flags already UNDER_VERIFICATION + training outstanding -> TRAINING_PENDING', async () => {
  const lms = require('../services/lms.service');
  const saved = lms.assignMandatoryCourses;
  lms.assignMandatoryCourses = async () => ({ assigned: 0 });
  try {
    row = baseRow({ lifecycle_status: null, is_identity_details_verified_by_crm: null });
    calls = [];
    trainingDone = null;
    const pending = await lifecycle.finalizeMobileRegistrationGate1(77);
    assert.equal(pending.lifecycle.status, 'TRAINING_PENDING', 'Gate 1 must not no-op an applicant who owes training');
    assert.equal(lifecycleWrites().length, 1);

    row = baseRow({ lifecycle_status: null, is_identity_details_verified_by_crm: null });
    calls = [];
    trainingDone = '2026-09-25 12:00:00';
    const done = await lifecycle.finalizeMobileRegistrationGate1(77);
    assert.equal(done.lifecycle.status, 'UNDER_VERIFICATION', 'training done: stays under verification');
  } finally {
    lms.assignMandatoryCourses = saved;
  }
});

test('the nightly drift heal still adopts a legacy-activated technician without a training lookup', async () => {
  // Activated by the legacy app (verified bit + efr_status 1) while the stored
  // status still says UNDER_VERIFICATION: current reads as ACTIVE, so he is not
  // an applicant and the rule must not refuse the heal.
  row = baseRow({ lifecycle_status: 'UNDER_VERIFICATION', is_technician_verified: 1, efr_status: 1 });
  trainingDone = null;
  const result = await lifecycle.reconcileLegacyStatus(77);
  assert.equal(result.lifecycle.status, 'ACTIVE');
  assert.equal(trainingLookups, 0);
});
