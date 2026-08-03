/*
 * Characterization + unit tests for the CONFIRM-FIRST WhatsApp conversation
 * flow (services/whatsapp-conversation.service.js, 2026-07-30 rework).
 *
 * What matters most here, and why each block exists:
 *
 *  1. BUTTON-PAYLOAD MATCHING — the approved Gallabox template
 *     `customer_interactive_msg` ships a MISSPELLED payload,
 *     "Need a Reschdeule". Gallabox matches on the payload string, so the
 *     outbound value must stay byte-for-byte wrong; inbound matching must be
 *     robust (case/whitespace) and must also survive a future re-approval that
 *     fixes the spelling. These tests are the tripwire against someone
 *     "correcting" the constant.
 *  2. PAST-DATE REJECTION — we must never write an appointment that has
 *     already gone by (the platform's past-appointment gate, in chat form).
 *  3. 1-HOUR SLOT PARSING of messy human input.
 *  4. GPS SERIALISATION — tbl_address.gps_location holds the legacy "lat,lng"
 *     string that the technician app reads for navigation. A format change
 *     would silently break navigation, so the exact shape is pinned.
 *
 * No DB, no network: the pure helpers are called directly, and the two flow
 * tests hand the service a fake pool + a stubbed gallabox sender.
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool } = require('./helpers/fake-pool');

const convo = require('../services/whatsapp-conversation.service');
const gallabox = require('../services/gallabox.whatsapp.service');

// A fixed instant so every date assertion is deterministic:
// 2026-08-05 10:30 IST (Wednesday).
const NOW = Date.parse('2026-08-05T05:00:00Z'); // 10:30 IST

// ── 1. Template button payloads + inbound matching ──────────────────────

test('the outbound reschedule payload keeps the UPSTREAM misspelling verbatim', () => {
  assert.equal(convo.BTN_PAYLOAD.RESCHEDULE, 'Need a Reschdeule',
    'the approved template is misspelled; Gallabox matches on the payload string, so correcting it breaks button matching');
  assert.equal(convo.BTN_PAYLOAD.CONFIRM, 'Yes, Confirm');
  assert.equal(convo.BTN_PAYLOAD.NOT_REQUIRED, 'Service Not Required');
});

test('templateButtonValues sends three quick replies at indexes 0,1,2 in order', () => {
  const bv = convo.templateButtonValues();
  assert.equal(bv.length, 3);
  assert.deepEqual(bv.map((b) => b.index), [0, 1, 2]);
  assert.deepEqual(bv.map((b) => b.type), ['quick_reply', 'quick_reply', 'quick_reply']);
  assert.deepEqual(bv.map((b) => b.payload), ['Yes, Confirm', 'Need a Reschdeule', 'Service Not Required']);
});

test('matchTemplateChoice maps the three EXACT approved payloads', () => {
  assert.equal(convo.matchTemplateChoice('Yes, Confirm'), 'confirm');
  assert.equal(convo.matchTemplateChoice('Need a Reschdeule'), 'reschedule');
  assert.equal(convo.matchTemplateChoice('Service Not Required'), 'not_required');
});

test('matchTemplateChoice is case-insensitive and trimmed', () => {
  assert.equal(convo.matchTemplateChoice('  yes, confirm '), 'confirm');
  assert.equal(convo.matchTemplateChoice('NEED A RESCHDEULE'), 'reschedule');
  assert.equal(convo.matchTemplateChoice('  SERVICE not required  '), 'not_required');
});

test('matchTemplateChoice accepts the CORRECTED spelling too (future template re-approval)', () => {
  assert.equal(convo.matchTemplateChoice('Need a Reschedule'), 'reschedule',
    'a fixed template must not need a code change');
  assert.equal(convo.matchTemplateChoice('reschedule'), 'reschedule');
  assert.equal(convo.matchTemplateChoice('need a reschdeule'), 'reschedule');
});

test('matchTemplateChoice tolerates typed replies and rejects noise', () => {
  assert.equal(convo.matchTemplateChoice('yes'), 'confirm');
  assert.equal(convo.matchTemplateChoice('confirmed'), 'confirm');
  assert.equal(convo.matchTemplateChoice("I don't need this service"), 'not_required');
  assert.equal(convo.matchTemplateChoice('service not needed'), 'not_required');
  assert.equal(convo.matchTemplateChoice(''), null);
  assert.equal(convo.matchTemplateChoice(null), null);
  assert.equal(convo.matchTemplateChoice('send me photos'), null);
  assert.equal(convo.matchTemplateChoice('10 AM'), null, 'a slot reply must not be read as a branch choice');
});

// ── 2. Past-date / past-slot rejection ──────────────────────────────────

test('isPastIstDate compares against the IST calendar day', () => {
  assert.equal(convo.isPastIstDate('2026-08-04', NOW), true);
  assert.equal(convo.isPastIstDate('2026-08-05', NOW), false, 'today is NOT past');
  assert.equal(convo.isPastIstDate('2026-08-06', NOW), false);
  assert.equal(convo.isPastIstDate('not-a-date', NOW), false);
});

test('validateAppointment REJECTS a past date — we never write a past appointment', () => {
  assert.deepEqual(convo.validateAppointment('2026-08-04', '10:00', NOW), { ok: false, reason: 'past_date' });
  assert.deepEqual(convo.validateAppointment('2025-01-01', null, NOW), { ok: false, reason: 'past_date' });
});

test('validateAppointment REJECTS a slot that has already ended TODAY', () => {
  // 10:30 IST — the 9 AM frame ended at 10:00.
  assert.deepEqual(convo.validateAppointment('2026-08-05', '09:00', NOW), { ok: false, reason: 'past_slot' });
  // The 10 AM frame runs to 11:00, so it is still live at 10:30.
  assert.deepEqual(convo.validateAppointment('2026-08-05', '10:00', NOW), { ok: true });
  assert.deepEqual(convo.validateAppointment('2026-08-05', '16:00', NOW), { ok: true });
});

test('validateAppointment accepts any slot on a FUTURE date, and flags junk', () => {
  assert.deepEqual(convo.validateAppointment('2026-08-06', '09:00', NOW), { ok: true });
  assert.deepEqual(convo.validateAppointment(null, '09:00', NOW), { ok: false, reason: 'invalid' });
  assert.deepEqual(convo.validateAppointment('05-08-2026', '09:00', NOW), { ok: false, reason: 'invalid' });
  assert.deepEqual(convo.validateAppointment('2026-08-06', 'noon', NOW), { ok: false, reason: 'invalid' });
});

test('parseCustomerDate resolves relative, ISO, day-first and month-name dates', () => {
  assert.equal(convo.parseCustomerDate('tomorrow', NOW), '2026-08-06');
  assert.equal(convo.parseCustomerDate('Today please', NOW), '2026-08-05');
  assert.equal(convo.parseCustomerDate('day after tomorrow', NOW), '2026-08-07');
  assert.equal(convo.parseCustomerDate('2026-08-11', NOW), '2026-08-11');
  assert.equal(convo.parseCustomerDate('11-08-2026', NOW), '2026-08-11', 'day-first, Indian convention');
  assert.equal(convo.parseCustomerDate('11/08', NOW), '2026-08-11');
  assert.equal(convo.parseCustomerDate('11 Aug', NOW), '2026-08-11');
  assert.equal(convo.parseCustomerDate('11th August 2026', NOW), '2026-08-11');
  assert.equal(convo.parseCustomerDate('Aug 11', NOW), '2026-08-11');
});

test('parseCustomerDate rolls a bare day/month forward when it has already passed', () => {
  // 2 Jan is behind 5 Aug 2026, so an omitted year means NEXT year.
  assert.equal(convo.parseCustomerDate('2 Jan', NOW), '2027-01-02');
});

test('parseCustomerDate returns null for vague input (handed to ai.service)', () => {
  assert.equal(convo.parseCustomerDate('sometime next week maybe', NOW), null);
  assert.equal(convo.parseCustomerDate('', NOW), null);
  assert.equal(convo.parseCustomerDate('31 Feb', NOW), null, 'an impossible date must not roll over to March');
});

// ── 3. 1-hour slot parsing ──────────────────────────────────────────────

test('ONE_HOUR_SLOTS are ten 1-HOUR frames, 9 AM → 7 PM', () => {
  assert.equal(convo.ONE_HOUR_SLOTS.length, 10);
  assert.equal(convo.ONE_HOUR_SLOTS[0].label, '9 AM–10 AM');
  assert.equal(convo.ONE_HOUR_SLOTS[0].start, '09:00');
  assert.equal(convo.ONE_HOUR_SLOTS[9].label, '6 PM–7 PM');
  for (const s of convo.ONE_HOUR_SLOTS) {
    assert.equal(Number(s.end.slice(0, 2)) - Number(s.start.slice(0, 2)), 1, `${s.label} must span exactly one hour`);
    // These labels are PRESENTATION ONLY as of 2026-07-31 — none of them is
    // written to tbl_job.time_slot any more (that column takes the containing
    // BAND; the frame survives as requested_date_time / requested_time). The
    // width bound is kept anyway: it costs nothing and the labels also ride in
    // WhatsApp quick replies, which have their own length limits.
    assert.ok(s.label.length <= 12, `${s.label} (${s.label.length}) must stay short`);
  }
});

test('parseOneHourSlot reads plain times', () => {
  assert.equal(convo.parseOneHourSlot('10 AM').start, '10:00');
  assert.equal(convo.parseOneHourSlot('10am').start, '10:00');
  assert.equal(convo.parseOneHourSlot('4 pm').start, '16:00');
  assert.equal(convo.parseOneHourSlot('4pm please').start, '16:00');
  assert.equal(convo.parseOneHourSlot('16:00').start, '16:00');
  assert.equal(convo.parseOneHourSlot('noon').start, '12:00');
  assert.equal(convo.parseOneHourSlot('12 pm').start, '12:00');
});

test('parseOneHourSlot takes the START of a RANGE', () => {
  assert.equal(convo.parseOneHourSlot('3-4 pm').start, '15:00');
  assert.equal(convo.parseOneHourSlot('3 – 4 PM').start, '15:00', 'en-dash range');
  assert.equal(convo.parseOneHourSlot('between 4 and 5').start, '16:00');
  assert.equal(convo.parseOneHourSlot('10 to 11 am').start, '10:00');
  assert.equal(convo.parseOneHourSlot('9 AM–10 AM').start, '09:00', 'our own echoed label round-trips');
});

test('parseOneHourSlot assumes afternoon for a bare 1–8 (no frame starts before 9 AM)', () => {
  assert.equal(convo.parseOneHourSlot('5').start, '17:00');
  assert.equal(convo.parseOneHourSlot('at 3').start, '15:00');
  assert.equal(convo.parseOneHourSlot('11').start, '11:00', 'a bare 9–18 is read as-is');
});

test('parseOneHourSlot snaps a part-hour DOWN to the containing frame', () => {
  assert.equal(convo.parseOneHourSlot('10:30').start, '10:00');
  assert.equal(convo.parseOneHourSlot('4:45 pm').start, '16:00');
});

test('parseOneHourSlot rejects out-of-window and unparseable input', () => {
  assert.equal(convo.parseOneHourSlot('8 am'), null, 'before the service window');
  assert.equal(convo.parseOneHourSlot('9 pm'), null, 'after the service window');
  assert.equal(convo.parseOneHourSlot('morning'), null, 'too vague — handed to ai.service');
  assert.equal(convo.parseOneHourSlot('whenever'), null);
  assert.equal(convo.parseOneHourSlot(''), null);
  assert.equal(convo.parseOneHourSlot(null), null);
});

test('slotByLabelOrStart accepts an AI HH:MM start and our own label', () => {
  assert.equal(convo.slotByLabelOrStart('16:00').label, '4 PM–5 PM');
  assert.equal(convo.slotByLabelOrStart('9:00').label, '9 AM–10 AM');
  assert.equal(convo.slotByLabelOrStart('4 PM–5 PM').start, '16:00');
  assert.equal(convo.slotByLabelOrStart('07:00'), null, 'outside the offered frames');
  assert.equal(convo.slotByLabelOrStart(''), null);
});

// ── 4. GPS coordinate serialisation ─────────────────────────────────────

test('formatGpsLocation produces the legacy "lat,lng" string the tech app navigates on', () => {
  assert.equal(convo.formatGpsLocation(28.6315, 77.2167), '28.6315,77.2167');
  assert.equal(convo.formatGpsLocation('28.6315', '77.2167'), '28.6315,77.2167', 'string input is coerced');
  assert.equal(convo.formatGpsLocation(-33.8688, 151.2093), '-33.8688,151.2093');
  assert.equal(convo.formatGpsLocation(0, 0), '0,0');
  // No JSON, no spaces, no parentheses — the column is a plain varchar the
  // technician app parses by splitting on the comma.
  assert.match(convo.formatGpsLocation(12.9, 77.5), /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
});

test('formatGpsLocation refuses junk rather than persisting "NaN,NaN" or "0,0"', () => {
  assert.equal(convo.formatGpsLocation(undefined, undefined), null);
  assert.equal(convo.formatGpsLocation('abc', 77.2), null);
  assert.equal(convo.formatGpsLocation(NaN, 1), null);
  // Number(null) === 0 and Number('') === 0 — without an explicit empty check a
  // missing pin would be stored as "0,0" and the tech app would navigate there.
  assert.equal(convo.formatGpsLocation(null, null), null);
  assert.equal(convo.formatGpsLocation(null, 77.2), null);
  assert.equal(convo.formatGpsLocation('', ''), null);
  assert.equal(convo.formatGpsLocation(undefined, 77.2), null);
  assert.equal(convo.formatGpsLocation(91, 20), null, 'latitude out of range');
  assert.equal(convo.formatGpsLocation(20, 181), null, 'longitude out of range');
});

test('formatGpsLocation matches maps.service.reverseGeocode byte-for-byte', () => {
  // reverseGeocode builds `${Number(lat)},${Number(lng)}` — the same value must
  // come out of both paths or the column would hold two formats.
  const lat = 19.076;
  const lng = 72.8777;
  assert.equal(convo.formatGpsLocation(lat, lng), `${Number(lat)},${Number(lng)}`);
});

// ── 5. Template variable rendering ──────────────────────────────────────

test('formatCustomerDateLabel renders a customer-friendly date', () => {
  assert.equal(convo.formatCustomerDateLabel('2026-08-05'), 'Wed, 05 Aug 2026');
  assert.equal(convo.formatCustomerDateLabel('2026-08-05 15:00:00'), 'Wed, 05 Aug 2026');
  assert.equal(convo.formatCustomerDateLabel(null), null, 'null lets the caller substitute a fallback, not "null"');
  assert.equal(convo.formatCustomerDateLabel('garbage'), null);
});

/*
 * DRIFT GUARD. time-slot.appointmentDateLabel is the same formatter, added there
 * because the reschedule SMS (notification-orchestrator.service) needs an
 * appointment date and must not require THIS file to get one — it would drag
 * ai.service, maps.service, job-magic-link.service and S3 into a notification
 * path. Until this older twin is folded into that helper, the two must agree
 * character for character: the customer can receive the WhatsApp template and
 * the reschedule SMS about the same visit, and a one-day or one-spelling
 * disagreement between them reads as two different appointments.
 */
