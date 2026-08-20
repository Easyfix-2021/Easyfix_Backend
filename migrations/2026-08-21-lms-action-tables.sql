-- ─────────────────────────────────────────────────────────────────────
-- 2026-08-21 — LMS action tool: chase log, field hand-off, client
--              certification requirements, and the sweep indexes.
--
-- WHAT
--   1. lms_chase_log            — every chase, who/when/how/outcome.
--   2. lms_chase_assignment     — "send to state managers": the hand-off
--                                 from the training team to the field.
--   3. lms_client_course_requirement — which course a client requires,
--                                 so "uncertified technicians" is
--                                 computable rather than tribal knowledge.
--   4. Two sweep indexes on easyfixer_courses.
--   5. Six tuning properties for the action-home detectors.
--
-- SHARED-DB RULE — THE DOCUMENTED EXCEPTION
--   CLAUDE.md forbids altering the shared easyfix_core schema because five
--   legacy services read it. The named carve-out is an EASYFIX-OWNED NEW
--   TABLE THAT NO LEGACY SERVICE REFERENCES — the precedent chain is
--   tbl_pincode (2026-05-01), tbl_plivo_call_log (2026-06-19),
--   tbl_ai_call_session (2026-07-06), tbl_user_allowed_stages (2026-07-29),
--   tbl_job_conference (2026-08-04) and tbl_easyfixer_sensitive_change_log
--   (2026-08-17). All three tables here are written only by
--   services/lms-chase.service.js and services/lms-action.service.js in
--   this backend, and read by nothing legacy.
--
--   The ONLY existing table touched is easyfixer_courses, and only to ADD
--   two indexes. It is EasyFix-owned in practice (0 rows, no legacy
--   writer — established in 2026-08-13-lms-foundation.sql), and an index
--   is invisible to any reader that does not know about it.
--
-- NAMING — `lms_` NOT `tbl_lms_`
--   `tbl_*` is the legacy Java convention. The most recent greenfield
--   feature in this repo (reward_points_ledger, reward_items, reward_claims
--   — 2026-08-13-rewards-foundation.sql) uses a bare feature prefix, and
--   that is the live convention. It also makes `SHOW TABLES LIKE 'lms_%'`
--   the complete, exact inventory of the feature.
--
-- TIMESTAMPS — DATETIME NOT NULL, NO DEFAULT CURRENT_TIMESTAMP
--   The pool runs with a '+05:30' session timezone while the server clock
--   is UTC, so a column default and an app-supplied `new Date()` would
--   silently record two different timezones in the same column. Every
--   timestamp here is written by the application. Same rule as
--   2026-08-17-easyfixer-sensitive-change-log.sql.
--
-- VOCABULARY COLUMNS ARE VARCHAR, NOT ENUM
--   Adding a fourth chase channel must never require an ALTER on a shared
--   database. Values are validated by Joi at the route and by the service.
--
-- NO FOREIGN KEYS TO LEGACY TABLES
--   efr_id, course_id, city_id and user ids are plain INTs validated in the
--   service layer. FK-ing into tbl_easyfixer / courses from a new table
--   would couple this feature's write path to legacy row lifecycles, and
--   one of the targets (training_videos) is MyISAM, where MySQL parses a
--   foreign key and then silently ignores it.
--
-- POST-APPLY
--   Nothing to restart. The detector tunables are read through
--   properties.service (1-hour cache); POST /api/admin/properties/reload
--   picks up a change without a deploy.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. The chase log ────────────────────────────────────────────────
-- "Every chase is logged — so nobody says they were never told."
--
-- recipient_masked holds a MASKED number only, written by
-- lms-chase.service.js::recordChase() via utils/mask-mobile. Masking
-- happens inside the record function, never at the call site, so a future
-- caller cannot bypass it by passing the full number. This table answers
-- "was this technician contacted", not "what is his number" — efr_id
-- resolves the live number behind the CRM's own permission model.
--
-- actor_role_name is a SNAPSHOT. The log must answer "did the training
-- team chase, or did the field?", and resolving the role at read time
-- would let a role rename, or a user changing teams, rewrite history.

