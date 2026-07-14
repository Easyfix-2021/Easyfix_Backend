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

// ─── autoRescheduleOnOpenIfLate (after-3pm link-OPEN shift) ──────────────
// Trigger is the OPEN time (current IST hour), injected via nowMs. Before 3pm →
// no DB round-trip. installFakePool monkeypatches the shared db.pool so the
// internal addComment routes through the fake too — no real DB.

test('autoRescheduleOnOpenIfLate — opened before 3pm IST is a no-op (no query at all)', async () => {
  const inst = installFakePool([]);
  try {
    const r = await magic.autoRescheduleOnOpenIfLate(42, db.pool, { nowMs: nowMsForIstHour(10) });
    assert.equal(r.shifted, false);
    assert.equal(inst.calls.length, 0, 'no query fired when opened before 3pm');
  } finally { inst.restore(); }
});

test('autoRescheduleOnOpenIfLate — opened after 3pm shifts +1 day (guarded) and audits with non-NULL easyfixer_id', async () => {
  const inst = installFakePool([
    [/UPDATE tbl_job\s+SET\s+original_appointment_date_time/, { affectedRows: 1 }],
    [/SELECT requested_date_time AS newReq/, [{ newReq: '2026-01-02 09:00:00', fk_easyfixter_id: 55 }]],
  ]);
  try {
    const r = await magic.autoRescheduleOnOpenIfLate(42, db.pool, { nowMs: nowMsForIstHour(16) });
    assert.equal(r.shifted, true);
    const upd = inst.calls.find((c) => /UPDATE tbl_job\s+SET\s+original_appointment_date_time/.test(c.sql));
    assert.ok(upd, 'UPDATE fired');
    assert.match(upd.sql, /INTERVAL 1 DAY/, 'shifts by exactly one day');
    assert.match(upd.sql, /DATE\(requested_date_time\) = DATE\(COALESCE\(original_appointment_date_time/, 'idempotency guard COALESCEs NULL original (bulk-upload jobs)');
    assert.match(upd.sql, /SET original_appointment_date_time = COALESCE\(original_appointment_date_time, requested_date_time\)/, 'back-fills a NULL original in the same atomic UPDATE');
    assert.match(upd.sql, /customer_submitted_at IS NULL/);
    assert.match(upd.sql, /job_status = 9/);
    const hist = inst.calls.find((c) => /INSERT INTO scheduling_history/.test(c.sql));
    assert.ok(hist, 'scheduling_history audit row written');
    assert.equal(hist.params[1], 55, 'easyfixer_id is the non-NULL tech id (NOT NULL — avoids candidate-ranking NOT-IN poison)');
    assert.match(String(hist.params[3]), /Auto Rescheduled for Next Day/, 'carries the auto-reschedule reason');
  } finally { inst.restore(); }
});

test('autoRescheduleOnOpenIfLate — idempotent: 0 rows affected writes no audit row', async () => {
  const inst = installFakePool([
    [/UPDATE tbl_job\s+SET\s+original_appointment_date_time/, { affectedRows: 0 }],
  ]);
  try {
    const r = await magic.autoRescheduleOnOpenIfLate(42, db.pool, { nowMs: nowMsForIstHour(16) });
    assert.equal(r.shifted, false);
    assert.ok(inst.calls.some((c) => /UPDATE tbl_job/.test(c.sql)), 'UPDATE attempted');
    assert.ok(!inst.calls.some((c) => /INSERT INTO scheduling_history/.test(c.sql)), 'no audit row when nothing shifted');
    assert.ok(!inst.calls.some((c) => /SELECT requested_date_time AS newReq/.test(c.sql)), 'no follow-up SELECT');
  } finally { inst.restore(); }
});
