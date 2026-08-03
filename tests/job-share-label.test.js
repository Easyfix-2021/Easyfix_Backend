'use strict';

/*
 * job-share — the APPOINTMENT LINE on the public shared-job link.
 *
 * ─── WHY THESE TESTS EXIST ────────────────────────────────────────────────
 *
 * A technician shares /public/shared-job/<token> with a customer. The page and
 * the WhatsApp/share-sheet blurb both state when the visit is. Both used to
 * build that line as `[requested_date_label, time_slot].join(' · ')` — the page
 * in the FE, the blurb in buildShareMessage — off the RAW tbl_job.time_slot.
 *
 * That column is DERIVED: it is the band containing requested_date_time, and
 * resolveTimeSlot re-derives it on every write. So a stored value that
 * disagrees with the appointment is already dead — the next save discards it.
 * Job #482491 is the recorded case: requested_date_time 05:30, which is
 * 'After Hours', stored alongside time_slot '3pm to 7pm'. The public link
 * published '3pm to 7pm' to the customer.
 *
 * The fix keeps showing a BAND (the promise is a window, not "the technician
 * arrives at 5:30 exactly") — just the band the appointment actually falls in.
 *
 * ─── DATE + BAND, NEVER THE MINUTE ────────────────────────────────────────
 *
 * The label briefly carried the exact time too ('Tue, 5 Aug 2026, 5:30 AM ·
 * After Hours'). The owner reversed that on 2026-08-03: "we don't want to commit
 * that the technician will reach exactly at 5:30 as it can get late, but we are
 * committing that they will reach in this slot". The line is back to
 *   'Tue, 5 Aug 2026 · After Hours'
 * and the minute must appear in NEITHER the label NOR the share message — pinned
 * below so putting the clock back is a deliberate product decision rather than
 * something that rides along with a formatting tweak.
 *
 * Three behaviours are pinned, because none is reachable by a type checker —
 * they are value-level facts about rows this repo cannot see:
 *
 *   1. A job with a REAL time-of-day: the band is DERIVED and the contradicting
 *      stored string must not appear anywhere in the payload or the message.
 *   2. A date-only job (the 00:00 midnight sentinel — "no time was ever
 *      captured", NOT a booking at midnight): the stored label is KEPT and only
 *      canonicalised for spelling, and NO bogus clock time is rendered.
 *   3. No customer-facing string states an arrival minute, on any row.
 *
 * Plus the invariant that made this a two-place bug in the first place: the
 * page payload and the share message must quote the SAME string.
 *
 * Non-destructive: fake pool, no real DB, zero writes. Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool } = require('./helpers/fake-pool');

const shareService = require('../services/job-share.service');

/*
 * A tbl_job row exactly as fetchShareDetails' SELECT projects it. The two date
 * columns are DATE_FORMAT output, so requested_date_time is an IST WALL-CLOCK
 * string ('%Y-%m-%d %H:%i:%s') — never a driver-localised Date. Every helper in
 * services/time-slot.js parses that spelling, which is why the fix needed no
 * SQL change: the raw wall clock was already on the wire beside the date label.
 */
function jobRow(overrides = {}) {
  return {
    job_id: 482491,
    fk_client_id: 7,
    job_status: 1,
    job_desc: 'AC not cooling',
    requested_date_time: '2026-08-05 05:30:00',
    requested_date_label: 'Tue, 5 Aug 2026',
    time_slot: '3pm to 7pm',
    address: '221B Sector 44',
    building: null,
    landmark: null,
    city_id: 12,
    pin_code: '122003',
    gps_location: null,
    address_instruction: null,
    client_name: 'Acme',
    ...overrides,
  };
}

function poolFor(row) {
  return makeFakePool([
    [/FROM tbl_job_services/i, [{ service_type_name: 'AC Repair', service_catg_name: 'Cooling' }]],
    [/FROM tbl_city/i, [{ city_name: 'Gurugram' }]],
    [/FROM tbl_job j/i, [row]],
  ]).pool;
}

const detailsFor = (overrides) => shareService.fetchShareDetails(482491, poolFor(jobRow(overrides)));

// ─── 1. A real time-of-day: the INSTANT wins ──────────────────────────────

