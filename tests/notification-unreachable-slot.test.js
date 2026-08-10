'use strict';

/*
 * CUSTOMER_NOT_REACHABLE — the BOOKING BAND in the DLT SMS.
 *
 * ─── WHY THESE TESTS EXIST ────────────────────────────────────────────────
 *
 * When a job goes to CALL_LATER the orchestrator texts the customer using the
 * DLT-registered CUSTOMER_NOT_REACHABLE template. One of its six positional
 * variables is the booking BAND, and it used to be the RAW tbl_job.time_slot
 * column.
 *
 * That column is DERIVED: it is the band containing requested_date_time, and
 * resolveTimeSlot re-derives it on every write. So a stored value that
 * disagrees with the appointment is already dead — the next save discards it.
 * Job #482491 is the recorded case: requested_date_time 05:30, which is
 * 'After Hours', stored alongside time_slot '3pm to 7pm'. The customer was
 * texted a window the system would not honour.
 *
 * THE FIX KEEPS SENDING A BAND. Quoting a slot rather than an exact minute is
 * deliberate — the owner's words: "we don't want to commit that the technician
 * will reach exactly at 5:30 as it can get late, but we are committing that
 * they will reach in this slot". Only WHICH band was wrong.
 *
 * ─── WHY THE DLT SHAPE IS PINNED HERE ─────────────────────────────────────
 *
 * This is an Indian DLT-registered template: the variable COUNT, their ORDER
 * and the surrounding literal text are registered with the telecom operator.
 * A mismatch is not cosmetic — operators silently DROP the message on the way
 * to the handset while SMSCountry still returns 200 OK, so the failure is
 * invisible from this side. Nothing but var6's VALUE may change, and a type
 * checker cannot see any of that. Hence the probe templates below, which read
 * the positional array back off the wire.
 *
 * Non-destructive: fake pool, no real DB, no provider call (sms.service.send is
 * stubbed). Runner: `node --test`.
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * The template body lives in tbl_sms_transational_meta and is resolved through
 * sms-template.service (which reads the shared db singleton). Route that one
 * SELECT to a PROBE body so the filled message reads back as the positional
 * array itself — this exercises the REAL fill(), not a re-implementation of it.
 */
let templateBody = '';
const fake = installFakePool([
  [/FROM tbl_sms_transational_meta/i, () => [{ sms: templateBody, client_id: 1 }]],
]);

const smsTemplate = require('../services/sms-template.service');
const smsService = require('../services/sms.service');
const { onJobEvent } = require('../services/notification-orchestrator.service');

// Intercept at the last hop before the provider. The orchestrator holds the
// module object (`require('./sms.service')`) and calls `.send` off it, so
// replacing the property is enough — and guarantees no SMS leaves the box.
const realSend = smsService.send;
let sent = null;
smsService.send = (payload) => { sent = payload; return Promise.resolve({ delivered: false, stubbed: true }); };

after(() => { smsService.send = realSend; fake.restore(); });

beforeEach(() => {
  sent = null;
  // getTemplate caches for 5 min keyed by stage:client — each test installs a
  // different probe body, so the cache has to go.
  smsTemplate.invalidate();
});

/*
 * A jobCtx exactly as job.service.getById hands it to the orchestrator: `j.*`
 * off tbl_job under mysql2 `dateStrings: true`, so requested_date_time is an
 * IST WALL-CLOCK string — the spelling every services/time-slot.js helper
 * parses. Job #482491's real values are the defaults.
 */
function jobCtx(overrides = {}) {
  return {
    job_id: 482491,
    fk_client_id: 7,
    customer_mob_no: '9876543210',
    customer_name: 'Asha Rao',
    client_name: 'Acme',
    easyfixer_name: 'Ravi Kumar',
    job_type: 'AC Repair',
    requested_date_time: '2026-08-05 05:30:00',
    time_slot: '3pm to 7pm',
    ...overrides,
  };
}

/* Send the event through the real orchestrator and hand back the SMS body. */
async function fire(overrides) {
  await onJobEvent('CustomerNotReachable', jobCtx(overrides));
  assert.ok(sent, 'an SMS must have been sent');
  return sent.message;
}

/*
 * Read the positional variable array back off the wire. The probe body is
 * `{#var1#}|…|{#varN#}`, so splitting on '|' reproduces exactly what
 * customerNotReachableVars() returned, in order. None of the fixture values
 * contains a pipe.
 */
async function varsOnTheWire(overrides, count = 6) {
  templateBody = Array.from({ length: count }, (_, i) => `{#var${i + 1}#}`).join('|');
  const message = await fire(overrides);
  return message.split('|');
}

// ─── 1. The DLT contract: count, order, and the untouched positions ────────

/*
 * THE CONTRACT TEST. Every position is pinned, not just the one that changed,
 * because the danger of editing this list is not "var6 is wrong" — it is
 * "var4 silently became var5". Positions 1–5 must be byte-identical to what
 * they were before the fix (name, job id, client, technician, the RAW
 * appointment datetime).
 */
test('the variable array is still exactly 6, in the registered order, with only var6 changed', async () => {
  const vars = await varsOnTheWire();

  assert.equal(vars.length, 6, 'the DLT registration has SIX variables — never add or remove one');
  assert.equal(vars[0], 'Asha Rao',            'var1 customer_name');
  assert.equal(vars[1], '482491',              'var2 job_id');
  assert.equal(vars[2], 'Acme',                'var3 client_name');
  assert.equal(vars[3], 'Ravi Kumar',          'var4 easyfixer_name');
  assert.equal(vars[4], '2026-08-05 05:30:00', 'var5 requested_date_time — still the RAW column');
  assert.equal(vars[5], 'After Hours',         'var6 the band — now DERIVED');
});

