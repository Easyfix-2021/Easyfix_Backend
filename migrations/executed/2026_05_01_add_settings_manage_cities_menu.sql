-- ============================================================================
-- Add "Manage Cities" sub-menu under Settings in the sidebar (tbl_menu).
--
-- Mirrors the pattern from the Manage Pincodes / Manage Zones menu rows.
-- The frontend URL_MAP in src/components/layout/Sidebar.tsx maps
--   url='manageCities' → /settings/cities.
-- The legacy CRM had url='city' as a coming-soon stub; we replace that with
-- the canonical key on the new app.
--
-- Run on:  easyfix_core (shared MySQL DB, port 3306)
-- Idempotent: NOT EXISTS guard on (parent_menu, menu_name).
-- ============================================================================

SET @settings_parent_id := (
  SELECT menu_id
    FROM tbl_menu
   WHERE menu_name = 'Settings'
     AND (parent_menu IS NULL OR parent_menu = 0)
   ORDER BY menu_id ASC
   LIMIT 1
);

SELECT IF(
  @settings_parent_id IS NULL,
  CAST('ERROR: Settings parent menu not found in tbl_menu' AS UNSIGNED),
  1
) AS ok;

SET @next_seq := (
  SELECT COALESCE(MAX(sequence), 0) + 1
    FROM tbl_menu
   WHERE parent_menu = @settings_parent_id
);

INSERT INTO tbl_menu
  (menu_name, parent_menu, menu_depth, has_child, url, icons, sequence, menu_status, action_name)
SELECT
  'Manage Cities',
  @settings_parent_id,
  2,
  0,
  'manageCities',
  'fa fa-building',
  @next_seq,
  1,
  'EasyfixerAction'
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM tbl_menu
   WHERE parent_menu = @settings_parent_id
     AND menu_name   = 'Manage Cities'
);

-- If a legacy 'city' coming-soon stub row exists, retire it so the new
-- Manage Cities link is the only entry. Idempotent.
UPDATE tbl_menu
   SET menu_status = 0
 WHERE parent_menu = @settings_parent_id
   AND url = 'city'
   AND menu_name <> 'Manage Cities';

SELECT menu_id, menu_name, parent_menu, sequence, url, menu_status
  FROM tbl_menu
 WHERE parent_menu = @settings_parent_id
 ORDER BY sequence;
