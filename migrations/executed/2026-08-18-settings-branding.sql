-- ============================================================================
-- 2026-08-18 — Settings → Theme & Branding
--
-- Creates, in one idempotent pass:
--   1. easyfix_theme_variant       — festival / seasonal theme windows
--   2. tbl_menu leaf url='branding' under the Settings parent
--   3. menu_action isBrandingView + isBrandingEdit
--   4. Admin (role_id = 2) grants: the leaf CSV + both actions
--   5. new.crm.visible.menu.ids    — appends the new leaf id
--   6. easyfix_properties          — branding.ai.emails       (EMPTY = deny-all)
--                                    branding.festival.enabled ('true')
--
-- Run on: easyfix_core (shared MySQL DB, port 3306)
--
-- SCHEMA POLICY. easyfix_theme_variant is a brand-new EasyFix-OWNED table that
-- no legacy service references — the explicit exception CLAUDE.md carves out of
-- the "never add tables" rule (same playbook as tbl_pincode / tbl_notice /
-- easyfix_properties). Nothing existing is altered.
--
-- STEP 5 IS NOT OPTIONAL. services/lookup.service.js filters the sidebar
-- through the new.crm.visible.menu.ids allowlist, and the CRM_UI Next.js
-- middleware redirects any menu url NOT on that list to /coming-soon. Seeding
-- the menu row without appending its id ships a page nobody can reach.
--
-- IDEMPOTENT. Every write is NOT EXISTS / FIND_IN_SET / INSERT IGNORE guarded,
-- so a second run is a no-op. The two property seeds deliberately use
-- INSERT IGNORE rather than ON DUPLICATE KEY UPDATE: re-running this file must
-- NEVER reset an operator-edited AI allowlist or undo an ops kill-switch flip.
-- ============================================================================

-- ─── 1. Theme variants ──────────────────────────────────────────────
-- One row = one dated branding window (Diwali, Holi, Republic Day, …).
-- anchor_x / anchor_y / scale are percentages the FE applies to the ornament
-- overlay; `animated` toggles motion for reduced-motion-friendly variants.
-- The composite index matches the only hot query — the public active lookup:
--   WHERE enabled = 1 AND CURDATE() BETWEEN starts_on AND ends_on.
CREATE TABLE IF NOT EXISTS easyfix_theme_variant (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  ornament_key VARCHAR(255) NULL,
  anchor_x DECIMAL(6,2) NOT NULL DEFAULT 50,
  anchor_y DECIMAL(6,2) NOT NULL DEFAULT 0,
  scale DECIMAL(6,2) NOT NULL DEFAULT 100,
  animated TINYINT(1) NOT NULL DEFAULT 1,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at DATETIME NOT NULL,
  INDEX idx_variant_window (enabled, starts_on, ends_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 2. Sidebar leaf: Settings → Theme & Branding ───────────────────
-- Same @settings_parent_id lookup the Manage Cities migration uses; it is the
-- one session variable in this file.
SET @settings_parent_id := (SELECT menu_id FROM tbl_menu WHERE menu_name = 'Settings' AND (parent_menu IS NULL OR parent_menu = 0) ORDER BY menu_id ASC LIMIT 1);

SELECT IF(@settings_parent_id IS NULL, CAST('ERROR: Settings parent menu not found in tbl_menu' AS UNSIGNED), 1) AS settings_parent_ok;

-- next_seq comes from a derived table so the aggregate is materialised before
-- the INSERT touches tbl_menu. Guarded on url so a re-run cannot double-insert
-- and so the slug the FE URL_MAP keys on stays unique across the whole table.
INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, icons, sequence, menu_status, action_name)
SELECT 'Theme & Branding', @settings_parent_id, 2, 0, 'branding', 'fa fa-paint-brush', seq.next_seq, 1, 'EasyfixerAction'
  FROM (SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM tbl_menu WHERE parent_menu = @settings_parent_id) AS seq
 WHERE @settings_parent_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM tbl_menu m WHERE m.url = 'branding');

-- ─── 3. Action permissions ──────────────────────────────────────────
-- Split View from Edit: the banner/tagline copy and the festival calendar are
-- worth showing to any operator who needs to know what the CRM is advertising,
-- while every write (and the S3 ornament upload) stays behind Edit.
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isBrandingView', 'View Theme & Branding', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'branding'
   AND NOT EXISTS (SELECT 1 FROM menu_action ma WHERE ma.action_name = 'isBrandingView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isBrandingEdit', 'Manage Theme & Branding', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'branding'
   AND NOT EXISTS (SELECT 1 FROM menu_action ma WHERE ma.action_name = 'isBrandingEdit');

-- ─── 4a. Admin role gets the leaf ───────────────────────────────────
-- CASE keeps a repeated run byte-for-byte stable and handles NULL/empty CSV.
UPDATE tbl_role r
  JOIN tbl_menu m ON m.url = 'branding'
   SET r.menu_ids = CASE
     WHEN r.menu_ids IS NULL OR r.menu_ids = '' THEN CAST(m.menu_id AS CHAR)
     WHEN FIND_IN_SET(m.menu_id, r.menu_ids) > 0 THEN r.menu_ids
     ELSE CONCAT(r.menu_ids, ',', m.menu_id)
   END
 WHERE r.role_id = 2;

-- ─── 4b. Admin role gets both actions (revive, then insert) ─────────
-- Revive first: role_menu_action soft-deletes, so a row previously revoked from
-- the Manage Role screen must be un-deleted rather than re-inserted (the INSERT
-- below would skip it and the grant would stay dead).
UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name IN ('isBrandingView', 'isBrandingEdit'));

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name IN ('isBrandingView', 'isBrandingEdit')
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

