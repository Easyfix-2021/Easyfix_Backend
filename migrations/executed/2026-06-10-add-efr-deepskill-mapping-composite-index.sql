-- 2026-06-10 — Defensive composite index on tbl_efr_deepskill_mapping
-- for the (easyfixer_id, is_repairing) filter pair used by the new
-- listOptionMappings query + the deep-skill ↔ easyfixer aggregations.
--
-- Without this, the active-only WHERE devolves to a per-row scan inside
-- each easyfixer_id's row set on the older single-column index. Prod
-- has ~4.7k technicians × N option mappings — composite kills the
-- difference for hot lookups (listOptionMappings, listMappedEasyfixers,
-- mappedEasyfixerCounts).
--
-- Idempotent: ADD INDEX errors if the index already exists, so we wrap
-- in a procedure that checks information_schema first.

DROP PROCEDURE IF EXISTS add_efr_deepskill_mapping_composite_idx;
DELIMITER //
CREATE PROCEDURE add_efr_deepskill_mapping_composite_idx()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name   = 'tbl_efr_deepskill_mapping'
       AND index_name   = 'idx_efr_deepskill_mapping_easyfixer_active'
  ) THEN
    ALTER TABLE tbl_efr_deepskill_mapping
      ADD INDEX idx_efr_deepskill_mapping_easyfixer_active (easyfixer_id, is_repairing);
  END IF;
END //
DELIMITER ;

CALL add_efr_deepskill_mapping_composite_idx();
DROP PROCEDURE add_efr_deepskill_mapping_composite_idx;
