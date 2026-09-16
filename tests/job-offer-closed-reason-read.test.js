/*
 * listOffers() surfaces WHY an offer closed — tbl_job_offer.closed_reason and
 * its human label — to the Schedule & Assign modal's EXPIRED chip.
 *
 * WHY THIS IS WORTH PINNING. `offer_status = 3 EXPIRED` is written by EIGHT
 * code paths and only ONE is the 30-minute timeout; the rest fire when the job
 * is assigned, rescheduled, released, withdrawn, re-offered, or when a sibling
 * accepts. The column was added to record that difference and nothing read it
 * back, so the modal said only THAT an offer closed. It matters beyond display:
 * candidate ranking scores a technician's acceptance rate, so whether a closed
 * offer reads as a decline is a fairness claim about a named person.
 *
 * Three properties, each a way this can go quietly wrong:
 *   1. The raw token AND the label both ship, and the label never replaces the
 *      raw value — reports and filters key on the token the writer stored.
 *   2. NULL survives as NULL. On an EXPIRED row it means "closed before this
 *      column existed", not "unknown cause", and inventing prose for it would
 *      assert something about an offer nobody recorded a reason for.
 *   3. The column is PROBED through the shared memo in offer-closed-reason.js,
 *      so a deploy predating the migration gets a NULL alias, not a 500.
 *
 * Non-destructive: fake pool, no real DB. Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const scenario = { hasColumn: true, offerRows: [] };

const fake = installFakePool([
  [/SHOW COLUMNS FROM tbl_job_offer LIKE 'closed_reason'/i, () => (scenario.hasColumn ? [{ Field: 'closed_reason' }] : [])],
  [/SELECT 1 FROM tbl_job_offer LIMIT 1/i, [{ 1: 1 }]],
  [/FROM easyfix_properties/i, []],
  [/SHOW COLUMNS/i, []],
  [/FROM tbl_job_customer_request LIMIT 1/i, []],
  [/SELECT magic_link_delivery_status FROM tbl_job LIMIT 1/i, [{ magic_link_delivery_status: null }]],
  [/FROM tbl_job_offer jo/i, () => scenario.offerRows],
]);

const jobSvc = require('../services/job.service');
const { OFFER_CLOSED_REASON, OFFER_CLOSED_REASON_LABEL } = require('../services/offer-closed-reason');

const offersQuery = () => fake.calls.find((c) => /FROM tbl_job_offer jo\b/i.test(c.sql));

beforeEach(() => {
  fake.calls.length = 0;
  scenario.hasColumn = true;
  scenario.offerRows = [];
});

test('the read selects closed_reason when the column is there', async () => {
  await jobSvc.listOffers(42, { sweep: false });
  assert.match(offersQuery().sql, /jo\.closed_reason/, 'the raw column must be projected');
  assert.doesNotMatch(offersQuery().sql, /NULL AS closed_reason/);
});

test('every closed_reason in the vocabulary gets its own label, raw value intact', async () => {
  scenario.offerRows = Object.values(OFFER_CLOSED_REASON).map((reason, i) => ({
    efr_id: i + 1, efr_name: 'Tech ' + i, offer_status: 3, closed_reason: reason,
  }));
  const rows = await jobSvc.listOffers(42, { sweep: false });
  for (const row of rows) {
    assert.equal(row.closed_reason_label, OFFER_CLOSED_REASON_LABEL[row.closed_reason],
      `${row.closed_reason} must carry its own wording`);
    assert.ok(row.closed_reason_label, `${row.closed_reason} has no label — the two maps have drifted`);
  }
  // Spot-check the one the CRM will show most, so a silent re-wording is visible.
  const rescheduled = rows.find((r) => r.closed_reason === OFFER_CLOSED_REASON.RESCHEDULED);
  assert.equal(rescheduled.closed_reason_label, 'Appointment rescheduled');
});

test('NULL stays NULL — it means "closed before the column existed", not "unknown"', async () => {
  scenario.offerRows = [{ efr_id: 1, offer_status: 3, closed_reason: null }];
  const [row] = await jobSvc.listOffers(42, { sweep: false });
  assert.equal(row.closed_reason, null);
  assert.equal(row.closed_reason_label, null, 'no prose may be invented for an unrecorded reason');
});

test('an unrecognised token keeps its raw value and gets a NULL label', async () => {
  // A newer deploy could write a reason this one has no wording for. Echoing
  // the token back dressed as prose would put a database value in front of an
  // operator as if it were a sentence.
  scenario.offerRows = [{ efr_id: 1, offer_status: 3, closed_reason: 'some_future_reason' }];
  const [row] = await jobSvc.listOffers(42, { sweep: false });
  assert.equal(row.closed_reason, 'some_future_reason', 'the raw value must survive');
  assert.equal(row.closed_reason_label, null);
});

test('the label is ADDED to the row, never instead of the value', async () => {
  scenario.offerRows = [{
    efr_id: 7, efr_name: 'Asha', offer_status: 3, reject_reason: null,
    closed_reason: OFFER_CLOSED_REASON.SIBLING_ACCEPTED,
  }];
  const [row] = await jobSvc.listOffers(42, { sweep: false });
  assert.equal(row.closed_reason, 'sibling_accepted');
  assert.equal(row.closed_reason_label, 'Another technician accepted');
  // Nothing the modal already rendered may have moved.
  assert.equal(row.efr_id, 7);
  assert.equal(row.efr_name, 'Asha');
  assert.equal(row.offer_status, 3);
});

test('a deploy without the column gets a NULL alias, not an unknown-column 500', async () => {
  // Same degradation the writers make (closedReasonSet returns an empty SET
  // fragment), through the SAME memoised probe — never a second one here.
  scenario.hasColumn = false;
  delete require.cache[require.resolve('../services/offer-closed-reason')];
  delete require.cache[require.resolve('../services/job.service')];
  const freshSvc = require('../services/job.service');
  fake.calls.length = 0;
  scenario.offerRows = [{ efr_id: 1, offer_status: 3 }];

  const [row] = await freshSvc.listOffers(42, { sweep: false });
  assert.match(offersQuery().sql, /NULL AS closed_reason/, 'the column must not be named');
  assert.doesNotMatch(offersQuery().sql, /jo\.closed_reason/);
  assert.equal(row.closed_reason_label, null, 'and the row shape stays identical');

  delete require.cache[require.resolve('../services/offer-closed-reason')];
  delete require.cache[require.resolve('../services/job.service')];
  require('../services/job.service');
});