test('formatCustomerDateLabel agrees with time-slot.appointmentDateLabel, character for character', () => {
  const ts = require('../services/time-slot');
  const inputs = [
    '2026-08-05', '2026-08-05 15:00:00', '2026-08-05 00:00:00', '2026-08-05T09:30',
    '2026-01-01', '2026-02-28', '2026-12-25',
    null, undefined, '', 'garbage', '05-08-2026',
  ];
  for (const v of inputs) {
    assert.equal(convo.formatCustomerDateLabel(v), ts.appointmentDateLabel(v), `disagreed on ${JSON.stringify(v)}`);
  }
});

/*
 * PRECEDENCE 2026-07-31. The APPOINTMENT HOUR wins and the band is only the
 * fallback: the customer tapped a 1-hour frame, so echoing "3PM to 7PM" back at
 * them would read as if we had lost their choice.
 *
 * ⚠ The hour is `appointment_time`, projected off requested_date_time — NOT the
 * legacy requested_time TEXT column, which is corrupted on every row that passed
 * through the old reschedule() (an IST literal re-shifted by +05:30: job 482474
 * is requested_date_time 16:00 / requested_time 21:30). Those rows are not
 * migrated, so reading the text column would send a 4 PM customer "9:30 PM".
 * The last case below pins exactly that.
 */
