-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-14 — Unified Easyfixer Activity Log (audit trail from LEAD → ACTIVE)
--
-- Single append-only table capturing all events across the technician lifecycle:
-- LEAD invites, app downloads, OTP verification, registration steps, status changes,
-- bank verification, comments — everything from supply request to active technician.
--
-- KEY DESIGN DECISIONS
--   1. Mirrors (not replaces) tbl_easyfixer_lifecycle_status_log and
--      tbl_easyfixer_sensitive_change_log. Existing services write to those;
--      code also appends here for a unified feed.
--   2. efr_id is backfilled via trigger: when a new technician registers (NEW
--      state), the trigger finds activity_log rows whose mobile equals the new
--      row's tbl_easyfixer.efr_no (the login mobile) and sets efr_id, linking
--      LEAD → technician journey.
--   3. from_stage / to_stage only populated for STATUS_CHANGED events
--      (both NULL for COMMENT_ADDED, BANK_VERIFIED, etc.).
--
-- INTEGRATION POINTS
--   • Supply Dashboard (backend) → POST INVITE_SENT on supply report creation
--   • Mobile app → POST APP_FIRST_OPEN, OTP_VERIFIED, REGISTRATION_STEP_*, etc.
--   • Backend trigger → auto-backfill efr_id when tbl_easyfixer row is created
--   • CRM → POST COMMENT_ADDED, STATUS_CHANGED on decisions
--   • Lifecycle & bank services → POST STATUS_CHANGED, BANK_VERIFIED (optional mirror)
--
-- ⚠ ALREADY RAN THE FIRST VERSION OF THIS FILE? RE-RUN IT.
-- The first version created the trigger reading tbl_user.user_mobile, a column
-- that does not exist, so every INSERT into tbl_easyfixer (app sign-up, CRM
-- Add Easyfixer, legacy services) fails once it is installed. It also used
-- CREATE TRIGGER IF NOT EXISTS, so only this version replaces it. Re-run the
-- whole file (safe, see below) or at least the DROP/CREATE pair in section 2.
-- Check: the trigger row in section 4 must report present = 1.
--
-- ── SAFE TO RE-RUN ───────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS, and DROP ... IF EXISTS then CREATE for the
-- trigger and the procedure (the pattern of
-- executed/2026-08-11-02-training-progress-uniqueness.sql). Both bodies are a
-- single statement: no DELIMITER, so this opens in DBeaver as well as the CLI.
--
-- POST-APPLY
--   • No backend restart needed: the trigger and procedure live in the database
--   • Enable the mobile app to POST to /api/mobile/activity-log
--   • Wire CRM onboarding decisions to activity log
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. The unified activity log table ─────────────────────────────────
CREATE TABLE IF NOT EXISTS tbl_easyfixer_activity_log (
  log_id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  efr_id            INT          NULL,          -- NULL until tech registers; backfilled by trigger
  mobile            VARCHAR(20)  NULL,          -- LEAD identifier before efr_id exists
  supply_request_id BIGINT       NULL,          -- links LEAD to supply-gap allocation
  event_type        VARCHAR(48)  NOT NULL,      -- INVITE_SENT, OTP_VERIFIED, REGISTERED, REGISTRATION_SUBMITTED, STATUS_CHANGED, COMMENT_ADDED, BANK_VERIFIED, etc.
  category          VARCHAR(24)  NOT NULL,      -- COMMUNICATION | LIFECYCLE | VERIFICATION | SENSITIVE_CHANGE | COMMENT
  section           VARCHAR(32)  NULL,          -- which tab: onboarding | bank | contact | work | skills | pincodes | status
  from_stage        VARCHAR(40)  NULL,          -- for STATUS_CHANGED: old state (NEW, REGISTRATION_IN_PROGRESS, etc.)
  to_stage          VARCHAR(40)  NULL,          -- for STATUS_CHANGED: new state
  source            VARCHAR(16)  NOT NULL,      -- SUPPLY_DASHBOARD | APP | CRM | CRON | SYSTEM | QUICKSIGHT
  actor_type        VARCHAR(16)  NULL,          -- TECHNICIAN | STAFF | SYSTEM
  actor_user_id     INT          NULL,          -- CRM user_id (if actor_type=STAFF)
  actor_name        VARCHAR(100) NULL,          -- for display (e.g. "Harkirpa Kaur" for STAFF, or "Technician" for APP)
  summary           VARCHAR(500) NULL,          -- human line: "Invite sent via WhatsApp" / "Bank verified by finance" / "Sent back — selfie unclear"
  metadata          JSON         NULL,          -- event-specific: {reason_code, reason_text, step, field, old_value, new_value, verified_by}
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (log_id),
  KEY idx_efr_created       (efr_id, created_at),
  KEY idx_mobile_created    (mobile, created_at),
  KEY idx_supply_created    (supply_request_id, created_at),
  KEY idx_type_created      (event_type, created_at),
  KEY idx_cat_created       (category, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Unified append-only audit trail: LEAD → technician lifecycle';


-- ─── 2. Trigger: backfill efr_id when technician registers ─────────────
-- When a new row is inserted into tbl_easyfixer (NEW state registration),
-- find matching activity_log rows by mobile and set efr_id.
-- This links LEAD invites to the eventual technician.
-- Reads NEW.efr_no (the login mobile, also what routes/mobile/activity-log.js
-- stores in `mobile`), not tbl_user: mobile_no can differ and user_id can be NULL.
-- Any trigger error fails the tbl_easyfixer INSERT, hence CONVERT + explicit
-- COLLATE: an explicit collation outranks the column's, so no server/legacy
-- collation default can raise an illegal-mix-of-collations error here.
DROP TRIGGER IF EXISTS tr_easyfixer_activity_backfill;
CREATE TRIGGER tr_easyfixer_activity_backfill
AFTER INSERT ON tbl_easyfixer
FOR EACH ROW
UPDATE tbl_easyfixer_activity_log
   SET efr_id = NEW.efr_id
 WHERE mobile = CONVERT(NEW.efr_no USING utf8mb4) COLLATE utf8mb4_0900_ai_ci
   AND efr_id IS NULL;


-- ─── 3. Helper stored procedure: append activity log entry ──────────────
-- Called from backend services to log an event atomically.
DROP PROCEDURE IF EXISTS sp_activity_log_append;
CREATE PROCEDURE sp_activity_log_append(
  IN p_efr_id INT,
  IN p_mobile VARCHAR(20),
  IN p_supply_request_id BIGINT,
  IN p_event_type VARCHAR(48),
  IN p_category VARCHAR(24),
  IN p_section VARCHAR(32),
  IN p_from_stage VARCHAR(40),
  IN p_to_stage VARCHAR(40),
  IN p_source VARCHAR(16),
  IN p_actor_type VARCHAR(16),
  IN p_actor_user_id INT,
  IN p_actor_name VARCHAR(100),
  IN p_summary VARCHAR(500),
  IN p_metadata JSON
)
INSERT INTO tbl_easyfixer_activity_log (
  efr_id, mobile, supply_request_id, event_type, category, section,
  from_stage, to_stage, source, actor_type, actor_user_id, actor_name,
  summary, metadata, created_at
) VALUES (
  p_efr_id, p_mobile, p_supply_request_id, p_event_type, p_category, p_section,
  p_from_stage, p_to_stage, p_source, p_actor_type, p_actor_user_id, p_actor_name,
  p_summary, p_metadata, NOW()
);


-- ─── 4. Verify ─────────────────────────────────────────────────────────
SELECT 'table tbl_easyfixer_activity_log' AS what, COUNT(*) AS present FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_easyfixer_activity_log'
UNION ALL
SELECT 'trigger tr_easyfixer_activity_backfill (reads efr_no)', COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = 'tr_easyfixer_activity_backfill' AND ACTION_STATEMENT LIKE '%NEW.efr_no%'
UNION ALL
SELECT 'procedure sp_activity_log_append', COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_NAME = 'sp_activity_log_append';
