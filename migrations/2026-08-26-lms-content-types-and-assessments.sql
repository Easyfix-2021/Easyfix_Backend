-- ─────────────────────────────────────────────────────────────────────
-- 2026-08-26 — LMS phase 4 + 5: a course becomes a list of CONTENT ITEMS,
--              and assessments become a kind of item
--
-- WHY NOW, AND WHY TOGETHER
--   A course is currently an ordered list of VIDEOS: course_videos holds
--   (course_id, video_id, sequence) and the admin API literally takes
--   `video_ids`. Adding PPTs or MCQs on top of that shape means bolting a
--   second ordered list beside the first, and then answering "what is item
--   3 of this course?" by merging two tables that each think they own
--   sequence. That is the retrofit worth avoiding, so ordering moves onto
--   the item before a second kind of item exists.
--
--   Phases 4 and 5 ship together because an assessment is not a feature
--   bolted to a course — it is a content KIND. Building the kinds first and
--   the MCQs after would mean designing lms_content twice.
--
-- THE MODEL
--   lms_content is the ordered list. Each row says WHAT kind and WHICH
--   thing, and owns the sequence. The thing itself lives in its own table:
--   a video in the legacy training_videos, a document in lms_document, an
--   assessment in lms_assessment.
--
--   COMPLETION IS DERIVED PER KIND, never stored twice:
--     video      — easyfixer_watched_video.watched_percentage = 100
--                  (the legacy Java service also writes that table; a second
--                  copy of video progress would be a second truth)
--     assessment — a passing row in lms_assessment_attempt
--     document   — a row in lms_document_ack
--
--   So there is no lms_content_progress table. Completion for a course is
--   "every item of it is complete", evaluated per kind.
--
-- SHARED-DB RULE
--   Every table here is new and EasyFix-owned; no legacy table is altered.
--   utf8mb4 throughout, because question and option text must hold Hindi —
--   training_videos is MyISAM latin1 and is exactly why question text
--   cannot hang off it.
--
-- NAMING
--   `lms_assessment`, never a bare `assessment`. tbl_easyfixer_assessment
--   already exists and is onboarding vetting — police verification,
--   behaviour, video call — nothing to do with training. The word is taken.
--
-- COURSE_VIDEOS
--   Kept, not dropped, and backfilled into lms_content below. Dropping it
--   in the same migration that introduces its replacement leaves no way
--   back if a read is missed; retiring it is a later, separate decision
--   once nothing selects from it.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. The ordered content list ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS lms_content (
  id INT NOT NULL AUTO_INCREMENT,
  course_id INT NOT NULL,
  kind ENUM('video','document','assessment') NOT NULL,
  ref_id INT NOT NULL,
  sequence INT NOT NULL DEFAULT 0,
  status TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lms_content_item (course_id, kind, ref_id),
  KEY idx_lms_content_course_seq (course_id, sequence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ─── 2. Documents (PPT, PDF) ─────────────────────────────────────────
-- file_key is an S3 object key, not a URL: utils/s3-storage.js presigns on
-- read, and a stored URL would either expire or have to be public.

CREATE TABLE IF NOT EXISTS lms_document (
  id INT NOT NULL AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  file_key VARCHAR(512) NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  size_bytes BIGINT NULL,
  page_count INT NULL,
  status TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME NULL,
  created_by INT NULL,
  PRIMARY KEY (id),
  KEY idx_lms_document_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ─── 3. Assessments and their questions ──────────────────────────────
-- pass_percent and max_attempts sit on the assessment, not in config: two
-- assessments in one course can legitimately differ, and a global setting
-- would have to be overridden the first time they do.

CREATE TABLE IF NOT EXISTS lms_assessment (
  id INT NOT NULL AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  pass_percent TINYINT NOT NULL DEFAULT 70,
  max_attempts TINYINT NOT NULL DEFAULT 3,
  status TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lms_question (
  id INT NOT NULL AUTO_INCREMENT,
  assessment_id INT NOT NULL,
  question_text TEXT NOT NULL,
  sequence INT NOT NULL DEFAULT 0,
  status TINYINT NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY idx_lms_question_assessment (assessment_id, sequence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lms_question_option (
  id INT NOT NULL AUTO_INCREMENT,
  question_id INT NOT NULL,
  option_text VARCHAR(500) NOT NULL,
  is_correct TINYINT NOT NULL DEFAULT 0,
  sequence INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_lms_option_question (question_id, sequence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ─── 4. Attempts ─────────────────────────────────────────────────────
-- One row per attempt, never overwritten. easyfixer_courses.score holds the
-- best score for reporting, but it is ONE SCALAR and cannot answer "how many
-- times did they try" — which is the question the LMS action tool's D3
-- detector was written for and could not ask.
--
-- course_id is denormalised on purpose: the same assessment can sit in two
-- courses, and an attempt belongs to the course the technician was working
-- through. Without it, "score for this course" is ambiguous.

CREATE TABLE IF NOT EXISTS lms_assessment_attempt (
  id INT NOT NULL AUTO_INCREMENT,
  easyfixer_id INT NOT NULL,
  assessment_id INT NOT NULL,
  course_id INT NULL,
  attempt_no INT NOT NULL,
  score_pct DECIMAL(5,2) NOT NULL,
  passed TINYINT NOT NULL DEFAULT 0,
  created_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lms_attempt (easyfixer_id, assessment_id, attempt_no),
  KEY idx_lms_attempt_lookup (easyfixer_id, assessment_id, passed)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ─── 5. Document acknowledgement ─────────────────────────────────────
-- A PPT has no watch percentage, so "complete" is the technician saying they
-- read it. Keyed on the CONTENT row rather than the document, so the same
-- PDF in two courses must be acknowledged for each — which is what a course
-- completion claim means.

CREATE TABLE IF NOT EXISTS lms_document_ack (
  id INT NOT NULL AUTO_INCREMENT,
  easyfixer_id INT NOT NULL,
  content_id INT NOT NULL,
  acknowledged_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lms_doc_ack (easyfixer_id, content_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ─── 6. Backfill the existing video content ──────────────────────────
-- Idempotent through uq_lms_content_item. NOW() here is the DATABASE
-- server's clock, not the app pool's IST-converted one — acceptable for a
-- backfill stamp on rows whose real creation time was never recorded, and
-- noted so nobody reads these as authoritative IST timestamps.

INSERT IGNORE INTO lms_content (course_id, kind, ref_id, sequence, status, created_at, updated_at)
SELECT cv.course_id, 'video', cv.video_id, cv.sequence, 1, NOW(), NOW() FROM course_videos cv;


-- ─── 7. "Training Videos" becomes "Content" ──────────────────────────
-- RENAMED, not replaced. The menu row carries every role grant in
-- tbl_role.menu_ids, its menu_action key, and its entry in the
-- new.crm.visible.menu.ids allowlist. Inserting a new leaf would need all
-- three seeded again and would leave the old one to be retired; renaming
-- carries the whole permission graph across untouched.
--
-- The url token stays 'lmsVideos' for the same reason — grants are keyed on
-- the menu row, but the CRM's URL_MAP resolves the token, so repointing
-- happens there (src/lib/legacy-url-map.ts: 'lmsVideos' -> '/lms/content').
--
-- Videos are not gone: they are the first tab of the new page. The sidebar
-- is a hard two-level tree (Sidebar.tsx::buildTree re-parents grandchildren),
-- so Content cannot have Training Videos nested UNDER it as a third level —
-- the kinds are tabs within one page, which is also where they belong,
-- because an operator building a course moves between them constantly.

UPDATE tbl_menu SET menu_name = 'Content' WHERE url = 'lmsVideos' AND menu_name = 'Training Videos';
