-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-01 — HRMS profile: date of birth and bank details on
-- tbl_user_personal_details.
--
-- tbl_user is NEVER altered — easyfix_core is shared by five legacy services
-- and that rule protects them. tbl_user_personal_details is EasyFix-owned
-- (created 2026-08-03, no legacy service references it), which is the
-- documented exception, so the new columns go here.
--
-- ── COLUMN NOTES ─────────────────────────────────────────────────────
--   date_of_birth        DATE. Set ONCE by the employee, then locked; a
--                        correction goes through HR approval.
--   bank_account_number  ENCRYPTED. AES-256-GCM envelope, see
--   bank_account_name    ENCRYPTED. lib/field-crypto.js.
--   bank_ifsc            CLEAR — a published RBI branch code, not a secret.
--   bank_name            CLEAR — a lookup label.
--   bank_account_last4   CLEAR — so a masked list renders without decrypting
--                        every row.
--
-- ── WHY VARCHAR(2048) FOR THE TWO ENCRYPTED COLUMNS ──────────────────
-- The envelope is ~835 characters of fixed overhead before any payload: two
-- key fingerprints, three IV/tag pairs, and a 684-character RSA-sealed data
-- key. Measured worst case — a 120-character holder name at 4 bytes per
-- character — is 1475. 2048 is that rounded up with headroom, because the
-- alternative to headroom is another ALTER on a table five services read.
-- MAX_CIPHERTEXT_CHARS in lib/field-crypto.js and this width must change
-- together.
--
-- ── PLAIN STATEMENTS, NO STORED PROCEDURE ────────────────────────────
-- This file previously wrapped the ALTERs in a procedure to make them
-- conditional. That is gone. `DELIMITER` is not SQL — it is a mysql-CLIENT
-- directive — so a file containing it cannot be run from DBeaver, a driver,
-- or any tool that is not the mysql CLI, which is exactly when someone needs
-- to run a migration by hand at speed.
--
-- The cost is that these statements are NOT idempotent: re-running an
-- ADD COLUMN that already exists errors. That is why step 1 exists. READ IT
-- FIRST — it tells you precisely which of the six columns are already there,
-- and you run only the statements for the ones that are missing. A migration
-- that requires a human to look is a smaller problem than one that cannot be
-- opened in the tool the human has.
--
-- ── IF THE COLUMNS ALREADY EXIST AT VARCHAR(255) ─────────────────────
-- An earlier draft of this file created bank_account_number and
-- bank_account_name at VARCHAR(255). If step 1 shows that, run step 3 —
-- WITHOUT it, the first real write is silently TRUNCATED and that row is
-- permanently undecryptable. Skip step 3 when step 1 already shows 2048.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. READ THIS FIRST — what already exists ────────────────────────
-- Run only the step-2 statements whose column is absent here, and run step 3
-- only if the two encrypted columns show 255.
SELECT column_name, data_type, character_maximum_length, is_nullable
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_user_personal_details'
 ORDER BY ordinal_position;


-- ─── 2. Add the columns ──────────────────────────────────────────────
-- One statement per line. Skip any whose column step 1 already listed.
ALTER TABLE tbl_user_personal_details ADD COLUMN date_of_birth DATE NULL DEFAULT NULL AFTER personal_email;

ALTER TABLE tbl_user_personal_details ADD COLUMN bank_account_number VARCHAR(2048) NULL DEFAULT NULL AFTER date_of_birth;

ALTER TABLE tbl_user_personal_details ADD COLUMN bank_ifsc VARCHAR(16) NULL DEFAULT NULL AFTER bank_account_number;

ALTER TABLE tbl_user_personal_details ADD COLUMN bank_account_name VARCHAR(2048) NULL DEFAULT NULL AFTER bank_ifsc;

ALTER TABLE tbl_user_personal_details ADD COLUMN bank_name VARCHAR(120) NULL DEFAULT NULL AFTER bank_account_name;

ALTER TABLE tbl_user_personal_details ADD COLUMN bank_account_last4 VARCHAR(4) NULL DEFAULT NULL AFTER bank_name;


-- ─── 3. ONLY IF step 1 showed the two encrypted columns at 255 ───────
-- Widening is safe and loses nothing. NARROWING them would truncate stored
-- ciphertext into rows that can never be decrypted, so never reverse these.
ALTER TABLE tbl_user_personal_details MODIFY COLUMN bank_account_number VARCHAR(2048) NULL DEFAULT NULL;

ALTER TABLE tbl_user_personal_details MODIFY COLUMN bank_account_name VARCHAR(2048) NULL DEFAULT NULL;


-- ─── 4. Verify ───────────────────────────────────────────────────────
-- Expect six rows, and 2048 for both encrypted columns.
SELECT column_name, data_type, character_maximum_length, is_nullable
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_user_personal_details'
   AND column_name IN ('date_of_birth', 'bank_account_number', 'bank_ifsc', 'bank_account_name', 'bank_name', 'bank_account_last4')
 ORDER BY ordinal_position;
