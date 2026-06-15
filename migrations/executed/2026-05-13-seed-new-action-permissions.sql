-- =============================================================================
-- Seed `menu_action` rows for action keys the NEW CRM_UI introduced
-- but the legacy easyfix_core DB never had, and grant them to the Admin
-- role (role_id = 2) via the standard `role_menu_action` upsert pattern.
--
-- WHY: getEffectivePermissions() builds a user's `actionPermissions` list
-- by JOINing role_menu_action × menu_action. If `menu_action` has no row
-- for a key (e.g. `isJobConfirm`), no role can hold it — including Admin.
-- The buttons gated on `actionFlags(me, ['isJobConfirm'])` therefore stay
-- hidden for everyone, which is the bug observed in My Orders →
-- Unconfirmed Orders (Confirm & Schedule icon missing for Admin).
--
-- This migration is the CORRECT FIX. It replaces the temporary bypass that
-- earlier short-circuited `hasAction` for Admin in lib/permissions.ts —
-- a bypass would have permanently masked the Manage Role workflow ("a key
-- the operator can't see in Manage Role is a key they can't manage").
--
-- KEYS BEING SEEDED (sourced from grep across Easyfix_CRM_UI 2026-05-13):
--   Job lifecycle gates introduced for the per-row quick actions on
--   /jobs + /my-orders:
--     isJobConfirm        — Confirm Unconfirmed Order (status 9 → 0)
--     isJobAssign         — Assign Technician (status 0 → 1)
--     isJobReassign       — Reassign Technician (status 1)
--     isJobStatusChange   — Check-In / Check-Out / Mark Incomplete
--     isJobCancel         — Cancel a job (destructive — kept separate
--                           from isJobEdit so it can be granted narrowly)
--   Client questionnaire (modal tab inside JobModal):
--     isClientQuestionaire — view/answer the per-client checklist
--
-- IDEMPOTENT: NOT EXISTS guards make re-runs a no-op.
--
-- MENU MAPPING: every key here attaches to the "Manage Jobs" menu (the
-- new app's `URL_MAP['job'] = '/jobs'`, which corresponds to the legacy
-- `tbl_menu.url = 'job'` row). If that row is missing, the migration
-- fails loudly — better than silently inserting orphan rows with NULL
-- menu_id that Manage Role can't render.
-- =============================================================================

SET @manage_jobs_menu_id := (
  SELECT menu_id FROM tbl_menu
   WHERE url = 'job' AND menu_status = 1
   ORDER BY menu_id ASC LIMIT 1
);

-- Hard stop if Manage Jobs menu isn't present. Without it the seeded
-- rows would be orphans (Manage Role tree wouldn't show them).
SELECT IF(
  @manage_jobs_menu_id IS NULL,
  (SELECT 'ABORT: tbl_menu row with url=''job'' not found — seed Manage Jobs menu first' FROM dual WHERE 1=0),
  'OK'
) AS preflight;

-- ─── 1. Insert missing menu_action rows ──────────────────────────────
-- Schema reminder (verified against legacy MenuAction.java):
--   id (PK, auto), menu_id (FK), action_name (permission key —
--   the string `hasAction()` checks), name (human label shown as the
--   checkbox label in Manage Role), status, delete_status,
--   created_on, created_by.
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @manage_jobs_menu_id, 'isJobConfirm', 'Confirm Unconfirmed Order', 1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isJobConfirm');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @manage_jobs_menu_id, 'isJobAssign', 'Assign Technician', 1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isJobAssign');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @manage_jobs_menu_id, 'isJobReassign', 'Reassign Technician', 1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isJobReassign');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @manage_jobs_menu_id, 'isJobStatusChange', 'Change Job Status (Check-In / Check-Out / Incomplete)', 1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isJobStatusChange');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @manage_jobs_menu_id, 'isJobCancel', 'Cancel Job', 1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isJobCancel');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @manage_jobs_menu_id, 'isClientQuestionaire', 'View / Answer Client Questionnaire', 1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isClientQuestionaire');

-- ─── 2. Grant the new rows to Admin (role_id = 2) ────────────────────
-- Mirrors the 2026-05-11 bootstrap migration: restore soft-deleted rows
-- first, then INSERT any that were never created. The application's
-- 5-min role cache will pick this up on its next miss; force-bust by
-- saving any role via Manage Roles if you need it immediately.
UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (
     SELECT id FROM menu_action
      WHERE action_name IN (
        'isJobConfirm','isJobAssign','isJobReassign',
        'isJobStatusChange','isJobCancel','isClientQuestionaire'
      )
   );

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name IN (
   'isJobConfirm','isJobAssign','isJobReassign',
   'isJobStatusChange','isJobCancel','isClientQuestionaire'
 )
   AND NOT EXISTS (
     SELECT 1 FROM role_menu_action rma
      WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id
   );

-- ─── 3. Verify ───────────────────────────────────────────────────────
SELECT ma.id, ma.action_name, ma.name, ma.menu_id,
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
  FROM menu_action ma
 WHERE ma.action_name IN (
   'isJobConfirm','isJobAssign','isJobReassign',
   'isJobStatusChange','isJobCancel','isClientQuestionaire'
 )
 ORDER BY ma.action_name;
