-- =============================================================================
-- Bootstrap the Admin role (role_id = 2) with full menu + action access.
--
-- WHY: After the role-access refactor that ported the legacy CRM model
-- (tbl_role.menu_ids CSV + role_menu_action soft-delete join), the new
-- Sidebar component gates visibility by me.permissions.menuIds. Roles
-- whose menu_ids is NULL/empty render a blank sidebar — matching the
-- legacy LoginAction.java semantics ("if menues is empty, skip menu load").
--
-- The Admin role in the production easyfix_core DB was created years ago
-- under the legacy CRM, but its menu_ids column either:
--   (a) was never populated, OR
--   (b) was populated against the OLD menu_id set and is now stale.
--
-- This migration unblocks the new CRM by giving Admin universal access:
--   - menu_ids ← every active tbl_menu row
--   - role_menu_action ← one row per active menu_action, isDeleted = 0
--
-- After this runs:
--   - Admin users see the full sidebar
--   - Every gated button in the new CRM is visible to Admin
--   - Admin can use Manage Roles to configure narrower roles (Finance,
--     Project Manager, etc.) from there — those start with whatever they
--     had in legacy and can be edited via the new UI.
--
-- IDEMPOTENT: re-running this is a no-op. menu_ids is overwritten
-- deterministically; role_menu_action uses the same upsert/restore pattern
-- the application uses.
--
-- SAFETY: only touches role_id = 2 ("Admin"). Other roles are left exactly
-- as they were. If you need to bootstrap a different role (e.g. role_id = 18
-- "Technology team"), copy this migration and swap the role_id constant.
-- =============================================================================

-- ─── 1. menu_ids ─────────────────────────────────────────────────────
-- GROUP_CONCAT default max length is 1024 bytes; menus easily exceed that
-- when 80+ menu_ids each take ~3 digits + comma. Bump the session limit
-- so the CSV doesn't truncate silently.
SET SESSION group_concat_max_len = 65535;

UPDATE tbl_role
   SET menu_ids = (
     SELECT GROUP_CONCAT(menu_id ORDER BY menu_id SEPARATOR ',')
       FROM tbl_menu
      WHERE menu_status = 1
   ),
       update_date = NOW()
 WHERE role_id = 2;

-- ─── 2. role_menu_action ─────────────────────────────────────────────
-- Mirror the application's upsert-restore pattern (see role.service.js
-- applyMenuActionIds): for each currently-active menu_action row, try
-- to UPDATE an existing (role_id=2, menu_action_id=X) row back to
-- isDeleted=0; if none exists, INSERT a fresh one.
--
-- Step 2a — restore any soft-deleted Admin rows (idempotent flip-back).
UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (
     SELECT id FROM menu_action
      WHERE (status IS NULL OR status = 1)
        AND (delete_status IS NULL OR delete_status = 0)
   );

-- Step 2b — insert any missing rows. NOT EXISTS guard makes re-runs safe.
INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE (ma.status IS NULL OR ma.status = 1)
   AND (ma.delete_status IS NULL OR ma.delete_status = 0)
   AND NOT EXISTS (
     SELECT 1 FROM role_menu_action rma
      WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id
   );

-- ─── 3. Verify ───────────────────────────────────────────────────────
-- Quick visibility check. The application's 5-minute role-cache will
-- pick the new values up automatically; force a refresh by hitting any
-- /api/* endpoint that calls role.service or just wait < 5 min.
SELECT role_id, role_name,
       CHAR_LENGTH(menu_ids) AS menu_ids_chars,
       (SELECT COUNT(*) FROM role_menu_action
         WHERE role_id = 2 AND isDeleted = 0) AS active_actions
  FROM tbl_role
 WHERE role_id = 2;
