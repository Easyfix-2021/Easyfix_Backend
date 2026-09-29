-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-29 — Employee working days + Team Roster (CRM staff, tbl_user)
--
-- WHY: Ops Team Leaders plan week-offs and shift times by a monthly e-mail
-- ("Ops Roster || Sep'26"). This moves it into the CRM:
--   * every CRM user gets a WEEKLY working-days pattern (Add/Edit User);
--   * a TL can override any single date for their team up to ~3 months ahead
--     (Team Roster page), with an update log and an action log.
--
-- EasyFix-owned SIDE TABLES keyed on tbl_user.user_id — the same route as
-- tbl_user_personal_details (2026-08-03). NOTHING on tbl_user is touched.
--
-- ── Key choice ──────────────────────────────────────────────────────────
-- user_id, NOT user_code. tbl_user.user_code is VARCHAR ('E200244'), NULL or
-- legacy junk on older rows, editable on Edit User, and has no UNIQUE index
-- (lib/emp-code.js — forbidden to add one on the shared legacy table). As a key
-- it could collide or orphan rows when a code is edited. emp_code is kept as a
-- plain, NON-UNIQUE copy for display, export and matching attendance files; the
-- app re-writes it on every write, so an edited code re-syncs.
--
-- ── Day codes ───────────────────────────────────────────────────────────
-- 'PR' Present, 'WO' Week Off — in the weekday columns AND in roster rows, one
-- vocabulary. CHAR(2), not ENUM: a new code needs no ALTER; the allowed set is
-- one JS constant (services/attendance-preference.service.js DAY_TYPES).
--
-- ── Resolution (services/roster.service.js resolveDays) ─────────────────
-- A roster row for (user, date) wins; otherwise the weekday column of the
-- preference; no preference row at all = 7 working days (fail-open: routing
-- never sees a week-off nobody entered). There is deliberately NO "on roster"
-- flag — a user is on roster for a date exactly when a row exists for it.
--
-- ── Timestamps ──────────────────────────────────────────────────────────
-- Written by the app as new Date() (pool session +05:30 → IST verbatim). No
-- DEFAULT CURRENT_TIMESTAMP: the server clock is UTC.
--
-- No FK constraints: a tbl_user write must never be blockable by these tables.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tbl_employee_attendance_preference (user_id INT NOT NULL, emp_code VARCHAR(20) NULL, working_days TINYINT NOT NULL DEFAULT 7, default_shift_start TIME NULL, monday CHAR(2) NOT NULL DEFAULT 'PR', tuesday CHAR(2) NOT NULL DEFAULT 'PR', wednesday CHAR(2) NOT NULL DEFAULT 'PR', thursday CHAR(2) NOT NULL DEFAULT 'PR', friday CHAR(2) NOT NULL DEFAULT 'PR', saturday CHAR(2) NOT NULL DEFAULT 'PR', sunday CHAR(2) NOT NULL DEFAULT 'PR', updated_by INT NULL, updated_on DATETIME NULL, created_on DATETIME NULL, PRIMARY KEY (user_id), KEY idx_eap_emp_code (emp_code));

-- source: GRID (hand edit) | PATTERN (Fill From Pattern) | COPY (Copy Previous Month).
-- "Keep cells already edited by hand" skips source = 'GRID'.
CREATE TABLE IF NOT EXISTS tbl_employee_roster (user_id INT NOT NULL, emp_code VARCHAR(20) NULL, roster_date DATE NOT NULL, day_type CHAR(2) NOT NULL, shift_start TIME NULL, source VARCHAR(16) NOT NULL, updated_by INT NOT NULL, updated_at DATETIME NOT NULL, PRIMARY KEY (user_id, roster_date), KEY idx_er_date (roster_date));

-- One row per changed value. field: day_type | shift_start | pref.<day> | pref.working_days | pref.shift.
-- roster_date is NULL for preference (Edit User) changes; action_id is NULL for them too.
-- new_value NULL on a day_type row = reset back to the weekly working days.
CREATE TABLE IF NOT EXISTS tbl_employee_roster_change_log (id BIGINT NOT NULL AUTO_INCREMENT, action_id BIGINT NULL, user_id INT NOT NULL, roster_date DATE NULL, field VARCHAR(24) NOT NULL, old_value VARCHAR(16) NULL, new_value VARCHAR(16) NULL, changed_by INT NOT NULL, created_at DATETIME NOT NULL, PRIMARY KEY (id), KEY idx_ercl_user (user_id, roster_date), KEY idx_ercl_created (created_at));

-- One row per user action (Save Grid, Fill From Pattern, Copy Previous Month, Reset, Export),
-- including DENIED attempts (status_code 4xx).
CREATE TABLE IF NOT EXISTS tbl_employee_roster_action_log (id BIGINT NOT NULL AUTO_INCREMENT, action VARCHAR(32) NOT NULL, actor_user_id INT NOT NULL, scope_summary VARCHAR(500) NULL, params TEXT NULL, affected_users INT NOT NULL DEFAULT 0, affected_cells INT NOT NULL DEFAULT 0, status_code SMALLINT NOT NULL, created_at DATETIME NOT NULL, PRIMARY KEY (id), KEY idx_eral_actor (actor_user_id, created_at), KEY idx_eral_created (created_at));
