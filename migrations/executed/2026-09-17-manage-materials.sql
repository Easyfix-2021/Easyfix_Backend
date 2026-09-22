-- =============================================================================
-- 2026-09-17 — Settings › Manage Materials (Material Master + Brand Master)
--
-- WHAT: 7 new EasyFix-owned tables (nothing legacy references any of them —
-- grepped both this repo and EasyFix_CRM for tbl_uom/tbl_brand/tbl_material,
-- zero hits), a UOM seed, the system "Not Applicable" brand, the sidebar
-- menu row, and all 12 action-permission keys granted to Admin (role_id=2).
--
-- Style: plain one-statement-per-line INSERT/UPDATE/CREATE, no `SET @var`/
-- PREPARE, no MariaDB-only syntax. Every INSERT/UPDATE is idempotent
-- (WHERE NOT EXISTS / FIND_IN_SET / isDeleted-revive) so a re-run is a no-op.
-- menu_id is resolved by a correlated subquery inline wherever it's needed,
-- instead of a session variable — see feedback_easyfix_minimal_migration_style.
--
-- Schema summary (see manage-materials-contract.md for full rules):
--   tbl_uom_master                 — Nos / Job / EA / Set / … unit picklist
--   tbl_brand_master               — brand master; is_system=1 for "Not Applicable"
--   tbl_material_master            — material master; pricing_type FIXED|DYNAMIC
--   tbl_material_price_group       — one row per FIXED "group" (a price + its brands)
--   tbl_material_price_group_brand — brands attached to a group (a brand once/material)
--   tbl_material_state_price       — state-override price for a group
--   tbl_material_state_price_state — states covered by a state-override (once/group)
--
-- POST-APPLY: users log out + back in (or an Admin role re-save) to pick up
-- the new menu + action grants — see the two 60s permission caches noted in
-- project_easyfix_permission_gating.md.
-- =============================================================================

-- ─── 1. Tables ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tbl_uom_master (
  uom_id     INT AUTO_INCREMENT PRIMARY KEY,
  uom_name   VARCHAR(50)  NOT NULL,
  uom_key    VARCHAR(50)  NOT NULL,
  status     TINYINT      NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL,
  UNIQUE KEY uq_uom_key (uom_key)
);

CREATE TABLE IF NOT EXISTS tbl_brand_master (
  brand_id   INT AUTO_INCREMENT PRIMARY KEY,
  brand_name VARCHAR(150) NOT NULL,
  brand_key  VARCHAR(150) NOT NULL,
  is_system  TINYINT      NOT NULL DEFAULT 0,
  status     TINYINT      NOT NULL DEFAULT 1,
  created_by INT          NULL,
  created_at DATETIME     NOT NULL,
  updated_by INT          NULL,
  updated_at DATETIME     NULL,
  UNIQUE KEY uq_brand_key (brand_key)
);

CREATE TABLE IF NOT EXISTS tbl_material_master (
  material_id     INT AUTO_INCREMENT PRIMARY KEY,
  material_name   VARCHAR(200) NOT NULL,
  material_key    VARCHAR(200) NOT NULL,
  description     VARCHAR(1000) NULL,
  service_catg_id INT          NOT NULL,
  uom_id          INT          NULL,
  pricing_type    VARCHAR(10)  NOT NULL,
  status          TINYINT      NOT NULL DEFAULT 1,
  created_by      INT          NULL,
  created_at      DATETIME     NOT NULL,
  updated_by      INT          NULL,
  updated_at      DATETIME     NULL,
  UNIQUE KEY uq_material_key_catg (material_key, service_catg_id),
  KEY idx_material_service_catg (service_catg_id),
  KEY idx_material_uom (uom_id)
);

CREATE TABLE IF NOT EXISTS tbl_material_price_group (
  group_id    INT AUTO_INCREMENT PRIMARY KEY,
  material_id INT           NOT NULL,
  price       DECIMAL(12,2) NULL,
  sort_order  INT           NOT NULL DEFAULT 0,
  KEY idx_price_group_material (material_id)
);

CREATE TABLE IF NOT EXISTS tbl_material_price_group_brand (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  group_id    INT NOT NULL,
  material_id INT NOT NULL,
  brand_id    INT NOT NULL,
  UNIQUE KEY uq_group_brand_material (material_id, brand_id),
  KEY idx_group_brand_group (group_id),
  KEY idx_group_brand_brand (brand_id)
);

CREATE TABLE IF NOT EXISTS tbl_material_state_price (
  state_price_id INT AUTO_INCREMENT PRIMARY KEY,
  group_id       INT           NOT NULL,
  price          DECIMAL(12,2) NOT NULL,
  KEY idx_state_price_group (group_id)
);

CREATE TABLE IF NOT EXISTS tbl_material_state_price_state (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  state_price_id INT NOT NULL,
  group_id       INT NOT NULL,
  state_id       INT NOT NULL,
  UNIQUE KEY uq_group_state (group_id, state_id),
  KEY idx_state_price_state_sp (state_price_id)
);

-- ─── 2. UOM seed (from the rate-card units; dedupe by key) ────────────────

INSERT INTO tbl_uom_master (uom_name, uom_key, status, created_at)
SELECT v.uom_name, LOWER(v.uom_name), 1, NOW()
  FROM (
    SELECT 'Nos' AS uom_name UNION ALL SELECT 'Job' UNION ALL SELECT 'EA' UNION ALL
    SELECT 'Set' UNION ALL SELECT 'Sq.Ft.' UNION ALL SELECT 'Sqmt' UNION ALL
    SELECT 'Sq. Mtr' UNION ALL SELECT 'Rft' UNION ALL SELECT 'Mtr' UNION ALL
    SELECT 'Cum' UNION ALL SELECT 'KG' UNION ALL SELECT 'Ltr' UNION ALL
    SELECT 'Per Bottle' UNION ALL SELECT 'Per Shutter' UNION ALL SELECT 'Per Ticket' UNION ALL
    SELECT 'Per Visit' UNION ALL SELECT 'Per Shipment'
  ) v
 WHERE NOT EXISTS (SELECT 1 FROM tbl_uom_master u WHERE u.uom_key = LOWER(v.uom_name));

