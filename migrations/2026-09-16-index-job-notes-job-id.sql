-- ============================================================================
-- 2026-09-16 — tbl_job_notes(job_id): the index the table never had
--
-- WHAT: one secondary index on tbl_job_notes (job_id, id).
--
-- WHY NOW: tbl_job_notes is the legacy Java CRM's free-text ops notepad. Until
-- today NOTHING in this repo referenced it — the table was written by a service
-- that no longer runs (last row 2026-04-29, the cutover) and read by nobody.
-- GET /api/admin/jobs/:id/notes changes that: the note list is fetched on every
-- job open from the Schedule & Assign console, keyed on job_id.
--
-- WHY IT MATTERS MORE THAN THE ROW COUNT SUGGESTS. Measured on QA 2026-09-16:
--
--     rows                3,303
--     distinct job_id     3,013        (≈1.1 notes per job — highly selective)
--     indexes             PRIMARY(id), and nothing else
--
-- 3,303 rows is nothing to scan once. It is not nothing to scan on EVERY job
-- open, from every operator, forever — and the count only goes up now that the
-- table has a writer again. This is the cheap moment to add it: the index is
-- measured in tens of kilobytes today.
--
-- ─── WHY (job_id, id) AND NOT (job_id) ALONE ────────────────────────────────
--
-- The read is:
--     SELECT … WHERE job_id = ? ORDER BY note_created_on DESC, id DESC
-- so job_id alone already turns the scan into a seek. `id` is appended because
-- it is the PK and therefore in the index leaf regardless — naming it costs no
-- extra bytes and makes the covering intent explicit to the next reader.
--
-- note_created_on is deliberately NOT in the index. It would let the sort be
-- index-ordered, but the service orders by (note_created_on DESC, id DESC) and
-- a job's notes are a handful of rows: MySQL sorts them in memory in
-- microseconds. Indexing a column to avoid sorting three rows is write cost for
-- no read.
--
-- ─── THE COLUMN THIS INDEX DOES NOT FIX ─────────────────────────────────────
--
-- note_created_by holds a DISPLAY NAME, not a user id — 3,303 of 3,303 rows are
-- non-numeric and match tbl_user.user_name. The new POST writes names too, to
-- match, so attribution stays lossy (two people can share a name; a rename
-- orphans old rows). That is a schema decision on a legacy table, not something
-- an index can repair, and it is recorded in services/job-notes.service.js so
-- nobody re-derives it. NOT changed here: this migration adds an index and
-- nothing else.
--
-- ─── OPERATIONAL ────────────────────────────────────────────────────────────
--
-- CREATE INDEX is ALGORITHM=INPLACE on MySQL 8 — the table stays readable and
-- writable throughout, with a brief metadata lock at each end. On 3,303 rows
-- this is effectively instantaneous; no off-peak window needed.
--
-- Additive only: no column added, dropped or altered, no row rewritten, no data
-- touched. Safe to run before or after the application deploy — the endpoints
-- work either way, just with a scan until this lands.
--
-- ⚠ NOT IDEMPOTENT: MySQL has no CREATE INDEX IF NOT EXISTS, and this repo's
-- convention is plain statements (no @set / PREPARE / MariaDB-only syntax). Re-
-- running errors with "Duplicate key name", which is safe and loud. Verify with
-- the SHOW INDEX below rather than by re-running.
-- ============================================================================

CREATE INDEX idx_job_notes_job_id ON tbl_job_notes (job_id, id);

-- Verify (read-only) — the new index, and the read it serves.
SHOW INDEX FROM tbl_job_notes;

EXPLAIN SELECT id, notes, job_stage, note_created_on, note_created_by
          FROM tbl_job_notes
         WHERE job_id = 1
         ORDER BY note_created_on DESC, id DESC;
