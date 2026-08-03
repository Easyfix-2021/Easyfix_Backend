'use strict';

/*
 * RescheduleTech — the NEW WINDOW in the reschedule SMS.
 *
 * ─── WHY THESE TESTS EXIST ────────────────────────────────────────────────
 *
 * When a job is rescheduled the orchestrator texts the customer. It used to
 * send a bare
 *     "EasyFix: Your AC Repair has been rescheduled."
 * which never said to WHEN, so the only way to find out was to phone us back.
 * Worse, being a plain template literal it was a NON-DLT body: in India the
 * operator silently drops a body that doesn't match a registered template, while
 * SMSCountry still returns 200 OK — so the failure is invisible from this side
 * and appending text to that literal would not have changed it.
 *
 * The branch now does what CustomerNotReachable already does: fill the
 * DLT-registered JOB_RESCHEDULED row from tbl_sms_transational_meta, and fall
 * back to an inline body that carries the SAME window when no row is registered.
 *
 * ─── DATE + BAND, NEVER THE MINUTE ────────────────────────────────────────
 *
 * The window is a DATE and a BAND. Quoting a slot rather than an arrival minute
 * is the governing product rule — the owner's words: "we don't want to commit
 * that the technician will reach exactly at 5:30 as it can get late, but we are
 * committing that they will reach in this slot". An SMS is the least
 * retractable surface we have, so it gets the band and nothing finer.
 *
 * The band is time-slot.js displaySlot: the appointment INSTANT wins, and only a
 * date-only booking / the 00:00 "no time captured" sentinel falls back to the
 * stored tbl_job.time_slot label, canonicalised for spelling only. Deriving a
 * band from the sentinel would text tens of thousands of legacy date-only jobs
 * an 'After Hours' window nobody booked.
 *
 * Everything below drives the REAL onJobEvent path and reads the message back
 * off the wire with sms.service.send stubbed — never a re-implementation of the
 * composition. Non-destructive: fake pool, no real DB, no provider call.
 * Runner: `node --test`.
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * The template body lives in tbl_sms_transational_meta and is resolved through
 * sms-template.service (which reads the shared db singleton). Route that one
 * SELECT so each test decides what — if anything — is registered:
 *   templateBody = '…'   a registered row (a PROBE body reads the positional
 *                        array straight back, exercising the REAL fill())
 *   templateBody = ''    NO row registered → the inline fallback path
 *   templateThrows       the lookup itself fails → fail-soft path
 */
let templateBody = '';
let templateThrows = false;
const fake = installFakePool([
  [/FROM tbl_sms_transational_meta/i, () => {
    if (templateThrows) throw new Error('ER_LOCK_WAIT_TIMEOUT: simulated');
    return [{ sms: templateBody, client_id: 1 }];
  }],
]);

const smsTemplate = require('../services/sms-template.service');
const smsService = require('../services/sms.service');
const { onJobEvent } = require('../services/notification-orchestrator.service');
const { displaySlot } = require('../services/time-slot');

// Intercept at the last hop before the provider. The orchestrator holds the
// module object (`require('./sms.service')`) and calls `.send` off it, so
// replacing the property is enough — and guarantees no SMS leaves the box.
const realSend = smsService.send;
let sent = null;
smsService.send = (payload) => { sent = payload; return Promise.resolve({ delivered: false, stubbed: true }); };

after(() => { smsService.send = realSend; fake.restore(); });

beforeEach(() => {
  sent = null;
  templateBody = '';
  templateThrows = false;
  // getTemplate caches for 5 min keyed by stage:client — each test installs a
  // different probe body, so the cache has to go.
  smsTemplate.invalidate();
});

