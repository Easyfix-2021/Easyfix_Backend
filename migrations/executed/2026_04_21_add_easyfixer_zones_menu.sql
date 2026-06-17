-- ============================================================================
-- Add "Zones" sub-menu under EasyFixers in the sidebar (tbl_menu).
--
-- Why this exists:
--   The /easyfixers/zones page already lives in Easyfix_CRM_UI and the
--   zone.service.js backend is wired, but the sidebar is DB-driven from
--   tbl_menu — without a row here, the link never renders. Front-end
--   URL_MAP already maps the legacy URL key 'manageZones' →
--   /easyfixers/zones (see src/components/layout/Sidebar.tsx).
--
-- Run on:  easyfix_core (the shared MySQL DB, port 3306)
-- Idempotent: re-running this script is safe — it INSERT-IGNOREs by
--             (parent_menu, menu_name) pair.
-- ============================================================================

-- 1. Resolve the EasyFixers parent menu_id at runtime — different envs
--    were seeded with different IDs, so don't hard-code.
SET @easyfixer_parent_id := (
  SELECT menu_id
    FROM tbl_menu
   WHERE menu_name = 'EasyFixers'
     AND (parent_menu IS NULL OR parent_menu = 0)
   ORDER BY menu_id ASC
   LIMIT 1
);

-- Sanity check — abort with a readable error if the parent isn't found
-- instead of inserting an orphan row that would silently disappear.
SELECT IF(
  @easyfixer_parent_id IS NULL,
  CAST('ERROR: EasyFixers parent menu not found in tbl_menu — confirm seed before re-running' AS UNSIGNED),
  1
) AS ok;

-- 2. Pick the next sequence number under the EasyFixers parent so the new
--    item appears at the bottom of the existing children.
SET @next_seq := (
  SELECT COALESCE(MAX(sequence), 0) + 1
    FROM tbl_menu
   WHERE parent_menu = @easyfixer_parent_id
);

-- 3. Insert the Zones row. menu_status = 1 → visible immediately.
--    has_child = 0 (leaf), menu_depth = 2 (child of a top-level item).
--    icons = 'fa fa-map-marker' to match the lucide MapPin used in the new UI.
INSERT INTO tbl_menu
  (menu_name, parent_menu, menu_depth, has_child, url, icons, sequence, menu_status)
SELECT
  'Zones',
  @easyfixer_parent_id,
  2,
  0,
  'manageZones',          -- legacy URL key — front-end URL_MAP resolves to /easyfixers/zones
  'fa fa-map-marker',
  @next_seq,
  1
FROM DUAL
WHERE NOT EXISTS (
  -- Idempotency guard — if a row with the same name already lives under
  -- the EasyFixers parent, do nothing.
  SELECT 1 FROM tbl_menu
   WHERE parent_menu = @easyfixer_parent_id
     AND menu_name   = 'Zones'
);

-- 4. Verify
SELECT menu_id, menu_name, parent_menu, sequence, url, menu_status
  FROM tbl_menu
 WHERE parent_menu = @easyfixer_parent_id
 ORDER BY sequence;
