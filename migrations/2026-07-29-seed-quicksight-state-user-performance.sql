-- Seed the STATE + USER Performance QuickSight per-report action keys and grant
-- them to Admin (role_id = 2). Mirrors 2026-07-24-seed-quicksight-premature-
-- confirmations.sql exactly: each key attaches to the SAME menu as
-- ef-QuickSight (Home), so Manage Roles shows them as individually
-- grant/revokable QuickSight reports with NO new sidebar menu.
-- NOT EXISTS-guarded → re-runs are a no-op.
--
-- WHAT THE REPORTS ARE: the City Performance scorecard (same periods, same SDA
-- and TAT definitions) over two new dimensions, built for the Performance Report
-- page's tabs.
--   State — GROUP BY the city's state. Every job belongs to exactly one state,
--           so these totals reconcile with City Performance.
--   User  — each row is a CRM user's "Manage Regions" grant
--           (tbl_user.manage_states): the jobs sitting in the states that user
--           manages.
--
-- ⚠ GRANT THE USER REPORT DELIBERATELY. It attributes volume and SDA/TAT
-- performance to NAMED users, so it is a performance-review surface, not a
-- general ops screen — the same caution as Premature Confirmations. It also
-- DOUBLE-COUNTS where two users manage the same region (each sees that region's
-- jobs in full), which the report states on screen and in its export; anyone
-- granted it should understand a row is "workload in this user's regions", not
-- a share of the total. Admin only by default; widen only where intended.

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightStatePerformanceView', 'View QuickSight - State Performance', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightStatePerformanceView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightUserPerformanceView', 'View QuickSight - User Performance', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightUserPerformanceView');

UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name IN ('isQuickSightStatePerformanceView', 'isQuickSightUserPerformanceView'));

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isQuickSightStatePerformanceView'
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isQuickSightUserPerformanceView'
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);
