-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-01 — HRMS profile: the profile photo pointer.
--
-- One column on tbl_user_personal_details, which EasyFix owns. tbl_user is
-- never altered — easyfix_core is shared by five legacy services.
--
-- ── COLUMN NOTE ──────────────────────────────────────────────────────
--   profile_image_key  The S3 object key, WITHOUT a file extension. The MIME
--                      type rides on the object's Content-Type, which is the
--                      repo's convention for every uploaded image (2026-05-15)
--                      — and here the type is determined from the file's magic
--                      bytes, never from what the client declared, because on
--                      an upload route reachable by every authed user a
--                      declared MIME is an assertion by the uploader.
--
--                      NULL means "no photo", and it is the ONLY
--                      representation of that. Never '' — two spellings of
--                      absence means every reader has to know both.
--
-- ── PLAIN STATEMENTS, NO STORED PROCEDURE ────────────────────────────
-- This file previously wrapped the ALTER in a procedure to make it
-- conditional. `DELIMITER` is not SQL — it is a mysql-CLIENT directive — so
-- the file could not be run from DBeaver or any driver, which is exactly the
-- tool someone reaches for when running a migration by hand.
--
-- The trade is that step 2 is not idempotent: re-running it when the column
-- exists errors. Step 1 is how you know. Read it, then run step 2 only if the
-- column is absent.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. READ THIS FIRST ──────────────────────────────────────────────
-- If profile_image_key already appears here, skip step 2 entirely.
SELECT column_name, data_type, character_maximum_length, is_nullable
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_user_personal_details'
 ORDER BY ordinal_position;


-- ─── 2. Add the column ───────────────────────────────────────────────
ALTER TABLE tbl_user_personal_details ADD COLUMN profile_image_key VARCHAR(255) NULL DEFAULT NULL;


-- ─── 3. Verify ───────────────────────────────────────────────────────
SELECT column_name, data_type, character_maximum_length, is_nullable
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_user_personal_details'
   AND column_name = 'profile_image_key';
