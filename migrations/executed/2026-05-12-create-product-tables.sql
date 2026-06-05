-- ────────────────────────────────────────────────────────────────────
-- Product catalog tables (Phase 8 — admin product CRUD)
-- ────────────────────────────────────────────────────────────────────
--
-- The legacy EasyFix_CRM ProductDaoImpl.java references these tables
-- (`product`, `product_code`, `product_additional_image`, `document`)
-- but a 2026-05-12 INFORMATION_SCHEMA audit confirmed they do NOT
-- exist in the production `easyfix` schema. Either the feature was
-- planned but never deployed, or the tables were dropped at some
-- point and the legacy code path is dead.
--
-- This migration recreates them with the exact column shape used by
-- routes/admin/products.js. Run BEFORE enabling the product feature
-- in the new admin UI.
--
-- Schema (verified against legacy DAO SQL, not just JPA models):
--   product
--     id              INT PK AUTO_INCREMENT
--     name            VARCHAR(255)
--     created_on      DATE
--     service_id      INT     — FK to tbl_client_service.client_service_id
--     primary_img_id  INT     — FK to document.id (legacy image registry)
--
--   product_code      (M:N — products can have multiple SKU codes)
--     product_id      INT FK
--     code            VARCHAR(100)
--
--   product_additional_image
--     product_id      INT FK
--     document_id     INT FK to document.id
--
-- Foreign keys are NOT declared because the document/tbl_client_service
-- tables predate this migration and adding them retroactively risks
-- breaking other writers. The new code's transactional inserts give us
-- application-level integrity.

CREATE TABLE IF NOT EXISTS `product` (
  `id`             INT NOT NULL AUTO_INCREMENT,
  `name`           VARCHAR(255) NOT NULL,
  `created_on`     DATE NOT NULL,
  `service_id`     INT NOT NULL,
  `primary_img_id` INT DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_product_service` (`service_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `product_code` (
  `product_id` INT NOT NULL,
  `code`       VARCHAR(100) NOT NULL,
  KEY `idx_product_code_pid` (`product_id`),
  KEY `idx_product_code_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `product_additional_image` (
  `product_id`  INT NOT NULL,
  `document_id` INT NOT NULL,
  KEY `idx_pai_pid` (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
