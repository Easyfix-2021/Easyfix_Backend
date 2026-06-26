-- Make prod's per-report QuickSight action keys match what the New CRM gates on.
-- The New CRM (FE pages + BE quicksight routes) checks `isQuickSight<Report>View`
-- (is- prefix). Prod was seeded on 2026-06-18 with `ef-QuickSight<Report>View`
-- (ef- prefix) → the per-report gates never matched → the report CARDS stay
-- hidden even though the button shows and Admin is granted. This renames the 10
-- report keys; the existing role_menu_action grants reference the row by id, so
-- they are PRESERVED (no re-grant needed).
--
-- ⚠️ LEGACY-SAFE — this touches ONLY the per-report keys (…View suffix). It does
-- NOT touch:
--   • the family button key `ef-QuickSight` (no View suffix — the New CRM button),
--   • the legacy `isQuicksight` (lowercase 's') Home button key, or
--   • tbl_menu row 59 (Legacy's external redirect URL).
-- Legacy QuickSight (button via `isQuicksight` + redirect via tbl_menu 59) is
-- completely unaffected. Idempotent: once renamed, the WHERE matches nothing.
--
-- (Supersedes the pending 2026-06-14-seed-quicksight-reports.sql FOR PROD, where
-- the keys already exist under the ef- prefix. On a fresh DB run that seed
-- instead; running both is harmless — the seed's NOT EXISTS guards skip the
-- already-renamed rows.)
UPDATE menu_action
   SET action_name = REPLACE(action_name, 'ef-QuickSight', 'isQuickSight')
 WHERE action_name LIKE 'ef-QuickSight%View';

-- ── Re-home the 10 report keys onto the Home menu (DURABLE fix). ─────────────
-- Prod seeded them on menu_id 59 (the LEGACY "EF-Quicksight" redirect menu),
-- but the New-CRM button key `ef-QuickSight` lives on menu_id 1 (Home). The
-- Manage-Role editor only renders menus in the role's menu_ids and saves via a
-- blanket soft-delete + re-grant of the SUBMITTED set (role.service.js
-- applyMenuActionIds) — so any Admin-role save drops the menu-59 report keys
-- (they're never rendered/submitted) and re-soft-deletes them. Colocating them
-- with the button on Home makes them render, grantable, and save-stable.
--
-- ⚠️ LEGACY-SAFE: this changes ONLY menu_action.menu_id for the New-CRM-native
-- is-prefixed report keys. It does NOT touch tbl_menu (row 59's redirect URL
-- stays), does NOT touch tbl_role.menu_ids, and leaves the legacy `isQuicksight`
-- (id 40) on menu 59 — the Legacy QuickSight flow is unaffected. Idempotent.
-- (Targets the Home menu by following the button key, so it works regardless of
--  the literal Home menu_id on this DB.)
UPDATE menu_action
   SET menu_id = (SELECT menu_id FROM (
                    SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1
                  ) AS home)
 WHERE action_name LIKE 'isQuickSight%View'
   AND menu_id <> (SELECT menu_id FROM (
                    SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' LIMIT 1
                  ) AS home2);

-- ── Restore the SOFT-DELETED per-report grants for Admin (role 2). ───────────
-- role_menu_action 159–168 (the 10 report grants) are isDeleted=1, so
-- _loadEffectivePermissions (WHERE rma.isDeleted=0) drops them → the report
-- cards stay hidden even though the button (grant 181, isDeleted=0) shows.
-- Re-activate them. Idempotent. (Run AFTER the re-home above; the re-home keeps
-- future role-saves from re-wiping these.)
UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (
     SELECT id FROM menu_action WHERE action_name LIKE 'isQuickSight%View'
   );

-- Verify A — the 10 keys are is-prefixed:
SELECT id, action_name, name, menu_id
  FROM menu_action
 WHERE action_name LIKE 'isQuickSight%View'
 ORDER BY id;

-- Verify B — Admin now has 10 ACTIVE report grants (isDeleted=0):
SELECT ma.action_name, rma.isDeleted
  FROM role_menu_action rma
  JOIN menu_action ma ON ma.id = rma.menu_action_id
 WHERE rma.role_id = 2 AND ma.action_name LIKE 'isQuickSight%View'
 ORDER BY ma.action_name;