/*
 * A jobCtx exactly as job.service.getById hands it to the orchestrator: `j.*`
 * off tbl_job under mysql2 `dateStrings: true`, so requested_date_time is an
 * IST WALL-CLOCK string — the spelling every services/time-slot.js helper
 * parses. Job #482491's real values are the defaults (05:30 stored beside a
 * contradicting '3pm to 7pm').
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
  await onJobEvent('RescheduleTech', jobCtx(overrides));
  assert.ok(sent, 'an SMS must have been sent');
  return sent.message;
}

/*
 * Read the positional variable array back off the wire. The probe body is
 * `{#var1#}|…|{#varN#}`, so splitting on '|' reproduces exactly what
 * jobRescheduledVars() returned, in order. None of the fixture values contains
 * a pipe.
 */
async function varsOnTheWire(overrides, count = 5) {
  templateBody = Array.from({ length: count }, (_, i) => `{#var${i + 1}#}`).join('|');
  const message = await fire(overrides);
  return message.split('|');
}

// ─── 1. The DLT shape ops has to register ─────────────────────────────────

/*
 * THE CONTRACT TEST. Every position is pinned, because once ops registers
 * JOB_RESCHEDULED the COUNT and ORDER freeze: a later edit that turns var4 into
 * var5 is not a cosmetic bug, it makes the operator drop the message on the way
 * to the handset while SMSCountry still returns 200 OK.
 */
test('JOB_RESCHEDULED fills five vars: name, job id, job type, DATE, BAND', async () => {
  const vars = await varsOnTheWire();

  assert.equal(vars.length, 5, 'five variables — register exactly these with the operator');
  assert.equal(vars[0], 'Asha Rao',         'var1 customer_name');
  assert.equal(vars[1], '482491',           'var2 job_id');
  assert.equal(vars[2], 'AC Repair',        'var3 job_type');
  assert.equal(vars[3], 'Wed, 05 Aug 2026', 'var4 the appointment DATE');
  assert.equal(vars[4], 'After Hours',      'var5 the BAND — derived from the 05:30 instant');
});

/*
 * fill() resolves an out-of-range {#varN#} to '' (vars[N-1] ?? ''), so a probe
 * asking for a sixth variable proves the array has no sixth element. This is
 * the half of "count is five" the test above cannot see.
 */
test('there is no 6th variable — the array length is capped at five', async () => {
  const vars = await varsOnTheWire({}, 6);
  assert.equal(vars.length, 6, 'the probe asked for 6 slots');
  assert.equal(vars[5], '', 'the 6th resolves to empty — nothing was appended to the list');
});

/*
 * A realistically-shaped registered body, filled end to end. This is the exact
 * text a customer receives once ops adds the row.
 */
test('a registered template renders the full window on the handset', async () => {
  templateBody = 'Dear {#var1#}, your EasyFix {#var3#} request {#var2#} has been rescheduled to '
               + '{#var4#}, {#var5#}. Our technician will reach you within this slot. - Team EasyFix';
  const message = await fire();

  assert.equal(
    message,
    'Dear Asha Rao, your EasyFix AC Repair request 482491 has been rescheduled to '
    + 'Wed, 05 Aug 2026, After Hours. Our technician will reach you within this slot. - Team EasyFix',
  );
});

// ─── 2. A real time-of-day: the appointment INSTANT wins ──────────────────

/*
 * Job #482491's recorded defect, on the reschedule surface: requested_date_time
 * 05:30 is 'After Hours', stored beside a stale time_slot '3pm to 7pm'. That
 * column is DERIVED — resolveTimeSlot re-derives it on every write — so texting
 * the stored string promises a window the system had already stopped honouring.
 */
test('a timed job states the DERIVED band, not the stale stored one', async () => {
  const message = await fire();

  assert.match(message, /After Hours/);
  // Case-insensitive: '3pm to 7pm' and '3PM to 7PM' are the same window, and
  // texting EITHER against an 05:30 appointment is the bug.
  assert.doesNotMatch(message, /3\s*pm\s*to\s*7\s*pm/i, 'the stale stored band must not reach the handset');
});

/*
 * THE GOVERNING RULE, pinned. We know this appointment is at 05:30 and we
 * deliberately do not say so — the promise is the slot. Asserted on the
 * FALLBACK body (templateBody stays '') because that is the string this repo
 * actually authors; the registered body's wording is ops', but its var5 is a
 * band by construction (test 1).
 */
