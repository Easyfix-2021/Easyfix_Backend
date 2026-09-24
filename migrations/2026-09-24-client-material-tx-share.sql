-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-24 — Client Material Rates: Tx Share (technician's charge on
-- top of the material price).
--
-- CONCEPT: a client's material rate now carries a "Tx Share" alongside its
-- Price. The CLIENT is asked to approve Price + Tx Share (shown combined on
-- the letterhead PDF, never the split — utils/pdf-rate-card.js); the
-- TECHNICIAN only ever sees the Price (services/material-price-resolver.js
-- strips tx_share from every mobile response). Default Tx Share = 20% of
-- the price, rounded to 2dp.
--
-- Only the CLIENT tables get the column — the master tables
-- (tbl_material_price_group / tbl_material_state_price) are untouched; a
-- master hit always computes 20% on the fly (no column needed there).
--
-- Backfill: every pre-existing row's tx_share was implicitly "20% of price"
-- at every read site already (NULL is read that way); this UPDATE just makes
-- the stored value match what reads have always computed, so a later plain
-- SELECT (without the app-layer NULL fallback) sees the same number too.
--
-- Style: one statement per line, no @set/PREPARE, nothing MariaDB-only, per
-- feedback_easyfix_minimal_migration_style. Idempotent: the backfill UPDATEs
-- guard on tx_share IS NULL, so a re-run touches nothing.
--
-- See docs/superpowers/specs/2026-09-18-client-material-rates-design.md,
-- "2026-09-24 — Tx Share" section, for the full contract.
--
-- Never run against Prod directly — QA first, per the design's "Delivery"
-- section. This migration has NOT been run against any database.
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE tbl_client_material_price_group ADD COLUMN tx_share DECIMAL(12,2) NULL;
ALTER TABLE tbl_client_material_state_price ADD COLUMN tx_share DECIMAL(12,2) NULL;
UPDATE tbl_client_material_price_group SET tx_share = ROUND(price * 0.2, 2) WHERE tx_share IS NULL;
UPDATE tbl_client_material_state_price SET tx_share = ROUND(price * 0.2, 2) WHERE tx_share IS NULL;
