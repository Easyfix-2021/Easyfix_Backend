-- Seed the Call Tracking QuickSight per-report action key + grant it to Admin
-- (role_id = 2). Mirrors 2026-07-29-seed-quicksight-state-user-performance.sql
-- exactly: the key attaches to the SAME menu as ef-QuickSight (Home), so Manage
-- Roles shows it as an individually grant/revokable QuickSight report with NO
-- new sidebar menu. NOT EXISTS-guarded -> re-runs are a no-op.
--
-- WHAT THE REPORT IS: call effort off the legacy tbl_job_caller_info log, at two
-- grains.
--   By Job          -- how much phoning a job took, by whom, to whom (Customer /
--                      Alternate / Client SPOC / Technician, derived by
--                      last-10-digit matching), and at which lifecycle step each
--                      call was made (from the per-call snapshot columns).
--   Daily By User   -- one row per (day, CRM user): call volume, connect rate,
--                      talk time, and where in the lifecycle that effort went.
-- Plus a per-call drill-down and a 2-sheet XLSX.
--
-- WARNING GRANT THIS DELIBERATELY. Every row attributes call volume, connect
-- rate, and talk time to a NAMED CRM user, so it is a performance-review surface,
-- not a general ops screen -- the same caution as Premature Confirmations and the
-- User Performance report. Admin only by default; widen only where intended.

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightCallTrackingView', 'View QuickSight - Call Tracking', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightCallTrackingView');

UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isQuickSightCallTrackingView');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isQuickSightCallTrackingView'
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);
