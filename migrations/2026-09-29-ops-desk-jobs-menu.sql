-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-29 — "Ops Desk" becomes a sidebar leaf under Jobs (owner request:
-- move it out of Admin Actions into its own sub-menu of the Jobs menu).
--
-- Until now /ops-desk had no tbl_menu row: it was reached from a card on
-- /admin-actions and from the /jobs header link. The CRM change that ships
-- with this removes the card and maps url 'opsDesk' → /ops-desk in
-- Easyfix_CRM_UI/src/lib/legacy-url-map.ts. The /jobs header link stays.
--
-- THE PERMISSION IS NOT MOVED. The page and its routes gate on the action key
-- isJobAppRequestResolve (migrations/executed/2026-09-15-seed-job-app-request-
-- action.sql, hung off Manage Jobs), which also gates the JobModal Schedule
-- Visit 2 and the technician-request reject. This file touches no menu_action
-- or role_menu_action row.
--
-- PLACEMENT. Shape copied from the Manage Jobs row (url 'job'), never written
-- as literals: parent_menu (Jobs — an AUTO_INCREMENT id that differs between
-- QA and production), menu_depth, icons and action_name. `sequence` is
-- float(11,4), so 2.00015 would round to 2.0002 and tie with App Job, sorting
-- AFTER it. Instead the row TIES with Manage Jobs at that row's own sequence:
-- /shared/lookup/menus orders by sequence then menu_id, and a new row's id is
-- higher, so it lands directly after Manage Jobs (same trick as
-- 2026-09-18-pending-for-material-menu.sql).
--
-- VISIBILITY = WHO CAN USE THE PAGE. The sidebar shows a leaf iff its id is in
-- the role's tbl_role.menu_ids CSV (role_menu_action carries action keys, not
-- menus), so step 2 appends the new id to every role that holds
-- isJobAppRequestResolve — the same predicate role.service.js
-- _loadEffectivePermissions applies at runtime (role_menu_action.isDeleted = 0
-- joined to menu_action by action_name). No role id is written here. This is a
-- one-time sync: afterwards the menu tick and the action tick are separate
-- checkboxes in Manage Roles.
--
-- THE ALLOWLIST (step 3) IS NOT OPTIONAL. When new.crm.visible.menu.ids is
-- active, a menu id missing from it is hidden AND the CRM middleware redirects
-- its route to /coming-soon — with this row mapped, that would break /ops-desk
-- for everyone, the /jobs header link included. Update-only, never INSERT:
-- creating the key would switch the allowlist ON for a whole environment. If an
-- environment drives the allowlist from the NEW_CRM_VISIBLE_MENU_IDS env var
-- instead of the property, add the id printed by step 4 there as well.
--
-- POST-APPLY: menu_ids is read through the 5-minute role cache and the
-- property through the 1-hour properties cache. Save any role in Manage Roles
-- (busts the role cache), do the 10-click logo flush (POST
-- /api/admin/properties/reload), then reload the CRM.
--
-- Style: idempotent, one statement per line, no variables.
-- ─────────────────────────────────────────────────────────────────────

-- ─── 1. The leaf ─────────────────────────────────────────────────────
INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name) SELECT 'Ops Desk', s.parent_menu, s.menu_depth, 0, 'opsDesk', 1, s.sequence, s.icons, s.action_name FROM (SELECT parent_menu, menu_depth, sequence, icons, action_name FROM tbl_menu WHERE url = 'job' AND menu_name = 'Manage Jobs' LIMIT 1) s WHERE NOT EXISTS (SELECT 1 FROM (SELECT url FROM tbl_menu) g WHERE g.url = 'opsDesk');

-- ─── 2. Sidebar grant, derived from the isJobAppRequestResolve grants ─
UPDATE tbl_role r SET r.menu_ids = CONCAT(COALESCE(r.menu_ids, ''), IF(r.menu_ids IS NULL OR r.menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE url = 'opsDesk' LIMIT 1)) WHERE EXISTS (SELECT 1 FROM role_menu_action rma JOIN menu_action ma ON ma.id = rma.menu_action_id WHERE rma.role_id = r.role_id AND rma.isDeleted = 0 AND ma.action_name = 'isJobAppRequestResolve') AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'opsDesk' LIMIT 1), COALESCE(r.menu_ids, ''));

-- ─── 3. The CRM visible-menu allowlist (append-only) ─────────────────
UPDATE easyfix_properties p JOIN tbl_menu m ON m.url = 'opsDesk' SET p.property_value = CONCAT(COALESCE(p.property_value, ''), IF(p.property_value IS NULL OR p.property_value = '', '', ','), m.menu_id) WHERE p.property_key = 'new.crm.visible.menu.ids' AND NOT FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''));

-- ─── 4. Verify ───────────────────────────────────────────────────────
SELECT m.menu_id, m.menu_name, m.parent_menu, m.menu_depth, m.url, m.sequence, m.action_name FROM tbl_menu m WHERE m.parent_menu = (SELECT parent_menu FROM tbl_menu WHERE url = 'opsDesk' LIMIT 1) ORDER BY COALESCE(m.sequence, 999), m.menu_id;
SELECT 'roles holding isJobAppRequestResolve' AS what, COUNT(DISTINCT rma.role_id) AS n FROM role_menu_action rma JOIN menu_action ma ON ma.id = rma.menu_action_id WHERE rma.isDeleted = 0 AND ma.action_name = 'isJobAppRequestResolve'
UNION ALL SELECT 'roles seeing Ops Desk (expect the same n)', COUNT(*) FROM tbl_role r JOIN tbl_menu m ON m.url = 'opsDesk' WHERE FIND_IN_SET(m.menu_id, COALESCE(r.menu_ids, ''))
UNION ALL SELECT 'allowlist carries it (0 = allowlist inactive or env-driven)', COUNT(*) FROM easyfix_properties p JOIN tbl_menu m ON m.url = 'opsDesk' WHERE p.property_key = 'new.crm.visible.menu.ids' AND FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''));
