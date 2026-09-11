-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-11 — RBAC action `isJobAfterPhotoUpload` ("Add After-Work Photo")
-- under Manage Jobs, granted to Admin (role_id 2).
--
-- Every job close now needs at least one after-work photo (services/job.service.js
-- setStatus; owner: "every flow needs it"). Ops can supply one from the CRM job
-- view: POST /api/admin/jobs/:id/images with category=Completion. That photo is
-- PROOF the job was done, so it takes its own key rather than riding on the
-- keyless Booking attachment — grant it from Settings → Manage Roles.
--
-- Until this runs the upload answers 403 "Missing permission:
-- isJobAfterPhotoUpload" and the CRM hides the button; nothing else changes.
-- Manage Jobs is the tbl_menu row with url = 'job' (menu_id 3 on QA), where
-- isJobStatusChange and isJobEdit already live.
--
-- Style: idempotent, one statement per line, no variables.

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isJobAfterPhotoUpload', 'Add After-Work Photo', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'job' AND m.menu_status = 1 AND m.menu_name = 'Manage Jobs'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isJobAfterPhotoUpload');

UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isJobAfterPhotoUpload');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name = 'isJobAfterPhotoUpload' AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);


-- ── Verification ────────────────────────────────────────────────────
-- SELECT m.menu_name, ma.id, ma.action_name, ma.name,
--        (SELECT COUNT(*) FROM role_menu_action rma
--          WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
--   FROM menu_action ma JOIN tbl_menu m ON m.menu_id = ma.menu_id
--  WHERE ma.action_name = 'isJobAfterPhotoUpload';
-- Then save any role in Manage Roles (or restart) and log out/in: permissions are cached 60 s.
