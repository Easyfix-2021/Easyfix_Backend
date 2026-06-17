-- ============================================================================
-- Add "Manage Zones" sub-menu under Settings in the sidebar (tbl_menu).
--
-- Why:
--   The new /settings/zones page is the canonical zone management surface
--   (CRUD + city mapping + bulk Excel upload/download). The sidebar reads
--   from tbl_menu, so without a row here the link doesn't appear under
--   Settings. The frontend URL_MAP in src/components/layout/Sidebar.tsx
--   already maps url='manageZones' → /settings/zones.
--
-- This is SEPARATE from the EasyFixer Zones row added earlier
-- (db/migrations/2026_04_21_add_easyfixer_zones_menu.sql) which routes to
-- /easyfixers/zones (the legacy read-only browse view). Both menu items
-- coexist — they serve different mental models.
--
-- Run on:  easyfix_core (shared MySQL DB, port 3306)
-- Idempotent: re-runs are safe; the INSERT is guarded by NOT EXISTS on
--             (parent_menu, menu_name).
-- ============================================================================

-- 1. Resolve the Settings parent menu_id at runtime.
SET @settings_parent_id := (
  SELECT menu_id
    FROM tbl_menu
   WHERE menu_name = 'Settings'
     AND (parent_menu IS NULL OR parent_menu = 0)
   ORDER BY menu_id ASC
   LIMIT 1
);

-- Sanity check — abort with a readable error if the parent isn't found
-- instead of inserting an orphan row that would silently disappear.
SELECT IF(
  @settings_parent_id IS NULL,
  CAST('ERROR: Settings parent menu not found in tbl_menu — confirm seed before re-running' AS UNSIGNED),
  1
) AS ok;

-- 2. Pick the next sequence number under the Settings parent so the new
--    item appears at the bottom of the existing children.
SET @next_seq := (
  SELECT COALESCE(MAX(sequence), 0) + 1
    FROM tbl_menu
   WHERE parent_menu = @settings_parent_id
);

-- 3. Insert. icons mirrors the lucide MapPin used in the Settings sidebar
--    section. action_name preserved for legacy CRM parity.
INSERT INTO tbl_menu
  (menu_name, parent_menu, menu_depth, has_child, url, icons, sequence, menu_status, action_name)
SELECT
  'Manage Zones',
  @settings_parent_id,
  2,
  0,
  'manageZones',          -- legacy URL key — front-end URL_MAP resolves to /settings/zones
  'fa fa-map-marker',
  @next_seq,
  1,
  'EasyfixerAction'
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM tbl_menu
   WHERE parent_menu = @settings_parent_id
     AND menu_name   = 'Manage Zones'
);

-- 4. Verify
SELECT menu_id, menu_name, parent_menu, sequence, url, menu_status
  FROM tbl_menu
 WHERE parent_menu = @settings_parent_id
 ORDER BY sequence;
