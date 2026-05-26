-- ─────────────────────────────────────────────────────────────────────
-- 2026-05-25 — Manage Clients write permissions
--
-- Adds two action keys gating the new Create/Edit endpoints on
-- routes/admin/clients.js:
--
--   isClientAddNew  → POST /api/admin/clients
--   isClientEdit    → PUT  /api/admin/clients/:id
--                    + all sub-resource POST/PUT/DELETE
--                      (contacts, billing, custom-properties)
--
-- Matches the legacy EasyFix_CRM keyspace (isClientAddNew + isClientEdit
-- are the same keys the legacy Velocity templates referenced for the
-- "Add Client" / "Edit Client" buttons).
--
-- Action visibility (action_status / delete_status semantics): 1/0 =
-- active+available. Mirrors the click-to-call migration shape.
--
-- Mandatory permission-gating rule (see memory
-- `project_easyfix_permission_gating`): every new gated UI surface
-- MUST land alongside its menu_action + role_menu_action grants so
-- the new flag shows up in Manage Role and so the Admin role can
-- actually exercise the new buttons without a manual UI step.
-- ─────────────────────────────────────────────────────────────────────

-- ─── 0. Locate the existing Manage Clients menu row ──────────────────
-- The Clients menu already exists in tbl_menu (added when the read-only
-- Clients list shipped — `url='clients'`). We attach the new
-- menu_action rows to it.
SET @manage_clients_menu_id := (
  SELECT menu_id FROM tbl_menu
   WHERE url = 'clients' OR menu_name = 'Clients' OR menu_name = 'Manage Clients'
   ORDER BY menu_id ASC LIMIT 1
);

SELECT IF(
  @manage_clients_menu_id IS NULL,
  (SELECT 'ABORT: tbl_menu row for Clients menu not found — seed Manage Clients menu first' FROM dual WHERE 1=0),
  'OK'
) AS preflight;

-- ─── 1. Insert the menu_action rows ──────────────────────────────────
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @manage_clients_menu_id,
       'isClientAddNew',
       'Add New Client',
       1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isClientAddNew');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @manage_clients_menu_id,
       'isClientEdit',
       'Edit Client (master + contacts + billing + custom properties)',
       1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isClientEdit');

-- ─── 2. Grant to Admin (role_id = 2) ─────────────────────────────────
-- Restore soft-deleted rows first, then INSERT any that were never created.
UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (
     SELECT id FROM menu_action WHERE action_name IN ('isClientAddNew', 'isClientEdit')
   );

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name IN ('isClientAddNew', 'isClientEdit')
   AND NOT EXISTS (
     SELECT 1 FROM role_menu_action rma
      WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id
   );

-- ─── 3. Verify ───────────────────────────────────────────────────────
SELECT ma.id, ma.action_name, ma.name, ma.menu_id,
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
  FROM menu_action ma
 WHERE ma.action_name IN ('isClientAddNew', 'isClientEdit')
 ORDER BY ma.action_name;
