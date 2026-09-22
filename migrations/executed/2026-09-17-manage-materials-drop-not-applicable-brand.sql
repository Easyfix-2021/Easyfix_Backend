-- =============================================================================
-- 2026-09-17 — Manage Materials QA fix: drop the "Not Applicable" system brand
--
-- WHAT: Decision A (owner QA round 1) replaces the "Not Applicable" system
-- brand with "No Brand" pricing (a price group with brand_ids: [] — see
-- services/material.service.js::validateGroupsPayload). The system brand row
-- seeded by 2026-09-17-manage-materials.sql (since edited to no longer seed
-- it) is deleted here for envs where that file already ran (QA).
--
-- HOW TO APPLY: run statement-by-statement; safe to re-run (no-op after the
-- first successful run, or if the row was never seeded).
--
-- IDEMPOTENCY: the DELETE's own WHERE clause is the guard — a second run
-- matches zero rows. It also refuses to delete a brand any material still
-- references (NOT EXISTS on tbl_material_price_group_brand, a different
-- table — not the delete target itself, so MySQL error 1093 "can't specify
-- target table for update in FROM clause" does not apply here).
--
-- POST-APPLY: none (no menu/permission changes).
-- =============================================================================

DELETE FROM tbl_brand_master WHERE brand_key = 'not applicable' AND is_system = 1 AND NOT EXISTS (SELECT 1 FROM tbl_material_price_group_brand gb WHERE gb.brand_id = tbl_brand_master.brand_id);

-- ─── Verify ─────────────────────────────────────────────────────────────

SELECT brand_id, brand_name, is_system FROM tbl_brand_master WHERE brand_key = 'not applicable';
