-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-01 — HRMS: rename the User parent, add the Approvals leaf, seed
-- its two action keys.
--
-- Pairs with 2026-09-01-hrms-01 / -02 / -03 (schema) and with the CRM's
-- 9c9b22b. Split out because it fails for different reasons than a schema
-- migration and is worth re-running on its own.
--
-- FOUR ARTIFACTS OR THE PAGE IS UNREACHABLE
--   1. tbl_menu leaf                        — this file
--   2. menu_action key                      — this file
--   3. role grants: tbl_role.menu_ids CSV
--      AND role_menu_action                 — this file
--   4. new.crm.visible.menu.ids property    — this file
--   plus a URL_MAP entry in the CRM's src/lib/legacy-url-map.ts, which
--   shipped in 9c9b22b as 'hrmsApprovals' -> '/hrms/approvals'. Without it
--   the sidebar link falls through to /coming-soon no matter what this SQL
--   says.
--
-- WHY MENU 11 IS RENAMED RATHER THAN A NEW PARENT CREATED
--   Menu 11 ('User') has exactly one child today, 'Manage Users' (id 12).
--   Owner's call: Manage Users is HR's screen, so the parent becomes HRMS
--   and keeps its child rather than standing up a second parent and moving
--   rows between them. Renaming touches one column; moving children
--   rewrites tbl_role.menu_ids CSVs across every role that had either.
--
--   Nothing in the backend keys off this menu's NAME — grepped, the only
--   'Users' literal is an xlsx worksheet title in routes/admin/users-bulk.js.
--   The CRM does: Sidebar.tsx picks parent icons from PARENT_META keyed by
--   menu_name, so the rename would silently drop the icon. 9c9b22b adds an
--   'HRMS' entry AND keeps the old 'User' one, so the icon survives this
--   migration and that deploy landing in either order, or either being
--   rolled back on its own.
--
-- SIBLINGS, NOT CHILDREN
--   Sidebar.tsx::buildTree() re-parents any grandchild to its nearest
--   top-level ancestor — the tree is a hard two levels. So 'Approvals' is a
--   SIBLING of 'Manage Users' under HRMS, and 'Profile Update Requests' is a
--   section heading INSIDE that page rather than a third menu level.
--
-- WHY THE PROPERTY IS UPDATE-ONLY, NEVER INSERT
--   If new.crm.visible.menu.ids is absent, resolveVisibleMenuIds() returns
--   null and the allowlist is inactive — every menu shows. Creating the key
--   here would switch that filter ON for a whole environment as a side
--   effect of adding one page, hiding every menu not on the list.
--
-- POST-APPLY
--   Operators must log out and back in. menu_ids and actionPermissions are
--   resolved into the JWT at login, so a running session keeps the old set.
--
-- Steps 1 and 2 are read-only. Read them before running step 3 onward.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. What exists now (read-only) ──────────────────────────────────
SELECT menu_id, menu_name, parent_menu, menu_depth, url, sequence, menu_status FROM tbl_menu WHERE menu_id IN (11, 12) OR parent_menu = 11 ORDER BY menu_depth, sequence;


-- ─── 2. Is the leaf already here? Expect 0 rows on a first run ───────
SELECT menu_id, menu_name, parent_menu, url FROM tbl_menu WHERE url = 'hrmsApprovals';


-- ─── 3. Rename the parent ────────────────────────────────────────────
-- Guarded on the CURRENT name as well as the id, so a re-run is a no-op and
-- a menu that someone has since renamed by hand is left alone rather than
-- silently overwritten. 'Users' is accepted too because the row is referred
-- to both ways in conversation and only the database knows which it is.
UPDATE tbl_menu SET menu_name = 'HRMS' WHERE menu_id = 11 AND menu_name IN ('User', 'Users');


-- ─── 4. The Approvals leaf ───────────────────────────────────────────
-- Parent resolved by id here rather than by name, because the name is what
-- step 3 just changed and a name lookup would depend on whether step 3 ran.
-- Sequence is derived from Manage Users so Approvals lands directly under it
-- whatever that row's sequence happens to be in this environment.
INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'Approvals', p.menu_id, 2, 0, 'hrmsApprovals', 1, COALESCE((SELECT c.sequence FROM tbl_menu c WHERE c.menu_id = 12), p.sequence) + 0.0001, 'fa-circle', 'hrmsApprovals'
  FROM tbl_menu p
 WHERE p.menu_id = 11
   AND NOT EXISTS (SELECT 1 FROM tbl_menu x WHERE x.url = 'hrmsApprovals');


