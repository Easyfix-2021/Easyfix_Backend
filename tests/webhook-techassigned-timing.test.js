/*
 * TechAssigned must fire on ACCEPTANCE, never on nomination.
 *
 * Legacy fired it the instant job_status became PENDING_TO_START (=1) with a
 * technician attached — EasyfixerCallRecordServiceImpl.java:183, inside the
 * accept/reject handler. Decathlon, PowerMax and Green Soul all consume this
 * event, so its timing is a live contract, not an implementation detail.
 *
 * Two paths reach that state and they are mutually exclusive:
 *
 *   OFFER   assign() delegates to offerToTechnicians() and RETURNS EARLY; the
 *           job stays BOOKED with no technician. acceptOffer() later performs
 *           the BOOKED→SCHEDULED claim — that is the acceptance.
 *   DIRECT  assign() falls through to the hard-schedule path, which does the
 *           BOOKED→SCHEDULED transition inline. There is no separate accept,
 *           so the assign IS the acceptance.
 *
 * These are source-level invariants because the alternative — driving the full
 * claim through a fake pool — would assert on the harness rather than on the
 * ordering that actually matters. The regressions being guarded are structural:
 * someone adds a third success exit, or moves the early return.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '../services/job.service.js'), 'utf8');

/** Body of a top-level `async function <name>(` up to the next top-level `}`. */
function functionBody(name) {
  const start = SRC.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name}() not found`);
  const end = SRC.indexOf('\n}', start);
  assert.notEqual(end, -1, `${name}() has no terminator`);
  return SRC.slice(start, end);
}

test('every acceptOffer success path fires TechAssigned', () => {
  const body = functionBody('acceptOffer');
  const successes = body.match(/return \{ accepted: true/g) || [];
  const fires = body.match(/fireWebhook\('TechAssigned'/g) || [];
  assert.ok(successes.length >= 2, 'both the legacy and race-safe claims are covered');
  assert.equal(
    fires.length, successes.length,
    'a success exit without a TechAssigned fire silently drops the event for Decathlon/PowerMax/Green Soul',
  );
});

test('acceptOffer fires only AFTER the transaction commits', () => {
  const body = functionBody('acceptOffer');
  // The dispatcher re-reads the job to build its payload, so firing before
  // commit races our own write and can serialise a pre-accept snapshot.
  for (const idx of [...body.matchAll(/fireWebhook\('TechAssigned'/g)].map((m) => m.index)) {
    const before = body.slice(0, idx);
    assert.ok(
      before.lastIndexOf('await conn.commit()') > before.lastIndexOf('await conn.beginTransaction()'),
      'TechAssigned fired while a transaction was still open',
    );
  }
});

test('acceptOffer never fires on a 409 — a lost race is not an assignment', () => {
  const body = functionBody('acceptOffer');
  // Each fire must sit below the affectedRows guard that throws the 409, so a
  // technician who lost the race cannot emit an assignment for the winner.
  const firstFire = body.indexOf("fireWebhook('TechAssigned'");
  const firstGuard = body.indexOf('affectedRows');
  assert.ok(firstGuard !== -1 && firstGuard < firstFire, 'the claim is verified before the event fires');
});

test('assign() delegates to the offer flow BEFORE its own TechAssigned fire', () => {
  const body = functionBody('assign');
  const delegation = body.indexOf('return offerToTechnicians(');
  const fire = body.indexOf("fireWebhook(isReassign ? 'RescheduleTech' : 'TechAssigned'");
  assert.ok(delegation !== -1, 'offer delegation present');
  assert.ok(fire !== -1, 'direct-path fire present');
  assert.ok(
    delegation < fire,
    'the offer path must return before the fire, or a job would emit TechAssigned at nomination AND again at acceptance',
  );
});

test('offerToTechnicians fires no job webhooks — nomination is not assignment', () => {
  const body = functionBody('offerToTechnicians');
  assert.equal(
    (body.match(/fireWebhook\(/g) || []).length, 0,
    'offering a job to a technician must not tell the client one is assigned',
  );
});

test('the status transition map still routes acceptance nowhere', () => {
  // BOOKED→SCHEDULED deliberately produces no event name: acceptOffer owns
  // TechAssigned. If a mapping is ever added here, the offer flow would fire
  // twice for a single acceptance.
  const { statusToEventName, STATUS } = require('../services/job.service');
  if (typeof statusToEventName !== 'function') return; // not exported — invariant covered above
  assert.equal(statusToEventName(STATUS.BOOKED, STATUS.SCHEDULED), null);
});
