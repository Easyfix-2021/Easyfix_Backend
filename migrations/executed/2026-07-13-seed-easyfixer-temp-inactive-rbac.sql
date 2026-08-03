-- RBAC for "Set Temporarily Inactive / Auto-Reactivate" — the action that lets an
-- operator schedule a technician's auto-reactivation. Requirement: ONLY Admins may
-- do this ("Only Admins can auto-activate technicians"). Seeds the action key and
-- grants it to role_id = 2 (Admin) only. Other roles can be granted later via
-- Manage Roles without a code change (the delegable, seeded-action pattern the
-- codebase mandates — no role_name/role_id bypass in code).
--
-- Verify the Manage-Easyfixers menu before running:
--   SELECT menu_id, url, menu_name FROM tbl_menu WHERE menu_name LIKE '%Easyfixer%';
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM tbl_menu WHERE menu_name LIKE '%Easyfixer%' ORDER BY menu_id ASC LIMIT 1), 'isEasyfixerTempInactive', 'Set Technician Temporarily Inactive / Auto-Reactivate', 1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isEasyfixerTempInactive');

UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isEasyfixerTempInactive');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name = 'isEasyfixerTempInactive' AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);