-- ─── 5. Make the leaf reachable in the new CRM ──────────────────────
-- Append-only, FIND_IN_SET guarded. If the property row is ABSENT the allowlist
-- is inactive entirely (resolveVisibleMenuIds returns null = show everything),
-- so there is deliberately no INSERT here — creating the key would switch the
-- filter ON for a whole environment as a side effect of this migration.
UPDATE easyfix_properties p
  JOIN tbl_menu m ON m.url = 'branding'
   SET p.property_value = CASE
     WHEN p.property_value IS NULL OR p.property_value = '' THEN CAST(m.menu_id AS CHAR)
     WHEN FIND_IN_SET(m.menu_id, p.property_value) > 0 THEN p.property_value
     ELSE CONCAT(p.property_value, ',', m.menu_id)
   END
 WHERE p.property_key = 'new.crm.visible.menu.ids';

-- ─── 6. Feature properties ──────────────────────────────────────────
-- branding.ai.emails — per-user allowlist for AI ornament generation
-- (FEATURES.canGenerateBrandArt). Seeded EMPTY = deny-all: parseEmailAllowlist
-- returns an empty Set for a blank value and every allowlist gate fails CLOSED.
INSERT IGNORE INTO easyfix_properties (property_key, property_value) VALUES ('branding.ai.emails', '');

-- branding.festival.enabled — global kill switch for the public festival theme.
-- 'false' makes GET /api/public/branding/active return {variant:null} without
-- touching a single row, which is what you want at 2am when an ornament renders
-- wrong on the login page.
INSERT IGNORE INTO easyfix_properties (property_key, property_value) VALUES ('branding.festival.enabled', 'true');

-- ─── Verification ───────────────────────────────────────────────────
-- One row per artifact. EVERY `present` value must be exactly 1, on the first
-- run and on any repeat run.
SELECT 'easyfix_theme_variant table' AS what, COUNT(*) AS present
  FROM INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'easyfix_theme_variant'
UNION ALL
SELECT 'idx_variant_window index', COUNT(DISTINCT INDEX_NAME)
  FROM INFORMATION_SCHEMA.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'easyfix_theme_variant' AND INDEX_NAME = 'idx_variant_window'
UNION ALL
SELECT 'branding menu leaf', COUNT(*)
  FROM tbl_menu WHERE url = 'branding'
UNION ALL
SELECT 'branding leaf under Settings', COUNT(*)
  FROM tbl_menu c
  JOIN tbl_menu p ON p.menu_id = c.parent_menu
 WHERE c.url = 'branding' AND p.menu_name = 'Settings'
UNION ALL
SELECT 'isBrandingView action', COUNT(*)
  FROM menu_action WHERE action_name = 'isBrandingView'
UNION ALL
SELECT 'isBrandingEdit action', COUNT(*)
  FROM menu_action WHERE action_name = 'isBrandingEdit'
UNION ALL
SELECT 'Admin branding menu grant', COUNT(*)
  FROM tbl_role r
  JOIN tbl_menu m ON m.url = 'branding'
 WHERE r.role_id = 2 AND FIND_IN_SET(m.menu_id, COALESCE(r.menu_ids, '')) > 0
UNION ALL
SELECT 'Admin isBrandingView grant', COUNT(*)
  FROM role_menu_action rma
  JOIN menu_action ma ON ma.id = rma.menu_action_id
 WHERE rma.role_id = 2 AND rma.isDeleted = 0 AND ma.action_name = 'isBrandingView'
UNION ALL
SELECT 'Admin isBrandingEdit grant', COUNT(*)
  FROM role_menu_action rma
  JOIN menu_action ma ON ma.id = rma.menu_action_id
 WHERE rma.role_id = 2 AND rma.isDeleted = 0 AND ma.action_name = 'isBrandingEdit'
UNION ALL
-- Passes both ways: allowlist OFF (property absent → every menu is visible) or
-- allowlist ON with the new id appended.
SELECT 'branding leaf reachable in new CRM', COUNT(*)
  FROM tbl_menu m
 WHERE m.url = 'branding'
   AND (
     NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'new.crm.visible.menu.ids')
     OR EXISTS (SELECT 1 FROM easyfix_properties p WHERE p.property_key = 'new.crm.visible.menu.ids' AND FIND_IN_SET(m.menu_id, COALESCE(p.property_value, '')) > 0)
   )
UNION ALL
SELECT 'branding.ai.emails property', COUNT(*)
  FROM easyfix_properties WHERE property_key = 'branding.ai.emails'
UNION ALL
SELECT 'branding.festival.enabled property', COUNT(*)
  FROM easyfix_properties WHERE property_key = 'branding.festival.enabled';
