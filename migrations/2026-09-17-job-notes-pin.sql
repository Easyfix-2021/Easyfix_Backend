-- ============================================================================
-- 2026-09-17 — tbl_job_notes: pin a note so it stays on top
--
-- WHAT: three nullable/defaulted columns on tbl_job_notes.
--   is_pinned          TINYINT(1) NOT NULL DEFAULT 0 — pinned notes list first
--   pinned_on          DATETIME NULL                 — when it was (last) pinned
--   pinned_by_user_id  INT NULL                      — tbl_user.user_id of who pinned it
--
-- WHY COLUMNS AND NOT A SIDE TABLE: a pin is a property of one note, several
-- notes on a job may be pinned, and the list query already reads this table —
-- a column keeps it one SELECT with one ORDER BY.
--
-- WHY IT IS SAFE ON A LEGACY TABLE: the Java CRM stopped writing tbl_job_notes
-- at the 2026-04-29 cutover (last row that day), and every column added here
-- has a default or is nullable, so any INSERT that names its columns — the
-- only writer left is services/job-notes.service.js — is unaffected. 3,303
-- rows on QA (2026-09-16): an instant ALTER.
--
-- pinned_by_user_id is an ID, unlike note_created_by (a display name): these
-- columns are new and ours, so they follow the rest of the schema rather than
-- the legacy column's lossy convention. The API resolves it to a name.
--
-- The service PROBES for is_pinned (SHOW COLUMNS) and degrades to "no pins"
-- until this runs, so deploying the code first cannot 500 the notes list.
-- ============================================================================

ALTER TABLE tbl_job_notes ADD COLUMN is_pinned TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE tbl_job_notes ADD COLUMN pinned_on DATETIME NULL DEFAULT NULL;
ALTER TABLE tbl_job_notes ADD COLUMN pinned_by_user_id INT NULL DEFAULT NULL;
