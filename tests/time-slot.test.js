/*
 * services/time-slot.js — the appointment slot model.
 *
 * Pins the two things this module exists to guarantee:
 *
 *   1. tbl_job.time_slot only ever receives one of FOUR broad bands. A 1-hour
 *      frame label ('3 PM–4 PM') must never reach the column again — that
 *      experiment was reversed on 2026-07-31, and the 1-hour granularity now
 *      lives in requested_date_time / requested_time.
 *
 *   2. The booking-conflict test is a real 1-HOUR OVERLAP on the appointment
 *      datetime, NOT string equality on a 3-to-5-hour band. Two jobs an hour
 *      apart must NOT conflict; the same hour must; and the 00:00 midnight
 *      sentinel ("no time captured", not "booked at midnight") must never
 *      manufacture a conflict — that would hard-filter technicians far more
 *      aggressively than the band equality it replaces.
 *
 * Pure functions — no DB, no network. Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ts = require('../services/time-slot');

const {
  BAND_MORNING, BAND_AFTERNOON, BAND_EVENING, BAND_AFTER_HOURS,
  TIME_SLOT_BANDS,
} = ts;

/*
 * The canonical four, byte-for-byte. These are the strings the live picker
 * already writes (39,997 / 14,665 / 2,204 rows on prod) — a stray space or an
 * en-dash here is a different vocabulary, which is the whole disease.
 */
test('the four bands are the exact canonical strings', () => {
  assert.deepEqual(TIME_SLOT_BANDS, ['9AM to 12PM', '12PM to 3PM', '3PM to 7PM', 'After Hours']);
});

// ─── deriveTimeSlot boundaries ───────────────────────────────────────
/*
 * Every boundary the spec names, taken from both sides. The one-minute-before
 * cases are the ones a naive `>` / `>=` mix-up breaks.
 */
test('deriveTimeSlot boundaries: 08:59 / 09:00 / 11:59 / 12:00', () => {
  assert.equal(ts.deriveTimeSlot('2026-08-05 08:59:00'), BAND_AFTER_HOURS);
  assert.equal(ts.deriveTimeSlot('2026-08-05 09:00:00'), BAND_MORNING);
  assert.equal(ts.deriveTimeSlot('2026-08-05 11:59:00'), BAND_MORNING);
  assert.equal(ts.deriveTimeSlot('2026-08-05 12:00:00'), BAND_AFTERNOON);
});

test('deriveTimeSlot boundaries: 14:59 / 15:00 / 18:59 / 19:00', () => {
  assert.equal(ts.deriveTimeSlot('2026-08-05 14:59:00'), BAND_AFTERNOON);
  assert.equal(ts.deriveTimeSlot('2026-08-05 15:00:00'), BAND_EVENING);
  assert.equal(ts.deriveTimeSlot('2026-08-05 18:59:00'), BAND_EVENING);
  assert.equal(ts.deriveTimeSlot('2026-08-05 19:00:00'), BAND_AFTER_HOURS);
});

test('deriveTimeSlot returns null when there is no hour to read', () => {
  assert.equal(ts.deriveTimeSlot(null), null);
  assert.equal(ts.deriveTimeSlot(''), null);
  assert.equal(ts.deriveTimeSlot('not-a-date'), null);
  assert.equal(ts.deriveTimeSlot('2026-08-05'), null, 'date-only has no time-of-day');
});

test('deriveTimeSlot accepts the datetime-local T separator as well as the SQL space', () => {
  assert.equal(ts.deriveTimeSlot('2026-08-05T10:30'), BAND_MORNING);
  assert.equal(ts.deriveTimeSlot('2026-08-05 10:30:00'), BAND_MORNING);
});

/*
 * THE INVARIANT. Whatever hour of the day, deriveTimeSlot may only answer with
 * one of the four bands — never a 1-hour frame, never one of the retired
 * 'Morning 9 to 2' / 'Evening 2 to 7' labels.
 */
test('deriveTimeSlot NEVER returns a 1-hour label, for any hour of the day', () => {
  for (let h = 0; h < 24; h += 1) {
    const stamp = `2026-08-05 ${String(h).padStart(2, '0')}:30:00`;
    const band = ts.deriveTimeSlot(stamp);
    assert.ok(TIME_SLOT_BANDS.includes(band), `${stamp} → ${band} is not one of the four bands`);
    assert.doesNotMatch(String(band), /–|-/, `${stamp} → ${band} looks like a frame label`);
  }
});

