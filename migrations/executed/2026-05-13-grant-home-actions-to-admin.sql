-- =============================================================================
-- Ensure the Home-menu action permissions are seeded AND granted to Admin.
--
-- WHY: The legacy CRM page-header buttons (QuickSight, Call Info,
-- Escalated Jobs, Book New Call) are gated on these action_name keys:
--
--     isBookNewCall, isCallInfo, isEscalatedJob, ef-QuickSight
--
-- All four are visible as checkboxes in the new-app Manage Role modal
-- (we already see them rendered against the Home menu), which means
-- they exist as `menu_action` rows in production. The Manage Role
-- modal screenshot also showed them CHECKED for the Admin role, which
-- means `role_menu_action` rows exist for them.
--
-- However: a session was observed where these buttons did not render
-- for an Admin user. Possible causes:
--   (a) The 2026-05-11 bootstrap migration that grants every
--       menu_action to Admin ran BEFORE one of these rows was
--       inserted in production. Result: the row exists in
--       menu_action but never made it into role_menu_action for
--       Admin, so getEffectivePermissions() omits it.
--   (b) Someone unchecked them in Manage Roles and forgot to re-check.
--
-- This migration is the cheap, idempotent fix for both causes. It
-- mirrors the bootstrap's upsert-restore pattern, scoped to these 4
-- specific action_names so other roles are untouched.
--
-- SAFETY: only touches role_id = 2 (Admin). Other roles preserve
-- their current grants. Idempotent — re-runs are a no-op.
-- =============================================================================

-- Step 1 — Restore any soft-deleted Admin grants for these 4 keys.
UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (
     SELECT id FROM menu_action
      WHERE action_name IN ('isBookNewCall', 'isCallInfo', 'isEscalatedJob', 'ef-QuickSight')
        AND (status IS NULL OR status = 1)
        AND (delete_status IS NULL OR delete_status = 0)
   );

-- Step 2 — Insert missing Admin grants. NOT EXISTS guard makes this safe
-- to re-run; if a row already exists for Admin we skip it.
INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name IN ('isBookNewCall', 'isCallInfo', 'isEscalatedJob', 'ef-QuickSight')
   AND (ma.status IS NULL OR ma.status = 1)
   AND (ma.delete_status IS NULL OR ma.delete_status = 0)
   AND NOT EXISTS (
     SELECT 1 FROM role_menu_action rma
      WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id
   );

-- Step 3 — Verify. Should show 4 rows, each `admin_granted = 1`.
SELECT ma.id, ma.action_name, ma.name, ma.menu_id,
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
  FROM menu_action ma
 WHERE ma.action_name IN ('isBookNewCall', 'isCallInfo', 'isEscalatedJob', 'ef-QuickSight')
 ORDER BY ma.action_name;