test('jobDateLabel prefers the appointment hour, then falls back to time_slot', () => {
  assert.equal(convo.jobDateLabel({ appointment_date: '2026-08-05', time_slot: '3PM to 7PM', appointment_time: '15:00' }),
    'Wed, 05 Aug 2026, 3 PM', 'the 1-hour start wins over the broad band');
  assert.equal(convo.jobDateLabel({ appointment_date: '2026-08-05', time_slot: '3 PM – 7 PM' }),
    'Wed, 05 Aug 2026, 3 PM – 7 PM', 'a legacy row with no usable hour still shows its band');
  assert.equal(convo.jobDateLabel({ appointment_date: '2026-08-05', time_slot: '3 PM – 7 PM', appointment_time: '00:00' }),
    'Wed, 05 Aug 2026, 3 PM – 7 PM', 'the 00:00 sentinel is skipped, not rendered as midnight');
  assert.equal(convo.jobDateLabel({ appointment_date: '2026-08-05', appointment_time: '14:00' }),
    'Wed, 05 Aug 2026, 2 PM');
  assert.equal(convo.jobDateLabel({ appointment_date: '2026-08-05', appointment_time: '14:30' }),
    'Wed, 05 Aug 2026, 2:30 PM');
  assert.equal(convo.jobDateLabel({ appointment_date: '2026-08-05', appointment_time: '00:00' }),
    'Wed, 05 Aug 2026', 'the 00:00 legacy sentinel is not shown');
  assert.equal(convo.jobDateLabel({ appointment_date: null }), null, 'no date → caller uses the fallback string');
  // THE REGRESSION: job 482474's real shape. The corrupted TEXT column must
  // never reach the customer.
  assert.equal(
    convo.jobDateLabel({ appointment_date: '2026-08-05', appointment_time: '16:00', requested_time: '21:30', time_slot: '3PM to 7PM' }),
    'Wed, 05 Aug 2026, 4 PM',
    'the corrupted legacy requested_time is ignored in favour of the appointment instant',
  );
});

