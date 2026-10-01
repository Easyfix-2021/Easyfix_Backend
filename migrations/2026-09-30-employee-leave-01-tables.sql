-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-30 — Employee Hub: leave requests + urgent-alert acks
--
-- Spec: docs/superpowers/specs/2026-09-30-employee-hub-leave-design.md §3.
-- EasyFix-owned NEW tables (the CLAUDE.md exception) keyed on
-- tbl_user.user_id; nothing on a legacy table is touched. No FKs.
--
-- kind LV | SL · duration FULL | FIRST_HALF | SECOND_HALF ·
-- status PENDING | APPROVED | REJECTED | WITHDRAWN | CANCELLED — VARCHAR +
-- one JS constant each (services/leave.service.js), same reason as the roster.
-- approver_user_id = the reporting_manager snapshotted at request time;
-- NULL = no RH, routed to Roster Admins (isRosterAdmin).
-- alert_key = 'leave:<id>' — generic so other urgent alerts can reuse it.
--
-- Timestamps are written by the app as new Date() (pool session +05:30 →
-- IST verbatim). No DEFAULT CURRENT_TIMESTAMP: the server clock is UTC.
--
-- Deploy order: THIS file before the backend (resolveDays is fail-soft on a
-- missing table, but the leave API is not); 02 after the CRM is live.
-- Idempotent — re-running is a no-op.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tbl_employee_leave_request (id BIGINT NOT NULL AUTO_INCREMENT, user_id INT NOT NULL, kind CHAR(2) NOT NULL, from_date DATE NOT NULL, to_date DATE NOT NULL, duration VARCHAR(12) NOT NULL, days DECIMAL(5,1) NOT NULL, reason VARCHAR(500) NULL, status VARCHAR(10) NOT NULL, approver_user_id INT NULL, decided_by INT NULL, decided_at DATETIME NULL, decision_note VARCHAR(500) NULL, cancelled_by INT NULL, cancelled_at DATETIME NULL, cancel_note VARCHAR(500) NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, PRIMARY KEY (id), KEY idx_elr_user_dates (user_id, from_date, to_date), KEY idx_elr_approver_status (approver_user_id, status), KEY idx_elr_status_dates (status, from_date));

CREATE TABLE IF NOT EXISTS tbl_user_alert_ack (user_id INT NOT NULL, alert_key VARCHAR(64) NOT NULL, acked_at DATETIME NOT NULL, PRIMARY KEY (user_id, alert_key));

SELECT 'tbl_employee_leave_request' AS what, COUNT(*) AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'tbl_employee_leave_request'
UNION ALL SELECT 'tbl_user_alert_ack', COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'tbl_user_alert_ack';