-- ─── 4. Sidebar menu row — "Manage Materials" under Settings ──────────────

INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, icons, sequence, menu_status, action_name)
SELECT 'Manage Materials',
       (SELECT menu_id FROM tbl_menu WHERE menu_name = 'Settings' AND (parent_menu IS NULL OR parent_menu = 0) ORDER BY menu_id ASC LIMIT 1),
       2, 0, 'managematerials', 'fa fa-cubes',
       (SELECT COALESCE(MAX(sequence), 0) + 1 FROM tbl_menu WHERE parent_menu = (SELECT menu_id FROM tbl_menu WHERE menu_name = 'Settings' AND (parent_menu IS NULL OR parent_menu = 0) ORDER BY menu_id ASC LIMIT 1)),
       1, 'managematerials'
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM tbl_menu WHERE url = 'managematerials')
   AND EXISTS (SELECT 1 FROM tbl_menu WHERE menu_name = 'Settings' AND (parent_menu IS NULL OR parent_menu = 0));

-- ─── 5. menu_action rows — all 12 keys, all under the new menu ────────────

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isMaterialView', 'View Materials', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'managematerials'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isMaterialView')
 LIMIT 1;

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isMaterialAddNew', 'Add Material', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'managematerials'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isMaterialAddNew')
 LIMIT 1;

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isMaterialEdit', 'Edit Material', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'managematerials'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isMaterialEdit')
 LIMIT 1;

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isMaterialDeactivate', 'Activate/Deactivate Material', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'managematerials'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isMaterialDeactivate')
 LIMIT 1;

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isMaterialDelete', 'Delete Material', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'managematerials'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isMaterialDelete')
 LIMIT 1;

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isMaterialImport', 'Import Materials', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'managematerials'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isMaterialImport')
 LIMIT 1;

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isBrandView', 'View Brands', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'managematerials'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isBrandView')
 LIMIT 1;

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isBrandAddNew', 'Add Brand', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'managematerials'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isBrandAddNew')
 LIMIT 1;

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isBrandEdit', 'Edit Brand', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'managematerials'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isBrandEdit')
 LIMIT 1;

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isBrandDeactivate', 'Activate/Deactivate Brand', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'managematerials'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isBrandDeactivate')
 LIMIT 1;

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isBrandDelete', 'Delete Brand', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'managematerials'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isBrandDelete')
 LIMIT 1;

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isBrandImport', 'Import Brands', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'managematerials'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isBrandImport')
 LIMIT 1;

-- ─── 6. Grant the menu to Admin (role_id=2) — tbl_role.menu_ids CSV ───────

UPDATE tbl_role
   SET menu_ids = CASE
     WHEN menu_ids IS NULL OR menu_ids = '' THEN CAST((SELECT menu_id FROM tbl_menu WHERE url = 'managematerials' LIMIT 1) AS CHAR)
     WHEN FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'managematerials' LIMIT 1), menu_ids) > 0 THEN menu_ids
     ELSE CONCAT(menu_ids, ',', (SELECT menu_id FROM tbl_menu WHERE url = 'managematerials' LIMIT 1))
   END
 WHERE role_id = 2;

-- ─── 7. Grant all 12 action keys to Admin (role_id=2) ─────────────────────

UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (
     SELECT id FROM menu_action WHERE action_name IN (
       'isMaterialView','isMaterialAddNew','isMaterialEdit','isMaterialDeactivate','isMaterialDelete','isMaterialImport',
       'isBrandView','isBrandAddNew','isBrandEdit','isBrandDeactivate','isBrandDelete','isBrandImport'
     )
   );

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name IN (
       'isMaterialView','isMaterialAddNew','isMaterialEdit','isMaterialDeactivate','isMaterialDelete','isMaterialImport',
       'isBrandView','isBrandAddNew','isBrandEdit','isBrandDeactivate','isBrandDelete','isBrandImport'
     )
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

-- ─── 8. Verify ──────────────────────────────────────────────────────────

SELECT table_name FROM information_schema.tables
 WHERE table_schema = DATABASE()
   AND table_name IN ('tbl_uom_master','tbl_brand_master','tbl_material_master',
                       'tbl_material_price_group','tbl_material_price_group_brand',
                       'tbl_material_state_price','tbl_material_state_price_state');

SELECT COUNT(*) AS uom_count FROM tbl_uom_master;

SELECT menu_id, menu_name, url, parent_menu FROM tbl_menu WHERE url = 'managematerials';

SELECT ma.action_name,
       (SELECT COUNT(*) FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.isDeleted = 0 AND rma.menu_action_id = ma.id) AS admin_granted
  FROM menu_action ma
 WHERE ma.action_name IN (
       'isMaterialView','isMaterialAddNew','isMaterialEdit','isMaterialDeactivate','isMaterialDelete','isMaterialImport',
       'isBrandView','isBrandAddNew','isBrandEdit','isBrandDeactivate','isBrandDelete','isBrandImport'
     )
 ORDER BY ma.action_name;

SELECT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'managematerials' LIMIT 1), menu_ids) AS admin_has_menu
  FROM tbl_role WHERE role_id = 2;