/*
 * jobDateLabel no longer formats the clock itself — it hands the wall clock
 * (appointment_date + appointment_time, two projections of the same column) to
 * time-slot.formatClock12. These are the boundaries where the two used to have
 * a chance of disagreeing, pinned on the composed customer string rather than
 * on the formatter alone, so a future change to either side is caught here.
 * See tests/time-slot.test.js for the formatter's own contract.
 */
test('jobDateLabel renders the shared formatter at every boundary that matters', () => {
  const at = (appointment_time) => convo.jobDateLabel({ appointment_date: '2026-08-05', appointment_time });
  assert.equal(at('12:00'), 'Wed, 05 Aug 2026, 12 PM', 'noon is 12 PM, never 0 PM');
  assert.equal(at('12:30'), 'Wed, 05 Aug 2026, 12:30 PM');
  assert.equal(at('00:30'), 'Wed, 05 Aug 2026, 12:30 AM', 'a real after-midnight visit still shows');
  assert.equal(at('09:00'), 'Wed, 05 Aug 2026, 9 AM', 'a whole hour drops the :00');
  assert.equal(at('09:05'), 'Wed, 05 Aug 2026, 9:05 AM', 'a part hour keeps zero-padded minutes');
  assert.equal(at('23:59'), 'Wed, 05 Aug 2026, 11:59 PM');
  assert.equal(at('00:00'), 'Wed, 05 Aug 2026', 'the sentinel yields no time at all');
  assert.equal(at('lunchtime'), 'Wed, 05 Aug 2026', 'unparseable time → date alone, never "null"');
  assert.equal(at(null), 'Wed, 05 Aug 2026');
  assert.equal(at(''), 'Wed, 05 Aug 2026');
});

