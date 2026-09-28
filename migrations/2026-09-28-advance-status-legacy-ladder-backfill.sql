-- ============================================================================
-- 2026-09-28 — tbl_efr_advance_payment.adv_status: renumber this backend's
--              rows onto the legacy ladder
--
-- WHAT: UPDATE tbl_efr_advance_payment SET adv_status = 1 WHERE adv_status = 0.
--       No schema change. One value, in one column, on rows only this backend
--       ever wrote.
--
-- ─── WHY ────────────────────────────────────────────────────────────────────
--
-- tbl_efr_advance_payment is SHARED with the legacy Struts CRM, which is still
-- live and still creating advances. Legacy's ladder (the only one the data has
-- ever really had — EasyFix_CRM AdvanceDaoImpl.java:429, and the per-stage
-- rendering in pages/jobs/getAllAdvanceListByJobId.vm) is:
--
--     1  Initiated            raised by the PM, awaiting Ops
--     2  Pending To Finance   Ops approved, awaiting Finance
--     3  Rejected by Ops      terminal
--     4  Advance Done         Finance paid, terminal
--     5  Rejected by Finance  terminal
--
-- routes/admin/advances.js shipped with an invented 0/1/2/3 ladder on that same
-- column: 0 pending, 1 ops-approved, 2 finance-approved, 3 rejected. The two
-- ladders collided silently, because they disagree without ever failing:
--
--   * a legacy 1 (Initiated) displayed in Audit Advance as "Ops Approved";
--   * a legacy 2 (Pending To Finance) displayed as "Finance Approved";
--   * ops-approve required 0, a value legacy NEVER writes, so it 409'd on
--     every legacy row;
--   * fin-approve accepted 1 — under legacy numbering, a request Ops had not
--     yet seen.
--
-- The code is fixed in this release (ADV_STATUS in routes/admin/advances.js).
-- This migration fixes the rows that release strands.
--
-- ─── WHY 0 → 1 IS UNAMBIGUOUS ───────────────────────────────────────────────
--
-- 0 is not a legacy value. Legacy's INSERT path writes 1 and its label ladder
-- starts at 1 (`if (advStatus > 0)`, with everything below falling through to
-- "TBD"). So every adv_status = 0 row in this table was created by this
-- backend's POST /admin/advances, where 0 meant exactly one thing: "pending /
-- initiated by PM". That is legacy's 1. The mapping is one-to-one and carries
-- no judgement call.
--
-- The other new-ladder values need no backfill, and MUST NOT be touched:
-- 1, 2 and 3 are legal in BOTH ladders, so a row holding one of them cannot be
-- attributed to either system from its value alone. Renumbering them would
-- corrupt legacy rows to repair new ones. This is why only 0 moves — it is the
-- single value that identifies its writer unambiguously.
--
-- CONSEQUENCE OF NOT RUNNING THIS: any advance this CRM created before the fix
-- sits at 0 forever. Ops-approve now requires 1 and reject now requires 1 or 2,
-- so those requests can no longer be approved, rejected or paid from either
-- CRM — they are stuck, and the PM's only route is to raise a new one.
--
-- ─── RISK ───────────────────────────────────────────────────────────────────
--
-- Rewrites live rows, so it is not reversible from the row values alone: after
-- it runs, a backfilled row is indistinguishable from a legacy Initiated one.
-- Section 1 prints the affected advance_ids BEFORE the write — capture that
-- output; it is the only rollback list there will be
-- (UPDATE … SET adv_status = 0 WHERE advance_id IN (<those ids>)).
--
-- Expected to touch few rows: the Billing & Charges tab that raises these was
-- itself invisible to every user until the 2026-09-09 RBAC fix
-- (see migrations/executed/2026-09-09-job-charges-rbac-action.sql), so the
-- window in which this backend could create an advance at all is short.
-- ============================================================================

-- ─── 1. Preflight (read-only) — what is there, and exactly what will move ───

SELECT adv_status, COUNT(*) AS rows_at_status
  FROM tbl_efr_advance_payment
 GROUP BY adv_status
 ORDER BY adv_status;

-- The rollback list. Save this output before running section 2.
SELECT advance_id, job_id, efr_id, advance_amt, initiated_on, initiated_by
  FROM tbl_efr_advance_payment
 WHERE adv_status = 0
 ORDER BY advance_id;

-- ─── 2. The backfill ────────────────────────────────────────────────────────

UPDATE tbl_efr_advance_payment
   SET adv_status = 1
 WHERE adv_status = 0;

-- ─── 3. Verify (read-only) ──────────────────────────────────────────────────

-- Expect 0.
SELECT COUNT(*) AS still_zero
  FROM tbl_efr_advance_payment
 WHERE adv_status = 0;

-- Expect every row to sit on a legacy rung; anything outside 1..5 is a row
-- neither system should have written and wants investigating before release.
SELECT adv_status, COUNT(*) AS rows_at_status
  FROM tbl_efr_advance_payment
 GROUP BY adv_status
 ORDER BY adv_status;
