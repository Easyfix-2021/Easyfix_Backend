/*
 * Characterization tests for job.service.statusToEventName — THE single gate
 * that maps a job_status transition to a webhook/notification event name. Every
 * customer SMS / email / WhatsApp + external webhook fan-out is decided here, so
 * a silent change to this mapping silently stops (or misfires) notifications.
 * This test pins the current mapping so a refactor can't move it unnoticed.
 *
 * Pure function — no DB. We still stub the shared pool BEFORE requiring the
 * service so a stray load-time query can never try to open a real connection.
 *
 * Runner: `node --test`. See `npm run test:events`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Belt-and-braces: neutralize the DB singleton before the service loads.
const db = require('../db');
db.pool.query = async () => [[], []];
db.pool.execute = db.pool.query;

const { statusToEventName, STATUS } = require('../services/job.service');

test('a no-op transition (same status) fires NO event', () => {
  // Mobile /eta and /reschedule deliberately call setStatus with the existing
  // status to ride the extras path and rely on nothing firing.
  assert.equal(statusToEventName(1, 1), null);
  assert.equal(statusToEventName(2, 2), null);
  assert.equal(statusToEventName(0, 0), null);
});

test('IN_PROGRESS transition → TechStart', () => {
  assert.equal(statusToEventName(STATUS.SCHEDULED, STATUS.IN_PROGRESS), 'TechStart');
  assert.equal(statusToEventName(STATUS.BOOKED, STATUS.IN_PROGRESS), 'TechStart');
});

test('COMPLETED transition → TechVisitComplete', () => {
  assert.equal(statusToEventName(STATUS.IN_PROGRESS, STATUS.COMPLETED), 'TechVisitComplete');
});

test('CANCELLED transition → CancelJob', () => {
  assert.equal(statusToEventName(STATUS.SCHEDULED, STATUS.CANCELLED), 'CancelJob');
});

test('REVISIT transition → TechVisitInComplete (checkout next-visit path)', () => {
  assert.equal(statusToEventName(STATUS.IN_PROGRESS, STATUS.REVISIT), 'TechVisitInComplete');
});

test('CALL_LATER (unreachable) transition → CustomerNotReachable', () => {
  assert.equal(statusToEventName(STATUS.SCHEDULED, STATUS.CALL_LATER), 'CustomerNotReachable');
});

test('transitions with no customer-facing event map to null', () => {
  // Booking / scheduling movements do not themselves fire a customer event via
  // this gate (ENQUIRY intentionally notifies nobody; SCHEDULED is silent here).
  assert.equal(statusToEventName(STATUS.BOOKED, STATUS.SCHEDULED), null);
  assert.equal(statusToEventName(STATUS.CALL_LATER, STATUS.BOOKED), null);
  assert.equal(statusToEventName(STATUS.SCHEDULED, STATUS.ENQUIRY), null);
});

test('moving BETWEEN completed states (3 ↔ 5) fires no second TechVisitComplete', () => {
  // Feedback & Complete (3 → 5, 2026-09-30): the visit was reported complete
  // when the job entered 3; a repeat would reach every webhook client twice.
  assert.equal(statusToEventName(STATUS.COMPLETED, STATUS.COMPLETED_ALT), null);
  assert.equal(statusToEventName(STATUS.COMPLETED_ALT, STATUS.COMPLETED), null);
  // Positive controls: ENTERING a completed state still fires, from any source.
  assert.equal(statusToEventName(STATUS.REVISIT, STATUS.COMPLETED), 'TechVisitComplete');
  assert.equal(statusToEventName(STATUS.IN_PROGRESS, STATUS.COMPLETED_ALT), 'TechVisitComplete');
  assert.equal(statusToEventName('10', STATUS.COMPLETED), 'TechVisitComplete', 'a string prev status (DB row) must not read as completed');
});
