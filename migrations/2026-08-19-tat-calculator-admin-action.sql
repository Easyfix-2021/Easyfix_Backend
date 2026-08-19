-- ============================================================================
-- 2026-08-19 — Admin Actions → TAT Calculator
--
-- Seeds the RBAC + reachability artifacts for the segment-wise TAT preview
-- page. Read-only feature: ONE action key (View). There is no Edit key because
-- there is nothing to edit — the page computes and displays, it never writes.
--
-- Creates, in one idempotent pass:
--   1. tbl_menu leaf  url='tatCalculator'  under the Settings parent
--   2. menu_action    isTatCalculatorView
--   3. Admin (role_id = 2) grants: the leaf CSV + the action
--   4. new.crm.visible.menu.ids — appends the new leaf id
--
-- STEP 4 IS NOT OPTIONAL. services/lookup.service.js filters the sidebar
-- through the new.crm.visible.menu.ids allowlist, and the CRM_UI Next.js
-- middleware redirects any menu url NOT on that list to /coming-soon. Seeding
-- the menu row without appending its id ships a page nobody can reach.
--
-- COMPANION FE EDIT (same PR, not optional): add
--   'tatCalculator': '/admin-actions/tat-calculator'
-- to Easyfix_CRM_UI/src/lib/legacy-url-map.ts. A slug missing from URL_MAP
-- routes the sidebar item to /coming-soon regardless of what this file does.
--
-- IDEMPOTENT. Every write is NOT EXISTS / FIND_IN_SET guarded, so a second run
-- is a no-op.
-- ============================================================================

-- ─── 1. Menu leaf ───────────────────────────────────────────────────
-- "Admin Action" is itself a depth-2 leaf under Settings (url 'adminAction'),
-- and Sidebar.buildTree() flattens depth-3 grandchildren into their nearest
-- top-level parent — so a child of adminAction would render under Settings
-- anyway. Seeding directly under Settings keeps the tree honest. The page is
-- ALSO surfaced as a tile on the /admin-actions hub.
SET @settings_parent_id := (SELECT menu_id FROM tbl_menu
                             WHERE menu_name = 'Settings'
                               AND (parent_menu IS NULL OR parent_menu = 0)
                             ORDER BY menu_id ASC LIMIT 1);

SELECT IF(@settings_parent_id IS NULL,
          CAST('ERROR: Settings parent menu not found in tbl_menu' AS UNSIGNED),
          1) AS settings_parent_ok;

-- next_seq comes from a derived table so the aggregate is materialised before
-- the INSERT touches tbl_menu. Guarded on url so a re-run cannot double-insert
-- and so the slug the FE URL_MAP keys on stays unique across the whole table.
INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, icons, sequence, menu_status, action_name)
SELECT 'TAT Calculator', @settings_parent_id, 2, 0, 'tatCalculator', 'fa fa-clock-o', seq.next_seq, 1, 'JobAction'
  FROM (SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM tbl_menu WHERE parent_menu = @settings_parent_id) AS seq
 WHERE @settings_parent_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM tbl_menu m WHERE m.url = 'tatCalculator');

-- ─── 2. Action key ──────────────────────────────────────────────────
-- View only. An action_name that does not EXIST in menu_action is
-- indistinguishable from one that was revoked, and hasAction() fails CLOSED
-- with no Admin bypass — so this row is what makes the page visible at all.
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isTatCalculatorView', 'View TAT Calculator', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'tatCalculator'
   AND NOT EXISTS (SELECT 1 FROM menu_action ma WHERE ma.action_name = 'isTatCalculatorView');

-- ─── 3a. Admin role gets the leaf ───────────────────────────────────
-- CASE keeps a repeated run byte-for-byte stable and handles NULL/empty CSV.
UPDATE tbl_role r
  JOIN tbl_menu m ON m.url = 'tatCalculator'
   SET r.menu_ids = CASE
     WHEN r.menu_ids IS NULL OR r.menu_ids = '' THEN CAST(m.menu_id AS CHAR)
     WHEN FIND_IN_SET(m.menu_id, r.menu_ids) > 0 THEN r.menu_ids
     ELSE CONCAT(r.menu_ids, ',', m.menu_id)
   END
 WHERE r.role_id = 2;

-- ─── 3b. Admin role gets the action (revive, then insert) ───────────
-- Revive first: role_menu_action soft-deletes, so a row previously revoked from
-- the Manage Roles screen must be un-deleted rather than re-inserted (the
-- INSERT below would skip it and the grant would stay dead).
UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isTatCalculatorView');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isTatCalculatorView'
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma
                    WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

-- ─── 4. Make the leaf reachable in the new CRM ──────────────────────
-- Append-only, FIND_IN_SET guarded. If the property row is ABSENT the allowlist
-- is inactive entirely (resolveVisibleMenuIds returns null = show everything),
-- so there is deliberately no INSERT here — creating the key would switch the
-- filter ON for a whole environment as a side effect of this migration.
UPDATE easyfix_properties p
  JOIN tbl_menu m ON m.url = 'tatCalculator'
   SET p.property_value = CASE
     WHEN p.property_value IS NULL OR p.property_value = '' THEN CAST(m.menu_id AS CHAR)
     WHEN FIND_IN_SET(m.menu_id, p.property_value) > 0 THEN p.property_value
     ELSE CONCAT(p.property_value, ',', m.menu_id)
   END
 WHERE p.property_key = 'new.crm.visible.menu.ids';

-- ─── Verification ───────────────────────────────────────────────────
-- One row per artifact. EVERY `present` value must be exactly 1, on the first
-- run and on any repeat run.
SELECT 'tatCalculator menu leaf' AS what, COUNT(*) AS present
  FROM tbl_menu WHERE url = 'tatCalculator'
UNION ALL
SELECT 'leaf sits under Settings', COUNT(*)
  FROM tbl_menu c
  JOIN tbl_menu p ON p.menu_id = c.parent_menu
 WHERE c.url = 'tatCalculator' AND p.menu_name = 'Settings'
UNION ALL
SELECT 'isTatCalculatorView action', COUNT(*)
  FROM menu_action WHERE action_name = 'isTatCalculatorView'
UNION ALL
SELECT 'Admin menu grant', COUNT(*)
  FROM tbl_role r
  JOIN tbl_menu m ON m.url = 'tatCalculator'
 WHERE r.role_id = 2 AND FIND_IN_SET(m.menu_id, COALESCE(r.menu_ids, '')) > 0
UNION ALL
SELECT 'Admin isTatCalculatorView grant', COUNT(*)
  FROM role_menu_action rma
  JOIN menu_action ma ON ma.id = rma.menu_action_id
 WHERE rma.role_id = 2 AND rma.isDeleted = 0 AND ma.action_name = 'isTatCalculatorView'
UNION ALL
-- 1 when the allowlist property is absent (filter inactive = page reachable)
-- OR present AND containing the new leaf. 0 means the page is unreachable.
SELECT 'new CRM menu visibility', COUNT(*)
  FROM (SELECT 1 AS ok
          FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'new.crm.visible.menu.ids')
        UNION ALL
        SELECT 1
          FROM easyfix_properties p
          JOIN tbl_menu m ON m.url = 'tatCalculator'
         WHERE p.property_key = 'new.crm.visible.menu.ids'
           AND FIND_IN_SET(m.menu_id, COALESCE(p.property_value, '')) > 0) v;
