/*
 * mobile-job-estimate.service.js — regression coverage for the NOW()-to-
 * bound-Date conversion (db.js pool is timezone: '+05:30', dateStrings: true;
 * a bound Date serializes as the IST wall clock, SQL NOW() does not).
 *
 * No test file existed for this module before; this pins the sendForApproval
 * writer, which stamps THREE columns (one datetime, two timestamp) that must
 * all share the same instant.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/SELECT job_id, fk_client_id, fk_easyfixter_id, job_status\s+FROM tbl_job/i,
    () => [{ job_id: 100, fk_client_id: 5, fk_easyfixter_id: 42, job_status: 2 }]],
  // Material Request Flow v2 (2026-09-21): sendForApproval now requires at
  // least one DRAFT line to exist before it will send — one fixture draft
  // row (sent_on IS NULL) so this file keeps testing what it always tested
  // (the Date-sharing behaviour), not the new 422 guard (covered elsewhere).
  [/^\s*SELECT id FROM quotation_details/i, () => [{ id: 1 }]],
  // One-timestamp-per-send lookup (2026-09-22 amendment) — no prior sent_on
  // in this file's world, so nextSentOn falls straight through to `now`.
  [/^\s*SELECT MAX\(sent_on\)/i, () => [{ maxSentOn: null }]],
  [/^\s*UPDATE quotation_details\b/i, () => ({ affectedRows: 1 })],
  [/^\s*UPDATE tbl_job\b/i, () => ({ affectedRows: 1 })],
  [/^\s*INSERT INTO tbl_job_image/i, () => ({ affectedRows: 1 })],
]);

const { sendForApproval } = require('../services/mobile-job-estimate.service');

after(() => fake.restore());

test('sendForApproval binds ONE Date shared by approval_sent_on_date_time, last_update_time and the check-in image, never SQL NOW()', async () => {
  fake.reset();
  await sendForApproval(100, 42, { checkInImageRefs: ['a.jpg'] });

  const upd = fake.calls.find((c) => /^\s*UPDATE tbl_job\b/i.test(c.sql));
  assert.ok(upd, 'the tbl_job stamp must have run');
  assert.match(upd.sql, /approval_sent_on_date_time = \?/);
  assert.match(upd.sql, /last_update_time = \?/);
  assert.doesNotMatch(upd.sql, /NOW\(\)/, 'no SQL NOW() may remain');
  // Params: [approvalSentOn, job_status, material_sub_status, last_update_time,
  // jobId, efrId] — the material_sub_status column (2026-09-18, Material
  // Management phase 2 sub-project D) sits between job_status and
  // last_update_time in the UPDATE's SET list, so last_update_time is now the
  // FOURTH bound param, not the third.
  const [approvalSentOn, , , lastUpdateTime] = upd.params;
  assert.ok(approvalSentOn instanceof Date, 'approval_sent_on_date_time is a bound Date');
  assert.ok(lastUpdateTime instanceof Date, 'last_update_time is a bound Date');
  assert.equal(approvalSentOn.getTime(), lastUpdateTime.getTime(),
    'both columns must share the SAME instant, not two separate new Date() calls');

  const img = fake.calls.find((c) => /^\s*INSERT INTO tbl_job_image/i.test(c.sql));
  assert.ok(img, 'the check-in image row must have run');
  assert.doesNotMatch(img.sql, /NOW\(\)/);
  const createdDate = img.params[4];
  assert.ok(createdDate instanceof Date, 'created_date is a bound Date');
  assert.equal(createdDate.getTime(), approvalSentOn.getTime(),
    'the whole send-for-approval action shares one instant');
});
