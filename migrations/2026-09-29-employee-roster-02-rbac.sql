-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-29 — Team Roster: sidebar menu, action keys, allowlist, horizon
--
-- Minimal-migration style (one statement per line, no @vars / PREPARE),
-- the shape of 2026-09-07-hrms-certificates-menu.sql. Every statement is
-- idempotent — re-running is a no-op.
--
-- 1. tbl_menu leaf "Team Roster", url key 'teamRoster' (CRM_UI URL_MAP →
--    /team-roster), top level.
-- 2. menu_action keys:
--      isRosterManage — the screen exists for this role (plan own team)
--      isRosterAdmin  — plan ANY user's roster, including today
-- 3. Grant both + the menu to Admin (role_id 2). Other roles (Ops TLs) are
--    granted from Manage Roles.
-- 4. Append the menu id to new.crm.visible.menu.ids (the new-CRM cutover gate).
-- 5. easyfix_properties:
--      roster.manager.emails — the SECOND lock (services/feature-access.service.js
--        canManageRoster). Seeded EMPTY = deny-all. Fill with the TL / HR emails
--        confirmed by the owner BEFORE applying, e.g.
--        UPDATE easyfix_properties SET property_value = 'a@easyfix.in,b@easyfix.in' WHERE property_key = 'roster.manager.emails';
--      roster.horizon.months — how far ahead a roster can be planned (default 3).
-- Properties are cached at boot: restart / flush the properties cache after applying.
-- ─────────────────────────────────────────────────────────────────────

INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name) SELECT 'Team Roster', 0, 1, 0, 'teamRoster', 1, 13.5000, 'fa-calendar', 'teamRoster' FROM dual WHERE NOT EXISTS (SELECT 1 FROM tbl_menu x WHERE x.url = 'teamRoster');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on) SELECT (SELECT menu_id FROM tbl_menu WHERE url = 'teamRoster' LIMIT 1), 'isRosterManage', 'Manage Team Roster (own team)', 1, 0, NOW() FROM dual WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isRosterManage');
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on) SELECT (SELECT menu_id FROM tbl_menu WHERE url = 'teamRoster' LIMIT 1), 'isRosterAdmin', 'Roster Admin (any user, incl. today)', 1, 0, NOW() FROM dual WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isRosterAdmin');

UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE url = 'teamRoster')) WHERE role_id = 2 AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'teamRoster'), COALESCE(menu_ids, ''));
UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name IN ('isRosterManage', 'isRosterAdmin'));
INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted) SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name IN ('isRosterManage', 'isRosterAdmin') AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

UPDATE easyfix_properties p JOIN tbl_menu m ON m.url = 'teamRoster' SET p.property_value = CONCAT(COALESCE(p.property_value, ''), IF(p.property_value IS NULL OR p.property_value = '', '', ','), m.menu_id) WHERE p.property_key = 'new.crm.visible.menu.ids' AND NOT FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''));

INSERT INTO easyfix_properties (property_key, property_value, updated_at) SELECT 'roster.manager.emails', '', NOW() FROM dual WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'roster.manager.emails');
INSERT INTO easyfix_properties (property_key, property_value, updated_at) SELECT 'roster.horizon.months', '3', NOW() FROM dual WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'roster.horizon.months');

SELECT 'Team Roster menu present' AS what, COUNT(*) AS ok FROM tbl_menu WHERE url = 'teamRoster'
UNION ALL SELECT 'both action keys seeded (2)', COUNT(*) FROM menu_action WHERE action_name IN ('isRosterManage', 'isRosterAdmin')
UNION ALL SELECT 'admin holds both keys (2)', COUNT(*) FROM role_menu_action rma JOIN menu_action ma ON ma.id = rma.menu_action_id WHERE rma.role_id = 2 AND rma.isDeleted = 0 AND ma.action_name IN ('isRosterManage', 'isRosterAdmin')
UNION ALL SELECT 'admin sees the menu', COUNT(*) FROM tbl_role r JOIN tbl_menu m ON m.url = 'teamRoster' WHERE r.role_id = 2 AND FIND_IN_SET(m.menu_id, COALESCE(r.menu_ids, ''))
UNION ALL SELECT 'visible-menu allowlist carries it (0 = allowlist inactive, also fine)', COUNT(*) FROM easyfix_properties p JOIN tbl_menu m ON m.url = 'teamRoster' WHERE p.property_key = 'new.crm.visible.menu.ids' AND FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''))
UNION ALL SELECT 'roster properties seeded (2)', COUNT(*) FROM easyfix_properties WHERE property_key IN ('roster.manager.emails', 'roster.horizon.months');
