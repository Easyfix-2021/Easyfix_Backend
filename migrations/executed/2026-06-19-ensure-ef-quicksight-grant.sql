-- =============================================================================
-- Make the Home "QuickSight" button appear on PRODUCTION (it shows on Local/QA
-- but not prod). The button is gated PURELY on the `ef-QuickSight` action key
-- granted to the user's role in role_menu_action (NOT on tbl_role.menu_ids — it
-- is not a sidebar item). Prod most likely never received the grant (the
-- 2026-05-13-grant-home-actions-to-admin.sql ran on staging but maybe not prod),
-- and/or the shared menu_action row is absent.
--
-- ⚠️ DO NOT HAMPER LEGACY CRM: menu_action + role_menu_action are SHARED with the
-- Legacy CRM. Legacy reads the external redirect target from tbl_menu.url; New
-- CRM ignores tbl_menu.url and routes in-app to /quicksight. So this migration:
--   • NEVER touches tbl_menu (Legacy's redirect URL stays intact), and
--   • NEVER touches tbl_role.menu_ids (no spurious New-CRM sidebar item).
-- It only ensures the shared `ef-QuickSight` action row exists and is granted to
-- the intended role(s). Granting it makes BOTH CRMs show their QuickSight button
-- for that role (Legacy → its URL redirect, New → /quicksight) — which is the
-- intended, consistent behaviour.
--
-- RUN THE DIAGNOSTICS in the response FIRST against prod to confirm the cause and
-- which roles need it. Idempotent — safe to re-run. Defaults to Admin (role 2);
-- add more role_ids per the diagnostic (steps 2b/3b template at the bottom).
-- =============================================================================

-- Step 0 — Ensure the shared ef-QuickSight menu_action row EXISTS. PROD DIAGNOSIS
-- (2026-06-19) CONFIRMED this row is ABSENT on prod (Legacy CRM shows QuickSight
-- off tbl_menu row 59 'EF-Quicksight' directly, NOT off menu_action), which is
-- exactly why the New-CRM button is missing on prod. Co-locate the new row on the
-- sibling Home action's menu (isBookNewCall) for Manage-Role grouping; fall back
-- to the existing EF-Quicksight tbl_menu row's menu_id (confirmed present on prod)
-- so it associates with the right menu; NULL only if neither exists (the New-CRM
-- action query ignores menu_id, so the button still works). tbl_menu is NEVER
-- written — Legacy's redirect URL on row 59 is left exactly as-is.
-- created_on is NOT NULL with no default on menu_action → must be supplied.
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT COALESCE(
         (SELECT menu_id FROM menu_action WHERE action_name = 'isBookNewCall' LIMIT 1),
         (SELECT menu_id FROM tbl_menu WHERE url LIKE '%EF-QuickSight%' OR menu_name LIKE '%Quick%' LIMIT 1)
       ),
       'ef-QuickSight', 'QuickSight', 1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight');

-- Step 1 — Restore any soft-deleted Admin (role 2) grant for ef-QuickSight.
UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (
     SELECT id FROM menu_action
      WHERE action_name = 'ef-QuickSight'
        AND (status IS NULL OR status = 1)
        AND (delete_status IS NULL OR delete_status = 0)
   );

-- Step 2 — Insert the Admin (role 2) grant if missing (NOT EXISTS = idempotent).
INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'ef-QuickSight'
   AND (ma.status IS NULL OR ma.status = 1)
   AND (ma.delete_status IS NULL OR ma.delete_status = 0)
   AND NOT EXISTS (
     SELECT 1 FROM role_menu_action rma
      WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id
   );

-- Step 3 — Verify (expect 1 row, admin_granted = 1).
SELECT ma.id, ma.action_name, ma.name, ma.menu_id,
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
  FROM menu_action ma
 WHERE ma.action_name = 'ef-QuickSight';

-- ── Template: grant to ADDITIONAL roles the prod diagnostic shows should see it.
-- Replace <ROLE_ID> and uncomment one pair per role (e.g. 3,5,7,11,12,13,15).
-- Step 2b (restore):
-- UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = <ROLE_ID> AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'ef-QuickSight');
-- Step 3b (insert):
-- INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted) SELECT <ROLE_ID>, ma.id, 0 FROM menu_action ma WHERE ma.action_name = 'ef-QuickSight' AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = <ROLE_ID> AND rma.menu_action_id = ma.id);