CREATE TABLE IF NOT EXISTS lms_chase_log (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  efr_id              INT          NOT NULL,
  channel             VARCHAR(24)  NOT NULL,
  outcome             VARCHAR(24)  NOT NULL,
  outcome_detail      VARCHAR(500) NULL,
  provider_message_id VARCHAR(128) NULL,
  target_type         VARCHAR(24)  NOT NULL,
  course_id           INT          NULL,
  session_id          INT          NULL,
  detector_key        VARCHAR(48)  NULL,
  batch_id            CHAR(36)     NULL,
  actor_user_id       INT          NULL,
  actor_role_name     VARCHAR(64)  NULL,
  actor_source        VARCHAR(16)  NOT NULL,
  recipient_masked    VARCHAR(24)  NULL,
  template_name       VARCHAR(128) NULL,
  language_code       VARCHAR(8)   NULL,
  created_at          DATETIME     NOT NULL,
  KEY idx_lms_chase_efr_created (efr_id, created_at),
  KEY idx_lms_chase_course_created (course_id, created_at),
  KEY idx_lms_chase_actor_created (actor_user_id, created_at),
  KEY idx_lms_chase_batch (batch_id),
  KEY idx_lms_chase_channel_created (channel, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─── 2. The field hand-off ───────────────────────────────────────────
-- "Send to state managers pushes the pending list into each state
-- manager's own screen, split by city."
--
-- This CREATES ROWS rather than being a filter, because the field screen
-- must distinguish "this technician is in my city" from "the training team
-- asked me to chase this technician" — and because the training team has
-- to be able to see that the hand-off was actioned.
--
-- city_id is a SNAPSHOT taken at hand-off, not a join at read time: a
-- technician who transfers city mid-chase must not vanish from the
-- manager who was asked to chase him.
--
-- course_id NULL means "everything this technician currently owes".

CREATE TABLE IF NOT EXISTS lms_chase_assignment (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  efr_id             INT          NOT NULL,
  course_id          INT          NULL,
  city_id            INT          NOT NULL,
  assigned_user_id   INT          NULL,
  status             VARCHAR(24)  NOT NULL,
  detector_key       VARCHAR(48)  NULL,
  batch_id           CHAR(36)     NOT NULL,
  note               VARCHAR(500) NULL,
  created_by_user_id INT          NULL,
  created_at         DATETIME     NOT NULL,
  first_chased_at    DATETIME     NULL,
  resolved_at        DATETIME     NULL,
  UNIQUE KEY uq_lms_chase_assignment (efr_id, course_id, batch_id),
  KEY idx_lms_ca_assignee_status (assigned_user_id, status, created_at),
  KEY idx_lms_ca_city_status (city_id, status, created_at),
  KEY idx_lms_ca_efr (efr_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─── 3. Client certification requirements ────────────────────────────
-- Detector D5: "a client needing certification has uncertified
-- technicians". tbl_client_easyfixer_mapping already says WHO is mapped to
-- a client; what was missing is WHICH course that client requires.
--
-- An empty table is a valid state: the detector then reports zero rows and
-- the screen says so, rather than inventing work.

CREATE TABLE IF NOT EXISTS lms_client_course_requirement (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  client_id          INT        NOT NULL,
  course_id          INT        NOT NULL,
  duration_months    INT        NOT NULL DEFAULT 0,
  duration_days      INT        NOT NULL DEFAULT 30,
  status             TINYINT(1) NOT NULL DEFAULT 1,
  created_by_user_id INT        NULL,
  created_at         DATETIME   NOT NULL,
  updated_at         DATETIME   NULL,
  UNIQUE KEY uq_lms_client_course (client_id, course_id),
  KEY idx_lms_ccr_course (course_id),
  KEY idx_lms_ccr_status (status, client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ─── 4. Sweep indexes on easyfixer_courses ───────────────────────────
-- The existing indexes — uq_easyfixer_course (easyfixer_id, course_id) and
-- idx_efr_course_due (easyfixer_id, due_date, completion_date) — both LEAD
-- with easyfixer_id. That is exactly right for the mobile hot path
-- (hasOverdueTraining runs on every authenticated request) and useless for
-- a set-wide sweep, which is what every action-home detector does.
--
-- Neither existing index is dropped.

-- D1 (deadline passed), D4 (paused, not started), and the Overdue/Pending
-- counters: a range scan on the date rather than a full scan, with
-- completion_date and course_id read from the index rather than the row.
ALTER TABLE easyfixer_courses ADD KEY idx_efr_course_due_global (due_date, completion_date, course_id);

-- D6 (stale module) and the "running normally" denominator: group by
-- course, filter on assignment age, and satisfy the completion aggregate
-- from the index.
ALTER TABLE easyfixer_courses ADD KEY idx_efr_course_course_created (course_id, created_at, completion_date);


-- ─── 5. Detector tunables ────────────────────────────────────────────
-- Seeded non-empty so the detectors have defined behaviour on day one.
-- lms.action.stale.min_cohort matters more than it looks: without a floor,
-- a course assigned to one person who has not finished it reports 0%
-- completion and screams at the top of the action list every day.

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'lms.action.stale.days', '7' WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'lms.action.stale.days');

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'lms.action.stale.pct', '30' WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'lms.action.stale.pct');

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'lms.action.stale.min_cohort', '5' WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'lms.action.stale.min_cohort');

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'lms.action.decision.days', '14' WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'lms.action.decision.days');

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'lms.chase.cooldown.hours', '20' WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'lms.chase.cooldown.hours');

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'lms.chase.bulk.max', '500' WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'lms.chase.bulk.max');


-- ─── 6. Verify ───────────────────────────────────────────────────────
SELECT 'lms_chase_log' AS what, COUNT(*) AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'lms_chase_log'
UNION ALL SELECT 'lms_chase_assignment', COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'lms_chase_assignment'
UNION ALL SELECT 'lms_client_course_requirement', COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'lms_client_course_requirement'
UNION ALL SELECT 'idx_efr_course_due_global', COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'easyfixer_courses' AND index_name = 'idx_efr_course_due_global'
UNION ALL SELECT 'idx_efr_course_course_created', COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'easyfixer_courses' AND index_name = 'idx_efr_course_course_created'
UNION ALL SELECT 'detector properties (expect 6)', COUNT(*) FROM easyfix_properties WHERE property_key LIKE 'lms.action.%' OR property_key LIKE 'lms.chase.%';
