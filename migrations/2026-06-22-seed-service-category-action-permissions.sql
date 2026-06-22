-- 2026-06-22 — Seed action permissions for Manage Service Category page
--
-- The Manage Service Category page (src/app/(authed)/settings/service-categories)
-- gates three write actions via actionFlags() (which is FAIL-CLOSED):
--    isServiceCategoryAddNew  — the "Add Service Category" button
--    isServiceCategoryEdit    — the per-row Edit (pencil) button
--    isServiceCategoryDelete  — the per-row Delete (trash) button
-- These are LEGACY action keys (the legacy CRM gated the same page on them), so
-- the menu_action rows MAY already exist in the shared easyfix_core DB. Either
-- way, Admin (role_id=2) was not granted them in the new stack, so /auth/me
-- returned no permission, actionFlags() resolved all three to false, and even
-- Admin saw no Add/Edit/Delete buttons (the exact fail-closed mode the
-- permissions.ts docblock warns about).
--
-- Pattern mirrors migrations/2026-06-22-seed-service-type-action-permissions.sql:
-- insert idempotently into menu_action (menu_id resolved inline from the
-- EXISTING tbl_menu row for the Service Category page — matched by its legacy URL
-- slug 'servicecategory', which Sidebar URL_MAP maps to /settings/service-categories,
-- with the display name 'Manage Service Category' as a fallback), revive any
-- soft-deleted Admin grants, then insert the grants that never existed.
-- tbl_menu and tbl_role.menu_ids are NOT touched — the sidebar entry already
-- exists from the legacy seed.
--
-- After this runs, the BE 60s permission cache + 5-min role cache pick it up on
-- the next miss; to force-bust immediately, save any role via Manage Roles.
-- Style: plain one-statement-per-line; each statement idempotent (re-run = no-op).

-- ─── 1. Insert the three menu_action rows ───────────────────────────
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isServiceCategoryAddNew', 'Add Service Category', 1, 0, NOW()
  FROM tbl_menu m
 WHERE (m.url = 'servicecategory' OR m.menu_name = 'Manage Service Category')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isServiceCategoryAddNew')
 LIMIT 1;

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isServiceCategoryEdit', 'Edit Service Category', 1, 0, NOW()
  FROM tbl_menu m
 WHERE (m.url = 'servicecategory' OR m.menu_name = 'Manage Service Category')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isServiceCategoryEdit')
 LIMIT 1;

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isServiceCategoryDelete', 'Delete Service Category', 1, 0, NOW()
  FROM tbl_menu m
 WHERE (m.url = 'servicecategory' OR m.menu_name = 'Manage Service Category')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isServiceCategoryDelete')
 LIMIT 1;

-- ─── 2. Grant the three rows to Admin (role_id = 2) ─────────────────
UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name IN ('isServiceCategoryAddNew','isServiceCategoryEdit','isServiceCategoryDelete'));

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name IN ('isServiceCategoryAddNew','isServiceCategoryEdit','isServiceCategoryDelete') AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

-- ─── 3. Verify (expected: 3 rows, admin_granted = 1 each) ───────────
SELECT ma.id, ma.action_name, ma.name, ma.menu_id,
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
  FROM menu_action ma
 WHERE ma.action_name IN ('isServiceCategoryAddNew','isServiceCategoryEdit','isServiceCategoryDelete')
 ORDER BY ma.action_name;
