-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-30 — Employee Hub menu: Attendance & Leaves, Approvals
--
-- Spec: docs/superpowers/specs/2026-09-30-employee-hub-leave-design.md §3.
-- Minimal-migration style (one statement per line, no @vars / PREPARE), the
-- shape of executed/2026-09-29-employee-roster-02-rbac.sql and the LMS parent
-- (executed/2026-08-13-lms-foundation.sql). Every statement is idempotent.
--
-- 1. tbl_menu parent "Employee Hub" (top level, url 'javascript:;', keyed by
--    menu_name + parent_menu 0 because every parent row shares that url),
--    sequence 8.5 — right after HRMS (menu_id 11, sequence 8) and before
--    Settings (9) on QA 2026-09-30.
-- 2. Children (CRM_UI URL_MAP):
--      employeeAttendance     → /employee-hub/attendance
--      employeeLeaveApprovals → /employee-hub/approvals
-- 3. Granted to EVERY admin-group role (services/role.service.js
--    ROLE_ID_TO_GROUP: 2, 3, 5, 7, 11, 12, 13, 15, 17, 18) — every CRM user.
--    No action key: who may approve is data (reporting_manager / isRosterAdmin).
-- 4. Appended to new.crm.visible.menu.ids (the new-CRM cutover gate).
--
-- Deploy AFTER the CRM build that has the Employee Hub pages is live.
-- Users must log out and back in — menu_ids are read at sign-in.
-- ─────────────────────────────────────────────────────────────────────

INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name) SELECT 'Employee Hub', 0, 1, 1, 'javascript:;', 1, 8.5000, 'fa-id-card', 'employeeHub' FROM dual WHERE NOT EXISTS (SELECT 1 FROM tbl_menu WHERE menu_name = 'Employee Hub' AND parent_menu = 0);

INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name) SELECT 'Attendance & Leaves', p.menu_id, 2, 0, 'employeeAttendance', 1, 8.5001, 'fa-circle', 'employeeAttendance' FROM tbl_menu p WHERE p.menu_name = 'Employee Hub' AND p.parent_menu = 0 AND NOT EXISTS (SELECT 1 FROM tbl_menu c WHERE c.url = 'employeeAttendance');
INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name) SELECT 'Approvals', p.menu_id, 2, 0, 'employeeLeaveApprovals', 1, 8.5002, 'fa-circle', 'employeeLeaveApprovals' FROM tbl_menu p WHERE p.menu_name = 'Employee Hub' AND p.parent_menu = 0 AND NOT EXISTS (SELECT 1 FROM tbl_menu c WHERE c.url = 'employeeLeaveApprovals');

UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE menu_name = 'Employee Hub' AND parent_menu = 0)) WHERE role_id IN (2, 3, 5, 7, 11, 12, 13, 15, 17, 18) AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE menu_name = 'Employee Hub' AND parent_menu = 0), COALESCE(menu_ids, ''));
UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE url = 'employeeAttendance')) WHERE role_id IN (2, 3, 5, 7, 11, 12, 13, 15, 17, 18) AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'employeeAttendance'), COALESCE(menu_ids, ''));
UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE url = 'employeeLeaveApprovals')) WHERE role_id IN (2, 3, 5, 7, 11, 12, 13, 15, 17, 18) AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'employeeLeaveApprovals'), COALESCE(menu_ids, ''));

UPDATE easyfix_properties p JOIN tbl_menu m ON m.menu_name = 'Employee Hub' AND m.parent_menu = 0 SET p.property_value = CONCAT(COALESCE(p.property_value, ''), IF(p.property_value IS NULL OR p.property_value = '', '', ','), m.menu_id) WHERE p.property_key = 'new.crm.visible.menu.ids' AND NOT FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''));
UPDATE easyfix_properties p JOIN tbl_menu m ON m.url = 'employeeAttendance' SET p.property_value = CONCAT(COALESCE(p.property_value, ''), IF(p.property_value IS NULL OR p.property_value = '', '', ','), m.menu_id) WHERE p.property_key = 'new.crm.visible.menu.ids' AND NOT FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''));
UPDATE easyfix_properties p JOIN tbl_menu m ON m.url = 'employeeLeaveApprovals' SET p.property_value = CONCAT(COALESCE(p.property_value, ''), IF(p.property_value IS NULL OR p.property_value = '', '', ','), m.menu_id) WHERE p.property_key = 'new.crm.visible.menu.ids' AND NOT FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''));

SELECT 'Employee Hub menu rows (expect 3)' AS what, COUNT(*) AS ok FROM tbl_menu WHERE (menu_name = 'Employee Hub' AND parent_menu = 0) OR url IN ('employeeAttendance', 'employeeLeaveApprovals')
UNION ALL SELECT 'children sit under Employee Hub (expect 2)', COUNT(*) FROM tbl_menu c JOIN tbl_menu p ON p.menu_id = c.parent_menu AND p.menu_name = 'Employee Hub' AND p.parent_menu = 0 WHERE c.url IN ('employeeAttendance', 'employeeLeaveApprovals')
UNION ALL SELECT 'admin-group roles holding all 3 (expect 10)', COUNT(*) FROM tbl_role r WHERE r.role_id IN (2, 3, 5, 7, 11, 12, 13, 15, 17, 18) AND FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE menu_name = 'Employee Hub' AND parent_menu = 0), COALESCE(r.menu_ids, '')) AND FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'employeeAttendance'), COALESCE(r.menu_ids, '')) AND FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'employeeLeaveApprovals'), COALESCE(r.menu_ids, ''))
UNION ALL SELECT 'visible-menu allowlist carries all 3 (0 = allowlist inactive, also fine)', COUNT(*) FROM easyfix_properties p JOIN tbl_menu m ON (m.menu_name = 'Employee Hub' AND m.parent_menu = 0) OR m.url IN ('employeeAttendance', 'employeeLeaveApprovals') WHERE p.property_key = 'new.crm.visible.menu.ids' AND FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''));
