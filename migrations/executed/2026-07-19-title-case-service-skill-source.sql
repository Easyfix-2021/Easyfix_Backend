-- Title-case tbl_service_skill_mapping.source ('ai' -> 'AI', 'manual' -> 'Manual').
--
-- The CRM Skill Matrix page renders source verbatim, so ops wanted 'AI' (acronym
-- preserved, not 'Ai') and 'Manual' instead of the lower-case seed values. The
-- write path (services/service-skill-matrix.service.js SOURCE constant) already
-- emits the Title-Case values; this normalises the rows written before that.
--
-- Collation is utf8mb4_0900_ai_ci (case-insensitive), so `source = 'ai'` matches
-- every casing variant ('ai'/'Ai'/'AI') — these UPDATEs are idempotent and also
-- fold any stray mixed-case rows. Safe to re-run.
--
-- tbl_service_skill_mapping is EasyFix-owned (created 2026-07-02), referenced by
-- no legacy service, so the DEFAULT change is within the shared-DB exception.

UPDATE tbl_service_skill_mapping SET source = 'AI' WHERE source = 'ai';
UPDATE tbl_service_skill_mapping SET source = 'Manual' WHERE source = 'manual';
ALTER TABLE tbl_service_skill_mapping MODIFY COLUMN source VARCHAR(16) NOT NULL DEFAULT 'AI';
