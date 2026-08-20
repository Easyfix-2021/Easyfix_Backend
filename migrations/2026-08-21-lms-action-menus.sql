-- ─────────────────────────────────────────────────────────────────────
-- 2026-08-21 — LMS action tool: the two sidebar leaves.
--
-- Pairs with 2026-08-21-lms-action-permissions.sql (which seeds the
-- isLmsAction / isLmsChaseHandoff keys) and 2026-08-21-lms-action-tables.sql
-- (the chase log and hand-off tables). Split into three files because they
-- fail for different reasons and are worth re-running independently.
--
-- FOUR ARTIFACTS OR THE PAGE IS UNREACHABLE
--   1. tbl_menu leaf                        — this file
--   2. menu_action key                      — the permissions migration
--   3. role grants: tbl_role.menu_ids CSV
--      AND role_menu_action                 — split across both
--   4. new.crm.visible.menu.ids property    — this file
--   plus a URL_MAP entry in the CRM's src/lib/legacy-url-map.ts, without
--   which the sidebar link falls through to /coming-soon no matter what
--   this SQL says. That edit ships in the same change.
--
-- SIBLINGS, NOT CHILDREN
--   Sidebar.tsx::buildTree() re-parents any grandchild to its nearest
--   top-level ancestor — the tree is a hard two levels. So "Action" and
--   "My City" join the existing four LMS leaves as siblings rather than
--   nesting under a Chase sub-menu.
--
-- WHY "My City" IS GRANTED TO ZONAL FIELD TEAM (role 12)
--   It is the state manager's screen, and role 12 is the closest existing
--   role. The page shows only the caller's own cities regardless — every
--   read is scoped through lib/scope.js — so a wrong grant here narrows to
--   nothing rather than leaking. Starting narrow is recoverable; ops can
--   move it in Manage Roles.
--
-- WHY THE PROPERTY IS UPDATE-ONLY, NEVER INSERT
--   If new.crm.visible.menu.ids is absent, resolveVisibleMenuIds() returns
--   null and the allowlist is inactive — every menu shows. Creating the key
--   here would switch that filter ON for a whole environment as a side
--   effect of adding two pages, hiding every menu not on the list.
--
-- POST-APPLY
--   Operators must log out and back in. menu_ids and actionPermissions are
--   resolved into the JWT at login, so a running session keeps the old set.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. The two leaves ───────────────────────────────────────────────
-- Parent resolved by name, never a hard-coded menu_id: tbl_menu.menu_id is
-- AUTO_INCREMENT and differs between QA and production.

INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'Action', p.menu_id, 2, 0, 'lmsAction', 1, 14.0005, 'fa-circle', 'lmsAction'
  FROM tbl_menu p
 WHERE p.menu_name = 'LMS' AND p.parent_menu = 0
   AND NOT EXISTS (SELECT 1 FROM tbl_menu c WHERE c.url = 'lmsAction');

INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'My City', p.menu_id, 2, 0, 'lmsField', 1, 14.0006, 'fa-circle', 'lmsField'
  FROM tbl_menu p
 WHERE p.menu_name = 'LMS' AND p.parent_menu = 0
   AND NOT EXISTS (SELECT 1 FROM tbl_menu c WHERE c.url = 'lmsField');


-- ─── 2. Sidebar visibility — the legacy CSV on tbl_role ───────────────
-- FIND_IN_SET guard makes each statement idempotent.

UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE url = 'lmsAction')) WHERE role_id = 2 AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'lmsAction'), COALESCE(menu_ids, ''));

UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE url = 'lmsField')) WHERE role_id = 2 AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'lmsField'), COALESCE(menu_ids, ''));

-- Zonal Field Team gets "My City" and the LMS parent, so the leaf has a
-- visible ancestor. Sidebar.tsx renders a parent when it is granted directly
-- OR has at least one visible child, but granting the parent keeps the
-- Manage Roles screen readable.
UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE menu_name = 'LMS' AND parent_menu = 0)) WHERE role_id = 12 AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE menu_name = 'LMS' AND parent_menu = 0), COALESCE(menu_ids, ''));

UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE url = 'lmsField')) WHERE role_id = 12 AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'lmsField'), COALESCE(menu_ids, ''));


-- ─── 3. The CRM visible-menu allowlist ───────────────────────────────
-- Append-only. No INSERT — see the header.

UPDATE easyfix_properties p JOIN tbl_menu m ON m.url = 'lmsAction' SET p.property_value = CONCAT(COALESCE(p.property_value, ''), IF(p.property_value IS NULL OR p.property_value = '', '', ','), m.menu_id) WHERE p.property_key = 'new.crm.visible.menu.ids' AND NOT FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''));

UPDATE easyfix_properties p JOIN tbl_menu m ON m.url = 'lmsField' SET p.property_value = CONCAT(COALESCE(p.property_value, ''), IF(p.property_value IS NULL OR p.property_value = '', '', ','), m.menu_id) WHERE p.property_key = 'new.crm.visible.menu.ids' AND NOT FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''));


-- ─── 4. Verify ───────────────────────────────────────────────────────
SELECT 'menu leaf lmsAction' AS what, COUNT(*) AS present FROM tbl_menu WHERE url = 'lmsAction'
UNION ALL SELECT 'menu leaf lmsField', COUNT(*) FROM tbl_menu WHERE url = 'lmsField'
UNION ALL SELECT 'admin sees lmsAction', COUNT(*) FROM tbl_role r JOIN tbl_menu m ON m.url = 'lmsAction' WHERE r.role_id = 2 AND FIND_IN_SET(m.menu_id, COALESCE(r.menu_ids, ''))
UNION ALL SELECT 'admin sees lmsField', COUNT(*) FROM tbl_role r JOIN tbl_menu m ON m.url = 'lmsField' WHERE r.role_id = 2 AND FIND_IN_SET(m.menu_id, COALESCE(r.menu_ids, ''))
UNION ALL SELECT 'zonal sees lmsField', COUNT(*) FROM tbl_role r JOIN tbl_menu m ON m.url = 'lmsField' WHERE r.role_id = 12 AND FIND_IN_SET(m.menu_id, COALESCE(r.menu_ids, ''))
UNION ALL SELECT 'allowlist carries both (0 = allowlist inactive, also fine)', COUNT(*) FROM easyfix_properties p JOIN tbl_menu m ON m.url IN ('lmsAction','lmsField') WHERE p.property_key = 'new.crm.visible.menu.ids' AND FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''));
