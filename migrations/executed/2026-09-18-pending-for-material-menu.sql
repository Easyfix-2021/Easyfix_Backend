-- =============================================================================
-- 2026-09-18 — "Pending for Material" sidebar entry under My Orders.
-- Material Management phase 2, sub-project D. See
-- docs/superpowers/specs/2026-09-18-pending-for-material-status-16-design.md.
--
-- WHY: the CRM already has the /my-orders?tab=pending-material tab, but the My
-- Orders sub-menu is DB-driven (tbl_menu rows with the legacy
-- `dashboardChecking?enumDesc=<value>` url, mapped to a Next.js route by
-- Easyfix_CRM_UI/src/lib/legacy-url-map.ts). Without a row the tab exists but
-- nothing links to it.
--
-- Shape copied from the sibling rows (menu_id 48-55, parent_menu 47 "My
-- Orders", menu_depth 2, action_name 'MyOrderAction', icons 'fa-angle-right').
-- sequence 3.0005 places it directly after "Pending to Close on App" and
-- before "Audit & Complete" — the lifecycle position of status 16, which a job
-- reaches FROM Pending to Close on App. It TIES with Pending to Close on
-- purpose: tbl_menu.sequence holds only 4 decimals (3.00055 rounds to 3.0006
-- and lands AFTER Audit), and the sidebar orders by sequence then menu_id, so a
-- tie with the lower-id row sorts this one immediately after it.
--
-- Idempotent: the INSERT is guarded by NOT EXISTS on the url, so a re-run is a
-- no-op.
--
-- ⚠️ AFTER THIS MIGRATION, the new menu_id must be added to the backend's
-- `NEW_CRM_VISIBLE_MENU_IDS` env allowlist on each environment (it is an env
-- var, not a DB row — see services/lookup.service.js applyMenuFilter). QA has
-- the allowlist ENABLED with 30 ids; a row missing from it is hidden from the
-- sidebar and direct navigation redirects to /coming-soon. Emails in
-- NEW_CRM_MENU_OVERRIDE_EMAILS bypass the allowlist and can verify before the
-- env change lands. The verify query at the bottom prints the id to add.
-- =============================================================================

-- ─── 1. The menu row ──────────────────────────────────────────────────────

INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'Pending for Material', 47, 2, 0, 'dashboardChecking?enumDesc=PendingForMaterial', 1, 3.0005, 'fa-angle-right', 'MyOrderAction'
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM tbl_menu WHERE url = 'dashboardChecking?enumDesc=PendingForMaterial');

-- Corrects a row seeded before the 4-decimal rounding was noticed (idempotent).
UPDATE tbl_menu SET sequence = 3.0005
 WHERE url = 'dashboardChecking?enumDesc=PendingForMaterial' AND sequence <> 3.0005;

-- ─── 2. Verify (read-only) — the id printed here goes into the env allowlist ─

SELECT menu_id, menu_name, parent_menu, url, sequence, menu_status
  FROM tbl_menu
 WHERE parent_menu = 47
 ORDER BY sequence;
