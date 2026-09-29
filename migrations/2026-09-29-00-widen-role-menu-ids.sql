-- ============================================================================
-- 2026-09-29 — widen tbl_role.menu_ids (VARCHAR(255) -> VARCHAR(2000))
--
-- WHAT: tbl_role.menu_ids is the CSV of menu ids a role sees in the sidebar.
-- WHY:  At 255 chars the Admin role's list was FULL on QA ("…89,90,91," —
--       exactly 255). Appending a menu id (2026-09-29-ops-desk-jobs-menu.sql's
--       grant, or ticking a new menu in Manage Roles) was silently truncated in
--       non-strict mode: no error, no grant. Any role given many menus hits it.
-- SAFE: widening only — no data change; the legacy Java CRM maps it as String.
-- ORDER: sorts BEFORE 2026-09-29-ops-desk-jobs-menu.sql on purpose, so the
--       Ops Desk grant has room when both run on a fresh environment.
-- ============================================================================

ALTER TABLE tbl_role MODIFY menu_ids VARCHAR(2000) NULL DEFAULT NULL;