test('the exact time is NEVER stated — the band is the whole promise', async () => {
  for (const dt of ['2026-08-05 05:30:00', '2026-08-05 15:00:00', '2026-08-05 09:45:00']) {
    const message = await fire({ requested_date_time: dt });
    assert.doesNotMatch(message, /\d{1,2}:\d{2}/, `${dt}: a clock time reached the customer`);
    assert.doesNotMatch(message, /5:30\s*AM/i,    `${dt}: the exact appointment minute reached the customer`);
  }
});

test('a mid-afternoon appointment is banded from the instant, overriding a contradicting store', async () => {
  const vars = await varsOnTheWire({ requested_date_time: '2026-08-05 13:00:00', time_slot: 'Morning 9 to 2' });
  assert.equal(vars[3], 'Wed, 05 Aug 2026');
  assert.equal(vars[4], '12PM to 3PM');
});

// ─── 3. Date-only / the 00:00 midnight sentinel ───────────────────────────

/*
 * 00:00:00 means "no time-of-day was ever captured" (date-only bookings, legacy
 * imports), NOT a visit at midnight. The DATE is still real and is stated; the
 * BAND falls back to the stored label because that is the only signal on file.
 * Deriving a band from the sentinel would band every such job 'After Hours'.
 */
test('a date-only job sends its STORED band, canonicalised, and no fabricated time', async () => {
  const vars = await varsOnTheWire({ requested_date_time: '2026-08-05 00:00:00' });

  assert.equal(vars[3], 'Wed, 05 Aug 2026', 'the date is real even on the sentinel');
  assert.equal(vars[4], '3PM to 7PM', 'stored 3pm to 7pm, canonically spelled');
  assert.notEqual(vars[4], 'After Hours', 'the midnight sentinel must NEVER be re-derived');
});

test('a date-only job never announces "12 AM"', async () => {
  const message = await fire({ requested_date_time: '2026-08-05 00:00:00' });
  assert.doesNotMatch(message, /12\s*AM/i);
  assert.doesNotMatch(message, /00:00/);
});

/*
 * canonicalSlot is a COSMETIC fold (case + spacing), never an interpretation.
 * tbl_job.time_slot carries ~79k rows of 'Morning 9 to 2' and friends from a
 * decade of pickers; re-labelling those on a read would be inventing an hour
 * nobody wrote down. Coarse, but never a wrong window.
 */
test('a legacy free-text label on a date-only job passes through verbatim', async () => {
  const vars = await varsOnTheWire({ requested_date_time: '2026-08-05 00:00:00', time_slot: 'Morning 9 to 2' });
  assert.equal(vars[4], 'Morning 9 to 2');
});

/*
 * A date we can read but no band we can justify. The date alone is genuinely
 * useful, so it is stated — and the sentence simply ENDS there. No trailing
 * comma, no ", ." where the band would have gone.
 */
test('a date with no readable band states the date alone — no dangling separator', async () => {
  const message = await fire({ requested_date_time: '2026-08-05 00:00:00', time_slot: null });

  assert.equal(message, 'EasyFix: Your AC Repair has been rescheduled to Wed, 05 Aug 2026.');
  assert.doesNotMatch(message, /,\s*\./, 'an empty band left a dangling comma');
  assert.doesNotMatch(message, /·/,      'no separator with nothing after it');
});

// ─── 4. No readable appointment at all ────────────────────────────────────

/*
 * A reschedule can leave the job with no readable appointment — pushed back to
 * unscheduled, or a legacy row that never carried a date. We must not emit
 * "rescheduled to ." and we must not invent a window.
 *
 * We also do NOT fall silent back to the old bare "has been rescheduled.":
 * saying only that the visit moved, with no word on what happens next, is what
 * sent customers to the phone in the first place. Promising a follow-up is the
 * only honest thing available when we genuinely do not have a window yet.
 *
 * This path deliberately SKIPS the template: the registered body wraps literal
 * text around {#var4#}/{#var5#} ("…rescheduled to {#var4#}, {#var5#}."), so
 * filling them blank would put "rescheduled to , ." on the handset — worse than
 * the vague message being replaced.
 */
