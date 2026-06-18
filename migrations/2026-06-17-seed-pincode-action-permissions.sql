-- 2026-06-17 — Seed action permissions for Manage Pincodes page
--
-- The Manage Pincodes page (src/app/(authed)/settings/pincodes) gates:
--    isPincodeAddNew  — the "Add Pincode" button + the per-row Zone-map button
--                       + the per-row Serviceable toggle
--    isPincodeUpload  — the "Download Template" + "Upload Excel" buttons
-- Neither key had a menu_action row, so /auth/me returned no permission,
-- actionFlags() resolved both to false, and operators (even Admin) saw the
-- Action column as "—" and no Add/Upload buttons. Confirmed in DB:
-- tbl_menu 'Manage Pincodes' = menu_id 66, zero menu_action rows, zero grants.
--
-- Pattern mirrors migrations/executed/2026-06-05-seed-deep-skill-action-
-- permissions.sql EXACTLY: insert idempotently into menu_action (menu_id
-- resolved inline via tbl_menu.menu_name), revive any soft-deleted Admin
-- (role_id=2) role_menu_action rows, then insert the grants that never existed.
--
-- After this runs, the app's 5-minute role cache picks the perms up on its next
-- miss; to force-bust immediately, save any role via Manage Roles in the CRM.
-- Style: plain one-statement-per-line; each statement idempotent (re-run = no-op).

-- ─── 1. Insert the two menu_action rows ─────────────────────────────
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isPincodeAddNew', 'Add / Edit Pincode', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.menu_name = 'Manage Pincodes'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isPincodeAddNew');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isPincodeUpload', 'Upload Pincodes (Excel)', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.menu_name = 'Manage Pincodes'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isPincodeUpload');

-- ─── 2. Grant the new rows to Admin (role_id = 2) ───────────────────
UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name IN ('isPincodeAddNew','isPincodeUpload'));

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name IN ('isPincodeAddNew','isPincodeUpload') AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

-- ─── 3. Verify (expected: 2 rows, admin_granted = 1 each) ───────────
SELECT ma.id, ma.action_name, ma.name, ma.menu_id,
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
  FROM menu_action ma
 WHERE ma.action_name IN ('isPincodeAddNew','isPincodeUpload')
 ORDER BY ma.action_name;