test('job #482491: an 05:30 appointment is banded After Hours, not the stored 3pm to 7pm', async () => {
  const d = await detailsFor();

  assert.equal(d.schedule.appointment_label, 'Tue, 5 Aug 2026 · After Hours');
  // The band exposed on its own must be the derived one too, so a consumer
  // reading schedule.time_slot cannot pick the stale string back up.
  assert.equal(d.schedule.time_slot, 'After Hours');
  // requested_time_label is RAW DATA, not the commitment: it carries the minute
  // for a caller that wants the underlying value, and nothing renders it. The
  // test below is what guarantees it never reaches a customer-facing string.
  assert.equal(d.schedule.requested_time_label, '5:30 AM');
});

/*
 * THE REVERT GUARD. The owner pulled the exact time back off this surface, so
 * neither the label the page renders nor the blurb that gets pasted into
 * WhatsApp may state an arrival minute — on ANY row shape.
 *
 * The structural assertion is the load-bearing one: the label is exactly
 * `date · band`, so everything LEFT of the separator must be the date label
 * verbatim. The removed clause sat precisely there (`${date}, ${clock} · band`),
 * which means re-adding it fails here even for a whole hour like '3 PM' that
 * carries no ':' for a regex to catch. A raw /\d{1,2}:\d{2}/ sweep alone could
 * not do this job, and a bare `\d+ ?(AM|PM)` sweep would be worse than useless —
 * the BAND itself is spelled '3PM to 7PM'.
 *
 * Deliberately NOT asserted over JSON.stringify(d): schedule.requested_time_label
 * legitimately holds the minute as data. The rule is about what we SAY.
 */
test('no customer-facing string states an arrival minute — the label or the share message', async () => {
  const rows = [
    { requested_date_time: '2026-08-05 05:30:00', time_slot: '3pm to 7pm' },      // half-hour
    { requested_date_time: '2026-08-05 15:00:00', time_slot: 'Morning 9 to 2' },  // whole hour ('3 PM' — no colon)
    { requested_date_time: '2026-08-05 00:00:00', time_slot: '3pm to 7pm' },      // the sentinel
  ];
  for (const row of rows) {
    const d = await detailsFor(row);
    const message = shareService.buildShareMessage(d, 'https://qa.easyfix.in/x');
    const label = d.schedule.appointment_label;
    const where = row.requested_date_time;

    assert.equal(
      label.split(' · ')[0], 'Tue, 5 Aug 2026',
      `${where}: everything before the separator must be the DATE alone — a time component is back in the label`,
    );
    assert.doesNotMatch(label, /\d{1,2}:\d{2}/, `${where}: no clock time may appear in the label`);
    assert.doesNotMatch(label, /5:30\s*AM/i,    `${where}: the exact time is back in the label`);
    assert.doesNotMatch(message, /5:30\s*AM/i,  `${where}: the exact time is back in the share message`);
    assert.doesNotMatch(message, /2026,\s*\d/,  `${where}: the share message states a time after the date`);
  }
});

test('the stale stored band appears NOWHERE on the wire — payload or share message', async () => {
  const d = await detailsFor();
  const message = shareService.buildShareMessage(d, 'https://qa.easyfix.in/x');

  // Case-insensitive: '3pm to 7pm' and '3PM to 7PM' are the same window, and
  // publishing EITHER against an 05:30 appointment is the bug.
  assert.doesNotMatch(JSON.stringify(d), /3\s*pm\s*to\s*7\s*pm/i);
  assert.doesNotMatch(message, /3\s*pm\s*to\s*7\s*pm/i);
});

/*
 * A 3 PM appointment stored against the legacy free-text 'Morning 9 to 2': the
 * instant still wins the BAND, and the label states that band — not "3 PM".
 * This is the case the removed clock clause read best on, which is exactly why
 * it is pinned: the label is a window even when we know the hour precisely.
 */
test('a whole-hour appointment states its BAND, not the hour', async () => {
  const d = await detailsFor({ requested_date_time: '2026-08-05 15:00:00', time_slot: 'Morning 9 to 2' });
  assert.equal(d.schedule.appointment_label, 'Tue, 5 Aug 2026 · 3PM to 7PM');
  // The underlying value is still on the payload — it just isn't in the promise.
  assert.equal(d.schedule.requested_time_label, '3 PM');
});

// ─── 2. Date-only / the 00:00 midnight sentinel ───────────────────────────

/*
 * 00:00:00 means "no time-of-day was ever captured" (date-only bookings,
 * legacy imports), NOT a visit at midnight. Two things must follow: the stored
 * label is the only signal on file so it is KEPT, and no clock time may be
 * invented from the sentinel.
 */