test('composeAddressLine strips newlines — WhatsApp rejects them in a template parameter', () => {
  const line = convo.composeAddressLine({
    address: 'Flat 4B, Tower 2\nSector 45\t',
    landmark: 'Near Metro',
    city_name: 'Gurugram',
    pin_code: '122003',
  });
  assert.doesNotMatch(line, /[\n\t]/, 'a newline or tab in a template body param gets the whole send rejected');
  assert.equal(line, 'Flat 4B, Tower 2 Sector 45, Near Metro, Gurugram, 122003');
});

test('composeAddressLine drops blanks + duplicates and never returns undefined text', () => {
  // Dedupe is case-insensitive and FIRST-WINS (field order: address, landmark,
  // city, pin) — a landmark that just repeats the city collapses to one mention.
  assert.equal(convo.composeAddressLine({ address: 'Some Road', city_name: 'Pune', landmark: 'Pune' }),
    'Some Road, Pune', 'a landmark repeating the city is dropped');
  assert.equal(convo.composeAddressLine({ address: 'Some Road', city_name: 'Pune', landmark: 'PUNE' }),
    'Some Road, PUNE', 'case-insensitive match, first occurrence kept');
  assert.equal(convo.composeAddressLine({}), '');
  assert.equal(convo.composeAddressLine({ address: null, pin_code: 411001 }), '411001');
  assert.doesNotMatch(convo.composeAddressLine({ address: undefined, city_name: 'X' }), /undefined|null/);
});

