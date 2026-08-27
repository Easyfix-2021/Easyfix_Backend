-- Make every QuickSight report key exist, render, and be grantable -- on any DB.
--
-- WHAT WAS WRONG. Manage Roles on production lists only SIX "View QuickSight -"
-- actions; the other ten never appear, so no role but Admin can be granted
-- them. The ten are the June batch. 2026-06-22-rename-quicksight-report-keys
-- diagnosed this exactly: production seeded them on menu_id 59 (the LEGACY
-- "EF-Quicksight" redirect menu) while the family key `ef-QuickSight` lives on
-- Home, and the Manage-Role editor only renders actions whose menu is in the
-- role's menu set. Off-Home keys are invisible, and because the editor saves by
-- soft-deleting everything and re-granting the SUBMITTED set, any role save
-- also silently drops them.
--
-- WHY AGAIN. That migration is in executed/, but the symptom is live on
-- production today, so on that database it either did not run or was undone.
-- Rather than guess which, this states the END STATE and is safe to run
-- anywhere: on a database that is already correct every statement matches
-- nothing.
--
-- THIS IS THE WHOLE SET, not the missing ten. A list that enumerates only what
-- was broken goes stale the moment someone adds a report; this one is the same
-- sixteen keys the CRM registry and the backend routers gate on, and
-- tests/quicksight-report-key-parity.test.js fails if the three drift apart.
--
-- Idempotent. Legacy-safe: touches only is-prefixed ...View keys. It does NOT
-- touch `ef-QuickSight` itself, the legacy `isQuicksight` (lowercase s) Home
-- button, or tbl_menu row 59's redirect URL.

-- 1. Every report key exists, homed on the SAME menu as the family key.
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home), 'isQuickSightOpenOrdersView', 'View QuickSight - Open Orders', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightOpenOrdersView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home), 'isQuickSightClientPerformanceView', 'View QuickSight - Client Performance', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightClientPerformanceView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home), 'isQuickSightVerticalOrdersView', 'View QuickSight - Vertical Orders', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightVerticalOrdersView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home), 'isQuickSightPriorityJobsView', 'View QuickSight - Priority Jobs', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightPriorityJobsView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home), 'isQuickSightMaterialReportView', 'View QuickSight - Material Report', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightMaterialReportView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home), 'isQuickSightCityPerformanceView', 'View QuickSight - City Performance', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightCityPerformanceView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home), 'isQuickSightTechnicianPerformanceView', 'View QuickSight - Technician Performance', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightTechnicianPerformanceView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home), 'isQuickSightSupplyGapView', 'View QuickSight - Supply Gap Analysis', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightSupplyGapView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home), 'isQuickSightEmployeeProductivityView', 'View QuickSight - Employee Productivity', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightEmployeeProductivityView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home), 'isQuickSightAdminDashboardView', 'View QuickSight - Admin Dashboard', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightAdminDashboardView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home), 'isQuickSightOfferAcceptanceView', 'View QuickSight - Offer Acceptance', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightOfferAcceptanceView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home), 'isQuickSightProfileUpdateRequestsView', 'View QuickSight - Profile Update Requests', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightProfileUpdateRequestsView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home), 'isQuickSightPrematureConfirmationsView', 'View QuickSight - Premature Confirmations', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightPrematureConfirmationsView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home), 'isQuickSightCallTrackingView', 'View QuickSight - Call Tracking', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightCallTrackingView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home), 'isQuickSightStatePerformanceView', 'View QuickSight - State Performance', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightStatePerformanceView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home), 'isQuickSightUserPerformanceView', 'View QuickSight - User Performance', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightUserPerformanceView');

-- 2. Re-home any report key that drifted off the family key's menu. This is the
--    statement that makes the ten render in Manage Roles again. Targets the menu
--    by FOLLOWING the family key, so it is correct whatever Home's id is here.
UPDATE menu_action
   SET menu_id = (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home)
 WHERE action_name LIKE 'isQuickSight%View'
   AND menu_id <> (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home2);

-- 3. A key that was soft-deleted cannot be granted. Revive them.
UPDATE menu_action
   SET status = 1, delete_status = 0
 WHERE action_name LIKE 'isQuickSight%View'
   AND (status <> 1 OR delete_status = 1);

-- 4. Admin (role 2) holds every report. Un-soft-delete first, then add missing.
UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name LIKE 'isQuickSight%View');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name LIKE 'isQuickSight%View'
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

-- Verify A -- expect 16 rows, all on the same menu_id as ef-QuickSight, status 1.
SELECT ma.id, ma.action_name, ma.name, ma.menu_id, ma.status, ma.delete_status
  FROM menu_action ma
 WHERE ma.action_name LIKE 'isQuickSight%View'
 ORDER BY ma.name;

-- Verify B -- expect ZERO rows. Any row here is a key the Manage-Role editor
-- still cannot render, which is the whole bug.
SELECT ma.action_name, ma.menu_id AS on_menu,
       (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS family_menu
  FROM menu_action ma
 WHERE ma.action_name LIKE 'isQuickSight%View'
   AND ma.menu_id <> (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1) AS home3);

-- Verify C -- expect 16 ACTIVE Admin grants.
SELECT COUNT(*) AS admin_active_report_grants
  FROM role_menu_action rma
  JOIN menu_action ma ON ma.id = rma.menu_action_id
 WHERE rma.role_id = 2
   AND (rma.isDeleted IS NULL OR rma.isDeleted = 0)
   AND ma.action_name LIKE 'isQuickSight%View';
