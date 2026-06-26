-- 2026-06-18 — Seed menu + action permissions for the Menu Admin page
--
-- The Menu Admin page (src/app/(authed)/settings/menu-admin) was just RBAC-gated
-- to match its sibling settings pages:
--    isMenuAddNew — the "Add Menu" button visibility
--    isMenuEdit   — the per-row Edit + Hide (soft-delete) buttons
-- But Menu Admin had NO tbl_menu row of its own and neither action_name was ever
-- seeded into menu_action, so actionFlags() resolved both to false and the page's
-- Add/Edit buttons were hidden for EVERYONE (fail-closed — same trap that hid the
-- Manage Pincodes actions; see migrations/executed/2026-06-17-seed-pincode-action-
-- permissions.sql). This grants them to Admin (role_id = 2).
--
-- Confirmed in DB before writing: tbl_menu has no '%menu%' row; menu_action has no
-- isMenuAddNew/isMenuEdit; settings children sit under parent_menu = 13 ('Settings',
-- menu_depth 2). tbl_menu.action_name is NOT NULL with no default, so the menu row
-- MUST carry a legacy action_name value (mirrors 'EasyfixerAction' on Manage Pincodes).
--
-- NOTE on the url slug: 'menuAdmin' is a placeholder legacy slug. It only affects the
-- SIDEBAR link, and no role references this menu in its menu_ids yet, so it will NOT
-- appear in any sidebar from this seed alone — it only becomes assignable in Manage
-- Roles. If/when it's added to a role's sidebar, confirm the CRM's slug→route map
-- resolves 'menuAdmin' → /settings/menu-admin (or adjust the slug then).
--
-- After this runs, the app's 5-minute role cache picks the perms up on its next miss;
-- to force-bust immediately, save any role via Manage Roles in the CRM.
-- Style: plain one-statement-per-line; each statement idempotent (re-run = no-op).

-- ─── 1. Ensure the Menu Admin tbl_menu row exists ───────────────────
INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, url, action_name, menu_status, sequence, icons, has_child)
SELECT 'Menu Admin', 13, 2, 'menuAdmin', 'MenuAdminAction', 1, 9.0050, 'fa fa-bars', 0
 WHERE NOT EXISTS (SELECT 1 FROM tbl_menu WHERE menu_name = 'Menu Admin');

-- ─── 2. Insert the two menu_action rows ─────────────────────────────
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isMenuAddNew', 'Add Menu', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.menu_name = 'Menu Admin'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isMenuAddNew');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isMenuEdit', 'Edit / Hide Menu', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.menu_name = 'Menu Admin'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isMenuEdit');

-- ─── 3. Grant the new rows to Admin (role_id = 2) ───────────────────
UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name IN ('isMenuAddNew','isMenuEdit'));

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name IN ('isMenuAddNew','isMenuEdit') AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

-- ─── 4. Verify (expected: 2 rows, admin_granted = 1 each) ───────────
SELECT ma.id, ma.action_name, ma.name, ma.menu_id,
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
  FROM menu_action ma
 WHERE ma.action_name IN ('isMenuAddNew','isMenuEdit')
 ORDER BY ma.action_name;
