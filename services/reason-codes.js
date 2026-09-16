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
 *     8  → Reschedule            (Schedule & Assign → Reschedule)
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
  /*
   * Reschedule → action_type = 8, the bucket seeded by
   * migrations/executed/2026-07-10-seed-reschedule-reasons-action-type-8.sql.
   *
   * ⚠⚠ THE SEEDED user_type VALUES FOLLOW THE MAPPING THIS FILE LATER
   * DISPROVED, so `?type=reschedule&dueTo=…` is wired correctly and will
   * nonetheless return the WRONG PARTY'S list until the rows are corrected.
   * The migration is dated 2026-07-10 and its own header cites
   * "1=Customer, 2=Client, 3=EasyFix, 4=Technician"; DUE_TO_USER_TYPE above was
   * corrected against the legacy .vm source four days later, on 2026-07-14, to
   * 1=EasyFix, 2=Customer, 3=Client. Reading the six seeded rows through the
   * corrected map:
   *   user_type 1  the three "Customer requested / not reachable / not
   *                available" reasons → served under dueTo=easyfix
   *   user_type 3  "Spare / parts not available", "Operational / scheduling
   *                delay" (both EasyFix-side) → served under dueTo=client
   *   user_type 4  "Technician unavailable / reassigned" → dueTo=technician ✓
   *   user_type 2  nothing at all → dueTo=customer returns an EMPTY list
   * Technician lines up in both schemes, which is precisely what masked the
   * original error and will mask this one: the radio looks like it works.
   *
   * THIS IS DATA, NOT CODE. The fix is an UPDATE of those six rows' user_type
   * (1→2 for the customer-worded ones, 3→1 for the EasyFix-worded ones) run by
   * whoever owns the reason catalogue, and it must land BEFORE the CRM points a
   * "Rescheduling Due To" radio at this mode. Nothing here should compensate
   * for it: a per-mode fudge of DUE_TO_USER_TYPE would make this map mean two
   * different things, which is the whole disease.
   *
   * Registering the mode here is the whole change: it makes the EXISTING
   * generic endpoint answer for reschedule too —
   *     GET /admin/jobs/action-reasons?type=reschedule&dueTo=<party>
   * which is action_type = 8 narrowed by user_type through DUE_TO_USER_TYPE
   * above. That is what the Reschedule dialog needs once it grows a
   * "Rescheduling Due To" radio like Cancel and Add Remarks already have.
   *
   * GET /admin/jobs/reschedule-reasons IS DELIBERATELY UNCHANGED. It returns
   * action_type = 8 with NO user_type filter, which is the right answer for the
   * single-dropdown dialog shipping today; narrowing it would silently shrink a
   * live list to one party's reasons. Two endpoints, two questions — the FE
   * moves when its dialog does.
   *
   * No new column and nothing to write: due-to is recoverable from the reason
   * id itself (action_taken_reason.user_type), and reschedule already stores
   * that id on tbl_job.enum_reason_id via addComment. So the PATCH body needs
   * no dueTo field, and adding one would create a second, desynchronisable
   * record of the same fact.
   */
  reschedule: 8,
  // JobOutcomeDialog modes — keys match the FE `mode` value verbatim
  // after lowercasing + whitespace/underscore/dash stripping.
  enquiry: 24,
  unreachable: 25,
});

/*
 * ── `dueTo=any`: an EXPLICIT "no party filter", only where it is needed ──
 *
 * THIS EXISTS BECAUSE THE DATA IS KNOWN-WRONG, NOT BECAUSE THE FILTER IS
 * OPTIONAL. The six action_type = 8 rows carry user_type values seeded against
 * the mapping DUE_TO_USER_TYPE later disproved (the `reschedule` note above has
 * the whole story), so `dueTo=customer` legitimately returns an EMPTY list on
 * today's catalogue. The owner has decided to leave those values as they are
 * for now, so the CRM needs to reach the whole bucket through the same endpoint
 * shape it already calls:
 *     GET /admin/jobs/action-reasons?type=reschedule&dueTo=any
 * which returns exactly what /reschedule-reasons returns — every active
 * action_type = 8 row, in the same { id, label } shape.
 *
 * ⚠ DELETE THIS, AND THE BRANCH IN /action-reasons THAT READS IT, THE DAY THOSE
 * SIX user_type VALUES ARE CORRECTED. It is a workaround for a data defect with
 * a known fix, not part of the reason model: once the catalogue is right every
 * party's list is correct and non-empty, and a lingering "any" would quietly
 * let a due-to radio send no party at all.
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
