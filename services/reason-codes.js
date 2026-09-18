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
 *     29 → Reschedule Before Start from CRM  (the per-party Reschedule dialog)
 *   and NOT 8 ("Reject & Reschedule"), which /admin/jobs/reschedule-reasons
 *   still serves unfiltered for the older dialog — see the `reschedule` note.
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
  /*
   * ── Reschedule → action_type 29, "Reschedule Before Start from CRM" ──
   *
   * THIS WAS 8 FOR ONE COMMIT AND IS NOW 29, and the reason is worth keeping:
   * 8's rows cannot answer a "Rescheduling Due To" radio and 29's already can.
   * Both buckets profiled on QA, 2026-09-16:
   *
   *   action_type 8  "Reject & Reschedule" — 7 rows, ALL user_type 1
   *       (ids 47-51, 62, 68; is_new = 0). So dueTo=easyfix would return all
   *       seven and customer / client / technician each return NOTHING. Two of
   *       the seven are customer-worded ("Customer has postponed", "Customer is
   *       not responding") while sitting under EasyFix, so its parties are both
   *       incomplete AND partly wrong.
   *   action_type 29 "Reschedule Before Start from CRM" — 16 rows, is_new = 1,
   *       all status 1: EasyFix 3 · Customer 6 · Client 2 · Technician 5. All
   *       four parties populated.
   *
   * 29'S PARTIES ARE RIGHT, and the WORDING proves it rather than asserting it:
   * all six user_type = 2 rows are prefixed "CX" and all five user_type = 4 rows
   * are prefixed "TX". Under the map this file disproved, 2 would mean Client
   * and every one of those CX rows would be misfiled — they are not. 29 was
   * seeded against the CORRECTED convention, which is exactly what the radio
   * needs and what 8 cannot give it.
   *
   * ⚠ 29 IS OLDER THAN IT LOOKS, AND DORMANT RATHER THAN NEW. It carries
   * 142,434 comments to 8's 37,873, but its last use was 2026-04-29 — the
   * legacy-CRM cutover — while 8 is still written today because
   * /reschedule-reasons hardcodes it. So this is not "move to the newer
   * bucket": it is adopting the better-organised bucket the legacy CRM used and
   * this stack never picked up. Ops will recognise the reasons, which is half
   * the point.
   *
   * GET /admin/jobs/reschedule-reasons STAYS ON 8, deliberately. The Current
   * tab's Reschedule dialog still calls it with one unfiltered dropdown, and
   * repointing it would swap the list under a live screen. Two endpoints, two
   * buckets, until the owner retires the old one:
   *     /action-reasons?type=reschedule&dueTo=<party>   → 29, per party  (NEW)
   *     /reschedule-reasons                             → 8,  unfiltered (OLD)
   *
   * The seed migration that put six rows into bucket 8
   * (migrations/executed/2026-07-10-…-action-type-8.sql) is NOT applied on QA —
   * none of its six descriptions is present — so bucket 8 there is the legacy
   * seven above. Check prod before assuming otherwise: if it DID run there,
   * bucket 8 holds thirteen rows written under two different party conventions,
   * which is one more reason the new dialog should not be pointed at it.
   *
   * No new column and nothing to write: due-to is recoverable from the reason
   * id itself (action_taken_reason.user_type), and reschedule already stores
   * that id on tbl_job.enum_reason_id via addComment. So the PATCH body needs
   * no dueTo field, and adding one would create a second, desynchronisable
   * record of the same fact.
   */
  reschedule: 29,
  // JobOutcomeDialog modes — keys match the FE `mode` value verbatim
  // after lowercasing + whitespace/underscore/dash stripping.
  enquiry: 24,
  unreachable: 25,
});

/*
 * ── `dueTo=any`: an EXPLICIT "no party filter", only where it is needed ──
 *
 * IT IS NOW REDUNDANT FOR ITS ORIGINAL PURPOSE, AND KEPT ON PURPOSE. It was
 * added while `reschedule` still pointed at action_type 8, whose rows sit
 * entirely under one party, so `dueTo=customer` returned an empty list and the
 * CRM needed a way to fall back to the whole bucket through the endpoint shape
 * it already called:
 *     GET /admin/jobs/action-reasons?type=reschedule&dueTo=any
 * Pointing the mode at 29 fixes that at the source — all four parties have
 * rows — so nothing should NEED this any more. It stays until the owner
 * retires bucket 8 and the old dialog with it, because a CRM already shipped
 * against this call must not start 400ing (it does not 400 today either: `any`
 * is stripped to the user_type = 2 default on the other modes) or, worse, start
 * silently returning one party's list where it used to return all of them.
 *
 * ⚠ DELETE THIS, AND THE BRANCH IN /action-reasons THAT READS IT, when the old
 * Reschedule dialog goes. It is a workaround, not part of the reason model: a
 * lingering "any" quietly lets a due-to radio send no party at all.
 *
 * SCOPED TO THE MODES THAT OPT IN — `reschedule` alone today. Deliberately NOT
 * a DUE_TO_USER_TYPE key: that would hand EVERY mode an unfiltered escape
 * hatch, and Cancel / Add Remarks / Enquiry / Un Reachable all have correct
 * per-party data and a radio that must keep meaning what it says. For every
 * other mode `any` stays exactly what it is today — an unrecognised value,
 * falling through to the user_type = 2 default like any other typo.
 */
const DUE_TO_ANY = 'any';
const MODES_ALLOWING_DUE_TO_ANY = Object.freeze(['reschedule']);

const ACTION_TYPE = Object.freeze({
  // Cancel Job → action_type = 1 bucket (CRM admin Cancel dialog). Reason is
  // picked per user_type via the "Cancellation Due To" radio, mirroring the
  // Add Remarks (action_type = 5) flow. Replaces the deprecated tbl_cancel_reason.
  CANCEL: 1,
  ADD_REMARKS: 5,
  ENQUIRY: 24,
  UNREACHABLE: 25,
});

module.exports = {
  DUE_TO_USER_TYPE,
  ACTION_TYPE_BY_MODE,
  ACTION_TYPE,
  // The temporary unfiltered-due-to escape hatch and the modes that opt into
  // it. Exported together so the route cannot hardcode either half, and so
  // removing the workaround is one edit in one file plus its branch.
  DUE_TO_ANY,
  MODES_ALLOWING_DUE_TO_ANY,
};
