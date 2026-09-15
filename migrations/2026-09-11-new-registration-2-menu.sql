-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-11 — "New Registration 2" sidebar leaf (revamped Easyfixer
-- List → Profile experience). Pairs with Easyfix_CRM_UI branch
-- `feature/new-registration-2` (route /easyfixers/new-registration-2).
--
-- THREE ARTIFACTS HERE + ONE ALREADY IN THE CRM
--   1. tbl_menu leaf                              — this file
--   2. sidebar visibility: tbl_role.menu_ids CSV  — this file
--   3. new.crm.visible.menu.ids allowlist         — this file (update-only)
--   4. URL_MAP entry in Easyfix_CRM_UI
--      src/lib/legacy-url-map.ts ('newRegistration2' →
--      '/easyfixers/new-registration-2')          — ALREADY SHIPPED on the
--      CRM branch. Without it the link falls through to /coming-soon.
--
--   No menu_action key is needed: the page is a VIEW. Its in-page actions
--   (status transition, bank update, mobile update, deep-skill edit) reuse
--   the EXISTING action permissions (isEasyfixerBankUpdate,
--   isEasyfixerMobileUpdate, lifecycle transition perms) via the existing
--   dialogs — this migration only makes the page reachable.
--
-- SIBLINGS, NOT CHILDREN
--   Sidebar.tsx::buildTree() flattens to a hard two levels, so this leaf is
--   added as a SIBLING of "Manage EasyFixers" under the same parent — never
--   nested under it. Parent + depth + sequence are copied from the existing
--   'easyfixer' leaf so it lands right beside it, in whichever parent group
--   that leaf lives in (resolved by url, never a hard-coded menu_id — ids
--   differ between QA and production).
--
-- GRANTED TO ADMIN ONLY (role_id 2)
--   New flows start with Admin, as the LMS / rewards menu migrations do.
--   Other roles are granted later from Manage Roles in the CRM UI.
--
-- POST-APPLY
--   Role menu_ids are cached server-side for up to 5 minutes, so the leaf can
--   take that long to appear. The CRM properties cache
--   (new.crm.visible.menu.ids) has a 1-hour TTL; use the admin
--   properties-reload endpoint (or the 10-click flush) for it to take effect
--   immediately.
--
-- IDEMPOTENCY  Fully re-runnable — every statement is guarded (NOT EXISTS /
--   FIND_IN_SET), so a re-run never duplicates a row or clobbers ops edits.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. The leaf (sibling of Manage EasyFixers) ──────────────────────
INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'New Registration 2', e.parent_menu, e.menu_depth, 0, 'newRegistration2', 1, e.sequence + 0.0005, 'fa-id-badge', 'newRegistration2'
  FROM tbl_menu e
 WHERE e.url = 'easyfixer'
   AND NOT EXISTS (SELECT 1 FROM tbl_menu c WHERE c.url = 'newRegistration2')
 ORDER BY e.menu_status DESC, e.menu_id
 LIMIT 1;


-- ─── 2. Sidebar visibility — Admin only (role_id 2) ──────────────────
UPDATE tbl_role r
  JOIN tbl_menu nm ON nm.url = 'newRegistration2'
   SET r.menu_ids = CONCAT(COALESCE(r.menu_ids, ''), IF(r.menu_ids IS NULL OR r.menu_ids = '', '', ','), nm.menu_id)
 WHERE r.role_id = 2
   AND NOT FIND_IN_SET(nm.menu_id, REPLACE(COALESCE(r.menu_ids, ''), ' ', ''));


-- ─── 3. CRM visible-menu allowlist (append-only; no INSERT of the key) ─
-- If the key is absent the allowlist is inactive (every menu shows), so we
-- never create it here — that would switch filtering ON environment-wide as
-- a side effect. We only extend it when it already exists.
UPDATE easyfix_properties p
  JOIN tbl_menu m ON m.url = 'newRegistration2'
   SET p.property_value = CONCAT(COALESCE(p.property_value, ''), IF(p.property_value IS NULL OR p.property_value = '', '', ','), m.menu_id)
 WHERE p.property_key = 'new.crm.visible.menu.ids'
   AND NOT FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''));


-- ─── 4. Verify (read-only) ───────────────────────────────────────────
SELECT 'menu leaf newRegistration2' AS what, COUNT(*) AS present FROM tbl_menu WHERE url = 'newRegistration2'
UNION ALL
SELECT 'Admin role (role_id 2) sees it', COUNT(*)
  FROM tbl_role r JOIN tbl_menu nm ON nm.url = 'newRegistration2'
 WHERE r.role_id = 2 AND FIND_IN_SET(nm.menu_id, REPLACE(COALESCE(r.menu_ids, ''), ' ', ''))
UNION ALL
SELECT 'allowlist carries it (0 = allowlist inactive, also fine)', COUNT(*)
  FROM easyfix_properties p JOIN tbl_menu m ON m.url = 'newRegistration2'
 WHERE p.property_key = 'new.crm.visible.menu.ids' AND FIND_IN_SET(m.menu_id, COALESCE(p.property_value, ''));