/*
 * fill() resolves an out-of-range {#varN#} to '' (vars[N-1] ?? ''), so a probe
 * asking for a seventh variable proves the array has no seventh element. This
 * is the half of "count unchanged" the test above cannot see.
 */
test('there is no 7th variable — the array length is capped at the registration', async () => {
  const vars = await varsOnTheWire({}, 7);
  assert.equal(vars.length, 7, 'the probe asked for 7 slots');
  assert.equal(vars[6], '', 'the 7th resolves to empty — nothing was appended to the list');
});

/*
 * The literal text between the variables is registered too. Fill a
 * realistically-shaped body and assert every word of it survives — the only
 * difference from the pre-fix output is the band's value.
 */
test('the surrounding literal text is untouched — only the band value differs', async () => {
  templateBody = 'Dear {#var1#}, we could not reach you for job {#var2#} of {#var3#}. '
               + 'Our technician {#var4#} will visit on {#var5#} in the slot {#var6#}. - Team EasyFix';
  const message = await fire();

  assert.equal(
    message,
    'Dear Asha Rao, we could not reach you for job 482491 of Acme. '
    + 'Our technician Ravi Kumar will visit on 2026-08-05 05:30:00 in the slot After Hours. - Team EasyFix',
  );
  // Still a SLOT, not a minute: the band is the promise, and swapping it for
  // "5:30 AM" would commit to an arrival time the business never offered.
  assert.doesNotMatch(message, /5:30\s*AM/i, 'the exact time must NOT replace the band');
});

// ─── 2. A real time-of-day: the appointment INSTANT wins ──────────────────

test('job #482491: an 05:30 appointment is banded After Hours, not the stored 3pm to 7pm', async () => {
  const message = await fire();

  assert.match(message, /After Hours/);
  // Case-insensitive: '3pm to 7pm' and '3PM to 7PM' are the same window, and
  // texting EITHER against an 05:30 appointment is the bug.
  assert.doesNotMatch(message, /3\s*pm\s*to\s*7\s*pm/i, 'the stale stored band must not reach the handset');
});

test('a mid-afternoon appointment is banded from the instant, overriding a contradicting store', async () => {
  const vars = await varsOnTheWire({ requested_date_time: '2026-08-05 13:00:00', time_slot: 'Morning 9 to 2' });
  assert.equal(vars[5], '12PM to 3PM');
});

// ─── 3. Date-only / the 00:00 midnight sentinel ───────────────────────────

/*
 * 00:00:00 means "no time-of-day was ever captured" (date-only bookings,
 * legacy imports), NOT a visit at midnight. Deriving from it would band every
 * such job 'After Hours' and text tens of thousands of customers a window
 * nobody ever booked — a far louder bug than the one being fixed. The stored
 * label is the only signal on file, so it is KEPT.
 */
test('a date-only job sends its STORED band, canonicalised for spelling only', async () => {
  const vars = await varsOnTheWire({ requested_date_time: '2026-08-05 00:00:00' });

  assert.equal(vars[5], '3PM to 7PM', 'stored 3pm to 7pm, canonically spelled');
  assert.notEqual(vars[5], 'After Hours', 'the midnight sentinel must NEVER be re-derived');
});

/*
 * canonicalSlot is a COSMETIC fold (case + spacing), never an interpretation.
 * tbl_job.time_slot carries ~79k rows of 'Morning 9 to 2' and friends from a
 * decade of pickers; re-labelling those on a read would be inventing an hour
 * nobody wrote down. Coarse, but never a wrong window.
 */
test('a legacy free-text label on a date-only job passes through verbatim', async () => {
  const vars = await varsOnTheWire({ requested_date_time: '2026-08-05 00:00:00', time_slot: 'Morning 9 to 2' });
  assert.equal(vars[5], 'Morning 9 to 2');
});

test('a job with no appointment and no stored band sends an empty band, not "After Hours"', async () => {
  const vars = await varsOnTheWire({ requested_date_time: null, time_slot: null });
  assert.equal(vars[4], '', 'var5 stays empty rather than rendering "null"');
  assert.equal(vars[5], '', 'var6 too — we invent nothing');
});

// ─── 4. The band comes from the SHARED helper ─────────────────────────────

/*
 * The public shared-job link had the identical bug and the identical fix. Both
 * now call services/time-slot.js displaySlot, so this asserts the SMS agrees
 * with that helper rather than trusting the two to stay in step by hand.
 */
test('the band on the wire is exactly time-slot.js displaySlot()', async () => {
  const { displaySlot } = require('../services/time-slot');
  const cases = [
    ['2026-08-05 05:30:00', '3pm to 7pm'],
    ['2026-08-05 00:00:00', '3pm to 7pm'],
    ['2026-08-05 00:00:00', 'Morning 9 to 2'],
    ['2026-08-05 15:00:00', 'Morning 9 to 2'],
    [null, null],
  ];
  for (const [dt, stored] of cases) {
    const vars = await varsOnTheWire({ requested_date_time: dt, time_slot: stored });
    assert.equal(vars[5], displaySlot(dt, stored), `${dt} / ${stored}`);
  }
});
