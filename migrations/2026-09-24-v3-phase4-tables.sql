-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-24 — V3 Phase 4: signature, tools to carry, products at site.
--
-- ⚠⚠ RUN THIS BEFORE DEPLOYING THE PHASE 4 BACKEND — NOT AFTER. ⚠⚠
--
-- Same rule as 2026-09-24-v3-phase3-tables.sql: all three tables are in
-- scripts/schema-verify.js EXPECTED as REQUIRED (not FAIL_SOFT, not OPTIONAL),
-- and a required table that does not exist makes bootWouldFail() true: the
-- server REFUSES TO START. This backend serves the CRM, the technician app and
-- the client dashboard, so deploying the code first takes down all three, in
-- QA or in Production. Order: (1) run the Phase 3 file if it has not run,
-- (2) run this file and the post-apply SELECTs below, (3) confirm three
-- tables, (4) only then deploy the code.
--
-- WHAT: three NEW EasyFix-owned tables. Nothing existing is altered.
--
--   tbl_job_signature     the customer's signature, taken on the finish step
--                         when no customer PIN was verified (spec D6). SVG
--                         PATH DATA only — the `d` attribute string, never an
--                         <svg> document, never markup — so there is no image
--                         pipeline and nothing a browser could execute.
--                         One row per job (PK); a re-sign replaces it.
--   tbl_job_tool          the tools a technician must carry, picked in the CRM
--                         from tbl_tools (spec D8). One row per (job, tool).
--   tbl_job_site_product  the products already at the customer's site: name,
--                         qty, optional brand, typed in the CRM (spec D9).
--
-- WHY: V3 plan 4.1 / 4.4 / 4.5. Services: services/job-signature.service.js,
-- services/job-extras.service.js.
--
-- SHARED-DB RULE — THE DOCUMENTED EXCEPTION, SAME AS
-- executed/2026-09-07-create-tbl-job-permission-request.sql: new tables that no
-- legacy service references.
--
-- ── Column notes ────────────────────────────────────────────────────────
-- tbl_job_signature
--   efr_id       the technician who took it (the job's owner at the time).
--   svg_path     path data, validated by the service to the SVG path grammar's
--                character set (command letters, digits, . , + - e and
--                whitespace), starting with M, at most 200 KB. MEDIUMTEXT
--                because 200 KB does not fit TEXT's 64 KB.
--   width/height the pad's coordinate space the path was drawn in (1..4096).
--   signed_on    new Date() + the pool's +05:30 session timezone = IST wall
--                clock verbatim. NO DEFAULT CURRENT_TIMESTAMP — the container
--                clock is UTC.
-- tbl_job_tool
--   tool_id      tbl_tools.tool_id. No FK: tbl_tools is legacy and a tool is
--                deactivated (tool_status '0'), never deleted.
--   added_by     tbl_user.user_id of the CRM user who set the list.
-- tbl_job_site_product
--   qty          1..999, enforced by the route.
--   added_by     tbl_user.user_id.
--
-- INDEXES
--   tbl_job_signature PRIMARY (job_id)   the one-per-job rule AND the read.
--   uq_jt (job_id, tool_id)              the replace-set's idempotency: a
--                                        double-submitted PUT cannot list a
--                                        tool twice. Its left prefix is also
--                                        the (job_id) access path, so no
--                                        separate KEY(job_id) is needed on
--                                        this table.
--   idx_jsp_job (job_id)                 the detail / batch read.
--
-- HOW TO APPLY
--   Run each statement in order. Plain CREATE — no @-variables, no PREPARE,
--   nothing MariaDB-only.
--
-- IDEMPOTENCY OF THIS FILE
--   Fully re-runnable: every CREATE is IF NOT EXISTS. No seed rows.
-- ─────────────────────────────────────────────────────────────────────

-- ── Dry run (read-only) — which of the three exist already? ───────────
SELECT table_name, engine, table_rows
  FROM information_schema.tables
 WHERE table_schema = DATABASE()
   AND table_name IN ('tbl_job_signature', 'tbl_job_tool', 'tbl_job_site_product');

CREATE TABLE IF NOT EXISTS tbl_job_signature (
  job_id    INT NOT NULL,
  efr_id    INT NOT NULL,
  svg_path  MEDIUMTEXT NOT NULL,
  width     INT NOT NULL,
  height    INT NOT NULL,
  signed_on DATETIME NOT NULL,
  PRIMARY KEY (job_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tbl_job_tool (
  id       INT NOT NULL AUTO_INCREMENT,
  job_id   INT NOT NULL,
  tool_id  INT NOT NULL,
  added_on DATETIME NOT NULL,
  added_by INT NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_jt (job_id, tool_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tbl_job_site_product (
  id       INT NOT NULL AUTO_INCREMENT,
  job_id   INT NOT NULL,
  name     VARCHAR(160) NOT NULL,
  qty      INT NOT NULL DEFAULT 1,
  brand    VARCHAR(80) NULL DEFAULT NULL,
  added_on DATETIME NOT NULL,
  added_by INT NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_jsp_job (job_id)
) ENGINE=InnoDB;

-- ── Read-only post-apply verification ─────────────────────────────────
-- Expect every declared column above, and uq_jt with non_unique = 0.
SELECT table_name, column_name, data_type, character_maximum_length, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name IN ('tbl_job_signature', 'tbl_job_tool', 'tbl_job_site_product')
 ORDER BY table_name, ordinal_position;

SELECT table_name, index_name, seq_in_index, column_name, non_unique
  FROM information_schema.statistics
 WHERE table_schema = DATABASE()
   AND table_name IN ('tbl_job_signature', 'tbl_job_tool', 'tbl_job_site_product')
 ORDER BY table_name, index_name, seq_in_index;

-- ── Hand verification once live (read-only) ───────────────────────────
-- 1. A tool listed twice on one job. Must return ZERO rows, always:
-- SELECT job_id, tool_id, COUNT(*) FROM tbl_job_tool GROUP BY job_id, tool_id HAVING COUNT(*) > 1;
-- 2. Signature data that is not path data (the service refuses it; this proves it). ZERO rows:
-- SELECT job_id FROM tbl_job_signature WHERE svg_path REGEXP '[<>"'';:/&]';
