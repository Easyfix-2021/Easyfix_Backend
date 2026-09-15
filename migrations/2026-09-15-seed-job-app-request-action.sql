-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-15 — RBAC action `isJobAppRequestResolve`
-- ("Approve / Reject Technician Requests") under Manage Jobs, granted to
-- Admin (role_id 2).
--
-- My Orders → Pending to Start → Technician Requests lists the cancellation
-- and reschedule asks a technician raises from the mobile app
-- (tbl_job.is_cancelled_by_app / is_rescheduled_by_app). Ops can now answer
-- them from the row.
--
-- APPROVE needs no key of its own: it IS the ordinary cancel (PATCH
-- /api/admin/jobs/:id/status → 6) or reschedule (PATCH /:id/reschedule), each
-- already gated by requireStageForTransition and by the CRM's own isJobCancel.
-- Both now clear the flag they answer, so the queue empties itself.
--
-- REJECT is the write this key guards: PATCH /api/admin/jobs/:id/app-request/reject
-- declines the ask and leaves the job exactly as it was — still status 1, same
-- technician, same appointment. Because nothing about the job changes, no
-- stage-transition guard can see it, so without this key it would be the one
-- job write on that router any admin-group role could make.
--
-- Until this runs the reject answers 403 "Missing permission:
-- isJobAppRequestResolve" and the CRM hides the Approve/Reject pair; the rows
-- still list, and View Job / Reassign still work. Manage Jobs is the tbl_menu
-- row with url = 'job' (menu_id 3 on QA), where isJobStatusChange, isJobEdit
-- and isJobAfterPhotoUpload already live.
--
-- Style: idempotent, one statement per line, no variables.

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isJobAppRequestResolve', 'Approve / Reject Technician Requests', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'job' AND m.menu_status = 1 AND m.menu_name = 'Manage Jobs'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isJobAppRequestResolve');

UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isJobAppRequestResolve');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name = 'isJobAppRequestResolve' AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);


-- ── Verification ────────────────────────────────────────────────────
-- SELECT m.menu_name, ma.id, ma.action_name, ma.name,
--        (SELECT COUNT(*) FROM role_menu_action rma
--          WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
--   FROM menu_action ma JOIN tbl_menu m ON m.menu_id = ma.menu_id
--  WHERE ma.action_name = 'isJobAppRequestResolve';
-- Then save any role in Manage Roles (or restart) and log out/in: permissions are cached 60 s.
