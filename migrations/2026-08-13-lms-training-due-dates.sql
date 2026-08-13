-- =============================================================================
-- LMS training deadlines — assignment duration, due date, completion date.
--
-- WHAT THIS DOES
--   Adds two columns to easyfixer_courses (the technician <-> course
--   assignment table) plus one index:
--
--     due_date         DATE     when the training must be finished by
--     completion_date  DATETIME when it actually was
--
-- WHY THE DURATION ITSELF IS NOT STORED
--   The operator picks "3 months" and the date is derived from it, so an
--   earlier draft of this migration also kept duration_months/duration_days
--   alongside. They are deliberately gone: the DATE is the fact every query,
--   reminder and restriction reads, and a second representation of the same
--   decision is a second thing that can disagree with it. The moment a
--   deadline is extended, a stored "3 months" is no longer true of the row it
--   sits on — it would describe the original assignment while due_date
--   described the current one. One column, one truth.
--
-- WHY completion_date IS SEPARATE FROM THE PROGRESS TABLE
--   easyfixer_watched_video records per-VIDEO progress with an update_date, so
--   "when did they finish the course" is only derivable as a MAX() across a
--   join that has to know the course's content at that moment — and course
--   content changes. Stamping the course-level completion when it happens
--   makes it a fact rather than a reconstruction.
--
-- WHY THE INDEX
--   The overdue lookup runs on the technician hot path (every mobile request
--   resolves lifecycle capabilities) and in the daily reminder cron's fan-out.
--   Both filter by easyfixer_id and then by due_date / completion_date. The
--   table is empty today, so the index is free to add now and expensive to
--   add later.
--
-- SHARED-DB NOTE
--   easyfixer_courses is a dormant legacy table with no legacy writer and 0
--   rows (verified 2026-08-13); EasyFix is now its only consumer. All four
--   changes are ADDITIVE — nothing is dropped, renamed or retyped, so a reader
--   that does not know these columns is unaffected.
--
-- HOW TO APPLY
--   Run statement-by-statement. On a re-run expect, and ignore:
--     "Duplicate column name" / "Duplicate key name idx_efr_course_due"
--
-- POST-APPLY
--   Section 3 seeds the two properties that control the daily reminder cron.
--   Both are read ONCE at server start, so a restart/redeploy is required
--   after changing either.
--     training.reminder.enabled  'false' -> the cron does not register
--     training.reminder.cron     '0 10 * * *' -> send time, IST
--   To turn the reminder on: set training.reminder.enabled to 'true' and
--   restart. Trigger Now on the Scheduled Jobs page works either way, so
--   delivery can be proven before enabling the daily fan-out.
-- =============================================================================

-- ─── 1. The deadline, and whether it was met ─────────────────────────
-- Both NULL-able on purpose. NULL due_date = "no deadline set", which is a
-- legitimate assignment and must never be treated as overdue. NULL
-- completion_date = not yet finished.
ALTER TABLE easyfixer_courses ADD COLUMN due_date DATE NULL;

ALTER TABLE easyfixer_courses ADD COLUMN completion_date DATETIME NULL;

-- ─── 2. Overdue lookup index ─────────────────────────────────────────
-- Column order matches the predicate: narrow to the technician first, then
-- the date range, with completion_date last so the "not yet finished" filter
-- is satisfied from the index rather than by reading the row.
ALTER TABLE easyfixer_courses ADD KEY idx_efr_course_due (easyfixer_id, due_date, completion_date);

-- ─── 3. Cron properties ──────────────────────────────────────────────
-- These rows must EXIST for ops to be able to change them: the properties API
-- is read-only (GET + reload — see routes/admin/properties.js), so there is no
-- way to create a property from the CRM. A key that was never seeded can only
-- be added by SQL, which is exactly the manual step this section removes.
--
-- Seeded 'false', unlike the attendance reminder which was seeded 'true'
-- (migrations/executed/2026-06-28-enable-attendance-reminder.sql). This one
-- pushes DAILY and its overdue message tells a technician their app is
-- restricted — that should start on a deliberate decision, not on a migration.
--
-- Idempotent: only inserts when the key is absent, so re-running never
-- clobbers a value ops has already changed.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'training.reminder.enabled', 'false'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'training.reminder.enabled');

-- The SEND TIME. Seeded with the same value the code falls back to, so the
-- default is visible and editable rather than buried in server/scheduler.js.
-- 10:00 IST is an hour after the attendance nudge so the two never land together.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'training.reminder.cron', '0 10 * * *'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'training.reminder.cron');

-- ─── 4. Verify ───────────────────────────────────────────────────────
SELECT 'due_date' AS what, COUNT(*) AS present FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'easyfixer_courses' AND column_name = 'due_date'
UNION ALL
SELECT 'completion_date', COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'easyfixer_courses' AND column_name = 'completion_date'
UNION ALL
SELECT 'idx_efr_course_due', COUNT(DISTINCT index_name) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'easyfixer_courses' AND index_name = 'idx_efr_course_due'
UNION ALL
SELECT 'training.reminder.enabled', COUNT(*) FROM easyfix_properties WHERE property_key = 'training.reminder.enabled'
UNION ALL
SELECT 'training.reminder.cron', COUNT(*) FROM easyfix_properties WHERE property_key = 'training.reminder.cron';
