-- ============================================================================
-- 2026-09-29 — training videos: server-side check on watch progress
--
-- WHAT: two nullable columns.
--   easyfixer_watched_video.first_watched_at  DATETIME NULL — the technician's
--       first progress report for this video; set on INSERT, never overwritten
--   training_videos.duration_seconds          INT NULL      — entered in the CRM
--
-- WHY: POST /api/mobile/training-videos/percentage takes a bare number, so an
-- API caller could post 100 for a video never played. setTrainingPercentage
-- (services/mobile-profile-extra.service.js) now caps the credit at
-- floor(elapsed / duration x 100) + WATCH_TOLERANCE_PCT. A video with no
-- duration is not checked.
--
-- WHY IT IS SAFE: both columns are nullable with no default, so the legacy Java
-- JPA writer (which does not map them) is unaffected. Rows that predate the
-- column get first_watched_at on their next report, backdated by the progress
-- they already hold.
--
-- The code PROBES both columns (lms.service.js LMS_FLAG_COLUMNS) and skips the
-- check until this runs. Both are listed in scripts/schema-verify.js EXPECTED,
-- so run this BEFORE deploying the code to an environment: the boot gate
-- blocks a container whose schema lacks them.
-- ============================================================================

ALTER TABLE easyfixer_watched_video ADD COLUMN first_watched_at DATETIME NULL DEFAULT NULL;
ALTER TABLE training_videos ADD COLUMN duration_seconds INT NULL DEFAULT NULL;
