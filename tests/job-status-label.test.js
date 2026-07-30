/*
 * Unit tests for utils/job-status-label.js — the single CRM-vocabulary
 * job-status label helper now shared by the Offer Acceptance report and the
 * Call Info export.
 *
 * The values here are pinned to the FRONTEND statusLabel (Easyfix_CRM_UI/
 * src/lib/utils.ts). The whole point of the helper is that the export cell, the
 * API field and the on-screen chip read the same, so this file is the guard
 * against them drifting apart again — most sharply on codes 10/20/21, where the
 * call-info export used to say Revisit / Pending to Close / Followup.
 *
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { jobStatusLabel, JOB_STATUS_LABELS } = require('../utils/job-status-label');

test('base codes match the FE statusLabel map', () => {
  assert.equal(jobStatusLabel(0), 'Booked'); // no assignment info → base label
  assert.equal(jobStatusLabel(1), 'Scheduled');
  assert.equal(jobStatusLabel(2), 'In Progress');
  assert.equal(jobStatusLabel(3), 'Completed');
  assert.equal(jobStatusLabel(5), 'Completed');
  assert.equal(jobStatusLabel(6), 'Cancelled');
  assert.equal(jobStatusLabel(7), 'Enquiry');
  assert.equal(jobStatusLabel(9), 'Unconfirmed');
  assert.equal(jobStatusLabel(15), 'Estimate Pending');
});

/*
 * The alignment this refactor was asked to make: the call-info export's old
 * local map read 10='Revisit', 20='Pending to Close', 21='Followup'. The CRM
 * vocabulary (and every screen) is Closed from App / In Progress / On Hold.
 */
test('codes 10 / 20 / 21 use the CRM vocabulary, not the legacy call-info labels', () => {
  assert.equal(jobStatusLabel(10), 'Closed from App');
  assert.equal(jobStatusLabel(20), 'In Progress');
  assert.equal(jobStatusLabel(21), 'On Hold');
  // The labels it must NOT be anymore:
  assert.notEqual(jobStatusLabel(10), 'Revisit');
  assert.notEqual(jobStatusLabel(20), 'Pending to Close');
  assert.notEqual(jobStatusLabel(21), 'Followup');
});

test('BOOKED (0) sub-splits by tech presence only when assignment is known', () => {
  assert.equal(jobStatusLabel(0, true), 'Pending App Ack');
  assert.equal(jobStatusLabel(0, false), 'Pending for Scheduling');
  // Unknown assignment → base label (matches the FE, which only splits when the
  // caller passes a real boolean).
  assert.equal(jobStatusLabel(0), 'Booked');
  assert.equal(jobStatusLabel(0, null), 'Booked');
  assert.equal(jobStatusLabel(0, undefined), 'Booked');
});

test('the split applies to code 0 ONLY — assigned is ignored for other codes', () => {
  assert.equal(jobStatusLabel(1, true), 'Scheduled');
  assert.equal(jobStatusLabel(2, false), 'In Progress');
});

test('null / blank / non-numeric code → empty string (callers guard display)', () => {
  assert.equal(jobStatusLabel(null), '');
  assert.equal(jobStatusLabel(undefined), '');
  assert.equal(jobStatusLabel(''), '');
  assert.equal(jobStatusLabel('abc'), '');
});

test('numeric strings resolve (DB drivers sometimes hand back strings)', () => {
  assert.equal(jobStatusLabel('0', true), 'Pending App Ack');
  assert.equal(jobStatusLabel('10'), 'Closed from App');
});

test('unknown numeric code surfaces loudly as "Status N"', () => {
  assert.equal(jobStatusLabel(99), 'Status 99');
});

test('the exported map is frozen (single source of truth, not mutable)', () => {
  assert.ok(Object.isFrozen(JOB_STATUS_LABELS));
});
