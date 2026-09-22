-- =============================================================================
-- 2026-09-18 — Client Material Rates (Material Management phase 2, sub-project C)
--
-- WHAT: 4 new EasyFix-owned tables mirroring the phase-1 material master shape
-- (tbl_material_price_group / _brand / tbl_material_state_price / _state),
-- scoped by client_id. The master tables are NOT modified — see
-- docs/superpowers/specs/2026-09-18-client-material-rates-design.md ("Data
-- model") for why a nullable client_id on the master tables was rejected.
--
-- Schema summary:
--   tbl_client_material_price_group       — one row per client "group" (a
--                                            price + its brands for one material)
--   tbl_client_material_price_group_brand — brands attached to a client group
--                                            (a brand once per client per material)
--   tbl_client_material_state_price       — state-override price for a client group
--   tbl_client_material_state_price_state — states covered by a state-override
--                                            (once per client group)
--
-- Style: one statement per line, CREATE TABLE IF NOT EXISTS, idempotent on
-- re-run, no `SET @var`/PREPARE, no MariaDB-only syntax. No RBAC seed rows —
-- this feature reuses the existing client rate-card action keys
-- (isClientEdit / client view), per the design's Decision 4.
--
-- Never run against Prod directly — QA first, per the design's "Delivery"
-- section.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tbl_client_material_price_group (
  group_id          INT AUTO_INCREMENT PRIMARY KEY,
  client_id         INT           NOT NULL,
  material_id       INT           NOT NULL,
  price             DECIMAL(12,2) NOT NULL,
  master_price_seen DECIMAL(12,2) NULL,
  status            TINYINT       NOT NULL DEFAULT 1,
  created_by        INT           NULL,
  created_at        DATETIME      NOT NULL,
  updated_by        INT           NULL,
  updated_at        DATETIME      NULL,
  KEY ix_client_material (client_id, material_id)
);

CREATE TABLE IF NOT EXISTS tbl_client_material_price_group_brand (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  group_id    INT NOT NULL,
  client_id   INT NOT NULL,
  material_id INT NOT NULL,
  brand_id    INT NOT NULL,
  UNIQUE KEY uq_client_group_brand (client_id, material_id, brand_id),
  KEY idx_client_group_brand_group (group_id),
  KEY idx_client_group_brand_brand (brand_id)
);

CREATE TABLE IF NOT EXISTS tbl_client_material_state_price (
  state_price_id INT AUTO_INCREMENT PRIMARY KEY,
  group_id       INT           NOT NULL,
  client_id      INT           NOT NULL,
  price          DECIMAL(12,2) NOT NULL,
  KEY idx_client_state_price_group (group_id)
);

CREATE TABLE IF NOT EXISTS tbl_client_material_state_price_state (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  state_price_id INT NOT NULL,
  group_id       INT NOT NULL,
  state_id       INT NOT NULL,
  UNIQUE KEY uq_client_group_state (group_id, state_id),
  KEY idx_client_state_price_state_sp (state_price_id)
);

-- ─── Verify ─────────────────────────────────────────────────────────────

SELECT table_name FROM information_schema.tables
 WHERE table_schema = DATABASE()
   AND table_name IN ('tbl_client_material_price_group','tbl_client_material_price_group_brand',
                       'tbl_client_material_state_price','tbl_client_material_state_price_state');
