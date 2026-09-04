/*
 * THE OFFER MODEL, reassign side — jobService.assign() moving a job from one
 * technician to ANOTHER must OFFER it (accept/reject), not hard-assign it, so
 * the incoming technician never silently inherits someone else's work.
 *
 * Pins the four decisions the behaviour rests on:
 *   (a) the OUTGOING claim is released — fk_easyfixter_id NULL, job back to
 *       BOOKED — because acceptOffer()'s first-wins gate needs exactly that.
 *   (b) a REJECT (or an offer nobody answers) leaves the job UNASSIGNED; it
 *       never falls back to the previous technician.
 *   (c) every OPEN offer from the previous round is expired job-wide before
 *       the new one goes out.
 *   ... and the blast radius: same technician, started jobs and a flag-OFF
 *   deploy all keep the legacy direct-assign path.
 *
 * Non-destructive: fake pool, per-test STOP-sentinel, no real DB.
 * Runner: `node --test --test-force-exit`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const active = (id) => ({
  efr_id: id,
  efr_status: 1,
  is_technician_verified: 1,
  efr_manager_id: null,
  scheduled_reactivation_date: null,
  lifecycle_status: 'ACTIVE',
  lifecycle_reason_code: null,
  lifecycle_reason: null,
  lifecycle_version: 1,
});

const OFFER_FLOW_ON = { 'job.offer.flow.enabled': 'true' };
const OFFER_FLOW_OFF = { 'job.offer.flow.enabled': 'false' };

// SCHEDULED job owned by technician 99; the reassign target is 42.
const defaults = () => ({
  props: OFFER_FLOW_ON,
  techRows: [active(42)],
  job: { job_id: 100, job_status: 1, fk_easyfixter_id: 99 },
  // What a FOR UPDATE re-read sees before the release. Diverging it from `job`
  // simulates a racing accept/unassign landing between the two reads.
  lockedJob: { job_id: 100, job_status: 1, fk_easyfixter_id: 99 },
  // What the job row reads as once the release has committed. The release is
  // a real state change mid-flow (offerToTechnicians re-reads the row and
  // refuses an owned job), so the fake has to model it or the second half of
  // the flow is never exercised.
  releasedJob: { job_id: 100, job_status: 0, fk_easyfixter_id: null },
  latestOffer: [],
  stopOn: /INSERT INTO tbl_job_offer/,
});
const scenario = defaults();

const RELEASE_UPDATE = /UPDATE tbl_job\s+SET fk_easyfixter_id = NULL/;
const DIRECT_ASSIGN_UPDATE = /^\s*UPDATE tbl_job SET fk_easyfixter_id = \?/;

let calls;
const released = () => calls.some((c) => RELEASE_UPDATE.test(c.sql));

const fake = installFakePool(
  [
    [/FROM easyfix_properties/i, () =>
      Object.entries(scenario.props).map(([property_key, property_value]) => ({ property_key, property_value }))],
    [/SHOW COLUMNS/i, []],
    [/FROM information_schema/i, [{ column_count: 6, history_count: 1 }]],
    [/SELECT 1 FROM tbl_job_offer LIMIT 1/i, [{ 1: 1 }]],
    [/FROM tbl_easyfixer e\s+WHERE e\.efr_id IN/, () => scenario.techRows],
    [/FROM tbl_easyfixer e\s+WHERE e\.efr_id = \?/, () => scenario.techRows],
    // One route serving three views of the same row: the unlocked getJobMeta
    // preload, the locked re-read (which may have drifted), and — once the
    // release has committed — the freed row the offer is actually issued
    // against. Collapsing them would prove nothing about either guard.
    [/SELECT job_id, job_status, fk_easyfixter_id/, (sql) => [
      released() ? scenario.releasedJob : (/FOR UPDATE/i.test(sql) ? scenario.lockedJob : scenario.job),
    ]],
    [RELEASE_UPDATE, { affectedRows: 1 }],
    [/FROM tbl_job_offer\s+WHERE job_id = \? AND fk_easyfixter_id = \?/, () => scenario.latestOffer],
    [/FROM tbl_job_offer jo/, []],
    // rejectOffer treats affectedRows !== 1 as a lost race and 409s.
    [/UPDATE tbl_job_offer\s+SET offer_status = 2/, { affectedRows: 1 }],
  ],
  // Indirection so each test can stop at the statement it characterizes.
  { stopOn: { test: (sql) => scenario.stopOn.test(sql) } },
);
calls = fake.calls;

const propsSvc = require('../services/properties.service');
const jobSvc = require('../services/job.service');

// job.service.js destructures getProperty at require time, so the flag has to
// be driven through the REAL properties cache — a stub on the module object
// would silently miss.
async function applyProps() { await propsSvc.flushCache(); }

beforeEach(async () => {
  fake.reset();
  Object.assign(scenario, defaults());
  await applyProps();
});

const stopped = (error) => error.__stop === true;
const find = (re) => calls.find((c) => re.test(c.sql));
const has = (re) => calls.some((c) => re.test(c.sql));

test('reassign to a NEW technician offers the job instead of hard-assigning it', async () => {
  await assert.rejects(
    () => jobSvc.assign(100, { easyfixerId: 42 }, { user_id: 9 }),
    stopped,
  );

  assert.ok(has(/INSERT INTO tbl_job_offer/), 'the incoming technician must get an OFFERED row');
  assert.ok(
    !has(DIRECT_ASSIGN_UPDATE),
    'the incoming technician must NOT be hard-assigned — acceptance is what schedules the job',
  );
});

test('(a) the outgoing claim is released: fk cleared and the job returns to BOOKED', async () => {
  await assert.rejects(
    () => jobSvc.assign(100, { easyfixerId: 42 }, { user_id: 9 }),
    stopped,
  );

  const release = find(RELEASE_UPDATE);
  assert.ok(release, 'the previous technician must be removed from the job');
  assert.match(release.sql, /job_status = 0/, 'the job goes back to BOOKED so acceptOffer can claim it');
  assert.match(release.sql, /scheduled_date_time = NULL/);
  assert.ok(release.params.includes(99), 'the release is scoped to the OUTGOING technician');

  // The release is audited against the outgoing technician, not the incoming
  // one — otherwise the reassign reads as an unexplained disappearance.
  const history = calls.find((c) => /INSERT INTO scheduling_history/.test(c.sql));
  assert.ok(history, 'the outgoing technician gets their own scheduling_history row');
  assert.equal(history.params[1], 99);
  assert.equal(history.params[3], 'Reassigned to another technician');
});

test('(a) the offer is issued against the RELEASED job, never the owned one', async () => {
  await assert.rejects(
    () => jobSvc.assign(100, { easyfixerId: 42 }, { user_id: 9 }),
    stopped,
  );

  // offerToTechnicians 409s (JOB_NOT_OFFERABLE) on a job that still has an
  // owner. Reaching the INSERT proves the release committed first.
  const lockReads = calls.filter((c) => /SELECT job_id, job_status, fk_easyfixter_id/.test(c.sql));
  assert.ok(lockReads.length >= 3, 'assign preloads, releases under lock, then the offer re-locks');
  assert.ok(has(/INSERT INTO tbl_job_offer/));
});

test('(b) a reject on the re-offered job leaves it UNASSIGNED, never back on the previous technician', async () => {
  // Post-release state: BOOKED, ownerless, technician 42 holding an OPEN offer.
  scenario.job = { job_id: 100, job_status: 0, fk_easyfixter_id: null };
  scenario.lockedJob = scenario.job;
  scenario.releasedJob = scenario.job;
  scenario.latestOffer = [{ job_offer_id: 7, offer_status: 0 }];
  // No stop-sentinel: rejectOffer returns a compact ack without hydrating the
  // job, so it can run to completion — and only a completed run can prove that
  // NOTHING later in the flow puts the previous technician back.
  scenario.stopOn = /$^/;

  const result = await jobSvc.rejectOffer(100, 42, { reason: 'Not available' });
  assert.deepEqual(result, { rejected: true, jobId: 100, legacyUnassigned: false });

  const reject = find(/UPDATE tbl_job_offer/);
  assert.match(reject.sql, /offer_status = 2/, 'the pool decision is recorded as REJECTED');
  assert.ok(
    !has(/UPDATE tbl_job\b/),
    'rejecting must not write tbl_job at all — the job stays BOOKED and ownerless, '
    + 'it never falls back to the previous technician',
  );
});

test('(c) every open offer from the previous round is expired before the new one goes out', async () => {
  await assert.rejects(
    () => jobSvc.assign(100, { easyfixerId: 42 }, { user_id: 9 }),
    stopped,
  );

  const sweep = calls.find((c) =>
    /UPDATE tbl_job_offer/.test(c.sql) && /offer_status = 3/.test(c.sql) && /WHERE job_id = \? AND offer_status = 0/.test(c.sql));
  assert.ok(sweep, 'a job-wide expiry sweep must close stale open offers');

  const sweepAt = calls.indexOf(sweep);
  const insertAt = calls.findIndex((c) => /INSERT INTO tbl_job_offer/.test(c.sql));
  assert.ok(sweepAt < insertAt, 'the sweep runs BEFORE the new offer, or it would expire the new one');
});

test('reassign to the SAME technician takes the direct path and creates no offer', async () => {
  scenario.techRows = [active(99)];
  scenario.stopOn = DIRECT_ASSIGN_UPDATE;

  await assert.rejects(
    () => jobSvc.assign(100, { easyfixerId: 99 }, { user_id: 9 }),
    stopped,
  );

  assert.ok(has(DIRECT_ASSIGN_UPDATE), 're-stamping the same technician stays a direct write');
  assert.ok(!has(RELEASE_UPDATE), 'the technician must not be released and re-offered their own job');
  assert.ok(!has(/INSERT INTO tbl_job_offer/));
});

test('a STARTED job is reassigned directly — it is never rewound to BOOKED', async () => {
  scenario.job = { job_id: 100, job_status: 2, fk_easyfixter_id: 99 };
  scenario.lockedJob = scenario.job;
  scenario.stopOn = DIRECT_ASSIGN_UPDATE;

  await assert.rejects(
    () => jobSvc.assign(100, { easyfixerId: 42 }, { user_id: 9 }),
    stopped,
  );

  assert.ok(has(DIRECT_ASSIGN_UPDATE));
  assert.ok(!has(RELEASE_UPDATE), 'IN_PROGRESS is outside DIRECT_REJECTABLE_STATES');
});

test('with the offer flow OFF a reassign keeps the legacy hard-assign behaviour', async () => {
  scenario.props = OFFER_FLOW_OFF;
  await applyProps();
  scenario.stopOn = DIRECT_ASSIGN_UPDATE;

  await assert.rejects(
    () => jobSvc.assign(100, { easyfixerId: 42 }, { user_id: 9 }),
    stopped,
  );

  const upd = find(DIRECT_ASSIGN_UPDATE);
  assert.equal(upd.params[0], 42, 'the incoming technician is written straight onto the job');
  assert.ok(!has(RELEASE_UPDATE));
  assert.ok(!has(/INSERT INTO tbl_job_offer/));
});

test('an INELIGIBLE incoming technician is refused BEFORE the job is released', async () => {
  scenario.techRows = [{ ...active(42), efr_status: 0, lifecycle_status: 'PAUSED', lifecycle_reason: 'Suspended' }];

  await assert.rejects(
    () => jobSvc.assign(100, { easyfixerId: 42 }, { user_id: 9 }),
    (error) => error.status === 400 && error.code === 'TECH_CANNOT_RECEIVE_JOBS',
  );

  // Releasing first would strand the job ownerless as the side effect of a
  // request that then 400s — worse than the defect being fixed.
  assert.ok(!has(RELEASE_UPDATE), 'the outgoing technician keeps the job when the reassign is refused');
  assert.ok(!has(/INSERT INTO tbl_job_offer/));
});

test('ownership drift observed under lock aborts the release with a 409', async () => {
  // The unlocked preload sees technician 99 and selects the re-offer branch;
  // by the time the row lock is taken, someone else already moved the job.
  scenario.lockedJob = { job_id: 100, job_status: 1, fk_easyfixter_id: 77 };

  await assert.rejects(
    () => jobSvc.assign(100, { easyfixerId: 42 }, { user_id: 9 }),
    (error) => error.status === 409 && error.code === 'JOB_ASSIGNMENT_CHANGED',
  );
  assert.ok(!has(RELEASE_UPDATE), 'a stale request must never release the current owner');
});

/*
 * ── (d) THE OUTGOING TECHNICIAN IS TOLD ─────────────────────────────
 * The release happens the instant the button is clicked, so without this push
 * a technician can keep travelling to a job that is no longer theirs — they
 * would learn only on their next app refresh.
 *
 * The push module is reached through `require(...)` AT CALL TIME inside
 * assign(), so replacing the export here is enough to intercept it; a
 * destructured import would have been captured at load and missed the stub.
 */
