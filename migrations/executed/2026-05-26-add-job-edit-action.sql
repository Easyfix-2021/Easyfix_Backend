-- ─────────────────────────────────────────────────────────────────────
-- 2026-05-26 — Seed `isJobEdit` action permission
--
-- WHY: The FE checks `actionFlags(me, ['isJobEdit'])` in multiple
-- places (Job modal edit button, JobAddressCard "Edit Address" button,
-- JobMaterialsTab Add/Delete, etc.). `getEffectivePermissions()` builds
-- the user's `actionPermissions` array by JOINing role_menu_action ×
-- menu_action. If `menu_action` has no row for `isJobEdit`, no role —
-- including Admin — can hold it, and every button gated on it stays
-- hidden.
--
-- This is the same data-fix pattern the 2026-05-13 migration used for
-- isJobConfirm / isJobAssign / etc. Apply this migration the same way:
--   mysql -h$DB_HOST -u$DB_USER -p$DB_PASSWORD $DB_NAME \
--     < EasyFix_Backend/migrations/2026-05-26-add-job-edit-action.sql
-- Then log out + log back in so the JWT carries the new permission.
--
-- IDEMPOTENT: NOT EXISTS guards make re-runs a no-op.
-- ─────────────────────────────────────────────────────────────────────

SET @manage_jobs_menu_id := (
  SELECT menu_id FROM tbl_menu
   WHERE url = 'job' AND menu_status = 1
   ORDER BY menu_id ASC LIMIT 1
);

-- Hard stop if Manage Jobs menu row is missing. Divide-by-zero forces
-- the script to exit non-zero on the failing branch.
SELECT IF(
  @manage_jobs_menu_id IS NULL,
  (SELECT 1/0 FROM dual),
  'OK'
) AS preflight;

-- ─── 1. Insert missing menu_action row ───────────────────────────────
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @manage_jobs_menu_id,
       'isJobEdit',
       'Edit Job (details, address, services, materials)',
       1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isJobEdit');

-- ─── 2. Grant to Admin (role_id = 2) ─────────────────────────────────
-- Re-activate soft-deleted grant rows first, then insert any that were
-- never created. Matches the upsert pattern from 2026-05-13.
UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (
     SELECT id FROM menu_action WHERE action_name = 'isJobEdit'
   );

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isJobEdit'
   AND NOT EXISTS (
     SELECT 1 FROM role_menu_action rma
      WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id
   );

-- ─── 3. Verify ───────────────────────────────────────────────────────
SELECT ma.id, ma.action_name, ma.name,
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
  FROM menu_action ma
 WHERE ma.action_name = 'isJobEdit';
