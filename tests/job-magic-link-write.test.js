/*
 * Characterization tests for the magic-link customer-submit WRITE path
 * (job-magic-link.service acceptSubmission + writeCustomerOrderDetails), in the
 * COLUMN-PRESENT scenario (default fake resolves probes → columns present).
 *
 * THE load-bearing invariant: this path writes via its OWN UPDATE tbl_job and
 * deliberately does NOT go through setStatus / touch job_status — Ops reviews the
 * submission before the status/notification machinery fires. This test is the
 * regression tripwire that keeps that bypass intact.
 *
 * These functions take an INJECTED pool, so we hand them the fake directly — no
 * monkeypatch. They wrap non-status errors, so we assert on fake.calls (which is
 * recorded before the STOP throw) rather than the thrown error's shape.
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool, installFakePool } = require('./helpers/fake-pool');

const db = require('../db');
const magic = require('../services/job-magic-link.service');

// IST wall-clock helper for the auto-reschedule tests: pick a UTC ms whose
// (+5:30) IST hour is `istHour`. e.g. istHour=10 → before 3pm; 16 → after 3pm.
function nowMsForIstHour(istHour) {
  // istHour = getUTCHours(nowMs + 5h30m). So nowMs at UTC (istHour-5), minus 30m.
  return Date.UTC(2026, 0, 1, istHour, 0, 0) - (5 * 60 + 30) * 60 * 1000;
}

test('acceptSubmission writes via its own UPDATE tbl_job — never setStatus / job_status', async () => {
  const fake = makeFakePool(
    [[/SELECT fk_address_id, fk_customer_id, fk_client_id FROM tbl_job/, [{ fk_address_id: 10, fk_customer_id: 20, fk_client_id: 30 }]]],
    { stopOn: /UPDATE tbl_job SET/ },
  );
  await assert.rejects(() => magic.acceptSubmission(42, {}, fake.pool));
  const write = fake.calls.find((c) => /UPDATE tbl_job SET/.test(c.sql));
  assert.ok(write, 'an UPDATE tbl_job must be issued');
  assert.doesNotMatch(write.sql, /job_status/, 'must NOT transition status (intentional setStatus bypass)');
  assert.match(write.sql, /customer_submitted_at/, 'stamps the submission audit column');
});

test('acceptSubmission includes the optional columns when they are present', async () => {
  const fake = makeFakePool(
    [[/SELECT fk_address_id, fk_customer_id, fk_client_id FROM tbl_job/, [{ fk_address_id: 10, fk_customer_id: 20, fk_client_id: 30 }]]],
    { stopOn: /UPDATE tbl_job SET/ },
  );
  await assert.rejects(() => magic.acceptSubmission(42, { branch_details: 'B7', building_name: 'Tower', product_code: 'P1' }, fake.pool));
  const write = fake.calls.find((c) => /UPDATE tbl_job SET/.test(c.sql));
  assert.ok(write);
  // Column probes resolve (present) in this file, so the optional cols are written.
  assert.match(write.sql, /branch_details/);
  assert.match(write.sql, /building_name/);
  assert.match(write.sql, /product_code/);
});

/*
 * The address-section gate (2026-07-15 regression tripwire).
 *
 * The whole tbl_address write used to hang off `payload.address` — the ONE
 * field the customer cannot edit (Service Address renders read-only; the map
 * "captures GPS only"). So a pin-only submission wrote NOTHING and the pin was
 * lost to everything but the customer_submitted_payload JSON blob. These lock
 * the widened gate: any supplied address-section field must reach tbl_address,
 * and a payload with none of them must still write nothing.
 */
const ADDR_ROUTE = [/SELECT fk_address_id, fk_customer_id, fk_client_id FROM tbl_job/,
  [{ fk_address_id: 10, fk_customer_id: 20, fk_client_id: 30 }]];

test('acceptSubmission — a PIN-ONLY submission (gps, no address) still writes tbl_address', async () => {
  const fake = makeFakePool([ADDR_ROUTE], { stopOn: /UPDATE tbl_address/ });
  await assert.rejects(() => magic.acceptSubmission(42, { gps_location: '28.631500,77.216700' }, fake.pool));
  const write = fake.calls.find((c) => /UPDATE tbl_address/.test(c.sql));
  assert.ok(write, 'a pin with no address text MUST still reach tbl_address (this was the bug)');
  assert.match(write.sql, /gps_location\s*=\s*COALESCE/, 'gps_location is COALESCE-guarded, not blind-set');
  assert.ok(write.params.includes('28.631500,77.216700'), 'the pin coordinates are bound as a param');
  assert.ok(write.params.includes(10), 'scoped to the job\'s fk_address_id');
});

