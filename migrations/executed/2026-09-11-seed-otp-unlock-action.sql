-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-11 — RBAC for Admin Actions → "Unlock OTP / PIN".
--
-- Every OTP and the job-closing PIN allow 5 attempts per 30 minutes, then lock.
-- The lock lifts by itself; this action lets an operator lift it NOW — for a
-- user locked out by someone else's wrong guesses, or a technician standing at
-- a finished job. Backend: routes/admin/otp-locks.js (requireAction
-- 'isOtpUnlock'); CRM_UI: the Admin Actions card + UnlockOtpDialog.
--
-- One new action key under the existing "Admin Action" menu, granted to Admin
-- (role_id 2). Other roles get it from Manage Roles on demand. The menu is
-- looked up by NAME — production menu_ids drift (QA has it as 42).
--
-- Template: migrations/executed/2026-06-18-seed-menu-admin-action-permissions.sql.
-- Style: one statement per line; idempotent (NOT EXISTS guards; the grant uses
-- the upsert/restore pattern Manage Roles itself uses).
--
-- After running: the permission caches hold for 60s (backend role.service and
-- the CRM's sessionStorage) — save any role in Manage Roles or restart the
-- backend, and log out/in to see the card.

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isOtpUnlock', 'Unlock OTP / PIN', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.menu_name = 'Admin Action'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isOtpUnlock');

UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isOtpUnlock');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name = 'isOtpUnlock' AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);


-- ── Verification ────────────────────────────────────────────────────
-- SELECT m.menu_name, ma.id, ma.action_name, ma.name,
--        (SELECT COUNT(*) FROM role_menu_action rma
--          WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
--   FROM menu_action ma JOIN tbl_menu m ON m.menu_id = ma.menu_id
--  WHERE ma.action_name = 'isOtpUnlock';
