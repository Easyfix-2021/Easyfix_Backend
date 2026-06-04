/*
 * Shared reason-codes mapping — promoted from inline constants in
 * routes/admin/jobs.js (2026-06-04) so any new caller (mobile app,
 * integration routes, future cross-tier features) reads from a single
 * source of truth instead of forking its own copy.
 *
 * DUE_TO_USER_TYPE
 *   Maps the operator-facing "Pending Due To" / "Open Due To" radio
 *   label (lowercased + whitespace-stripped on the URL side) to the
 *   integer stored as `tbl_action_taken_reason.user_type`. Verified
 *   2026-05-19 against the legacy CRM action_taken_reason dump:
 *     1 → Customer    (e.g. "Customer is not responding")
 *     2 → Client      (e.g. "Phone not reachable", "Reschedule – CX request")
 *     3 → EasyFix     (e.g. "Spare not available", "Pending Authorisation")
 *     4 → Technician  (e.g. "Tx No-Show", "Estimate not received from Technician")
 *
 * ACTION_TYPE_BY_MODE
 *   Maps the FE dialog mode (route query param `type`) to the integer
 *   `tbl_action_taken_reason.action_type` bucket. Confirmed by ops
 *   2026-06-04. The legacy `action_type` table also has a human-readable
 *   `type` string column ("Un Reachable", "Enquiry", "test" for id=5)
 *   — we deliberately do NOT match by that string (it's drift-prone)
 *   and use the integer IDs only.
 *     5  → Job CheckOut Remarks  (the "Add Remarks" / comments popup)
 *     24 → Enquiry               (JobOutcomeDialog mode='enquiry')
 *     25 → Un Reachable          (JobOutcomeDialog mode='unreachable')
 */

const DUE_TO_USER_TYPE = Object.freeze({
  customer: 1,
  client: 2,
  easyfix: 3,
  technician: 4,
});

const ACTION_TYPE_BY_MODE = Object.freeze({
  // Add Remarks → 'Job CheckOut Remarks' bucket. Not currently used as a
  // mode key in routes (the comment-reasons endpoint hardcodes 5
  // directly) — exposed here so cross-tier callers can reach it by
  // name without re-hardcoding.
  addremarks: 5,
  // JobOutcomeDialog modes — keys match the FE `mode` value verbatim
  // after lowercasing + whitespace/underscore/dash stripping.
  enquiry: 24,
  unreachable: 25,
});

const ACTION_TYPE = Object.freeze({
  ADD_REMARKS: 5,
  ENQUIRY: 24,
  UNREACHABLE: 25,
});

module.exports = {
  DUE_TO_USER_TYPE,
  ACTION_TYPE_BY_MODE,
  ACTION_TYPE,
};
