-- Seed the Employee Performance QuickSight keys + grant both to Admin
-- (role_id = 2). Mirrors 2026-07-30-seed-quicksight-call-tracking.sql: both keys
-- attach to the SAME menu as ef-QuickSight (Home), so Manage Roles shows them
-- with NO new sidebar menu. NOT EXISTS-guarded -> re-runs are a no-op.
--
--   isQuickSightEmployeePerformanceView    -- the report card + page. Joins the
--                                             QuickSight family tree in Manage
--                                             Roles on its own (matched by shape).
--   isQuickSightEmployeePerformanceUpload  -- the "Upload Data" button. A plain
--                                             Home action: whoever builds data.js
--                                             is not everyone who may view it.
--
-- WHAT THE REPORT IS: the MIS Employee Performance Dashboard (revenue vs target,
-- open jobs, client / city / TAT-SDA, zonal breakdown, TimeChamp productivity,
-- IVR) rendered inside the CRM from an uploaded data.js snapshot.
--
-- WARNING GRANT THIS DELIBERATELY. Every section attributes revenue, targets and
-- working hours to a NAMED employee -- a performance-review surface, the same
-- caution as Call Tracking and User Performance. Admin only by default.
--
-- Until this runs the page answers 403 "Missing permission:
-- isQuickSightEmployeePerformanceView" and the card stays hidden.

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1) AS home), 'isQuickSightEmployeePerformanceView', 'View QuickSight - Employee Performance', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightEmployeePerformanceView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1) AS home), 'isQuickSightEmployeePerformanceUpload', 'Upload QuickSight - Employee Performance Data', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightEmployeePerformanceUpload');

UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name IN ('isQuickSightEmployeePerformanceView', 'isQuickSightEmployeePerformanceUpload'));

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name IN ('isQuickSightEmployeePerformanceView', 'isQuickSightEmployeePerformanceUpload')
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

-- ── Verification ────────────────────────────────────────────────────
-- SELECT ma.id, ma.menu_id, ma.action_name, ma.name,
--        (SELECT COUNT(*) FROM role_menu_action rma
--          WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
--   FROM menu_action ma
--  WHERE ma.action_name IN ('ef-QuickSight', 'isQuickSightEmployeePerformanceView', 'isQuickSightEmployeePerformanceUpload');
-- Then log out/in: permissions are cached 60 s.