test('acceptSubmission — the map-search text persists to tbl_address.building', async () => {
  const fake = makeFakePool([ADDR_ROUTE], { stopOn: /UPDATE tbl_address/ });
  await assert.rejects(() => magic.acceptSubmission(42, {
    building: '12 MG Road, Bengaluru', gps_location: '12.971600,77.594600',
  }, fake.pool));
  const write = fake.calls.find((c) => /UPDATE tbl_address/.test(c.sql));
  assert.ok(write);
  // `building` is the column the CRM's Confirm & Schedule "Search Location On
  // Map" field reads back — see AddressPickerWithMap's serviceAddressReadOnly.
  assert.ok(write.params.includes('12 MG Road, Bengaluru'), 'map-search text is bound');
  assert.doesNotMatch(write.sql, /address\s*=\s*\?/, 'the booked address must never be blind-overwritten');
});

test('acceptSubmission — address:\'\' alongside a pin must NOT blank the booked address', async () => {
  // Regression guard. `COALESCE('', address)` returns '' (empty string is not
  // NULL), so passing '' through would WIPE the customer's booked address. '' has
  // to reach the query as NULL, like every sibling field. Reachable input: Joi
  // .allow('')s this field, and the widened gate lets a pin-only payload through
  // on gps alone.
  const fake = makeFakePool([ADDR_ROUTE], { stopOn: /UPDATE tbl_address/ });
  await assert.rejects(() => magic.acceptSubmission(42, {
    address: '', gps_location: '19.076000,72.877700',
  }, fake.pool));
  const write = fake.calls.find((c) => /UPDATE tbl_address/.test(c.sql));
  assert.ok(write, 'the pin still writes (the gate passes on gps)');
  assert.ok(!write.params.includes(''), 'an empty address must never be bound — it would blank the column');
  assert.equal(write.params[0], null, 'address collapses to NULL so COALESCE keeps the booked value');
});

test('acceptSubmission — no address-section fields at all → no tbl_address write', async () => {
  // No stopOn: a payload with no `services` skips the service block, so the
  // whole call runs to completion against the fake. Letting it finish proves
  // the ABSENCE of the address write rather than merely never reaching it.
  const fake = makeFakePool([ADDR_ROUTE]);
  await magic.acceptSubmission(42, { customer_name: 'Asha' }, fake.pool);
  assert.ok(
    fake.calls.some((c) => /UPDATE tbl_job SET/.test(c.sql)),
    'sanity: the tbl_job write still ran, so we really did traverse the address block',
  );
  assert.ok(
    !fake.calls.some((c) => /UPDATE tbl_address/.test(c.sql)),
    'nothing address-shaped was supplied, so the gate must stay closed',
  );
});

test('writeCustomerOrderDetails writes tbl_job directly, no status transition', async () => {
  const fake = makeFakePool(
    [[/SELECT fk_address_id FROM tbl_job/, [{ fk_address_id: 10 }]]],
    { stopOn: /UPDATE tbl_job SET/ },
  );
  await assert.rejects(() => magic.writeCustomerOrderDetails(42, {}, fake.pool));
  const write = fake.calls.find((c) => /UPDATE tbl_job SET/.test(c.sql));
  assert.ok(write, 'an UPDATE tbl_job must be issued');
  assert.doesNotMatch(write.sql, /job_status/, 'must NOT transition status');
  assert.match(write.sql, /customer_submitted_at/);
});

// ─── autoRescheduleOnOpenIfLate (link-OPEN shift) ────────────────────────
// The trigger is the APPOINTMENT DATE evaluated at open time: shift only when
// DATE(requested_date_time) <= today (IST), and always land on TOMORROW. The
// open HOUR is no longer a trigger (it used to be ">= 3pm", which also shifted
// jobs booked for next week) — it survives only as audit text.
// installFakePool monkeypatches the shared db.pool so the internal addComment
// routes through the fake too — no real DB.

// The kill switch reads easyfix_properties through the cache; stub it so these
// tests never depend on DB state. `undefined` = property absent = default ON.
const properties = require('../services/properties.service');
function withAutoReschedule(value, fn) {
  const original = properties.getProperty;
  properties.getProperty = (k) => (k === 'job.auto_reschedule.enabled' ? value : original(k));
  return (async () => { try { return await fn(); } finally { properties.getProperty = original; } })();
}

/*
 * ─── tbl_job.time_slot IS ALWAYS A BAND ──────────────────────────────
 *
 * Both customer-submit writers run their slot through the shared writer-side
 * gate (services/time-slot.js resolveTimeSlot), so a 1-hour frame label can no
 * longer land in the column no matter which surface the customer used:
 *   - acceptSubmission            ← the public magic-link FORM
 *   - writeCustomerOrderDetails   ← the conversational WhatsApp flow
 * The 1-hour choice is not lost: it is the appointment's time-of-day, carried
 * by requested_date_time + requested_time.
 */