test('(d) the OUTGOING technician is pushed that the job has been taken away', async () => {
  const pushSvc = require('../services/job-offer-push.service');
  const real = pushSvc.sendJobRemovedPush;
  const sent = [];
  pushSvc.sendJobRemovedPush = async (efrId, opts) => { sent.push({ efrId, ...opts }); return { delivered: true }; };
  try {
    await assert.rejects(
      () => jobSvc.assign(100, { easyfixerId: 42 }, { user_id: 9 }),
      stopped,
    );
  } finally {
    pushSvc.sendJobRemovedPush = real;
  }

  assert.equal(sent.length, 1, 'exactly one removal push');
  assert.equal(sent[0].efrId, 99, 'it goes to the OUTGOING technician, never the incoming one');
  assert.equal(sent[0].jobId, 100);
});

/*
 * The removal message deliberately carries NO routing key, and that is load
 * bearing on both apps — see the block comment on sendJobRemovedPush. A future
 * edit that "helpfully" adds job_id to make the push deep-link would send the
 * technician to a job they can no longer fetch, so pin it here rather than in
 * prose.
 */
test('(d2) the removal push carries no deep-link key for a job the technician has lost', async () => {
  const pushSvc = require('../services/job-offer-push.service');
  const pushDelivery = require('../services/push-delivery.service');
  const realDeliver = pushDelivery.deliverToEfr;
  let captured = null;
  pushDelivery.deliverToEfr = async (efrId, message) => {
    captured = message;
    return { delivered: true, deliveredCount: 1, tokenCount: 1 };
  };
  try {
    await pushSvc.sendJobRemovedPush(99, { jobId: 100 });
  } finally {
    pushDelivery.deliverToEfr = realDeliver;
  }

  assert.ok(captured, 'the push must actually reach the delivery layer');
  assert.equal(captured.data.type, 'job_removed');
  assert.equal(captured.data.removedJobId, '100', 'the id travels under a NON-routing key');
  // Expo routeTap deep-links on jobId ?? job_id; legacy Flutter switches on screen.
  for (const key of ['job_id', 'jobId', 'screen']) {
    assert.ok(!(key in captured.data), `data.${key} would deep-link into a job this technician has lost`);
  }
  assert.match(captured.body, /100/, 'the body names the job, since the tap cannot');
});
