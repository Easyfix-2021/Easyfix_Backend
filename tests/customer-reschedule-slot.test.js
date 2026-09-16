'use strict';
/*
 * The customer reschedule window. Customers picking 8 AM or after 7 PM left ops
 * with appointments they could not commit to, so the public reschedule-request
 * endpoint accepts only a start hour in 9 AM – 7 PM and stores that hour's band.
 * The edges are the whole point: 08:59 and 19:00 must be refused, 09:00 and
 * 18:59 kept.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { customerRescheduleSlot } = require('../routes/public/job-completion');

test('hours inside 9 AM – 7 PM map to their daytime band', () => {
  assert.equal(customerRescheduleSlot('2026-09-18 09:00:00'), '9AM to 12PM');
  assert.equal(customerRescheduleSlot('2026-09-18 11:59:00'), '9AM to 12PM');
  assert.equal(customerRescheduleSlot('2026-09-18 12:00:00'), '12PM to 3PM');
  assert.equal(customerRescheduleSlot('2026-09-18 15:00:00'), '3PM to 7PM');
  assert.equal(customerRescheduleSlot('2026-09-18 18:59:00'), '3PM to 7PM');
});

test('before 9 AM, from 7 PM on, and no time at all are refused', () => {
  for (const dt of [
    '2026-09-18 08:00:00', '2026-09-18 08:59:00', '2026-09-18 19:00:00',
    '2026-09-18 23:30:00', '2026-09-18 00:00:00', '2026-09-18', '', null,
  ]) {
    assert.equal(customerRescheduleSlot(dt), null, `accepted ${dt}`);
  }
});