const BANDS = ['9AM to 12PM', '12PM to 3PM', '3PM to 7PM', 'After Hours'];

function jobWriteFor(fake) {
  const write = fake.calls.find((c) => /UPDATE tbl_job SET/.test(c.sql));
  assert.ok(write, 'an UPDATE tbl_job must be issued');
  return write;
}

/*
 * The submitted label the live form actually sends is a BOOKING_BANDS value
 * ('3PM to 7PM') — page.tsx renders BOOKING_BANDS and posts slot.value. It is no
 * longer the en-dash display label, so a test asserting '3 PM – 7 PM' round-trips
 * would be pinning an input no live submission can produce.
 *
 * booking_cut_off_time_slot must NOT echo whatever the form sent: that would put
 * a fifth spelling into a column every other create path fills from
 * job.service's deriveBookingCutoffSlot ('3 PM - 7 PM', plain hyphen). Both
 * shapes are asserted below — the canonical band on time_slot, the legacy
 * hyphenated window on the cut-off column.
 */
test('acceptSubmission stores the BAND in time_slot and the LEGACY window spelling on the cut-off column', async () => {
  const run = async (submittedLabel) => {
    const fake = makeFakePool(
      [[/SELECT fk_address_id, fk_customer_id, fk_client_id FROM tbl_job/, [{ fk_address_id: 10, fk_customer_id: 20, fk_client_id: 30 }]]],
      { stopOn: /UPDATE tbl_job SET/ },
    );
    await assert.rejects(() => magic.acceptSubmission(42, {
      requested_date_time: '2026-08-05T15:00:00',
      time_slot: submittedLabel,
    }, fake.pool));
    return jobWriteFor(fake);
  };
  // params[3] = time_slot, params[4] = booking_cut_off_time_slot (SET order).
  for (const label of ['3PM to 7PM', '3 PM – 7 PM']) {
    const write = await run(label);
    assert.equal(write.params[3], '3PM to 7PM', `time_slot is canonicalised (submitted ${label})`);
    assert.equal(write.params[4], '3 PM - 7 PM',
      `booking_cut_off_time_slot uses deriveBookingCutoffSlot's spelling (submitted ${label})`);
  }
});

test('writeCustomerOrderDetails (WhatsApp chat) stores the BAND, never the 1-hour frame', async () => {
  const fake = makeFakePool(
    [[/SELECT fk_address_id FROM tbl_job/, [{ fk_address_id: 10 }]]],
    { stopOn: /UPDATE tbl_job SET/ },
  );
  await assert.rejects(() => magic.writeCustomerOrderDetails(42, {
    requested_date_time: '2026-08-05 15:00:00',
    time_slot: '3 PM\u20134 PM',        // a caller still handing over a 1-hour label
    requested_time: '15:00',
  }, fake.pool));
  const write = jobWriteFor(fake);
  // params[2] = requested_date_time, [3] = time_slot, [4] = requested_time.
  assert.ok(BANDS.includes(write.params[3]), `time_slot=${write.params[3]} must be a band`);
  assert.equal(write.params[3], '3PM to 7PM');
  assert.equal(write.params[4], '15:00', 'the 1-hour START survives in requested_time');
});

test('autoRescheduleOnOpenIfLate — disabled by property never writes, and reports a DUE appointment', async () => {
  // The disabled path deliberately runs ONE read-only lookup so an already-due
  // appointment is still reported — otherwise the switch being off is invisible
  // in the funnel. What it must never do is WRITE.
  const inst = installFakePool([
    [/SELECT requested_date_time AS req FROM tbl_job/, [{ req: '2026-01-01 09:00:00' }]],
  ]);
  try {
    await withAutoReschedule('false', async () => {
      const r = await magic.autoRescheduleOnOpenIfLate(42, db.pool, { nowMs: nowMsForIstHour(16) });
      assert.equal(r.shifted, false);
      assert.equal(r.reason, 'disabled');
    });
    assert.ok(
      !inst.calls.some((c) => /UPDATE tbl_job/.test(c.sql)),
      'the kill switch must prevent every write',
    );
    assert.ok(
      !inst.calls.some((c) => /INSERT INTO scheduling_history/.test(c.sql)),
      'no audit row when nothing was rescheduled',
    );
    const probe = inst.calls.find((c) => /SELECT requested_date_time AS req FROM tbl_job/.test(c.sql));
    assert.ok(probe, 'the due-appointment probe still runs so the skip can be logged');
    assert.match(probe.sql, /DATE\(requested_date_time\) <= \?/, 'probe asks the same due question the trigger does');
  } finally { inst.restore(); }
});

