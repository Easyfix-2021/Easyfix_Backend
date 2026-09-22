-- =============================================================================
-- 2026-09-18 — Material Add Requests (Material Management phase 2, sub-project A)
--
-- WHAT: 1 new EasyFix-owned table. On the technician app's Estimate screen the
-- material picker offers master-list materials ONLY, plus "Others" — and
-- "Others" raises a new-material add request instead of a free-text quotation
-- line. This table is a request LOG, not a second master: approving a row
-- creates a normal tbl_material_master row through the phase-1
-- services/material.service.js createMaterial(), so there is exactly one
-- place a material can be born. See
-- docs/superpowers/specs/2026-09-18-material-add-requests-design.md.
--
-- request_status: 1 pending, 2 approved, 3 rejected.
-- service_catg_id is stamped from the job on the server — never trust the app
-- payload for it (see the design's "Data model" section for why).
--
-- Style: one statement per line, CREATE TABLE IF NOT EXISTS, idempotent on
-- re-run, no `SET @var`/PREPARE, no MariaDB-only syntax.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tbl_material_add_request (
  request_id      INT AUTO_INCREMENT PRIMARY KEY,
  material_name   VARCHAR(200)  NOT NULL,
  brand_name      VARCHAR(150)  NULL,
  service_catg_id INT           NOT NULL,
  job_id          INT           NULL,
  efr_id          INT           NULL,
  expected_price  DECIMAL(12,2) NULL,
  qty             DECIMAL(12,2) NULL,
  note            VARCHAR(500)  NULL,
  request_status  TINYINT       NOT NULL DEFAULT 1,
  reject_reason   VARCHAR(500)  NULL,
  material_id     INT           NULL,
  reviewed_by     INT           NULL,
  reviewed_at     DATETIME      NULL,
  created_at      DATETIME      NOT NULL,
  KEY ix_status_created (request_status, created_at),
  KEY ix_job (job_id)
);

-- ─── Verify ─────────────────────────────────────────────────────────────

SELECT table_name FROM information_schema.tables
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_material_add_request';
