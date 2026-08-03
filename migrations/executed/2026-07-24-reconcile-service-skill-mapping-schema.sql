-- Reconcile a DRIFTED tbl_service_skill_mapping to the canonical CATEGORY-keyed
-- schema — WITHOUT dropping the table. 2026-07-24.
--
-- ⚠⚠ RUN THIS ONLY ON A HOST WHERE THE SCHEMA IS DRIFTED. ⚠⚠
--
-- WHY: some environments still carry the PRE-RECUT `tbl_service_skill_mapping`,
-- keyed on `service_type_id` instead of the canonical `service_catg_id`
-- (see migrations/executed/2026-07-02-create-tbl-service-skill-mapping.sql — the
-- table was deliberately re-keyed from service_type to service CATEGORY). Every
-- read/write in services/service-skill-matrix.service.js selects
-- `service_catg_id`, so the Job Skill Matrix page 500s on a drifted host with
-- "Unknown column 'ssm.service_catg_id'".
--
-- The ONLY structural difference between a drifted host and canonical is the
-- key COLUMN NAME (verified against a live drifted host: id / service_name /
-- deep_skill_id / confidence / source / status / created_on / updated_on all
-- already match). So a plain column RENAME reconciles the shape — no DROP, no
-- CREATE, no data loss of the table object, grants or triggers.
--
-- MySQL auto-rewrites every index that references a renamed column, so the
-- UNIQUE key and secondary keys carry over intact and now (correctly) cover
-- `service_catg_id`. The app never references index NAMES — only that those
-- columns are indexed — so no index DDL is needed.
--
-- HOW TO KNOW IF A HOST NEEDS THIS:
--   SHOW COLUMNS FROM tbl_service_skill_mapping WHERE Field = 'service_catg_id';
--   → 0 rows  = DRIFTED, run this file, then rebuild.
--   → 1 row   = ALREADY CORRECT, DO NOT run this file.
-- The app also reports it: the Job Skill Matrix page shows "schema not ready"
-- (getStats returns schemaReady:false) on a drifted host.

-- 1. Rename the mis-keyed column. Indexes that referenced service_type_id
--    (the unique key + the two secondary keys) auto-follow to service_catg_id.
ALTER TABLE tbl_service_skill_mapping
  CHANGE COLUMN service_type_id service_catg_id INT NOT NULL;

-- 2. Discard the pre-recut AI rows. Their values are service_TYPE ids on the
--    WRONG axis — after the rename they'd be mislabelled as categories and would
--    no longer join to tbl_service_catg. The rows are AI-regenerable, and a
--    rebuild only wholesale-replaces AI rows for categories that have deep
--    skills, so orphaned wrong-axis rows must be cleared explicitly here.
--    (source='Manual' overrides are preserved. On a genuinely pre-recut host
--    there are normally none; if any exist, reconcile them by hand — their
--    service_catg_id may still hold a stale service_type value.)
DELETE FROM tbl_service_skill_mapping WHERE source = 'AI';

-- 3. AFTER RUNNING: Settings → Admin Actions → Job Skill Matrix → Build Matrix
--    repopulates it (needs SOPHY_API_KEY_SKILL_MATRIX configured).
