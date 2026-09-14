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
--      state), the trigger finds matching activity_log rows by mobile and sets
--      efr_id, linking LEAD → technician journey.
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
-- POST-APPLY
--   • Restart the backend (to load trigger changes)
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
DELIMITER $$
CREATE TRIGGER IF NOT EXISTS tr_easyfixer_activity_backfill
AFTER INSERT ON tbl_easyfixer FOR EACH ROW
BEGIN
  DECLARE v_mobile VARCHAR(20);
  -- Extract mobile from tbl_user (newly created)
  SELECT user_mobile INTO v_mobile FROM tbl_user WHERE user_id = NEW.user_id LIMIT 1;

  -- Backfill all activity_log rows matching this mobile with the new efr_id
  IF v_mobile IS NOT NULL THEN
    UPDATE tbl_easyfixer_activity_log
    SET efr_id = NEW.efr_id
    WHERE mobile = v_mobile AND efr_id IS NULL;
  END IF;
END$$
DELIMITER ;


-- ─── 3. Helper stored procedure: append activity log entry ──────────────
-- Called from backend services to log an event atomically.
DELIMITER $$
CREATE PROCEDURE IF NOT EXISTS sp_activity_log_append(
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
BEGIN
  INSERT INTO tbl_easyfixer_activity_log (
    efr_id, mobile, supply_request_id, event_type, category, section,
    from_stage, to_stage, source, actor_type, actor_user_id, actor_name,
    summary, metadata, created_at
  ) VALUES (
    p_efr_id, p_mobile, p_supply_request_id, p_event_type, p_category, p_section,
    p_from_stage, p_to_stage, p_source, p_actor_type, p_actor_user_id, p_actor_name,
    p_summary, p_metadata, NOW()
  );
END$$
DELIMITER ;


-- ─── 4. Verify ─────────────────────────────────────────────────────────
SELECT 'table tbl_easyfixer_activity_log' AS what, COUNT(*) AS present FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_easyfixer_activity_log'
UNION ALL
SELECT 'trigger tr_easyfixer_activity_backfill', COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = 'tr_easyfixer_activity_backfill'
UNION ALL
SELECT 'procedure sp_activity_log_append', COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_NAME = 'sp_activity_log_append';
