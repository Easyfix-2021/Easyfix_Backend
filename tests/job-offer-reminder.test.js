/*
 * Characterization tests for the job-offer ESCALATION REMINDER cron.
 *
 * Pins the three properties that make this cron safe to switch on:
 *   1. It is DOUBLE-gated and default-off — with the flags unset it touches
 *      nothing at all (not even a SELECT).
 *   2. The selection window: no reminder before 5 min, none once the offer is
 *      close to the 30-min expiry, and never for an offer that is not OPEN.
 *   3. The 2-reminder cap + idempotency, which are the whole reason
 *      last_reminded_at exists — a 2-minute cron re-reading the same row must
 *      not spam the technician.
 *
 * The fake pool here does more than canned rows: it EVALUATES the cron's own
 * bound eligibility params against an in-memory offer row and a fake clock, so
 * the timeline test drives the REAL runner (real SQL params, real claim/
 * affectedRows logic) across a simulated 40 minutes. Nothing is stubbed except
 * time and the storage.
 *
 * Non-destructive: fake pool, no real DB, no network. Runner: `node --test`.
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const MIN = 60_000;

// ── Simulated world ──────────────────────────────────────────────────
let props = {};
let now = 0;                 // fake "NOW()" in ms
let offer = null;            // the single in-memory tbl_job_offer row
let job = null;              // the tbl_job row the EXISTS clause checks
let technician = null;       // the tbl_easyfixer row the lifecycle gate checks
let selects = 0;             // how many eligibility SELECTs the runner issued

// Mirror of ELIGIBLE_SQL, evaluated against the params the runner actually
// bound. Keeping this driven by the runner's OWN params (rather than by the
// test's constants) is what makes it a real test of the query.
function eligible([afterMin, maxAgeMin, intervalMin]) {
  if (!offer || offer.offer_status !== 0) return false;
  if (!(offer.offered_at <= now - afterMin * MIN)) return false;
  if (!(offer.offered_at > now - maxAgeMin * MIN)) return false;
  if (!(offer.last_reminded_at == null || offer.last_reminded_at <= now - intervalMin * MIN)) return false;
  // The EXISTS on tbl_job — the offer row alone never says whether the JOB is
  // still offerable (nothing closes offers when a job is cancelled/assigned).
  const jobEligible = !!job && job.job_id === offer.job_id
    && job.job_status === 0 && job.fk_easyfixter_id == null;
  const technicianEligible = !!technician
    && technician.efr_id === offer.fk_easyfixter_id
    && technician.efr_status === 1
    && technician.is_technician_verified === 1;
  return jobEligible && technicianEligible;
}

const fake = installFakePool([
  [/FROM easyfix_properties/i, () =>
    Object.entries(props).map(([property_key, property_value]) => ({ property_key, property_value }))],

  // The per-row claim. Routed BEFORE the SELECT so the more specific write wins.
  [/UPDATE tbl_job_offer\s+SET last_reminded_at/i, (_sql, params) => {
    const [offerId, ...windowParams] = params;
    if (offer && offer.job_offer_id === offerId && eligible(windowParams)) {
      offer.last_reminded_at = now;
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }],

  [/SELECT job_offer_id, job_id, fk_easyfixter_id\s+FROM tbl_job_offer/i, (_sql, params) => {
    selects += 1;
    return eligible(params)
      ? [{ job_offer_id: offer.job_offer_id, job_id: offer.job_id, fk_easyfixter_id: offer.fk_easyfixter_id }]
      : [];
  }],

  // Token lookups (push-delivery) fall through to [] → "no tokens" → the real
  // sendJobOfferPush short-circuits before any FCM call. No network, no stub.
]);

const propsSvc = require('../services/properties.service');
const reminderCron = require('../services/job-offer-reminder-cron');
const { OFFER_TTL_MINUTES } = require('../services/job.service');

async function setProps(next) {
  props = next;
  await propsSvc.flushCache();
}

const FLAGS_ON = {
  'job.offer.loud_alert.enabled': 'true',
  'job.offer.reminder.enabled': 'true',
};

function freshOffer() {
  return { job_offer_id: 7, job_id: 100, fk_easyfixter_id: 42, offer_status: 0, offered_at: now, last_reminded_at: null };
}

after(() => fake.restore());
beforeEach(() => {
  fake.reset();
  now = Date.parse('2026-07-29T10:00:00Z');
  offer = freshOffer();
  // The matching job: still BOOKED (0) and owner-less, i.e. genuinely offerable.
  job = { job_id: 100, job_status: 0, fk_easyfixter_id: null };
  technician = { efr_id: 42, efr_status: 1, is_technician_verified: 1 };
  selects = 0;
});

// ─── Window arithmetic ───────────────────────────────────────────────

test('the eligibility window derives the reminder cap and never outlives the offer', () => {
  assert.equal(
    reminderCron.MAX_REMINDER_AGE_MINUTES,
    reminderCron.REMINDER_AFTER_MINUTES + reminderCron.REMINDER_INTERVAL_MINUTES * reminderCron.MAX_REMINDERS,
    'the window width is what enforces the cap — it must stay derived, not hard-coded',
  );
  assert.ok(
    reminderCron.MAX_REMINDER_AGE_MINUTES <= OFFER_TTL_MINUTES,
    'a reminder must never point at an offer acceptOffer() would already refuse',
  );
});

// ─── Gating ──────────────────────────────────────────────────────────

test('flags off: the runner is a total no-op — it does not even query', async () => {
  await setProps({});
  fake.reset();
  const r = await reminderCron.runOfferReminders();
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'flags off');
  assert.equal(selects, 0, 'no eligibility SELECT may run while the feature is off');
  assert.ok(!fake.calls.some((c) => /tbl_job_offer/i.test(c.sql)), 'the offer table must not be touched at all');
});

test('master on but reminder sub off: still a no-op (the sub must be opted into)', async () => {
  await setProps({ 'job.offer.loud_alert.enabled': 'true' });
  fake.reset();
  const r = await reminderCron.runOfferReminders();
  assert.equal(r.skipped, true);
  assert.ok(!fake.calls.some((c) => /tbl_job_offer/i.test(c.sql)));
});

test('reminder sub on but master off: still a no-op (the master overrides)', async () => {
  await setProps({ 'job.offer.reminder.enabled': 'true' });
  fake.reset();
  const r = await reminderCron.runOfferReminders();
  assert.equal(r.skipped, true);
  assert.ok(!fake.calls.some((c) => /tbl_job_offer/i.test(c.sql)));
});

// ─── Selection window ────────────────────────────────────────────────

test('an offer younger than the first-reminder delay is not selected', async () => {
  await setProps(FLAGS_ON);
  now += (reminderCron.REMINDER_AFTER_MINUTES - 1) * MIN;
  const r = await reminderCron.runOfferReminders();
  assert.equal(r.eligible, 0);
  assert.equal(r.claimed, 0);
  assert.equal(offer.last_reminded_at, null, 'nothing may be stamped for an offer that was not reminded');
});

test('an offer past the reminder window is not selected (near-expiry offers are left alone)', async () => {
  await setProps(FLAGS_ON);
  now += (reminderCron.MAX_REMINDER_AGE_MINUTES + 1) * MIN;
  const r = await reminderCron.runOfferReminders();
  assert.equal(r.eligible, 0);
  assert.equal(r.claimed, 0);
});

test('a non-OPEN offer is never reminded, whatever its age', async () => {
  await setProps(FLAGS_ON);
  offer.offer_status = 1; // ACCEPTED
  now += (reminderCron.REMINDER_AFTER_MINUTES + 1) * MIN;
  const r = await reminderCron.runOfferReminders();
  assert.equal(r.eligible, 0);
});

test('a CANCELLED job is never reminded, even while its offer row is still open', async () => {
  await setProps(FLAGS_ON);
  // Nothing closes tbl_job_offer rows on cancel, so the offer stays OPEN — the
  // job predicate is the only thing standing between the tech and a push for a
  // dead job.
  job.job_status = 6; // CANCELLED
  now += reminderCron.REMINDER_AFTER_MINUTES * MIN;
  const r = await reminderCron.runOfferReminders();
  assert.equal(r.eligible, 0, 'the SELECT must exclude an offer whose job is cancelled');
  assert.equal(r.claimed, 0);
  assert.equal(offer.last_reminded_at, null);
});

test('a job already assigned to someone else is never reminded (losing offers stay open)', async () => {
  await setProps(FLAGS_ON);
  job.fk_easyfixter_id = 99; // direct-assigned to another tech
  now += reminderCron.REMINDER_AFTER_MINUTES * MIN;
  const r = await reminderCron.runOfferReminders();
  assert.equal(r.eligible, 0);
  assert.equal(r.claimed, 0);
});

test('a lifecycle-restricted technician is never selected or reminded', async () => {
  await setProps(FLAGS_ON);
  technician.efr_status = 0;
  now += reminderCron.REMINDER_AFTER_MINUTES * MIN;

  const r = await reminderCron.runOfferReminders();

  assert.equal(r.eligible, 0);
  assert.equal(r.claimed, 0);
  assert.equal(offer.last_reminded_at, null);
  const select = fake.calls.find((call) => (
    /SELECT job_offer_id, job_id, fk_easyfixter_id/i.test(call.sql)
  ));
  assert.match(select.sql, /EXISTS \(SELECT 1 FROM tbl_easyfixer ef/i);
  assert.match(select.sql, /ef\.efr_status = 1/i);
  assert.match(select.sql, /ef\.is_technician_verified = 1/i);
});

test('an open, unanswered offer inside the window IS claimed and stamped', async () => {
  await setProps(FLAGS_ON);
  now += reminderCron.REMINDER_AFTER_MINUTES * MIN;
  const r = await reminderCron.runOfferReminders();
  assert.equal(r.eligible, 1);
  assert.equal(r.claimed, 1, 'the conditional claim must succeed for a fresh eligible offer');
  assert.equal(offer.last_reminded_at, now, 'last_reminded_at is stamped BEFORE the push, so a push failure cannot re-spam');

  // The claim re-asserts the eligibility predicate — that is what makes it
  // atomic against a second replica.
  const claim = fake.calls.find((c) => /UPDATE tbl_job_offer\s+SET last_reminded_at/i.test(c.sql));
  assert.ok(claim, 'the claim UPDATE must be issued');
  assert.match(claim.sql, /offer_status = 0/, 'claim re-checks the offer is still OPEN');
  assert.match(claim.sql, /last_reminded_at IS NULL OR last_reminded_at <= NOW\(\)/, 'claim re-checks the spacing');
  assert.match(claim.sql, /EXISTS \(SELECT 1 FROM tbl_job j/, 'claim re-checks the job is still offerable');
  assert.match(claim.sql, /EXISTS \(SELECT 1 FROM tbl_easyfixer ef/, 'claim re-checks technician lifecycle eligibility');
  assert.equal(claim.params[0], 7, 'claim is scoped to the one offer row');
});

// ─── Idempotency + cap ───────────────────────────────────────────────

test('re-running immediately claims nothing (idempotent within the interval)', async () => {
  await setProps(FLAGS_ON);
  now += reminderCron.REMINDER_AFTER_MINUTES * MIN;
  const first = await reminderCron.runOfferReminders();
  assert.equal(first.claimed, 1);

  const second = await reminderCron.runOfferReminders();
  assert.equal(second.eligible, 0, 'last_reminded_at must exclude the row from the very next tick');
  assert.equal(second.claimed, 0);
});

test('a lost claim race (another replica won) pushes nothing', async () => {
  await setProps(FLAGS_ON);
  now += reminderCron.REMINDER_AFTER_MINUTES * MIN;
  // Simulate the SELECT seeing the row, then a rival stamping it first: the
  // route below evaluates the predicate at UPDATE time, so flipping the row to
  // ACCEPTED between the two makes the conditional claim report affectedRows 0.
  const origQuery = require('../db').pool.query;
  require('../db').pool.query = async (sql, params) => {
    const out = await origQuery(sql, params);
    if (/SELECT job_offer_id, job_id, fk_easyfixter_id/i.test(String(sql))) offer.offer_status = 1;
    return out;
  };
  const r = await reminderCron.runOfferReminders();
  require('../db').pool.query = origQuery;

  assert.equal(r.eligible, 1, 'the SELECT saw it');
  assert.equal(r.claimed, 0, 'but the conditional claim must refuse it');
  assert.equal(r.pushed, 0, 'and nothing may be pushed for an unclaimed row');
});

test('over the offer\'s whole life a 2-min cron reminds it AT MOST twice', async () => {
  await setProps(FLAGS_ON);
  const stampedAtAges = [];
  let lastStamp = null;

  // Tick every 2 minutes (the cron's real cadence) across 40 simulated minutes —
  // well past both the reminder window and the 30-min offer TTL.
  for (let ageMin = 0; ageMin <= 40; ageMin += 2) {
    now = offer.offered_at + ageMin * MIN;
    await reminderCron.runOfferReminders();
    if (offer.last_reminded_at !== lastStamp) {
      lastStamp = offer.last_reminded_at;
      stampedAtAges.push(ageMin);
    }
  }

  assert.equal(stampedAtAges.length, reminderCron.MAX_REMINDERS,
    `expected at most ${reminderCron.MAX_REMINDERS} reminders, got ages [${stampedAtAges}]`);
  assert.ok(stampedAtAges[0] >= reminderCron.REMINDER_AFTER_MINUTES, 'the first reminder respects the initial delay');
  assert.ok(stampedAtAges[1] - stampedAtAges[0] >= reminderCron.REMINDER_INTERVAL_MINUTES, 'reminders stay spaced apart');
  for (const age of stampedAtAges) {
    assert.ok(age < reminderCron.MAX_REMINDER_AGE_MINUTES, 'no reminder may land outside the window');
    assert.ok(age < OFFER_TTL_MINUTES, 'no reminder may land on an already-expired offer');
  }
});

// ─── Un-migrated deploys ─────────────────────────────────────────────

test('a missing last_reminded_at column degrades to a logged no-op, not a crash', async () => {
  await setProps(FLAGS_ON);
  const origQuery = require('../db').pool.query;
  require('../db').pool.query = async (sql, params) => {
    if (/SELECT job_offer_id, job_id, fk_easyfixter_id/i.test(String(sql))) {
      const e = new Error("Unknown column 'last_reminded_at' in 'where clause'");
      e.code = 'ER_BAD_FIELD_ERROR';
      throw e;
    }
    return origQuery(sql, params);
  };
  const r = await reminderCron.runOfferReminders();
  require('../db').pool.query = origQuery;

  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'ER_BAD_FIELD_ERROR');
  assert.equal(r.pushed, 0);
});