-- ─── 5. Action keys ──────────────────────────────────────────────────
-- Two keys, not one. Viewing the queue and deciding on it are different
-- privileges: an HR coordinator may need to see what is waiting without
-- being the person who writes a colleague's bank account number onto the
-- record. The CRM drops the Actions column entirely when only the view key
-- is granted, so the split is visible in the UI rather than implied.
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM tbl_menu WHERE url = 'hrmsApprovals' LIMIT 1), 'isProfileApprovalView', 'View Profile Update Requests', 1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isProfileApprovalView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM tbl_menu WHERE url = 'hrmsApprovals' LIMIT 1), 'isProfileApprovalProcess', 'Approve / Reject Profile Update Requests', 1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isProfileApprovalProcess');


-- ─── 6. Sidebar visibility — the legacy CSV on tbl_role ──────────────
-- Admin (role 2) only, deliberately. Starting narrow is recoverable; ops can
-- widen it in Manage Roles once they decide who in HR owns this queue.
-- FIND_IN_SET guard makes the statement idempotent.
UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE url = 'hrmsApprovals')) WHERE role_id = 2 AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'hrmsApprovals'), COALESCE(menu_ids, ''));


-- ─── 7. Action grants ────────────────────────────────────────────────
-- Revive-then-insert: role_menu_action SOFT-deletes, so an insert-only
-- migration leaves a previously revoked grant revoked forever.
UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name IN ('isProfileApprovalView', 'isProfileApprovalProcess'));

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name IN ('isProfileApprovalView', 'isProfileApprovalProcess') AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);


-- ─── 8. The CRM visible-menu allowlist ───────────────────────────────
-- Append-only. No INSERT — see the header.
UPDATE easyfix_properties p JOIN tbl_menu m ON m.url = 'hrmsApprovals' SET p.property_value = CONCAT(COALESCE(p.property_value, ''), IF(p.property_value IS NULL OR p.property_value = '', '', ','), m.menu_id) WHERE p.property_key = 'new.crm.visible.menu.ids' AND NOT FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''));


-- ─── 9. Verify ───────────────────────────────────────────────────────
SELECT 'parent renamed to HRMS' AS what, COUNT(*) AS ok FROM tbl_menu WHERE menu_id = 11 AND menu_name = 'HRMS'
UNION ALL SELECT 'Manage Users still under it', COUNT(*) FROM tbl_menu WHERE menu_id = 12 AND parent_menu = 11
UNION ALL SELECT 'Approvals leaf present', COUNT(*) FROM tbl_menu WHERE url = 'hrmsApprovals'
UNION ALL SELECT 'leaf is depth 2 under 11', COUNT(*) FROM tbl_menu WHERE url = 'hrmsApprovals' AND parent_menu = 11 AND menu_depth = 2
UNION ALL SELECT 'both action keys seeded', COUNT(*) FROM menu_action WHERE action_name IN ('isProfileApprovalView', 'isProfileApprovalProcess')
UNION ALL SELECT 'admin holds both keys', COUNT(*) FROM role_menu_action rma JOIN menu_action ma ON ma.id = rma.menu_action_id WHERE rma.role_id = 2 AND rma.isDeleted = 0 AND ma.action_name IN ('isProfileApprovalView', 'isProfileApprovalProcess')
UNION ALL SELECT 'admin sees the leaf', COUNT(*) FROM tbl_role r JOIN tbl_menu m ON m.url = 'hrmsApprovals' WHERE r.role_id = 2 AND FIND_IN_SET(m.menu_id, COALESCE(r.menu_ids, ''))
UNION ALL SELECT 'allowlist carries it (0 = allowlist inactive, also fine)', COUNT(*) FROM easyfix_properties p JOIN tbl_menu m ON m.url = 'hrmsApprovals' WHERE p.property_key = 'new.crm.visible.menu.ids' AND FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''));
