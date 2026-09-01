-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-01 — HRMS profile: date of birth + payout bank details
--
-- WHY HERE AND NOT ON tbl_user: tbl_user is the LEGACY table shared by five
-- services and CLAUDE.md forbids altering it. tbl_user_personal_details
-- (2026-08-03) was created for exactly this — it was named for the CONTACT /
-- PERSONAL concept rather than for "personal email" so that the next field in
-- this shape would be an ADD COLUMN here instead of a fourth side table keyed
-- on the same user_id. This is that next field, twice over. Additive only.
-- NOTHING on tbl_user is touched.
--
-- Every ADD COLUMN is wrapped in an information_schema.columns existence probe
-- (the idiom from 2026-08-13-ensure-easyfixer-withdrawal-storage.sql), so
-- re-running this file on a host that already has the columns is a no-op rather
-- than an ER_DUP_FIELDNAME. `ALTER TABLE … ADD COLUMN IF NOT EXISTS` is NOT
-- used: it is MariaDB-only syntax and this is MySQL.
--
-- ── Column notes ────────────────────────────────────────────────────────
-- date_of_birth        DATE, not DATETIME. A birthday has no time-of-day, and
--                      storing one would drag the +05:30 session-timezone
--                      question into a value that has no clock. The upcoming-
--                      birthdays read matches on MONTH/DAY only and must never
--                      project the YEAR or an age.
--                      NULLABLE: ~7.5k existing users have no DOB. The app
--                      grants exactly ONE free self-service set while this is
--                      NULL; every later change goes through the approval
--                      queue in tbl_user_profile_update_request.
-- bank_account_number  VARCHAR(32). Indian account numbers run 9–18 digits, but
--                      the column is a STRING, not a number: leading zeros are
--                      significant and an INT would silently eat them.
--                      Deliberately NOT indexed and NOT unique — a joint or
--                      family account legitimately repeats across employees.
-- bank_ifsc            VARCHAR(16). An IFSC is exactly 11 characters
--                      (AAAA0BBBBBB); 16 is headroom, and the FORMAT is
--                      enforced in the application
--                      (/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/), never by the schema —
--                      a CHECK constraint here could not be relaxed without
--                      another ALTER on a table five services read.
-- bank_account_name    VARCHAR(120). The name as it appears at the bank, which
--                      is NOT always tbl_user.user_name — that mismatch is the
--                      single most common cause of a rejected payout, so it is
--                      captured separately rather than inferred.
-- bank_name            VARCHAR(120). Free text, not a FK to a bank master. No
--                      bank master exists in easyfix_core that covers CRM
--                      users, and inventing one would be a new shared table
--                      for a field nobody aggregates on.
--
-- All five are NULLABLE with no DEFAULT. Requiredness is an APPLICATION rule
-- (routes/admin + services), exactly as personal_email is: a NOT NULL column
-- would mean back-filling every legacy user before anyone could be edited.
-- ─────────────────────────────────────────────────────────────────────

-- ── Dry run (read-only) — what does this host have BEFORE the write? ──
-- Expect the base 2026-08-03 columns and none of the five below on a host that
-- has never had this applied; expect all of them on a re-run.
SELECT column_name, data_type, character_maximum_length, is_nullable
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_user_personal_details'
 ORDER BY ordinal_position;

DELIMITER $$

DROP PROCEDURE IF EXISTS _ensure_hrms_personal_detail_columns$$
CREATE PROCEDURE _ensure_hrms_personal_detail_columns()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_user_personal_details'
       AND column_name = 'date_of_birth'
  ) THEN
    ALTER TABLE tbl_user_personal_details
      ADD COLUMN date_of_birth DATE NULL DEFAULT NULL AFTER personal_email;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_user_personal_details'
       AND column_name = 'bank_account_number'
  ) THEN
    ALTER TABLE tbl_user_personal_details
      ADD COLUMN bank_account_number VARCHAR(32) NULL DEFAULT NULL AFTER date_of_birth;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_user_personal_details'
       AND column_name = 'bank_ifsc'
  ) THEN
    ALTER TABLE tbl_user_personal_details
      ADD COLUMN bank_ifsc VARCHAR(16) NULL DEFAULT NULL AFTER bank_account_number;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_user_personal_details'
       AND column_name = 'bank_account_name'
  ) THEN
    ALTER TABLE tbl_user_personal_details
      ADD COLUMN bank_account_name VARCHAR(120) NULL DEFAULT NULL AFTER bank_ifsc;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_user_personal_details'
       AND column_name = 'bank_name'
  ) THEN
    ALTER TABLE tbl_user_personal_details
      ADD COLUMN bank_name VARCHAR(120) NULL DEFAULT NULL AFTER bank_account_name;
  END IF;
END$$

DELIMITER ;

CALL _ensure_hrms_personal_detail_columns();
DROP PROCEDURE _ensure_hrms_personal_detail_columns;

-- ── Read-only post-apply verification ─────────────────────────────────
-- Must list all five new columns alongside the original three.
SELECT column_name, data_type, character_maximum_length, is_nullable
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_user_personal_details'
 ORDER BY ordinal_position;