// ─── normaliseSlotLabel ──────────────────────────────────────────────
test('normaliseSlotLabel maps a 1-hour frame onto its CONTAINING band', () => {
  assert.equal(ts.normaliseSlotLabel('3 PM–4 PM'), BAND_EVENING);
  assert.equal(ts.normaliseSlotLabel('9 AM–10 AM'), BAND_MORNING);
  assert.equal(ts.normaliseSlotLabel('11 AM–12 PM'), BAND_MORNING);
  assert.equal(ts.normaliseSlotLabel('12 PM–1 PM'), BAND_AFTERNOON);
  assert.equal(ts.normaliseSlotLabel('6 PM–7 PM'), BAND_EVENING);
  // hyphen / spaced variants of the same frame must land identically
  assert.equal(ts.normaliseSlotLabel('3 PM - 4 PM'), BAND_EVENING);
});

test('normaliseSlotLabel canonicalises the customer form’s spaced-en-dash bands', () => {
  assert.equal(ts.normaliseSlotLabel('9 AM – 12 PM'), BAND_MORNING);
  assert.equal(ts.normaliseSlotLabel('12 PM – 3 PM'), BAND_AFTERNOON);
  assert.equal(ts.normaliseSlotLabel('3 PM – 7 PM'), BAND_EVENING);
});

test('normaliseSlotLabel is the identity on the four canonical bands', () => {
  for (const band of TIME_SLOT_BANDS) assert.equal(ts.normaliseSlotLabel(band), band);
});

test('normaliseSlotLabel folds the whole After Hours family together', () => {
  assert.equal(ts.normaliseSlotLabel('After Hours'), BAND_AFTER_HOURS);
  assert.equal(ts.normaliseSlotLabel('After Hours - 19:00'), BAND_AFTER_HOURS);
  assert.equal(ts.normaliseSlotLabel('after hours'), BAND_AFTER_HOURS);
});

/*
 * A bare 1–8 with no meridiem is afternoon/evening: no booking window starts
 * before 9 AM, so the legacy '3-7' means 3 PM. Same rule the WhatsApp free-text
 * parser applies.
 */
test('normaliseSlotLabel reads a bare 1–8 as afternoon, matching the chat parser', () => {
  assert.equal(ts.normaliseSlotLabel('3-7'), BAND_EVENING);
  assert.equal(ts.normaliseSlotLabel('12-3'), BAND_AFTERNOON);
  assert.equal(ts.normaliseSlotLabel('9-12'), BAND_MORNING);
  assert.equal(ts.normaliseSlotLabel('15:00'), BAND_EVENING);
});

/*
 * We refuse to GUESS an hour that was never written down. The free-text legacy
 * vocabulary returns null so the caller falls back to the appointment datetime
 * (which is real evidence) rather than inventing a band.
 */
test('normaliseSlotLabel returns null for the free-text legacy vocabulary', () => {
  for (const junk of ['Morning 9 to 2', 'Evening 2 to 7', 'Afternoon 12 to 5',
                      'morning 9 to night 8', 'Anytime', '', null, undefined]) {
    assert.equal(ts.normaliseSlotLabel(junk), null, `${JSON.stringify(junk)} should not resolve`);
  }
});

// ─── resolveTimeSlot — the writer-side gate ──────────────────────────
test('resolveTimeSlot lets the APPOINTMENT TIME win over any caller label', () => {
  // The operator picked the 3 PM–4 PM frame; the band follows the instant.
  assert.equal(ts.resolveTimeSlot('3 PM–4 PM', '2026-08-05 15:00:00'), BAND_EVENING);
  // A caller label that contradicts the instant does not get to win.
  assert.equal(ts.resolveTimeSlot('9AM to 12PM', '2026-08-05 14:00:00'), BAND_AFTERNOON);
  // No label at all is fine — the instant is all we need.
  assert.equal(ts.resolveTimeSlot(null, '2026-08-05 10:00:00'), BAND_MORNING);
});