test('autoRescheduleOnOpenIfLate — absent property means ENABLED (default-on, matches the per-cron flags)', async () => {
  const inst = installFakePool([
    [/UPDATE tbl_job\s+SET\s+original_appointment_date_time/, { affectedRows: 0 }],
  ]);
  try {
    await withAutoReschedule(undefined, async () => {
      await magic.autoRescheduleOnOpenIfLate(42, db.pool, { nowMs: nowMsForIstHour(16) });
    });
    assert.ok(inst.calls.some((c) => /UPDATE tbl_job/.test(c.sql)), 'an absent flag must NOT disable the feature');
  } finally { inst.restore(); }
});

test('autoRescheduleOnOpenIfLate — shifts a due appointment to TOMORROW and audits with non-NULL easyfixer_id', async () => {
  const inst = installFakePool([
    [/UPDATE tbl_job\s+SET\s+original_appointment_date_time/, { affectedRows: 1 }],
    [/SELECT requested_date_time AS newReq/, [{ newReq: '2026-01-02 09:00:00', fk_easyfixter_id: 55 }]],
  ]);
  try {
    await withAutoReschedule(undefined, async () => {
      const r = await magic.autoRescheduleOnOpenIfLate(42, db.pool, { nowMs: nowMsForIstHour(16) });
      assert.equal(r.shifted, true);
    });
    const upd = inst.calls.find((c) => /UPDATE tbl_job\s+SET\s+original_appointment_date_time/.test(c.sql));
    assert.ok(upd, 'UPDATE fired');
    // ABSOLUTE target, not a relative interval: `+ INTERVAL n DAY` on an
    // appointment five days old would still land in the past.
    assert.match(upd.sql, /requested_date_time = TIMESTAMP\(\?, TIME\(requested_date_time\)\)/, 'lands on an absolute date, preserving the time-of-day so time_slot stays valid');
    assert.doesNotMatch(upd.sql, /INTERVAL \d+ DAY/, 'must NOT use a relative interval');
    assert.match(upd.sql, /DATE\(requested_date_time\) <= \?/, 'only fires when the appointment is today or already past');
    assert.match(upd.sql, /DATE\(requested_date_time\) = DATE\(COALESCE\(original_appointment_date_time/, 'idempotency guard COALESCEs NULL original (bulk-upload jobs)');
    assert.match(upd.sql, /SET original_appointment_date_time = COALESCE\(original_appointment_date_time, requested_date_time\)/, 'back-fills a NULL original in the same atomic UPDATE');
    assert.match(upd.sql, /customer_submitted_at IS NULL/);
    assert.match(upd.sql, /job_status = 9/);
    // IST dates are computed in JS and bound as params — never CURDATE()/NOW(),
    // whose calendar day follows the DB server's timezone, not IST.
    assert.doesNotMatch(upd.sql, /CURDATE\(\)/, 'IST day must not come from the DB server clock');
    const [tomorrow, , today] = upd.params;
    assert.match(String(tomorrow), /^\d{4}-\d{2}-\d{2}$/, 'tomorrow bound as a bare IST date');
    assert.match(String(today), /^\d{4}-\d{2}-\d{2}$/, 'today bound as a bare IST date');
    // The target is TODAY + 1 — derived from the current IST day, never from the
    // appointment. An appointment-relative shift would leave an old date in the past.
    const expectedTomorrow = new Date(Date.parse(String(today) + 'T00:00:00Z') + 86400000)
      .toISOString().slice(0, 10);
    assert.equal(String(tomorrow), expectedTomorrow, 'target is exactly today + 1 (not appointment + N)');
    const hist = inst.calls.find((c) => /INSERT INTO scheduling_history/.test(c.sql));
    assert.ok(hist, 'scheduling_history audit row written');
    assert.equal(hist.params[1], 55, 'easyfixer_id is the non-NULL tech id (NOT NULL — avoids candidate-ranking NOT-IN poison)');
    assert.match(String(hist.params[3]), /Auto Rescheduled/, 'carries the stable token the CRM chip detector matches on');
  } finally { inst.restore(); }
});

test('autoRescheduleOnOpenIfLate — idempotent: 0 rows affected writes no audit row', async () => {
  const inst = installFakePool([
    [/UPDATE tbl_job\s+SET\s+original_appointment_date_time/, { affectedRows: 0 }],
  ]);
  try {
    await withAutoReschedule(undefined, async () => {
      const r = await magic.autoRescheduleOnOpenIfLate(42, db.pool, { nowMs: nowMsForIstHour(16) });
      assert.equal(r.shifted, false);
    });
    assert.ok(inst.calls.some((c) => /UPDATE tbl_job/.test(c.sql)), 'UPDATE attempted');
    assert.ok(!inst.calls.some((c) => /INSERT INTO scheduling_history/.test(c.sql)), 'no audit row when nothing shifted');
    assert.ok(!inst.calls.some((c) => /SELECT requested_date_time AS newReq/.test(c.sql)), 'no follow-up SELECT');
  } finally { inst.restore(); }
});
