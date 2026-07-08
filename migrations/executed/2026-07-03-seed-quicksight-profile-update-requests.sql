-- Seed the Profile Update Requests QuickSight per-report action key + grant it
-- to Admin (role_id = 2). Mirrors 2026-07-02-seed-quicksight-offer-acceptance.sql:
-- the key attaches to the SAME menu as ef-QuickSight, so Manage Roles shows it
-- as an individually grant/revokable QuickSight report with NO new sidebar menu.
-- NOT EXISTS-guarded → re-runs are a no-op. DO NOT MOVE INTO executed/.

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightProfileUpdateRequestsView', 'View QuickSight - Profile Update Requests', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightProfileUpdateRequestsView');

UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isQuickSightProfileUpdateRequestsView');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isQuickSightProfileUpdateRequestsView'
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);
