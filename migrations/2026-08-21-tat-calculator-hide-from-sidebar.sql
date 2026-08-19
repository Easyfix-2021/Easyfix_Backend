-- ============================================================================
-- 2026-08-21 — TAT Calculator: hide the sidebar entry, keep the RBAC key
--
-- The 2026-08-19 migration seeded a tbl_menu leaf so the page would have a
-- menu_action to hang `isTatCalculatorView` off. Side effect: it also rendered
-- as a root-level item under Settings. It should be reachable ONLY as a card on
-- the Admin Actions hub, like Validate Flows and Build Skill Matrix.
--
-- FIX: menu_status = 0 on the leaf. Nothing else changes.
--
-- ── Why menu_status, and NOT removing the id from the visibility allowlist ──
--
-- Both hide the sidebar item, but only one of them keeps the page reachable.
--
--   services/lookup.service.js menuVisibility() selects
--       SELECT menu_id, url FROM tbl_menu WHERE menu_status = 1
--   and returns every row whose id is NOT in `new.crm.visible.menu.ids` as a
--   HIDDEN legacy url. The CRM_UI Next.js middleware redirects any request
--   whose pathname matches a hidden url to /coming-soon.
--
--   So dropping the id from the allowlist while leaving menu_status = 1 would
--   hide the sidebar item AND redirect /admin-actions/tat-calculator to
--   /coming-soon — breaking the hub card, which is the one way in we want.
--
--   menu_status = 0 removes the row from that query entirely, so it is neither
--   visible nor hidden: no sidebar entry, no redirect. The allowlist entry the
--   2026-08-19 migration appended becomes inert and is deliberately left in
--   place — it is harmless, and it is already correct if the leaf is ever
--   re-activated.
--
-- ── What deliberately survives ──────────────────────────────────────────────
--
--   menu_action isTatCalculatorView — role.service.js getEffectivePermissions
--     joins role_menu_action → menu_action ONLY. It never touches tbl_menu, so
--     the action key resolves exactly as before.
--
--   The Manage Roles checkbox — lookup.service.js menuActions() LEFT JOINs
--     tbl_menu and filters on ma.status / ma.delete_status, NOT menu_status. The
--     checkbox stays listed and still groups under its parent's name, so the
--     permission remains grantable from the UI.
--
--   The role grants (tbl_role.menu_ids + role_menu_action) — untouched.
--
-- IDEMPOTENT. Re-running is a no-op.
-- ============================================================================

UPDATE tbl_menu SET menu_status = 0 WHERE url = 'tatCalculator';

-- ─── Verification ───────────────────────────────────────────────────
-- Expected: leaf hidden = 1 · action key intact = 1 · admin grant intact = 1
SELECT 'leaf hidden from sidebar' AS what, COUNT(*) AS present
  FROM tbl_menu WHERE url = 'tatCalculator' AND menu_status = 0
UNION ALL
SELECT 'isTatCalculatorView action still exists', COUNT(*)
  FROM menu_action WHERE action_name = 'isTatCalculatorView'
UNION ALL
SELECT 'Admin still granted the action', COUNT(*)
  FROM role_menu_action rma
  JOIN menu_action ma ON ma.id = rma.menu_action_id
 WHERE rma.role_id = 2 AND rma.isDeleted = 0 AND ma.action_name = 'isTatCalculatorView';