// ── 6. Branch C reason classification ───────────────────────────────────

test('mapReasonCode keeps the EXISTING labels/types the CRM already reports on', () => {
  assert.deepEqual(convo.mapReasonCode('self_assembly'), { code: 'self_assembly', type: 'cancel', label: 'Self Assembly' });
  assert.deepEqual(convo.mapReasonCode('site_not_ready'), { code: 'site_not_ready', type: 'reschedule', label: 'Site Not Ready' });
  assert.deepEqual(convo.mapReasonCode('work_completed'), { code: 'work_completed', type: 'cancel', label: 'Work already completed' });
});

test('mapReasonCode falls back to Other for anything unrecognised', () => {
  assert.deepEqual(convo.mapReasonCode('other'), { code: 'other', type: 'cancel', label: 'Other' });
  assert.deepEqual(convo.mapReasonCode('hallucinated_category'), { code: 'other', type: 'cancel', label: 'Other' });
  assert.deepEqual(convo.mapReasonCode(null), { code: 'other', type: 'cancel', label: 'Other' });
});

test('classifyReasonKeyword is the AI-unavailable fallback, not a guesser', () => {
  assert.equal(convo.classifyReasonKeyword('I assembled it myself already'), 'self_assembly');
  assert.equal(convo.classifyReasonKeyword('did it myself'), 'self_assembly');
  assert.equal(convo.classifyReasonKeyword('the site is not ready yet'), 'site_not_ready');
  assert.equal(convo.classifyReasonKeyword('work is already done'), 'work_completed');
  assert.equal(convo.classifyReasonKeyword('someone else fixed it'), 'work_completed');
  assert.equal(convo.classifyReasonKeyword('I returned the product'), null, 'no match → caller stores Other + verbatim');
  assert.equal(convo.classifyReasonKeyword(''), null);
});

// ── 7. Flow: the opening template send ──────────────────────────────────

function stubTemplate() {
  const sent = [];
  const original = gallabox.sendTemplate;
  gallabox.sendTemplate = async (args) => { sent.push(args); return { delivered: true }; };
  return { sent, restore() { gallabox.sendTemplate = original; } };
}

const JOB_ROW = {
  job_id: 42,
  job_status: 9,
  time_slot: '3 PM – 7 PM',
  requested_time: '15:00',
  appointment_date: '2026-08-05',
  // Projected off requested_date_time by loadJobForConversation — the hour
  // jobDateLabel actually renders.
  appointment_time: '15:00',
  fk_address_id: 10,
  customer_mob_no: '9876543210',
  customer_name: 'Asha',
  client_name: 'For Testing',
  address: 'Flat 4B, Tower 2',
  landmark: 'Near Metro',
  pin_code: '122003',
  city_name: 'Gurugram',
};