test('a job with no appointment at all says the visit moved and a window will follow', async () => {
  templateBody = 'Rescheduled to {#var4#}, {#var5#}.'; // registered, but unfillable here
  const message = await fire({ requested_date_time: null, time_slot: null });

  assert.equal(
    message,
    'EasyFix: Your AC Repair has been rescheduled. We will confirm the new date and time shortly.',
  );
  assert.doesNotMatch(message, /rescheduled to/i, 'no dangling "rescheduled to" with nothing after it');
  assert.doesNotMatch(message, /null|undefined/i, 'a missing column must never be rendered');
});

test('an unparseable appointment is treated as no appointment, not as text', async () => {
  const message = await fire({ requested_date_time: 'not-a-date', time_slot: '3pm to 7pm' });
  assert.match(message, /We will confirm the new date and time shortly\./);
  assert.doesNotMatch(message, /not-a-date/);
});

// ─── 5. The fallback path (no row registered) ─────────────────────────────

/*
 * Until ops registers JOB_RESCHEDULED, getTemplate returns null. The customer
 * must still be told the new window — the inline body is at risk of carrier-side
 * dropping, but it is strictly better than the old text (which was equally at
 * risk AND said nothing), and it upgrades itself the moment the row exists.
 */
test('with no template registered, the inline fallback still carries the window', async () => {
  const message = await fire(); // templateBody = '' → no active row

  assert.equal(message, 'EasyFix: Your AC Repair has been rescheduled to Wed, 05 Aug 2026, After Hours.');
});

/*
 * FAIL-SOFT. The reschedule itself has already committed by the time this runs;
 * a template lookup is a DB read and must never turn a successful reschedule
 * into an error. onJobEvent's own catch would swallow a throw, but it would also
 * swallow the SMS — so the branch has to catch it itself and still send.
 */
test('a template lookup FAILURE still sends the window and never throws', async () => {
  templateThrows = true;
  const message = await fire();

  assert.equal(message, 'EasyFix: Your AC Repair has been rescheduled to Wed, 05 Aug 2026, After Hours.');
});

test('a job with no job_type degrades to "service" rather than "your undefined"', async () => {
  const message = await fire({ job_type: null });
  assert.match(message, /^EasyFix: Your service has been rescheduled to /);
});

test('no customer mobile on file — nothing is sent, nothing throws', async () => {
  await onJobEvent('RescheduleTech', jobCtx({ customer_mob_no: null }));
  assert.equal(sent, null, 'no recipient means no send attempt');
});

// ─── 6. The band comes from the SHARED helper ─────────────────────────────

/*
 * The public shared-job link and the CUSTOMER_NOT_REACHABLE SMS derive their
 * band from services/time-slot.js displaySlot. This surface must agree with them
 * by construction rather than by hand — a customer who opens the share link and
 * reads the SMS has to see the same window.
 *
 * Every case here HAS a band, because a bandless job never reaches the template
 * at all — it takes the date-only inline wording instead, which is pinned by its
 * own test above ("a date with no readable band…"). Probing one here would only
 * re-assert that skip, in a form that looks like a band assertion.
 */
test('the band on the wire is exactly time-slot.js displaySlot()', async () => {
  const cases = [
    ['2026-08-05 05:30:00', '3pm to 7pm'],
    ['2026-08-05 00:00:00', '3pm to 7pm'],
    ['2026-08-05 00:00:00', 'Morning 9 to 2'],
    ['2026-08-05 15:00:00', 'Morning 9 to 2'],
    ['2026-08-05 09:00:00', null],
  ];
  for (const [dt, stored] of cases) {
    const expected = displaySlot(dt, stored);
    assert.notEqual(expected, '', `fixture ${dt} / ${stored} has no band — it would not use the template`);
    const vars = await varsOnTheWire({ requested_date_time: dt, time_slot: stored });
    assert.equal(vars[4], expected, `${dt} / ${stored}`);
  }
});
