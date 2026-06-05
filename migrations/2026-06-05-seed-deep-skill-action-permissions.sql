-- 2026-06-05 — Seed action permissions for Manage Deep Skills page
--
-- The new Manage Deep Skills page (src/app/(authed)/settings/deep-skills)
-- gates its "Add Deep Skill" button + per-row Edit affordance on two
-- action keys:
--    isDeepSkillAddNew  — shows the top-right "Add Deep Skill" button
--    isDeepSkillEdit    — shows the per-row pencil + "Deactivate" trash
--
-- Neither key had a menu_action row, so /auth/me returned no permission,
-- actionFlags() resolved both to false, and operators (even Admin) saw
-- only the "view-only" placeholder. Pattern mirrors 2026-05-13-seed-new-
-- action-permissions.sql exactly: insert idempotently into menu_action,
-- restore any soft-deleted role_menu_action rows for Admin (role_id=2),
-- then insert the role_menu_action rows that never existed.
--
-- After this migration runs, the application's 5-minute role cache will
-- pick the new perms up on its next miss; to force-bust immediately,
-- save any role via Manage Roles in the CRM (that endpoint flushes).
--
-- Style: plain one-statement-per-line per the user's migration-style rule
-- (no @set/PREPARE/EXECUTE, no MariaDB-only IF NOT EXISTS on columns).
-- Each statement is idempotent — re-running this file is a no-op.

-- ─── 1. Insert the two menu_action rows ─────────────────────────────
-- Resolves the Deep Skills menu_id inline via subquery on
-- tbl_menu.menu_name. The page's sidebar label is "Manage Deep Skills"
-- (sidebar slot 9.009 per the auto-allocation comment in
-- migrations/executed/2026-04-18-auto-allocation-settings.sql).

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isDeepSkillAddNew', 'Add New Deep Skill', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.menu_name = 'Manage Deep Skills'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isDeepSkillAddNew');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isDeepSkillEdit', 'Edit Deep Skill', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.menu_name = 'Manage Deep Skills'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isDeepSkillEdit');

-- ─── 2. Grant the new rows to Admin (role_id = 2) ───────────────────
-- Two-step pattern: (a) revive any soft-deleted rows; (b) INSERT the
-- ones that never existed. Mirrors 2026-05-11-bootstrap-admin-role-
-- permissions.sql so the data shape is consistent.

UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name IN ('isDeepSkillAddNew','isDeepSkillEdit'));

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name IN ('isDeepSkillAddNew','isDeepSkillEdit') AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

-- ─── 3. Verify ──────────────────────────────────────────────────────
-- Expected: 2 rows, both with admin_granted = 1. If admin_granted is 0,
-- the menu lookup found nothing — check that tbl_menu has a row with
-- menu_name = 'Manage Deep Skills' (case-sensitive).

SELECT ma.id, ma.action_name, ma.name, ma.menu_id,
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
  FROM menu_action ma
 WHERE ma.action_name IN ('isDeepSkillAddNew','isDeepSkillEdit')
 ORDER BY ma.action_name;