test('startConversation sends `customer_interactive_msg` with NAMED bodyValues + the 3 quick replies', async () => {
  const stub = stubTemplate();
  try {
    const fake = makeFakePool([
      [/FROM tbl_job j/, [JOB_ROW]],
      [/SELECT conversation_id FROM tbl_whatsapp_conversation/, []],
      [/INSERT INTO tbl_whatsapp_conversation/, { insertId: 7 }],
    ]);
    const res = await convo.startConversation(42, { action: 'first' }, fake.pool);
    assert.equal(res.delivered, true);

    assert.equal(stub.sent.length, 1);
    const t = stub.sent[0];
    assert.equal(t.templateName, 'customer_interactive_msg');
    // NAMED keys, not positional 1/2/3.
    assert.deepEqual(Object.keys(t.bodyValues).sort(), ['address', 'client_name', 'date', 'name']);
    assert.equal(t.bodyValues.client_name, 'For Testing');
    assert.equal(t.bodyValues.name, 'Asha');
    // JOB_ROW carries requested_time 15:00, which now outranks the band label.
    assert.equal(t.bodyValues.date, 'Wed, 05 Aug 2026, 3 PM');
    assert.equal(t.bodyValues.address, 'Flat 4B, Tower 2, Near Metro, Gurugram, 122003');
    assert.deepEqual(t.buttonValues.map((b) => b.payload),
      ['Yes, Confirm', 'Need a Reschdeule', 'Service Not Required']);

    // The row opens at awaiting_choice, and the cadence stamp binds a JS Date
    // (pool timezone +05:30 → IST verbatim) instead of SQL NOW().
    const ins = fake.calls.find((c) => /INSERT INTO tbl_whatsapp_conversation/.test(c.sql));
    assert.ok(ins.params.includes('awaiting_choice'), 'new conversations open at awaiting_choice');
    const stamp = fake.calls.find((c) => /magic_link_sent_at/.test(c.sql));
    assert.match(stamp.sql, /magic_link_sent_at = \?/, 'never SQL NOW() for an application timestamp');
    assert.ok(stamp.params[0] instanceof Date);
  } finally {
    stub.restore();
  }
});

test('startConversation substitutes a graceful fallback when the job has no scheduled date', async () => {
  const stub = stubTemplate();
  try {
    const fake = makeFakePool([
      [/FROM tbl_job j/, [{ ...JOB_ROW, appointment_date: null, appointment_time: null, time_slot: null, requested_time: null }]],
      [/SELECT conversation_id FROM tbl_whatsapp_conversation/, []],
      [/INSERT INTO tbl_whatsapp_conversation/, { insertId: 8 }],
    ]);
    await convo.startConversation(42, {}, fake.pool);
    const t = stub.sent[0];
    assert.equal(t.bodyValues.date, 'To be confirmed');
    assert.doesNotMatch(String(t.bodyValues.date), /null|undefined/);
    assert.doesNotMatch(String(t.bodyValues.address), /null|undefined/);
  } finally {
    stub.restore();
  }
});

// ── 8. Flow: a location pin is captured wherever it arrives ─────────────

test('captureCustomerGps writes ONLY gps_location — never the booked address text', async () => {
  const fake = makeFakePool([[/SELECT fk_address_id FROM tbl_job/, [{ fk_address_id: 10 }]]]);
  const gps = await convo.captureCustomerGps(42, { lat: 28.6315, lng: 77.2167 }, fake.pool);
  assert.equal(gps, '28.6315,77.2167');

  const write = fake.calls.find((c) => /UPDATE tbl_address/.test(c.sql));
  assert.ok(write, 'the pin must reach tbl_address');
  assert.match(write.sql, /gps_location = COALESCE/, 'COALESCE-guarded, so no other column is blanked');
  assert.ok(write.params.includes('28.6315,77.2167'), 'the coordinates are bound as a param');
  assert.ok(write.params.includes(10), 'scoped to the job\'s fk_address_id');
  // The booked address is ops-entered data with a different role — a pin must
  // never overwrite it (unlike the superseded awaiting_location handler).
  const addressParamIdx = 0; // COALESCE_COLUMNS order starts with `address`
  assert.equal(write.params[addressParamIdx], null, 'address stays NULL → COALESCE keeps the ops value');
});

test('captureCustomerGps is best-effort — a junk pin or missing address writes nothing', async () => {
  const noAddr = makeFakePool([[/SELECT fk_address_id FROM tbl_job/, [{ fk_address_id: null }]]]);
  assert.equal(await convo.captureCustomerGps(42, { lat: 1, lng: 2 }, noAddr.pool), null);
  assert.equal(noAddr.calls.filter((c) => /UPDATE tbl_address/.test(c.sql)).length, 0);

  const junk = makeFakePool([[/SELECT fk_address_id FROM tbl_job/, [{ fk_address_id: 10 }]]]);
  assert.equal(await convo.captureCustomerGps(42, { lat: 'x', lng: null }, junk.pool), null);
  assert.equal(junk.calls.length, 0, 'an unusable pin short-circuits before any query');
});
