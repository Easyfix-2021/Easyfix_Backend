-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-01 — HRMS profile: date of birth + payout bank details
--
-- ⚠ TWO OF THESE COLUMNS HOLD CIPHERTEXT, NOT VALUES. bank_account_number and
--   bank_account_name are written and read ONLY through lib/field-crypto.js
--   (AES-256-GCM, `v1:<iv>:<tag>:<ct>`). Their widths and the extra
--   bank_account_last4 column below exist for that reason. Full rationale in
--   the column notes; the sibling audit table is
--   2026-09-01-hrms-03-create-tbl-sensitive-reveal-log.sql.
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
-- bank_account_number  VARCHAR(255), holding a CIPHERTEXT, not a number. Indian
--                      account numbers run 9–18 digits and leading zeros are
--                      significant, so the plaintext was always a STRING rather
--                      than an INT — but what actually lands here is the
--                      `v1:<iv>:<tag>:<ct>` envelope produced by
--                      lib/field-crypto.js, which is roughly 4x the plaintext
--                      (base64 of a 12-byte IV + a 16-byte tag + the payload).
--                      32 characters could not hold it; 255 fits the widest
--                      account number this feature accepts with room to spare,
--                      and lib/field-crypto refuses to emit anything longer so
--                      a non-STRICT host can never truncate a ciphertext into
--                      an undecryptable one.
--                      Deliberately NOT indexed and NOT unique — a joint or
--                      family account legitimately repeats across employees,
--                      and a random IV per value makes two rows holding the
--                      same account number differ anyway, so an index on this
--                      column could not answer a single useful question.
-- bank_ifsc            VARCHAR(16), CLEAR. An IFSC is exactly 11 characters
--                      (AAAA0BBBBBB); 16 is headroom, and the FORMAT is
--                      enforced in the application
--                      (/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/), never by the schema —
--                      a CHECK constraint here could not be relaxed without
--                      another ALTER on a table five services read.
--                      NOT ENCRYPTED, deliberately: an IFSC is a PUBLISHED RBI
--                      branch code, identical for every employee banking at
--                      that branch. Encrypting it would protect nothing and
--                      would make the column ungroupable and undebuggable.
-- bank_account_name    VARCHAR(255), holding a CIPHERTEXT. The name as it
--                      appears at the bank, which is NOT always
--                      tbl_user.user_name — that mismatch is the single most
--                      common cause of a rejected payout, so it is captured
--                      separately rather than inferred. It is ENCRYPTED because
--                      it is the PII that ties an account number to a person:
--                      the number alone is a string, the number plus the holder
--                      is a payment instruction. Widened from 120 for the same
--                      ~4x envelope reason as the account number; the PLAINTEXT
--                      limit stays 120 and is enforced in the application.
-- bank_account_last4   VARCHAR(4), CLEAR, and clear ON PURPOSE. The masked
--                      display ('••••1234') is what every list and profile read
--                      renders, and deriving those four digits from the
--                      ciphertext would mean an AES decryption per row per
--                      render — turning a routine list into the one place the
--                      key is exercised thousands of times a day. Four digits
--                      identify a payout on a bank statement; they do not
--                      reconstruct an account.
-- bank_name            VARCHAR(120), CLEAR. Free text, not a FK to a bank
--                      master. No bank master exists in easyfix_core that
--                      covers CRM users, and inventing one would be a new
--                      shared table for a field nobody aggregates on. Not
--                      encrypted for the same reason as the IFSC: it is a
--                      lookup label, and the IFSC already names the bank.
--
-- ── WHY TWO COLUMNS ARE ENCRYPTED AND THREE ARE NOT ─────────────────────
-- The account NUMBER is the secret and the holder NAME is the PII that ties it
-- to a person; those two are the payment instruction. The IFSC, the bank name
-- and the last four are either public, a label, or deliberately non-identifying.
-- Encrypting the whole family would buy nothing and cost every grouping, every
-- ORDER BY and every "which branch is this" support question.
--
-- THE KEY IS NOT IN THE DATABASE. It is env EASYFIX_FIELD_ENC_KEY (32 raw bytes,
-- base64). A dump of this table without that env var yields no account numbers.
-- That is the entire threat model this buys: it does NOT protect against an
-- attacker who has the application's environment, and it is not meant to.
--
-- All six are NULLABLE with no DEFAULT. Requiredness is an APPLICATION rule
-- (routes/admin + services), exactly as personal_email is: a NOT NULL column
-- would mean back-filling every legacy user before anyone could be edited.
-- ─────────────────────────────────────────────────────────────────────

-- ── Dry run (read-only) — what does this host have BEFORE the write? ──
-- Expect the base 2026-08-03 columns and none of the six below on a host that
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
      ADD COLUMN bank_account_number VARCHAR(255) NULL DEFAULT NULL AFTER date_of_birth;
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
      ADD COLUMN bank_account_name VARCHAR(255) NULL DEFAULT NULL AFTER bank_ifsc;
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

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_user_personal_details'
       AND column_name = 'bank_account_last4'
  ) THEN
    ALTER TABLE tbl_user_personal_details
      ADD COLUMN bank_account_last4 VARCHAR(4) NULL DEFAULT NULL AFTER bank_name;
  END IF;
END$$

DELIMITER ;

CALL _ensure_hrms_personal_detail_columns();
DROP PROCEDURE _ensure_hrms_personal_detail_columns;

-- ── Read-only post-apply verification ─────────────────────────────────
-- Must list all six new columns alongside the original three, and the two
-- encrypted ones must read character_maximum_length = 255. A 32 or a 120 there
-- means an OLDER version of this file was applied to this host first: the
-- ciphertext will not fit, and on a non-STRICT server it will be TRUNCATED
-- rather than rejected — silently unrecoverable. Widen before writing anything:
--   ALTER TABLE tbl_user_personal_details MODIFY bank_account_number VARCHAR(255) NULL DEFAULT NULL;
--   ALTER TABLE tbl_user_personal_details MODIFY bank_account_name   VARCHAR(255) NULL DEFAULT NULL;
SELECT column_name, data_type, character_maximum_length, is_nullable
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_user_personal_details'
 ORDER BY ordinal_position;

-- Nothing may be readable here. Once the feature is live this must return only
-- `v1:`-prefixed envelopes and NULLs — a bare account number in either column
-- means a write bypassed lib/field-crypto.js, which is a defect, not a variant.
SELECT user_id,
       LEFT(bank_account_number, 3) AS acct_prefix,
       LEFT(bank_account_name, 3)   AS name_prefix,
       bank_account_last4, bank_ifsc, bank_name
  FROM tbl_user_personal_details
 WHERE bank_account_number IS NOT NULL
 ORDER BY user_id
 LIMIT 20;
