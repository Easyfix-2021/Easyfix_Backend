-- =============================================================================
-- 2026-09-22 — Material Approval: visit-chosen reschedule reason seed.
--
-- WHAT: a seeded action_taken_reason row (action_type = 8, the same
-- "Reschedule" bucket services/lookup.service.js#rescheduleReasons() reads
-- and GET /admin/jobs/reschedule-reasons serves) so the reschedule every
-- approve path now performs — to the visit date/time the client or CRM
-- picked, via services/job-estimate-approval.js#approveWithVisitSchedule —
-- resolves to a readable label instead of an orphan id. Same idempotent
-- SELECT..WHERE NOT EXISTS shape as
-- migrations/executed/2026-07-10-seed-reschedule-reasons-action-type-8.sql.
--
-- HISTORY: this file originally also created a side table
-- tbl_job_auto_schedule for a same-day AUTO-reschedule (find the technician's
-- next open 7-day slot and book it without asking). The owner rejected that
-- design on 2026-09-22 ("never pre-assume the next visit date") in favour of
-- letting the client/CRM pick the slot themselves
-- (services/visit-slots.service.js). That table and its needs_scheduling
-- column are gone from the code and never shipped to a database (this
-- migration was never run) — nothing to roll back. This file is SHRUNK to
-- just the reason seed, renamed to match the new flow.
--
-- IDEMPOTENCY: one statement per line, plain INSERT..SELECT..WHERE NOT
-- EXISTS, no `SET @var`/PREPARE (banned in this repo) and no MariaDB-only
-- syntax.
--
-- NOT RUN AGAINST ANY DATABASE by this change — the lead runs it.
-- =============================================================================

-- ─── 1. Preflight (read-only) — does the reason already exist? ────────────

SELECT id, action_desc, user_type, status FROM action_taken_reason
 WHERE action_type = 8 AND action_desc = 'Material Approved — Visit Chosen';

-- ─── 2. The seeded reason row ───────────────────────────────────────────────

-- status = 0: a SYSTEM reason. rescheduleReasons() (the CRM Schedule & Assign
-- and technician-app Reschedule dropdowns) lists only status = 1, so an active
-- row would let someone pick it for an unrelated manual reschedule. The approval
-- path finds it by action_desc and reschedule() does not check status.
-- is_new: the column is NOT NULL with no default (every action_type 8 row has 0);
-- omitting it fails with ER_NO_DEFAULT_FOR_FIELD (1364) under strict mode.
INSERT INTO action_taken_reason (action_type, action_desc, user_type, status, is_new)
SELECT 8, 'Material Approved — Visit Chosen', 1, 0, 0
 WHERE NOT EXISTS (SELECT 1 FROM action_taken_reason WHERE action_type = 8 AND action_desc = 'Material Approved — Visit Chosen');

-- ─── 3. Verify (read-only) ───────────────────────────────────────────────────

SELECT id, action_desc, user_type, status FROM action_taken_reason
 WHERE action_type = 8 AND action_desc = 'Material Approved — Visit Chosen';
