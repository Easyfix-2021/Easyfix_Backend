/*
 * Shared reason-codes mapping — promoted from inline constants in
 * routes/admin/jobs.js (2026-06-04) so any new caller (mobile app,
 * integration routes, future cross-tier features) reads from a single
 * source of truth instead of forking its own copy.
 *
 * DUE_TO_USER_TYPE
 *   Maps the operator-facing "Pending Due To" / "Open Due To" radio
 *   label (lowercased + whitespace-stripped on the URL side) to the
 *   integer stored as `tbl_action_taken_reason.user_type`.
 *
 *   ⚠ The seeded data does NOT follow the naive 1=Customer/2=Client order.
 *   Ground truth is the legacy CRM Velocity pages — jobCancel.vm and every
 *   sibling reason page (jobInquiry/jobComment/jobCallLater/…) bind the
 *   radio to userType with the SAME else-EasyFix convention:
 *     customer → 2, client → 3, technician → 4, else (easyfix) → 1
 *   i.e. the rows live under:
 *     1 → EasyFix     (the else-branch bucket; e.g. "Spare not available")
 *     2 → Customer    (e.g. "Customer is not responding"; magic-link 38/39)
 *     3 → Client      (e.g. "Phone not reachable", "Reschedule – CX request")
 *     4 → Technician  (e.g. "Tx No-Show", "Estimate not received from Technician")
 *   The earlier "verified 2026-05-19" 1=Customer/2=Client mapping was read
 *   off a mislabeled dump and shifted 3 of 4 parties (Technician=4 lined up
 *   in both schemes, masking it). Corrected 2026-07-14 against the .vm source.
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
  customer: 2,   // Customer reasons live under user_type = 2
  client: 3,     // Client   reasons live under user_type = 3
  easyfix: 1,    // EasyFix  reasons live under user_type = 1 (legacy .vm else-branch)
  technician: 4, // Technician reasons live under user_type = 4
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
