-- ============================================================================
-- 2026-09-29 — "Introduction to Easyfix": the default, undeletable, mandatory course
--
-- Owner, 2026-09-29: one course every technician must finish — new AND existing
-- who have not — videos only, at least one video, never deletable. The
-- technician app's Complete Training = this course + any other active
-- mandatory course. Existing technicians who have not watched it are locked
-- out of job offers in the new app until they do (owner's choice).
--
-- WHAT:
--   1. courses.is_system — marks the one system course. The backend PROBES it
--      (services/lms.service.js LMS_FLAG_COLUMNS), so code and SQL may land in
--      either order; before this runs, is_global keeps gating as it does today.
--   2. The course row: is_mandatory = 1, is_system = 1.
--   3. Its content = today's mandatory catalogue (training_videos.is_global = 1).
--      Completion is per VIDEO id, so everyone who already watched those videos
--      is complete on day one — nothing resets. From here on the course's
--      videos, not is_global, are what every technician must watch.
--   4. Assigned to every active technician (efr_status = 1), no due date.
--   5. Stamped complete for those who have already watched every video in it,
--      with the time of their last watch.
--
-- HOW TO APPLY: statement by statement. Only (1) is not re-runnable — on a
-- re-run it fails with "Duplicate column name 'is_system'", which means it
-- already ran. (2)–(5) are NOT EXISTS / IS NULL guarded and are no-ops on re-run.
-- Run BEFORE or AFTER the backend deploy — either order is safe.
-- Timestamps are IST wall-clock (the pool's +05:30), never the server clock.
-- ============================================================================

-- 1. Column
ALTER TABLE courses ADD COLUMN is_system TINYINT NOT NULL DEFAULT 0;

-- 2. The course
INSERT INTO courses (name, description, status, is_mandatory, is_system, reward_points, certificate_enabled, created_at, updated_at) SELECT 'Introduction to Easyfix', 'Mandatory for every technician before receiving job offers.', 1, 1, 1, NULL, 0, CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'), CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30') FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM courses WHERE is_system = 1);

-- 3. Its videos: today's mandatory catalogue
INSERT INTO lms_content (course_id, kind, ref_id, sequence, status, created_at, updated_at) SELECT c.id, 'video', tv.id, 1, 1, CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'), CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30') FROM courses c JOIN training_videos tv ON tv.is_global = 1 WHERE c.is_system = 1 AND NOT EXISTS (SELECT 1 FROM lms_content lc WHERE lc.course_id = c.id);

-- 4. Assigned to every active technician
INSERT INTO easyfixer_courses (easyfixer_id, course_id, created_at, updated_at, due_date) SELECT e.efr_id, c.id, CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'), CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'), NULL FROM tbl_easyfixer e JOIN courses c ON c.is_system = 1 WHERE e.efr_status = 1 AND NOT EXISTS (SELECT 1 FROM easyfixer_courses ec WHERE ec.easyfixer_id = e.efr_id AND ec.course_id = c.id);

-- 5. Carry over: complete for those who watched every video in it
UPDATE easyfixer_courses ec JOIN courses c ON c.id = ec.course_id AND c.is_system = 1 SET ec.completion_date = (SELECT MAX(w.update_date) FROM easyfixer_watched_video w JOIN lms_content lc ON lc.ref_id = w.video_id AND lc.course_id = c.id AND lc.kind = 'video' AND lc.status = 1 WHERE w.easyfixer_id = ec.easyfixer_id AND w.watched_percentage = 100), ec.updated_at = CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30') WHERE ec.completion_date IS NULL AND EXISTS (SELECT 1 FROM lms_content lc WHERE lc.course_id = c.id AND lc.kind = 'video' AND lc.status = 1) AND NOT EXISTS (SELECT 1 FROM lms_content lc WHERE lc.course_id = c.id AND lc.kind = 'video' AND lc.status = 1 AND NOT EXISTS (SELECT 1 FROM easyfixer_watched_video w WHERE w.easyfixer_id = ec.easyfixer_id AND w.video_id = lc.ref_id AND w.watched_percentage = 100));

-- 6. Verify (read-only)
SELECT c.id, c.name, c.is_mandatory, c.is_system, (SELECT COUNT(*) FROM lms_content lc WHERE lc.course_id = c.id AND lc.status = 1) AS videos, (SELECT COUNT(*) FROM easyfixer_courses ec WHERE ec.course_id = c.id) AS assigned, (SELECT COUNT(*) FROM easyfixer_courses ec WHERE ec.course_id = c.id AND ec.completion_date IS NOT NULL) AS complete FROM courses c WHERE c.is_system = 1;
