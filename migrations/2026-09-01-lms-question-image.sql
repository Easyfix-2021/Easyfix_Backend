-- ============================================================================
-- 2026-09-01 — LMS: image-based assessment questions
--
-- WHAT THIS DOES
--   Adds ONE nullable column to lms_question:
--
--     image_key  VARCHAR(512) NULL   -- S3 object key, never a URL
--
-- WHY A COLUMN AND NOT A TABLE
--   A question has at most one image. A child table buys 0..N, which nobody
--   asked for, and it would need its own delete arm: setAssessmentQuestions()
--   hard-DELETEs and re-INSERTs every question and option on each save, so a
--   child table would orphan rows on every edit. lms_document.file_key already
--   proves the house shape — the key lives as a column on the owning row.
--
-- WHY THE KEY AND NOT A URL
--   Presigned URLs expire (documentUrl() mints them at a 1h TTL per request).
--   Storing one would persist a dead link. VARCHAR(512) matches
--   lms_document.file_key exactly, deliberately.
--
-- NULL IS LOAD-BEARING
--   NULL means "a text-only question" — which is every question that exists
--   today and every question an operator does not add an image to. There is no
--   default and no backfill, so this migration is behaviour-preserving: an
--   existing paper renders byte-for-byte as it does now.
--
-- STRICT, NOT PROBED — a deliberate departure from is_mandatory / is_global
--   Those two are read through lmsFlagColumns() because a WRONG "absent" there
--   silently disables mandatory training platform-wide — a quiet failure worth
--   paying for. A missing image_key is a loud 500 that the pre-swap boot gate
--   (.github/workflows/deploy.yml) catches before traffic moves, so it goes in
--   scripts/schema-verify.js as a hard requirement instead. Do not add it to
--   the probe vocabulary in tests/lms-schema-probe.test.js.
--
-- SAFE FOR THE LEGACY CONSUMER — checked, not assumed
--   grep for `lms_question` across EasyFix_CRM/src and EasyFix_API/src returns
--   ZERO files. The LMS tables are owned solely by EasyFix_Backend; no legacy
--   Java DAO reads or writes them.
--
-- ─── HOW TO APPLY ───────────────────────────────────────────────────────────
--   Run STATEMENT BY STATEMENT, in order, against easyfix.
--   Section 1 is a read-only preflight that says whether section 2 still needs
--   to run. Section 2 is a plain ALTER, deliberately NOT wrapped in
--   `SET @sql := … PREPARE … EXECUTE` (banned in this repo on 2026-05-30) and
--   deliberately not using `ADD COLUMN IF NOT EXISTS` (MariaDB-only).
--
--   ON A RE-RUN, expect and ignore:
--     ERROR 1060 (42S21): Duplicate column name 'image_key'
--
-- IDEMPOTENCY
--   1. Preflight  read-only, always safe.
--   2. ALTER      guarded by the preflight; re-running errors 1060, changes
--                 nothing.
--   3. Verify     read-only.
--
-- POST-APPLY
--   Restart the backend. schema-verify's boot check reads the column list once
--   per process; a process started before this ALTER will fail its next boot
--   check rather than serve a half-known schema.
-- ============================================================================

-- ─── 1. Preflight — does the column already exist? ──────────────────────────
-- Expect 0 rows on a fresh apply (run section 2), 1 row if already applied.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'lms_question'
   AND COLUMN_NAME = 'image_key';

-- ─── 2. The column ──────────────────────────────────────────────────────────
-- S3 object key (the LmsDocuments/<ts>_<rand> shape), never a presigned URL.
ALTER TABLE lms_question ADD COLUMN image_key VARCHAR(512) NULL;

-- ─── 3. Verification ────────────────────────────────────────────────────────
-- Expect exactly one row: image_key / varchar(512) / YES / NULL default.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'lms_question'
   AND COLUMN_NAME = 'image_key';

-- Nothing is backfilled, so with_image must be 0 immediately after apply.
SELECT COUNT(*)                        AS total_questions,
       SUM(image_key IS NOT NULL
           AND image_key <> '')        AS with_image
  FROM lms_question;
