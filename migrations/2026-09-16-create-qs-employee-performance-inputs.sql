-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-16 — Employee Performance: storage for the UPLOADED inputs
--              (emp detail, both target lists, TimeChamp, IVR) and the
--              FROZEN Primary SPOC of every closed job.
--
-- WHAT
--   QuickSight → Employee Performance was a data.js snapshot MIS built
--   off-platform (build_data.py). It moves to a server-side build with three
--   kinds of input (owner decisions, final):
--     LIVE from the DB, never uploaded
--         open jobs, closed jobs, and the CRM counts
--         (Booked / Scheduled / Audit / Closed / Cancelled)
--     UPLOADED as an .xlsx inside the CRM, into the tables below. The file
--     has the SAME five sheets and headers as the MIS workbook, so MIS can
--     reuse its own sheets:
--         MONTHLY  "emp detail", "target list", "Secondary spoc target list"
--         DAILY    "time champ data", "ivr data record"
--     FROZEN on first capture (scheduled job)
--         the Primary SPOC each closed job is credited to
--
--   Seven tables, all prefixed tbl_qs_ep_ (QuickSight · Employee Performance):
--     tbl_qs_ep_upload_batch       one row per COMMITTED upload (audit)
--     tbl_qs_ep_roster             "emp detail": one row per (month, CRM name)
--     tbl_qs_ep_primary_target     "target list": one row per (month, person)
--     tbl_qs_ep_secondary_target   "Secondary spoc target list": (month, person)
--     tbl_qs_ep_timechamp_daily    "time champ data": one row per person per day
--     tbl_qs_ep_ivr_daily          "ivr data record": one row per agent per day
--     tbl_qs_ep_job_spoc           one row per closed job: its frozen Primary SPOC
--
--   Written by services/quicksight/employee-performance/uploads.service.js
--   (the five upload tables) and by the SPOC capture job (tbl_qs_ep_job_spoc).
--   Read by the same service's loadUploads() and the dashboard builder.
--
-- SHARED-DB RULE — THE DOCUMENTED EXCEPTION
--   CLAUDE.md forbids altering the shared `easyfix_core` schema. Its stated
--   carve-out is an EASYFIX-OWNED NEW TABLE THAT NO LEGACY SERVICE REFERENCES,
--   already used by tbl_pincode (2026-05-01), tbl_job_tat_locality
--   (2026-08-20), tbl_certificate (2026-09-07) and tbl_attempt_window
--   (2026-09-11). No legacy service reads or writes these seven.
--   NO FOREIGN KEYS, deliberately: job_id / spoc_user_id / uploaded_by /
--   batch_id are plain INTs. A tbl_user or tbl_job write can never be blocked
--   by these tables, and removing a user never cascades into performance
--   history. NOTHING existing is altered by this file.
--
-- WHY TABLES, NOT A JSON BLOB IN S3
--   (1) The flow is incremental — replace one date, upsert one (month,
--       person). In S3 that is read-modify-rewrite of a whole object, with no
--       atomicity across sheets and a lost update when two operators upload
--       together. Here it is one transaction.
--   (2) The upload preview diffs the file against what is stored (dates that
--       will be overwritten, stored rows per month): indexed SELECTs.
--   (3) Volume is tiny: ~62 TimeChamp + ~22 IVR rows a day (~30k a year) and
--       ~120 roster + target rows a month.
--
-- ══════════════════════════════════════════════════════════════════════
-- PEOPLE ARE NAMES, RESOLVED AT READ TIME — no user_id is stored here
-- ══════════════════════════════════════════════════════════════════════
-- The sheets identify people by name (owner decision): "CRM CURRENT NAME" in
-- emp detail, with "Row Labels" and "EMPLOYE NAME" as aliases (build_data.py's
-- canon_name); "Primary spoc" / "Name" in the target lists; "Employee Name" /
-- "Employee Id" in TimeChamp; "Agent Name" in IVR. These tables store those
-- values as uploaded. WHO a row belongs to is decided when the dashboard is
-- built, against THAT MONTH's emp detail, by compose.js's own port of
-- build_data.py (services/quicksight/employee-performance/compose.js,
-- fromWorkbookSheets). So:
--   * A TimeChamp / IVR / target row for someone not on that month's emp
--     detail is STORED (the preview warns) and HIDDEN on the dashboard. The
--     moment an emp detail upload adds that person (or an alias for them), the
--     stored rows attach — no re-upload, no UPDATE, no stale "resolved" column.
--   * Matching emp detail CRM names to tbl_user.user_name (for live jobs) is
--     also read-time, in the builder.
--
-- ══════════════════════════════════════════════════════════════════════
-- WRITE RULES — what one upload does (all in ONE transaction)
-- ══════════════════════════════════════════════════════════════════════
-- DAILY (TimeChamp, IVR). Each DATE present in a sheet REPLACES exactly that
--   (source, date):
--     DELETE FROM tbl_qs_ep_timechamp_daily WHERE work_date IN (<file dates>)
--     then INSERT the file's rows for those dates.
--   Dates absent from the file are untouched, and so is the OTHER source's
--   data for the same date. Not an upsert per person: names get corrected
--   between exports ('Ankit Jha' → 'Ankit Kumar Jha') and TimeChamp ids are
--   handed from one person to another, so an upsert on the raw key would leave
--   the stale row behind and count one person's day twice.
--
-- MONTHLY (emp detail, both target lists). INSERT ... ON DUPLICATE KEY UPDATE
--   on the PRIMARY KEY (month, <name key>). Rows not in the file are untouched.
--   A file that REPEATS a key is REJECTED by the upload check — the database
--   cannot catch that, the second upsert would silently win.
--   emp detail's month comes from its "Team Name <Mon>" column headers: one
--   sheet row is one roster row for EVERY such column (a blank team = on that
--   month's emp detail with no team, exactly as build_data.py reads it).
--   A target row's key is the PERSON: the emp detail CRM name its name resolves
--   to that month (so 'Abhishek' and 'Abhishek Yadav' are one key), or the
--   typed name when it resolves to nobody. Uploading a target for a person
--   therefore also deletes that month's stored row typed under another alias of
--   the same person — one target per person per month, never two added up.
--   A month name ("August") means the nearest such month: 8 months back to 3
--   ahead of the upload's IST month.
--
-- Nothing is ever deleted except by those two replace rules. There is no
-- "Remove" column: the headers are MIS's.
--
-- ══════════════════════════════════════════════════════════════════════
-- tbl_qs_ep_job_spoc — THE FREEZE
-- ══════════════════════════════════════════════════════════════════════
-- tbl_vertical_mapping keeps no history (see executed/2026-08-26-backfill-
-- job-primary-spoc-intmax.sql), so crediting closed jobs to the CURRENT
-- mapping re-attributes past revenue every time a client is reassigned.
--   1. A scheduled job (server/scheduler.js pattern, respects CRON_DISABLED)
--      finds closed jobs with NO row here, resolves the client's Primary SPOC
--      with the rule of resolveClientPrimarySpoc() in services/job.service.js,
--      and stores (job_id, spoc_user_id, captured_on).
--   2. Reads credit each closed job to its row here, and fall back to the
--      current mapping only for a job with no row yet. GET endpoints NEVER
--      write; a read on a database without this table uses the current mapping.
-- FIRST CAPTURE WINS, FOREVER. Write with
--     INSERT INTO tbl_qs_ep_job_spoc (job_id, spoc_user_id, captured_on)
--     VALUES ? ON DUPLICATE KEY UPDATE job_id = job_id
-- (the tbl_job_tat_locality precedent). Never UPDATE spoc_user_id, and not
-- INSERT IGNORE: IGNORE also downgrades genuine errors to warnings nobody
-- reads. Two replicas capturing the same job at once are safe — the primary
-- key makes the second insert a no-op.
-- spoc_user_id NULL = no Primary SPOC resolved at capture. That is frozen too:
-- the job stays unattributed rather than moving to whoever is mapped later.
-- LIMITS: the freeze starts at the first capture after deploy; jobs closed
-- before then are captured with the mapping AS OF that run.
-- tbl_job.job_primary_spoc is NOT the source (VARCHAR(100), clamped
-- 2147483647 values, sparsely filled).
--
-- ══════════════════════════════════════════════════════════════════════
-- CONVENTIONS THE SERVICES FOLLOW
-- ══════════════════════════════════════════════════════════════════════
-- DATETIME, NO DB CLOCK DEFAULT. uploaded_on and captured_on are written by
--   the app as new Date(); the pool's +05:30 session timezone (db.js) stores
--   the IST wall clock. No DEFAULT CURRENT_TIMESTAMP / ON UPDATE.
-- DATES AS STRINGS. work_date / call_date are written as 'YYYY-MM-DD' and
--   month as 'YYYY-MM'. The pool sets dateStrings: true, so DATE reads back as
--   the same string, and 'YYYY-MM' sorts and compares correctly as text.
-- MEASURES ARE DOUBLE, NOT DECIMAL. build_data.py computes with the file's
--   floats (Daily Target 86211.34615384616, hours 8.122). DECIMAL(n,2) would
--   round them and the dashboard would drift from MIS's numbers. mysql2 reads
--   DOUBLE back as a JS number. Call counts are whole numbers (the upload
--   rejects fractions), stored as SIGNED INT with a >= 0 CHECK.
-- NAME KEYS ARE utf8mb4_bin. *_key = the name trimmed, inner whitespace
--   collapsed to one space, lower-cased (build_data.py's norm(), via
--   compose.js). The server default collation (utf8mb4_0900_ai_ci on QA) is
--   accent- and case-insensitive, so 'José' and 'Jose' would collide on the
--   primary key although the upload check sees two people. Binary collation
--   makes the database agree with the check exactly.
-- NON-STRICT sql_mode (measured on QA 2026-09-16: IGNORE_SPACE,
--   NO_ENGINE_SUBSTITUTION). MySQL then truncates an over-long VARCHAR and
--   stores '' for a bad ENUM without an error, so the upload check enforces
--   lengths and required values BEFORE writing. The CHECK constraints are the
--   backstop; MySQL 8.0.16+ enforces them whatever the sql_mode.
-- DEPLOY ORDER. Until this file has run, the upload endpoints answer 503
--   "Employee Performance storage is not set up yet" and loadUploads() returns
--   empty inputs (the dashboard shows live jobs only).
--
-- HOW TO APPLY
--   Run each statement in order: one dry-run SELECT, seven plain CREATE TABLE
--   IF NOT EXISTS, then the read-only verification. No PREPARE, no
--   @-variables, no DELIMITER. QA first. PRODUCTION NEEDS EXPLICIT OWNER
--   APPROVAL — and until it runs there, qa-db-refresh (1st and 16th, from the
--   Production replica) removes these tables from QA together with every row
--   uploaded to them, so re-apply on QA after each refresh.
--
-- IDEMPOTENCY
--   Fully re-runnable: every CREATE is IF NOT EXISTS, and nothing is seeded.
--   IF NOT EXISTS also means a table left over from an older draft keeps its
--   OLD shape silently. The verification block prints every column and key, so
--   compare it rather than trusting a clean run.
--
-- UNDO (QA only; nothing else references these tables): drop the tables by
--   hand. Keep tbl_qs_ep_job_spoc if the frozen attributions must survive —
--   they cannot be recaptured with the mapping as it was.
-- ─────────────────────────────────────────────────────────────────────

-- ── Dry run (read-only) — does this host already have any of them? ────
-- Zero rows = a fresh apply. Any row = a re-run (or an older draft: check its
-- columns against the verification block before relying on it).
SELECT table_name, engine, table_collation, table_rows, create_time
  FROM information_schema.tables
 WHERE table_schema = DATABASE()
   AND table_name IN ('tbl_qs_ep_upload_batch', 'tbl_qs_ep_roster', 'tbl_qs_ep_primary_target',
                      'tbl_qs_ep_secondary_target', 'tbl_qs_ep_timechamp_daily', 'tbl_qs_ep_ivr_daily',
                      'tbl_qs_ep_job_spoc')
 ORDER BY table_name;


-- ─── 1. tbl_qs_ep_upload_batch ──────────────────────────────────────
-- One row per COMMITTED upload, inserted inside the upload's transaction, so
-- a rolled-back upload leaves no row. The preview writes nothing.
--
-- batch_id      AUTO_INCREMENT. Every data row carries the batch_id of the
--               upload that last wrote it.
-- file_name     The uploaded file's original name, as the browser sent it.
-- file_sha256   Lower-case hex SHA-256 of the file bytes. Not unique:
--               re-uploading an identical file is legitimate.
-- sheets        Comma-separated names of the sheets that carried rows, e.g.
--               'emp detail,time champ data,ivr data record'.
-- date_from     Earliest / latest TimeChamp or IVR date in the file. NULL when
-- date_to       neither daily sheet had rows.
-- month_from    Earliest / latest emp detail or target month ('YYYY-MM'). NULL
-- month_to      when no monthly sheet had rows.
-- summary_json  The preview report that was committed (per-sheet row counts,
--               warnings, overwritten dates). MEDIUMTEXT, not JSON: never
--               queried by key; TEXT would stop at 64 KB and the non-strict
--               sql_mode would truncate an oversized report silently.
-- uploaded_by   tbl_user.user_id of the operator (req.user.user_id).
-- uploaded_on   new Date() at commit, IST wall clock.
CREATE TABLE IF NOT EXISTS tbl_qs_ep_upload_batch (
  batch_id     INT          NOT NULL AUTO_INCREMENT,
  file_name    VARCHAR(255) NOT NULL,
  file_sha256  CHAR(64)     NOT NULL,
  sheets       VARCHAR(255) NOT NULL,
  date_from    DATE         NULL DEFAULT NULL,
  date_to      DATE         NULL DEFAULT NULL,
  month_from   CHAR(7)      NULL DEFAULT NULL,
  month_to     CHAR(7)      NULL DEFAULT NULL,
  summary_json MEDIUMTEXT   NOT NULL,
  uploaded_by  INT          NOT NULL,
  uploaded_on  DATETIME     NOT NULL,
  PRIMARY KEY (batch_id),
  KEY idx_qs_ep_batch_uploaded_on (uploaded_on),
  CONSTRAINT chk_qs_ep_batch_months CHECK (
    month_from REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'
    AND month_to REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='EasyFix-owned: Employee Performance upload audit (one row per committed upload)';


-- ─── 2. tbl_qs_ep_roster — sheet "emp detail" ───────────────────────
-- One row per (month, person). Upserted by (month, crm_key).
--
-- month          'YYYY-MM', from the sheet's "Team Name <Mon>" header.
-- crm_key        norm("CRM CURRENT NAME") — the upsert key (utf8mb4_bin).
-- crm_name       "CRM CURRENT NAME" trimmed, as typed. The dashboard's
--                employee key and the name matched to tbl_user.user_name.
-- emp_id         "EMP ID" trimmed ('' when blank). TimeChamp's id fallback.
-- employee_name  "EMPLOYE NAME" trimmed ('' when blank). Display name, alias.
-- row_labels     "Row Labels" trimmed ('' when blank). Alias.
-- vertical       "vertical"; NULL when blank or 0 (build_data.py's
--                vertical_or_none: the person takes the team lead's).
-- team_name      That month's "Team Name <Mon>" cell; '' = no team.
-- row_no         Position in the month's list. A person keeps their position
--                when re-uploaded; a new person is appended. Aliases are
--                claimed in this order (build_data.py: the first claim wins)
--                and the dashboard lists employees in it.
-- batch_id       The upload that last wrote this row.
CREATE TABLE IF NOT EXISTS tbl_qs_ep_roster (
  month          CHAR(7)       NOT NULL,
  crm_key        VARCHAR(150)  CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  crm_name       VARCHAR(150)  NOT NULL,
  emp_id         VARCHAR(32)   NOT NULL,
  employee_name  VARCHAR(150)  NOT NULL,
  row_labels     VARCHAR(150)  NOT NULL,
  vertical       VARCHAR(100)  NULL DEFAULT NULL,
  team_name      VARCHAR(150)  NOT NULL,
  row_no         INT           NOT NULL,
  batch_id       INT           NOT NULL,
  PRIMARY KEY (month, crm_key),
  KEY idx_qs_ep_roster_batch (batch_id),
  CONSTRAINT chk_qs_ep_roster_month CHECK (month REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT chk_qs_ep_roster_name CHECK (crm_key <> '' AND crm_name <> '')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='EasyFix-owned: Employee Performance emp detail, one row per (month, CRM name)';


-- ─── 3. tbl_qs_ep_primary_target — sheet "target list" ──────────────
-- One row per (month, person). Upserted by (month, person_key).
--
-- month          'YYYY-MM', from the "month" cell (a month name).
-- person_key     norm(the emp detail CRM name "Primary spoc" resolves to that
--                month), or norm("Primary spoc") when it resolves to nobody.
-- person_name    "Primary spoc" trimmed, as typed. Re-resolved at read time.
-- target_amount  "Target Amount" (summed per person per month by the builder,
--                as build_data.py sums it).
-- daily_target   "Daily Target" (the per-day target, as build_data.py reads it).
-- row_no         Row order in the uploaded sheet.
CREATE TABLE IF NOT EXISTS tbl_qs_ep_primary_target (
  month          CHAR(7)       NOT NULL,
  person_key     VARCHAR(150)  CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  person_name    VARCHAR(150)  NOT NULL,
  target_amount  DOUBLE        NOT NULL,
  daily_target   DOUBLE        NOT NULL,
  row_no         INT           NOT NULL,
  batch_id       INT           NOT NULL,
  PRIMARY KEY (month, person_key),
  KEY idx_qs_ep_primary_target_batch (batch_id),
  CONSTRAINT chk_qs_ep_primary_target_month CHECK (month REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT chk_qs_ep_primary_target_values CHECK (target_amount >= 0 AND daily_target >= 0 AND person_key <> '')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='EasyFix-owned: Employee Performance primary SPOC targets, one row per (month, person)';


-- ─── 4. tbl_qs_ep_secondary_target — sheet "Secondary spoc target list"
-- One row per (month, person). Same keys as the primary list.
--
-- total_target   "Total Target"; the per-day target is total_target / 26.
CREATE TABLE IF NOT EXISTS tbl_qs_ep_secondary_target (
  month          CHAR(7)       NOT NULL,
  person_key     VARCHAR(150)  CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  person_name    VARCHAR(150)  NOT NULL,
  total_target   DOUBLE        NOT NULL,
  row_no         INT           NOT NULL,
  batch_id       INT           NOT NULL,
  PRIMARY KEY (month, person_key),
  KEY idx_qs_ep_secondary_target_batch (batch_id),
  CONSTRAINT chk_qs_ep_secondary_target_month CHECK (month REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT chk_qs_ep_secondary_target_values CHECK (total_target >= 0 AND person_key <> '')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='EasyFix-owned: Employee Performance secondary SPOC targets, one row per (month, person)';


-- ─── 5. tbl_qs_ep_timechamp_daily — sheet "time champ data" ─────────
-- One row per person per day, including all-zero rows (an absent day is data).
-- Replaced per work_date.
--
-- work_date         "Date".
-- name_key          norm("Employee Name"). One row per (date, name).
-- employee_id       "Employee Id" trimmed, as exported. One row per (date, id).
--                   NOT unique across dates: TimeChamp hands ids from one
--                   person to another.
-- employee_name     "Employee Name" trimmed.
-- working_hours     Decimal HOURS (6.2 = six hours twelve minutes, never an
-- productive_hours  Excel day fraction), 0..24.
-- away_hours
CREATE TABLE IF NOT EXISTS tbl_qs_ep_timechamp_daily (
  work_date         DATE          NOT NULL,
  name_key          VARCHAR(150)  CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  employee_id       VARCHAR(32)   CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  employee_name     VARCHAR(150)  NOT NULL,
  working_hours     DOUBLE        NOT NULL,
  productive_hours  DOUBLE        NOT NULL,
  away_hours        DOUBLE        NOT NULL,
  batch_id          INT           NOT NULL,
  PRIMARY KEY (work_date, name_key),
  UNIQUE KEY uq_qs_ep_tc_date_employee (work_date, employee_id),
  KEY idx_qs_ep_tc_batch (batch_id),
  CONSTRAINT chk_qs_ep_tc_hours CHECK (
    working_hours BETWEEN 0 AND 24
    AND productive_hours BETWEEN 0 AND 24
    AND away_hours BETWEEN 0 AND 24
    AND name_key <> '' AND employee_id <> ''
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='EasyFix-owned: Employee Performance TimeChamp hours, one row per person per day';


-- ─── 6. tbl_qs_ep_ivr_daily — sheet "ivr data record" ───────────────
-- One row per agent per day, for agents present in that day's export.
-- Replaced per call_date.
--
-- call_date          "Date".
-- agent_key          norm("Agent Name"). One row per (date, agent).
-- agent_name         "Agent Name" trimmed (the export pads it).
-- incoming_calls     "Total Incoming Calls".
-- outgoing_calls     "Total Outgoing Calls".
-- missed_calls       "Total Missed Calls". Can exceed incoming + outgoing
--                    (it includes missed IVR-queue calls).
-- avg_handling_secs  "Avg Handling Time" in plain SECONDS.
-- SIGNED INT for counts: a subtraction that goes negative on UNSIGNED columns
-- raises ERROR 1690; the CHECK keeps the stored values >= 0.
CREATE TABLE IF NOT EXISTS tbl_qs_ep_ivr_daily (
  call_date          DATE          NOT NULL,
  agent_key          VARCHAR(150)  CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  agent_name         VARCHAR(150)  NOT NULL,
  incoming_calls     INT           NOT NULL,
  outgoing_calls     INT           NOT NULL,
  missed_calls       INT           NOT NULL,
  avg_handling_secs  DOUBLE        NOT NULL,
  batch_id           INT           NOT NULL,
  PRIMARY KEY (call_date, agent_key),
  KEY idx_qs_ep_ivr_batch (batch_id),
  CONSTRAINT chk_qs_ep_ivr_counts CHECK (
    incoming_calls >= 0
    AND outgoing_calls >= 0
    AND missed_calls >= 0
    AND avg_handling_secs >= 0
    AND agent_key <> ''
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='EasyFix-owned: Employee Performance IVR calls, one row per agent per day';


-- ─── 7. tbl_qs_ep_job_spoc ──────────────────────────────────────────
-- The frozen Primary SPOC of each closed job (see THE FREEZE above).
--
-- job_id        tbl_job.job_id. PRIMARY KEY = one capture per job, first wins.
-- spoc_user_id  tbl_user.user_id resolved at capture by the
--               resolveClientPrimarySpoc() rule. NULL = none resolved; frozen
--               as unattributed.
-- captured_on   new Date() at capture, IST wall clock.
CREATE TABLE IF NOT EXISTS tbl_qs_ep_job_spoc (
  job_id        INT       NOT NULL,
  spoc_user_id  INT       NULL DEFAULT NULL,
  captured_on   DATETIME  NOT NULL,
  PRIMARY KEY (job_id),
  KEY idx_qs_ep_job_spoc_user (spoc_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='EasyFix-owned: Employee Performance frozen Primary SPOC per closed job (first capture wins)';


-- ── Read-only post-apply verification ─────────────────────────────────
-- 1. Summary: every row's got must equal expect.
--    (The CHECK row reads 0 on a server older than MySQL 8.0.16, which parses
--    and ignores CHECK. QA ran 8.4.9 on 2026-09-17; confirm Production's
--    VERSION() before relying on the backstop there.)
SELECT 'seven tables present' AS what, COUNT(*) AS got, 7 AS expect
  FROM information_schema.tables
 WHERE table_schema = DATABASE()
   AND table_name IN ('tbl_qs_ep_upload_batch', 'tbl_qs_ep_roster', 'tbl_qs_ep_primary_target',
                      'tbl_qs_ep_secondary_target', 'tbl_qs_ep_timechamp_daily', 'tbl_qs_ep_ivr_daily',
                      'tbl_qs_ep_job_spoc')
UNION ALL SELECT 'all seven are InnoDB', COUNT(*), 7
  FROM information_schema.tables
 WHERE table_schema = DATABASE() AND engine = 'InnoDB'
   AND table_name IN ('tbl_qs_ep_upload_batch', 'tbl_qs_ep_roster', 'tbl_qs_ep_primary_target',
                      'tbl_qs_ep_secondary_target', 'tbl_qs_ep_timechamp_daily', 'tbl_qs_ep_ivr_daily',
                      'tbl_qs_ep_job_spoc')
UNION ALL SELECT 'roster upsert key: PRIMARY (month, crm_key)', COUNT(*), 2
  FROM information_schema.statistics
 WHERE table_schema = DATABASE() AND table_name = 'tbl_qs_ep_roster' AND index_name = 'PRIMARY'
UNION ALL SELECT 'primary target upsert key: PRIMARY (month, person_key)', COUNT(*), 2
  FROM information_schema.statistics
 WHERE table_schema = DATABASE() AND table_name = 'tbl_qs_ep_primary_target' AND index_name = 'PRIMARY'
UNION ALL SELECT 'secondary target upsert key: PRIMARY (month, person_key)', COUNT(*), 2
  FROM information_schema.statistics
 WHERE table_schema = DATABASE() AND table_name = 'tbl_qs_ep_secondary_target' AND index_name = 'PRIMARY'
UNION ALL SELECT 'TimeChamp replaced per date: PRIMARY (work_date, name_key)', COUNT(*), 2
  FROM information_schema.statistics
 WHERE table_schema = DATABASE() AND table_name = 'tbl_qs_ep_timechamp_daily' AND index_name = 'PRIMARY'
UNION ALL SELECT 'one TimeChamp row per (date, employee id)', COUNT(*), 2
  FROM information_schema.statistics
 WHERE table_schema = DATABASE() AND table_name = 'tbl_qs_ep_timechamp_daily'
   AND index_name = 'uq_qs_ep_tc_date_employee' AND non_unique = 0
UNION ALL SELECT 'IVR replaced per date: PRIMARY (call_date, agent_key)', COUNT(*), 2
  FROM information_schema.statistics
 WHERE table_schema = DATABASE() AND table_name = 'tbl_qs_ep_ivr_daily' AND index_name = 'PRIMARY'
UNION ALL SELECT 'frozen SPOC: one row per job_id', COUNT(*), 1
  FROM information_schema.statistics
 WHERE table_schema = DATABASE() AND table_name = 'tbl_qs_ep_job_spoc' AND index_name = 'PRIMARY'
UNION ALL SELECT 'name keys are binary-collated', COUNT(*), 6
  FROM information_schema.columns
 WHERE table_schema = DATABASE() AND collation_name = 'utf8mb4_bin'
   AND ((table_name = 'tbl_qs_ep_roster' AND column_name = 'crm_key')
     OR (table_name IN ('tbl_qs_ep_primary_target', 'tbl_qs_ep_secondary_target') AND column_name = 'person_key')
     OR (table_name = 'tbl_qs_ep_timechamp_daily' AND column_name IN ('name_key', 'employee_id'))
     OR (table_name = 'tbl_qs_ep_ivr_daily' AND column_name = 'agent_key'))
UNION ALL SELECT 'spoc_user_id is NULLABLE', COUNT(*), 1
  FROM information_schema.columns
 WHERE table_schema = DATABASE() AND is_nullable = 'YES'
   AND table_name = 'tbl_qs_ep_job_spoc' AND column_name = 'spoc_user_id'
UNION ALL SELECT 'no DB-clock default on any datetime', COUNT(*), 0
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name IN ('tbl_qs_ep_upload_batch', 'tbl_qs_ep_roster', 'tbl_qs_ep_primary_target',
                      'tbl_qs_ep_secondary_target', 'tbl_qs_ep_timechamp_daily', 'tbl_qs_ep_ivr_daily',
                      'tbl_qs_ep_job_spoc')
   AND data_type IN ('datetime', 'timestamp')
   AND (column_default IS NOT NULL OR extra LIKE '%on update%')
UNION ALL SELECT 'no foreign keys in or out', COUNT(*), 0
  FROM information_schema.referential_constraints
 WHERE constraint_schema = DATABASE()
   AND (table_name IN ('tbl_qs_ep_upload_batch', 'tbl_qs_ep_roster', 'tbl_qs_ep_primary_target',
                       'tbl_qs_ep_secondary_target', 'tbl_qs_ep_timechamp_daily', 'tbl_qs_ep_ivr_daily',
                       'tbl_qs_ep_job_spoc')
     OR referenced_table_name IN ('tbl_qs_ep_upload_batch', 'tbl_qs_ep_roster', 'tbl_qs_ep_primary_target',
                                  'tbl_qs_ep_secondary_target', 'tbl_qs_ep_timechamp_daily',
                                  'tbl_qs_ep_ivr_daily', 'tbl_qs_ep_job_spoc'))
UNION ALL SELECT 'CHECK constraints enforced (MySQL 8.0.16+)', COUNT(*), 9
  FROM information_schema.table_constraints
 WHERE table_schema = DATABASE() AND constraint_type = 'CHECK'
   AND table_name IN ('tbl_qs_ep_upload_batch', 'tbl_qs_ep_roster', 'tbl_qs_ep_primary_target',
                      'tbl_qs_ep_secondary_target', 'tbl_qs_ep_timechamp_daily', 'tbl_qs_ep_ivr_daily',
                      'tbl_qs_ep_job_spoc');

-- 2. Every column, to compare against the CREATE statements above (catches a
--    table an older draft left behind, which IF NOT EXISTS would keep).
SELECT table_name, column_name, column_type, is_nullable, column_default, collation_name
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name IN ('tbl_qs_ep_upload_batch', 'tbl_qs_ep_roster', 'tbl_qs_ep_primary_target',
                      'tbl_qs_ep_secondary_target', 'tbl_qs_ep_timechamp_daily', 'tbl_qs_ep_ivr_daily',
                      'tbl_qs_ep_job_spoc')
 ORDER BY table_name, ordinal_position;

-- 3. Every key, column by column.
SELECT table_name, index_name, seq_in_index, column_name, non_unique
  FROM information_schema.statistics
 WHERE table_schema = DATABASE()
   AND table_name IN ('tbl_qs_ep_upload_batch', 'tbl_qs_ep_roster', 'tbl_qs_ep_primary_target',
                      'tbl_qs_ep_secondary_target', 'tbl_qs_ep_timechamp_daily', 'tbl_qs_ep_ivr_daily',
                      'tbl_qs_ep_job_spoc')
 ORDER BY table_name, index_name, seq_in_index;

-- ── Hand verification once uploads are live (read-only) ───────────────
--
-- 1. Upload history, newest first:
-- SELECT b.batch_id, b.uploaded_on, u.user_name AS uploaded_by, b.file_name, b.sheets, b.date_from, b.date_to, b.month_from, b.month_to FROM tbl_qs_ep_upload_batch b LEFT JOIN tbl_user u ON u.user_id = b.uploaded_by ORDER BY b.batch_id DESC LIMIT 20;
--
-- 2. Coverage per day — what is stored:
-- SELECT work_date, COUNT(*) AS tc_rows FROM tbl_qs_ep_timechamp_daily GROUP BY work_date ORDER BY work_date DESC LIMIT 45;
-- SELECT call_date, COUNT(*) AS ivr_rows FROM tbl_qs_ep_ivr_daily GROUP BY call_date ORDER BY call_date DESC LIMIT 45;
--
-- 3. Months with an emp detail, and their size:
-- SELECT month, COUNT(*) AS people, SUM(team_name = '') AS no_team FROM tbl_qs_ep_roster GROUP BY month ORDER BY month DESC;
--
-- 4. How far the freeze has diverged from the current mapping (jobs whose
--    frozen SPOC is no longer an active Primary SPOC of their client), and how
--    many jobs are frozen as unattributed:
-- SELECT COUNT(*) AS moved_since_capture FROM tbl_qs_ep_job_spoc s JOIN tbl_job j ON j.job_id = s.job_id WHERE s.spoc_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tbl_vertical_mapping vm WHERE vm.client_id = j.fk_client_id AND vm.user_type = 1 AND (vm.status IS NULL OR vm.status = 1) AND vm.user_id = s.spoc_user_id);
-- SELECT COUNT(*) AS frozen_unattributed FROM tbl_qs_ep_job_spoc WHERE spoc_user_id IS NULL;