test('resolveTimeSlot falls back to the caller label when the booking is DATE-ONLY', () => {
  // Midnight is the "no time captured" sentinel, so the label is all we have.
  assert.equal(ts.resolveTimeSlot('3 PM–4 PM', '2026-08-05 00:00:00'), BAND_EVENING);
  assert.equal(ts.resolveTimeSlot('9 AM – 12 PM', '2026-08-05 00:00:00'), BAND_MORNING);
  assert.equal(ts.resolveTimeSlot('12PM to 3PM', null), BAND_AFTERNOON);
});

test('resolveTimeSlot keeps an unreadable legacy label verbatim rather than inventing a band', () => {
  assert.equal(ts.resolveTimeSlot('Morning 9 to 2', '2026-08-05 00:00:00'), 'Morning 9 to 2');
  assert.equal(ts.resolveTimeSlot('Anytime', null), 'Anytime');
});

test('resolveTimeSlot preserves the legacy date-only create fallback', () => {
  // No label AND no time-of-day → the historical 'After Hours' default.
  assert.equal(ts.resolveTimeSlot(null, '2026-08-05 00:00:00'), BAND_AFTER_HOURS);
  assert.equal(ts.resolveTimeSlot(null, null), null);
});

/*
 * THE HEADLINE GUARANTEE, swept over every frame the pickers can produce: a
 * 1-hour label handed to the writer-side gate always comes back as a band.
 */
test('resolveTimeSlot NEVER yields a 1-hour label, for any offered frame', () => {
  for (const h of ts.SLOT_START_HOURS) {
    const hh = String(h).padStart(2, '0');
    const h12 = ((h + 11) % 12) + 1;
    const n12 = ((h + 12) % 12) + 1;
    const label = `${h12} ${h < 12 ? 'AM' : 'PM'}–${n12} ${h + 1 < 12 ? 'AM' : 'PM'}`;
    const stored = ts.resolveTimeSlot(label, `2026-08-05 ${hh}:00:00`);
    assert.ok(TIME_SLOT_BANDS.includes(stored), `${label} stored as ${stored}`);
    // ...and also when there is no appointment instant to lean on.
    const storedNoDt = ts.resolveTimeSlot(label, null);
    assert.ok(TIME_SLOT_BANDS.includes(storedNoDt), `${label} (no datetime) stored as ${storedNoDt}`);
  }
});

// ─── the midnight sentinel ───────────────────────────────────────────
test('hasTimeOfDay rejects the 00:00 sentinel and every no-time shape', () => {
  assert.equal(ts.hasTimeOfDay('2026-08-05 00:00:00'), false);
  assert.equal(ts.hasTimeOfDay('2026-08-05 00:00'), false);
  assert.equal(ts.hasTimeOfDay('2026-08-05'), false);
  assert.equal(ts.hasTimeOfDay(null), false);
  assert.equal(ts.hasTimeOfDay('rubbish'), false);
  // A genuine after-midnight visit carries a real minute and passes.
  assert.equal(ts.hasTimeOfDay('2026-08-05 00:30:00'), true);
  assert.equal(ts.hasTimeOfDay('2026-08-05 09:00:00'), true);
});

// ─── the conflict predicate ──────────────────────────────────────────
/*
 * conflictFrame gives the (date, hour) the SQL binds verbatim
 * (`DATE(requested_date_time) = ? AND HOUR(requested_date_time) = ?`), so
 * testing the JS mirror tests the query too — they are one implementation.
 *
 * THE RULE is "same 1-hour slot", NOT a sliding window. That distinction is
 * what removes the over-exclusion: under a sliding ±1h window a 09:30 job and a
 * 10:15 job overlapped and one lost the technician; they are different frames
 * and must not clash.
 */
test('conflictFrame is the appointment date and hour', () => {
  assert.deepEqual(ts.conflictFrame('2026-08-05 15:00:00'), { date: '2026-08-05', hour: 15 });
  assert.deepEqual(ts.conflictFrame('2026-08-05 15:45:00'), { date: '2026-08-05', hour: 15 },
    'a part-hour time belongs to the frame that CONTAINS it');
});

test('conflictFrame reads the late-evening hour without a date bug', () => {
  assert.deepEqual(ts.conflictFrame('2026-08-05 23:30:00'), { date: '2026-08-05', hour: 23 });
});

