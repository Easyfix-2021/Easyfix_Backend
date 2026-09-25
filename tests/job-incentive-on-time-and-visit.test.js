/*
 * The two system-awarded charges: who earns them, and who PAYS for them.
 *
 * These write real money into a technician's ledger — job-ledger.service folds
 * every job_material row into the completion post — so the properties worth
 * pinning are the ones that would be WRONG rather than merely broken:
 *
 *   1. ON-TIME MEANS THE BOOKED SLOT, not a tolerance in minutes. The owner's
 *      definition (2026-09-23) is "within same slot of appointment". 11:55 for a
 *      9AM-12PM booking earns it and 12:05 does not, however close the clock
 *      looks. A refactor toward "within 60 minutes" would look kinder and would
 *      silently pay for arrivals the customer experienced as late — and the
 *      backend already contains that other definition, in the weekly-performance
 *      OTA query, which is exactly how the two would get confused.
 *
 *   2. WHO FUNDS WHICH. The on-time bonus is client_charge 0 — EasyFix pays it
 *      out of its own share. The visit charge is client_charge == tx_charge —
 *      the client pays it and EasyFix's share is untouched. Swap them and either
 *      a customer is billed Rs 50 nobody told them about, or EasyFix eats Rs 250
 *      per wasted visit across the whole fleet. Neither shows up as an error.
 *
 *   3. IT CANNOT PAY TWICE. job_material has no unique index (confirmed against
 *      migrations: the table is legacy and this repo has never had DDL for it),
 *      so the single INSERT...WHERE NOT EXISTS is the only thing standing
 *      between a retried check-in and a double payment.
 *
 * Runner: `node --test tests/job-incentive-on-time-and-visit.test.js`
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { installFakePool } = require('./helpers/fake-pool');

// Rows already on the job, and every INSERT the code under test issued.
let existingReasons = [];
const inserts = [];

const fake = installFakePool([
  // properties.service's cold load — empty, so the defaults apply.
  [/FROM\s+easyfix_properties/i, []],
  // loadLedgerConfig is not reached here, but be explicit rather than lucky.
  [/FROM\s+tbl_tax_rate/i, [{ rate: 0 }]],
  [
    /INSERT\s+INTO\s+job_material/i,
    (sql, params) => {
      // The guard the statement itself carries: the trailing NOT EXISTS pair is
      // (job_id, reason). Model it exactly, so the test exercises the real rule.
      const reason = params[1];
      inserts.push({ jobId: params[0], reason, tx: params[2], client: params[3], sql });
      if (existingReasons.includes(reason)) return { affectedRows: 0 };
      existingReasons.push(reason);
      return { affectedRows: 1 };
    },
  ],
]);
after(() => fake.restore());

const svc = require('../services/job-incentive.service');

// A 9AM-12PM booking. `time_slot` is deliberately left blank: displaySlot
// derives the band from the appointment instant, which is the rule the app and
// the CRM both follow, and a stored column that disagrees is already dead.
const JOB = { job_id: 9001, requested_date_time: '2026-09-23 10:00:00', time_slot: '' };

beforeEach(() => { existingReasons = []; inserts.length = 0; fake.reset(); });

test('on time means the BOOKED SLOT, not a tolerance in minutes', () => {
  // Inside 9AM-12PM.
  assert.equal(svc.startedInSlot(JOB, '2026-09-23 09:05:00'), true, 'early in the slot');
  assert.equal(svc.startedInSlot(JOB, '2026-09-23 11:55:00'), true,
    '11:55 is still inside the 9AM-12PM band the customer was promised');

  // Outside it — and only five minutes later than the case above.
  assert.equal(svc.startedInSlot(JOB, '2026-09-23 12:05:00'), false,
    '12:05 is the NEXT band. A "within 60 minutes" rule would pay this one; the '
    + 'owner\'s rule does not, and the customer\'s experience is why');
  assert.equal(svc.startedInSlot(JOB, '2026-09-23 08:30:00'), false, 'before the band');
});

test('"we cannot tell" is null, and never quietly becomes "he was late"', () => {
  assert.equal(svc.startedInSlot(JOB, null), null, 'no check-in stamp');
  assert.equal(
    svc.startedInSlot({ job_id: 1, requested_date_time: '2026-09-23', time_slot: '' }, '2026-09-23 10:00:00'),
    null,
    'a date with no time of day has no band — that is unknown, not late',
  );
});

test('the on-time bonus is EasyFix-funded: tx 50, client 0', async () => {
  const res = await svc.awardOnTimeStart(JOB, { checkinAt: '2026-09-23 10:00:00', actorId: 7 });

  assert.equal(res.awarded, true);
  assert.equal(res.amount, svc.DEFAULT_ON_TIME);
  assert.equal(inserts.length, 1, 'exactly one row');
  assert.equal(inserts[0].tx, 50, 'the technician gains Rs 50');
  assert.equal(
    inserts[0].client, 0,
    'and the client is billed NOTHING. computeCompletionAmounts gives EasyFix '
    + '(cx - tx), so client_charge 0 is what makes EasyFix fund it out of margin. '
    + 'Any other value here bills a customer for a bonus nobody told them about.',
  );
});

test('a late arrival is not paid, and issues no INSERT at all', async () => {
  const res = await svc.awardOnTimeStart(JOB, { checkinAt: '2026-09-23 12:05:00', actorId: 7 });
  assert.equal(res.awarded, false);
  assert.equal(res.onTime, false);
  assert.equal(inserts.length, 0, 'a refused bonus must not even reach the table');
});

test('the visit charge BILLS THE CLIENT: tx 250, client 250', async () => {
  const res = await svc.awardVisitCharge(9001, { actorId: 7 });

  assert.equal(res.awarded, true);
  assert.equal(res.amount, svc.DEFAULT_VISIT);
  assert.equal(inserts[0].tx, 250, 'he is paid for the wasted trip');
  assert.equal(
    inserts[0].client, 250,
    'and the client pays for it, so EasyFix\'s share is unchanged (cx - tx == 0). '
    + 'client_charge 0 here would have EasyFix absorb every wasted visit in the fleet.',
  );
});

test('a retried check-in cannot pay the bonus twice', async () => {
  const first = await svc.awardOnTimeStart(JOB, { checkinAt: '2026-09-23 10:00:00', actorId: 7 });
  const second = await svc.awardOnTimeStart(JOB, { checkinAt: '2026-09-23 10:00:00', actorId: 7 });

  assert.equal(first.awarded, true);
  assert.equal(second.awarded, false, 'the second call reports it did NOT insert');
  assert.equal(existingReasons.length, 1, 'and the table holds exactly one row');

  // The guard has to be IN THE STATEMENT, not a SELECT beside it: a phone
  // retrying a timed-out check-in can arrive while the first is still in flight.
  assert.match(
    inserts[0].sql,
    /WHERE\s+NOT\s+EXISTS/i,
    'the duplicate check must be part of the INSERT — job_material has no unique '
    + 'index to fall back on, so a separate SELECT would leave a real window',
  );
});

test('the two charges do not block each other — different reasons, both paid', async () => {
  await svc.awardOnTimeStart(JOB, { checkinAt: '2026-09-23 10:00:00', actorId: 7 });
  await svc.awardVisitCharge(9001, { actorId: 7 });
  assert.equal(existingReasons.length, 2,
    'the idempotency key is the REASON, so a job can carry both');
  assert.notEqual(svc.REASON_ON_TIME, svc.REASON_VISIT);
});
