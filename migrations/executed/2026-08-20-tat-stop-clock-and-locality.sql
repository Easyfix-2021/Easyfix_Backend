-- ============================================================================
-- 2026-08-20 — TAT engine: stop clock, locality snapshot, coverage index
--
-- Creates, in one idempotent pass:
--   1. tbl_job_tat_stop      — TAT pause ledger (spec §5). MULTIPLE per job.
--   2. tbl_job_tat_locality  — frozen Local/Travel classification, 1 per job.
--   3. idx_efr_active_pin    — index the pincode-coverage read needs.
--
-- Both tables are EasyFix-OWNED and referenced by no legacy service, which is
-- the explicit carve-out in CLAUDE.md's "never alter schema, never add tables"
-- rule (precedent: tbl_pincode). No existing table's columns are changed.
--
-- ⚠ NO `DEFAULT CURRENT_TIMESTAMP` ON ANY DATETIME HERE. The MySQL server clock
-- is UTC while the connection pool session runs at +05:30, so a server-side
-- default writes a UTC instant into a column every reader treats as IST — a
-- silent 5h30m error. Every timestamp in these tables is written app-side as
-- `new Date()`, matching the platform's IST-storage convention.
-- ============================================================================

-- ─── 1. Stop-clock ledger ───────────────────────────────────────────
-- Why a new table rather than extending the legacy Fulfilment Hold
-- (job_status = 21 + tbl_job.full_fillment_*): that hold is capped at ONE per
-- job forever, its reason is free text with no owner, and its release writes
-- only job_status = 10 with NO end timestamp — so even that single hold's
-- duration cannot be derived. It is also read by two QuickSight reports, so
-- its columns must not be repurposed.
--
-- `stop_owned_by` is a column, not an FK: the platform's existing `user_type`
-- vocabulary (EasyFix / Customer / Client / Technician) has no OEM/Vendor
-- member, and separating EasyFix-caused delays from vendor-caused ones is the
-- entire reporting point of the field.
--
-- `reason_code` is the ONLY reason source today and is therefore NOT NULL. The
-- spec fixes exactly three triggers, so they live as constants in
-- services/tat.service.js rather than as an ops-editable dropdown:
--   MATERIAL · OEM_PART · ENTRY_PERMISSION
--
-- `reason_id` is a nullable hook for the day ops DOES want an editable list. It
-- would point at action_taken_reason — note that table's columns are
-- (id, action_type, action_desc, user_type, status, is_new); `action_type` is a
-- bare INTEGER bucket, and services/reason-codes.js warns explicitly against
-- resolving a bucket by the legacy action_type.type STRING because it drifts.
-- Allocating a free bucket integer needs a live SELECT, which is exactly why
-- this migration does not seed one.
CREATE TABLE IF NOT EXISTS tbl_job_tat_stop (
  stop_id         INT           NOT NULL AUTO_INCREMENT,
  job_id          INT           NOT NULL,
  stop_start      DATETIME      NOT NULL,
  stop_end        DATETIME      NULL,               -- NULL = still paused
  reason_id       INT           NULL,               -- FK action_taken_reason.id
  reason_code     VARCHAR(40)   NOT NULL,           -- MATERIAL | OEM_PART | ENTRY_PERMISSION
  stop_owned_by   VARCHAR(16)   NOT NULL,           -- EasyFix | Client | OEM/Vendor
  remarks         VARCHAR(500)  NULL,
  created_by      INT           NULL,
  created_on      DATETIME      NOT NULL,
  closed_by       INT           NULL,
  updated_on      DATETIME      NULL,
  PRIMARY KEY (stop_id),
  KEY idx_tat_stop_job (job_id, stop_start),
  -- Partial "one open stop per job" cannot be expressed in MySQL: a UNIQUE on
  -- (job_id, stop_end) permits unlimited NULLs. That invariant is enforced in
  -- the service layer; this index makes the check cheap.
  KEY idx_tat_stop_open (job_id, stop_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 2. Locality snapshot ───────────────────────────────────────────
-- A job's Local/Travel classification is derived from technician pincode
-- coverage, which CHANGES: onboarding a technician into an area would
-- retroactively tighten every past job there from a 48h Visit target to 24h.
-- A scorecard nobody can reproduce is not a scorecard, so the classification is
-- frozen when the job is created.
--
-- DELIBERATELY NOT BACKFILLED. For a job completed months ago we cannot know
-- what coverage looked like at ITS booking, and stamping today's answer would
-- produce a value that claims to be a snapshot of something it never observed.
-- Historical jobs simply have no row here and the engine falls back to the live
-- computation, flagging the result as un-snapshotted. Same precedent as
-- offered_by_user_id, which left pre-existing offers NULL rather than inventing
-- an attribution.
CREATE TABLE IF NOT EXISTS tbl_job_tat_locality (
  job_id          INT           NOT NULL,
  is_local        TINYINT(1)    NOT NULL,
  pincode         VARCHAR(10)   NULL,     -- the pincode the decision was made on
  snapshot_source VARCHAR(16)   NOT NULL, -- booking | backfill
  resolved_on     DATETIME      NOT NULL,
  PRIMARY KEY (job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 3. Coverage read index ─────────────────────────────────────────
-- services/pincode-coverage.service.js scans tbl_easyfixer for active+verified
-- technicians with a home pincode. tbl_easyfixer has NO index with efr_status
-- leading and NONE on efr_pin_no at all, so that pass is a full table scan
-- today. Guarded by an equivalent-left-prefix probe in the house style.
SET @has_active_pin = (
  SELECT COUNT(*) FROM (
    SELECT index_name FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'tbl_easyfixer'
     GROUP BY index_name
    HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index)
             IN ('efr_status,is_technician_verified,efr_pin_no')
        OR GROUP_CONCAT(column_name ORDER BY seq_in_index)
             LIKE 'efr_status,is_technician_verified,efr_pin_no,%'
  ) equivalent_index
);
SET @ddl_active_pin = IF(
  @has_active_pin = 0,
  'ALTER TABLE tbl_easyfixer ADD INDEX idx_efr_active_pin (efr_status, is_technician_verified, efr_pin_no), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_active_pin FROM @ddl_active_pin;
EXECUTE stmt_active_pin;
DEALLOCATE PREPARE stmt_active_pin;

-- ─── Verification ───────────────────────────────────────────────────
-- Every `present` must be exactly 1, on the first run and on any repeat run.
SELECT 'tbl_job_tat_stop table' AS what, COUNT(*) AS present
  FROM information_schema.tables
 WHERE table_schema = DATABASE() AND table_name = 'tbl_job_tat_stop'
UNION ALL
SELECT 'tbl_job_tat_locality table', COUNT(*)
  FROM information_schema.tables
 WHERE table_schema = DATABASE() AND table_name = 'tbl_job_tat_locality'
UNION ALL
SELECT 'idx_efr_active_pin index', COUNT(DISTINCT index_name)
  FROM information_schema.statistics
 WHERE table_schema = DATABASE() AND table_name = 'tbl_easyfixer'
   AND index_name = 'idx_efr_active_pin';