test('NOT a sliding window: adjacent part-hours are different frames', () => {
  assert.equal(ts.sameConflictFrame('2026-08-05 09:30:00', '2026-08-05 10:15:00'), false,
    '45 minutes apart but different hours — a sliding window would have clashed these');
});

test('THE FIX: two jobs an hour apart do NOT conflict', () => {
  assert.equal(ts.sameConflictFrame('2026-08-05 09:00:00', '2026-08-05 11:00:00'), false,
    'a 9 AM job must no longer block an 11 AM job — this is the over-exclusion being removed');
  assert.equal(ts.sameConflictFrame('2026-08-05 09:00:00', '2026-08-05 10:00:00'), false,
    'exactly one hour apart: the first ENDS as the second begins');
  assert.equal(ts.sameConflictFrame('2026-08-05 10:00:00', '2026-08-05 09:00:00'), false,
    'and symmetrically the other way round');
});

test('the same hour DOES conflict, and so does any part-hour overlap', () => {
  assert.equal(ts.sameConflictFrame('2026-08-05 09:00:00', '2026-08-05 09:00:00'), true);
  assert.equal(ts.sameConflictFrame('2026-08-05 09:00:00', '2026-08-05 09:30:00'), true);
  assert.equal(ts.sameConflictFrame('2026-08-05 09:30:00', '2026-08-05 09:00:00'), true);
  assert.equal(ts.sameConflictFrame('2026-08-05 09:00:00', '2026-08-05 09:59:59'), true);
});

test('conflicts are scoped to the day — same hour, different date, no clash', () => {
  assert.equal(ts.sameConflictFrame('2026-08-05 09:00:00', '2026-08-06 09:00:00'), false);
});

/*
 * THE TRAP THAT MUST NOT SHIP. Legacy rows sit at 00:00:00 meaning "no time
 * captured". A naive hour comparison makes every one of them collide
 * with every other at midnight, which would exclude technicians FAR more
 * aggressively than the band equality this replaces.
 */
test('the midnight sentinel never manufactures a conflict', () => {
  assert.equal(ts.conflictFrame('2026-08-05 00:00:00'), null,
    'a sentinel PROPOSED job produces no frame at all ⇒ the filter stands down');
  assert.equal(ts.sameConflictFrame('2026-08-05 00:00:00', '2026-08-05 00:00:00'), false,
    'two sentinel rows must not collide with each other');
  assert.equal(ts.sameConflictFrame('2026-08-05 09:00:00', '2026-08-05 00:00:00'), false,
    'a sentinel CANDIDATE row must not block a real 9 AM booking');
  assert.equal(ts.sameConflictFrame('2026-08-05 00:00:00', '2026-08-05 09:00:00'), false);
  assert.equal(ts.conflictFrame(null), null);
  assert.equal(ts.conflictFrame('2026-08-05'), null, 'a date-only proposal has no hour to compare');
});

test('a genuine after-midnight visit still conflicts normally', () => {
  // 00:30 is a real appointment (After Hours), not the sentinel.
  assert.equal(ts.sameConflictFrame('2026-08-05 00:30:00', '2026-08-05 00:45:00'), true);
  assert.equal(ts.sameConflictFrame('2026-08-05 00:30:00', '2026-08-05 02:00:00'), false);
});

// ─── wallClockTime ───────────────────────────────────────────────────
/*
 * requested_time carries the 1-hour START, so it must be read STRAIGHT off the
 * IST wall-clock literal. job.service's formatTimeIST() re-parses such a string
 * as a real instant and adds +05:30 again — on our UTC containers that stored a
 * 16:00 appointment as requested_time '21:30' (live example: job 482474).
 */
test('wallClockTime takes the time-of-day verbatim, with no timezone shift', () => {
  assert.equal(ts.wallClockTime('2026-08-05 14:30:00'), '14:30');
  assert.equal(ts.wallClockTime('2026-08-05T09:00'), '09:00');
  assert.equal(ts.wallClockTime('2026-08-05 00:00:00'), '00:00');
  assert.equal(ts.wallClockTime('2026-08-05'), null);
  assert.equal(ts.wallClockTime(null), null);
});
