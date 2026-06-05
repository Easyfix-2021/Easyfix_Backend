-- =============================================================================
-- Seed the `isClickToCall` action permission for the new Kaleyra-backed
-- outbound calling feature, and grant it to the Admin role (role_id = 2).
--
-- WHY: services/role.service.js::getEffectivePermissions() builds a user's
-- `actionPermissions` list from role_menu_action × menu_action. The new
-- POST /api/admin/calls/click-to-call route + every <CallButton/> on the
-- CRM gate themselves on `actionPermissions.includes('isClickToCall')`.
-- Without this row, no role can hold the key — including Admin — so the
-- buttons stay hidden for everyone and the endpoint 403s for everyone.
--
-- MENU MAPPING: attaches to the same "Manage Jobs" menu used by all the
-- other job-lifecycle action keys (isJobAssign, isJobConfirm, …). The
-- CallButton lives inside JobModal + Manage Jobs row + My Orders row +
-- Dashboard recent-jobs row, plus the Customer popup — but those are all
-- "places jobs and customers live in the CRM operator's mental model",
-- so co-locating with the Manage Jobs menu is correct.
--
-- IDEMPOTENT: NOT EXISTS guards make re-runs a no-op.
-- =============================================================================

SET @manage_jobs_menu_id := (
  SELECT menu_id FROM tbl_menu
   WHERE url = 'job' AND menu_status = 1
   ORDER BY menu_id ASC LIMIT 1
);

SELECT IF(
  @manage_jobs_menu_id IS NULL,
  (SELECT 'ABORT: tbl_menu row with url=''job'' not found — seed Manage Jobs menu first' FROM dual WHERE 1=0),
  'OK'
) AS preflight;

-- ─── 1. Insert the menu_action row ────────────────────────────────────
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @manage_jobs_menu_id,
       'isClickToCall',
       'Place Outbound Call to Customer (Kaleyra)',
       1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isClickToCall');

-- ─── 2. Grant to Admin (role_id = 2) ──────────────────────────────────
-- Restore soft-deleted rows first, then INSERT any that were never created.
UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isClickToCall');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isClickToCall'
   AND NOT EXISTS (
     SELECT 1 FROM role_menu_action rma
      WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id
   );

-- ─── 3. Verify ────────────────────────────────────────────────────────
SELECT ma.id, ma.action_name, ma.name, ma.menu_id,
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
  FROM menu_action ma
 WHERE ma.action_name = 'isClickToCall';
