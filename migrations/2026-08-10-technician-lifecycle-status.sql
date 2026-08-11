-- Technician lifecycle state machine (EasyFix Technician App specification v5.1).
--
-- PENDING SHARED-SCHEMA MIGRATION — run QA first and obtain DBA sign-off.
-- The unified backend is staged-deploy safe: pre-migration reads derive the
-- lifecycle from existing flags, while new lifecycle writes return a clear 503.
-- Legacy services ignore every nullable/additive column below.
--
-- Deliberately lean: exactly six additive columns and NO new secondary indexes.
-- The scheduled block end date reuses the existing tbl_easyfixer.scheduled_reactivation_date;
-- pause / re-application counts derive from tbl_easyfixer_lifecycle_status_log; the
-- default-off evaluator/reapplication crons run bounded and unindexed. Re-add
-- idx_efr_lifecycle_evaluation / idx_efr_lifecycle_until / idx_efr_reapplication_queue
-- (and any denormalized column they need) only if those crons are ever enabled at scale.

-- ALGORITHM=INPLACE, LOCK=NONE is pinned deliberately: tbl_easyfixer is a SHARED
-- legacy table, so the ALTER must stay ONLINE (concurrent reads+writes permitted)
-- and must FAIL FAST rather than silently fall back to ALGORITHM=COPY (which takes
-- a shared lock and blocks writes for the whole rebuild). All six columns are plain
-- nullable / DEFAULT — no auto-increment — so INPLACE+LOCK=NONE is supported on
-- MySQL 5.7 and 8.0 alike. On MySQL 8.0.12+ you MAY change this to ALGORITHM=INSTANT
-- for a metadata-only change (no rebuild); leave it INPLACE if the server is 5.7.x.
ALTER TABLE tbl_easyfixer
  ADD COLUMN lifecycle_status VARCHAR(40) NULL DEFAULT NULL,
  ADD COLUMN lifecycle_reason_code VARCHAR(80) NULL DEFAULT NULL,
  ADD COLUMN lifecycle_reason VARCHAR(500) NULL DEFAULT NULL,
  ADD COLUMN lifecycle_changed_at DATETIME NULL DEFAULT NULL,
  ADD COLUMN lifecycle_source VARCHAR(20) NULL DEFAULT NULL,
  ADD COLUMN lifecycle_version INT UNSIGNED NOT NULL DEFAULT 0,
  ALGORITHM=INPLACE, LOCK=NONE;

CREATE TABLE IF NOT EXISTS tbl_easyfixer_lifecycle_status_log (
  lifecycle_log_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  efr_id INT NOT NULL,
  from_status VARCHAR(40) NULL,
  to_status VARCHAR(40) NOT NULL,
  reason_code VARCHAR(80) NULL,
  reason VARCHAR(500) NULL,
  source VARCHAR(20) NOT NULL,
  actor_user_id INT NULL,
  metadata JSON NULL,
  status_version INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (lifecycle_log_id),
  UNIQUE KEY uq_efr_lifecycle_version (efr_id, status_version),
  KEY idx_efr_lifecycle_history (efr_id, created_at, lifecycle_log_id),
  KEY idx_lifecycle_transition (to_status, created_at, efr_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Backfill one authoritative state per existing, non-deleted technician. The
-- order matches mobile-registration.service's legacy-derived gate and preserves
-- temporarily inactive rows as SUSPENDED so the existing reactivation cron can
-- later lift them through the audited lifecycle path. The scheduled end date is
-- NOT copied into a new column — it already lives in scheduled_reactivation_date.
UPDATE tbl_easyfixer e
LEFT JOIN tbl_user u ON u.user_id = e.user_id
SET e.lifecycle_status = CASE
      WHEN e.is_technician_verified = 1 AND e.efr_status = 0
        AND e.scheduled_reactivation_date IS NOT NULL THEN 'SUSPENDED'
      WHEN e.is_technician_verified = 1 AND e.efr_status = 0 THEN 'INACTIVE'
      WHEN e.is_technician_verified = 1 AND e.efr_manager_id IS NOT NULL
        AND e.efr_manager_id > 0 THEN 'UNDER_MASTER'
      WHEN e.is_technician_verified = 1 THEN 'ACTIVE'
      WHEN e.is_identity_details_verified_by_crm = 2 THEN 'VERIFICATION_REJECTED'
      WHEN u.personal_details_filled = 2 THEN 'APPLICATION_REJECTED'
      WHEN e.user_id IS NULL OR e.user_id = 0 THEN 'NEW'
      WHEN COALESCE(u.is_personal_detail_filled, 0) = 0
        OR e.adhaar_card_number IS NULL OR e.adhaar_card_number = ''
        OR e.efr_profile_img IS NULL OR e.efr_profile_img = ''
        THEN 'REGISTRATION_INCOMPLETE'
      ELSE 'UNDER_VERIFICATION'
    END,
    e.lifecycle_reason_code = 'MIGRATED_LEGACY_STATUS',
    e.lifecycle_reason = NULL,
    e.lifecycle_changed_at = COALESCE(e.update_date, e.insert_date, NOW()),
    e.lifecycle_version = 1,
    e.lifecycle_source = 'MIGRATION'
WHERE e.lifecycle_status IS NULL
  AND NOT (e.efr_status <=> 3);

-- Durable re-application provenance lives in the audit log, not a denormalized
-- column: the seed INSERT below writes a to_status = 'REAPPLIED' row for every
-- technician sitting in REAPPLIED at migration time, so a later approval that
-- moves the current status away still leaves the immutable REAPPLIED history
-- behind (queried via COUNT(*)/EXISTS on to_status = 'REAPPLIED').

INSERT INTO tbl_easyfixer_lifecycle_status_log
  (efr_id, from_status, to_status, reason_code, reason, source,
   actor_user_id, metadata, status_version, created_at)
SELECT e.efr_id, NULL, e.lifecycle_status, e.lifecycle_reason_code, NULL,
       'MIGRATION', NULL, JSON_OBJECT('basis', 'legacy flags'),
       e.lifecycle_version, e.lifecycle_changed_at
  FROM tbl_easyfixer e
 WHERE e.lifecycle_source = 'MIGRATION'
   AND e.lifecycle_version = 1
   AND NOT EXISTS (
     SELECT 1 FROM tbl_easyfixer_lifecycle_status_log l
      WHERE l.efr_id = e.efr_id AND l.status_version = 1
   );

-- All automatic lifecycle work is opt-in. This single kill-switch is read by
-- server/scheduler.js at startup to gate the evaluator cron; it stays a live
-- property so Ops can flip it without a code change. Every other lifecycle
-- threshold/batch knob is now a hardcoded constant in
-- services/easyfixer-lifecycle-evaluation-cron.js (promote back to properties
-- only if live tuning is ever needed).
INSERT INTO easyfix_properties (property_key, property_value)
VALUES ('easyfixer.lifecycle.evaluation.enabled', 'false')
ON DUPLICATE KEY UPDATE property_value = property_value;

-- Kill-switch for the daily auto-reactivation cron (server/scheduler.js reads it
-- at startup; a restart applies a change). Seeded 'false' so the row EXISTS and
-- Ops can flip it — the cron's batch/runtime knobs stay in-code fallbacks.
INSERT INTO easyfix_properties (property_key, property_value)
VALUES ('easyfixer.auto_reactivation.enabled', 'false')
ON DUPLICATE KEY UPDATE property_value = property_value;