test('a date-only job keeps its stored band, canonicalised for spelling only', async () => {
  const d = await detailsFor({ requested_date_time: '2026-08-05 00:00:00' });

  assert.equal(d.schedule.time_slot, '3PM to 7PM', 'stored 3pm to 7pm, canonically spelled');
  assert.equal(d.schedule.appointment_label, 'Tue, 5 Aug 2026 · 3PM to 7PM');
});

test('a date-only job renders NO time — the sentinel never becomes "12 AM"', async () => {
  const d = await detailsFor({ requested_date_time: '2026-08-05 00:00:00' });
  const message = shareService.buildShareMessage(d, 'https://qa.easyfix.in/x');

  assert.equal(d.schedule.requested_time_label, null);
  assert.doesNotMatch(d.schedule.appointment_label, /12\s*AM/i);
  assert.doesNotMatch(d.schedule.appointment_label, /\d:\d\d/, 'no clock time at all');
  assert.doesNotMatch(message, /12\s*AM/i);
});

/*
 * canonicalSlot is a COSMETIC fold (case + spacing), never an interpretation.
 * tbl_job.time_slot carries ~79k rows of 'Morning 9 to 2' and friends from a
 * decade of pickers; re-labelling those on a read would be inventing an hour
 * nobody wrote down. Coarse, but never a wrong window.
 */
test('a legacy free-text label on a date-only job survives verbatim', async () => {
  const d = await detailsFor({ requested_date_time: '2026-08-05 00:00:00', time_slot: 'Morning 9 to 2' });
  assert.equal(d.schedule.time_slot, 'Morning 9 to 2');
  assert.equal(d.schedule.appointment_label, 'Tue, 5 Aug 2026 · Morning 9 to 2');
});

test('a date-only job with no stored band at all degrades to the bare date', async () => {
  const d = await detailsFor({ requested_date_time: '2026-08-05 00:00:00', time_slot: null });
  assert.equal(d.schedule.time_slot, null);
  assert.equal(d.schedule.appointment_label, 'Tue, 5 Aug 2026');
});

test('an unscheduled job has no appointment line — the page omits the card', async () => {
  const d = await detailsFor({ requested_date_time: null, requested_date_label: null, time_slot: null });
  const message = shareService.buildShareMessage(d, 'https://qa.easyfix.in/x');

  assert.equal(d.schedule.appointment_label, null);
  assert.doesNotMatch(message, /scheduled/i, 'the clause is dropped, not left dangling');
});

// ─── 3. The page and the message must not drift ───────────────────────────

/*
 * THE REASON THIS WAS A TWO-PLACE BUG. The page composed its own line in the FE
 * and buildShareMessage composed a second one here, from the same fields. Both
 * now read schedule.appointment_label, and this asserts it rather than trusting
 * it: the message must CONTAIN the page's exact string.
 */
test('the share message quotes the page label byte for byte', async () => {
  for (const dt of ['2026-08-05 05:30:00', '2026-08-05 00:00:00', '2026-08-05 15:00:00']) {
    const d = await detailsFor({ requested_date_time: dt });
    const message = shareService.buildShareMessage(d, 'https://qa.easyfix.in/x');
    assert.ok(
      message.includes(`scheduled ${d.schedule.appointment_label}`),
      `${dt}: message must quote "${d.schedule.appointment_label}" — got ${JSON.stringify(message)}`,
    );
  }
});

// ─── 4. The SQL shape the helpers depend on ───────────────────────────────

/*
 * The band derivation reads the appointment's WALL CLOCK. If the projection
 * ever drops back to a date-only DATE_FORMAT (or to a raw column the driver
 * localises into a Date), hasTimeOfDay silently reports false on every row and
 * the whole surface reverts to publishing the stale stored band — a regression
 * that still LOOKS like a legitimate window. Pin the projection.
 */
test('the SELECT projects requested_date_time as an IST wall-clock string', async () => {
  const fake = makeFakePool([
    [/FROM tbl_job_services/i, []],
    [/FROM tbl_city/i, []],
    [/FROM tbl_job j/i, [jobRow()]],
  ]);
  await shareService.fetchShareDetails(482491, fake.pool);

  const main = fake.calls.find((c) => /FROM tbl_job j/i.test(c.sql));
  assert.ok(main, 'the main SELECT must have run');
  assert.match(main.sql, /DATE_FORMAT\(j\.requested_date_time, '%Y-%m-%d %H:%i:%s'\)\s+AS requested_date_time/);
  assert.match(main.sql, /DATE_FORMAT\(j\.requested_date_time, '%a, %e %b %Y'\)\s+AS requested_date_label/);
});
