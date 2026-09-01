-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-01 — HRMS profile: date of birth + payout bank details
--
-- ⚠ TWO OF THESE COLUMNS HOLD CIPHERTEXT, NOT VALUES. bank_account_number and
--   bank_account_name are written and read ONLY through lib/field-crypto.js
--   (ENVELOPE ENCRYPTION —
--   `v2:<op_fp>:<rec_fp>:<dek_iv>:<dek_tag>:<dek_ct>:<sealed_dek>:<iv>:<tag>:<ct>`).
--   Their widths and the extra bank_account_last4 column below exist for that
--   reason. Full rationale in the column notes; the sibling audit table is
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
-- bank_account_number  VARCHAR(2048), holding an ENVELOPE, not a number. Indian
--                      account numbers run 9–18 digits and leading zeros are
--                      significant, so the plaintext was always a STRING rather
--                      than an INT — but what actually lands here is the v2
--                      envelope produced by lib/field-crypto.js.
--
--                      WHY 2048 AND NOT 255. The envelope carries a per-value
--                      DATA KEY twice over: wrapped under the operational key,
--                      and sealed to an RSA-4096 RECOVERY PUBLIC KEY so the
--                      value survives the operational key being lost. That
--                      sealed copy alone is 512 bytes → 684 base64 characters.
--                      Fixed overhead, in characters:
--                            'v2'                             2
--                            9 colons                         9
--                            2 key fingerprints (8 hex each)  16
--                            dek iv    12 B → ceil(12/3)*4    16
--                            dek tag   16 B                   24
--                            dek ct    32 B                   44
--                            sealed dek 512 B                684
--                            value iv  12 B                   16
--                            value tag 16 B                   24
--                            ────────────────────────────── = 835
--                      plus the value at ceil(n/3)*4 for n PLAINTEXT BYTES.
--                      Worst case is the 120-CHARACTER holder-name limit at 4
--                      UTF-8 bytes per character: 480 B → 640 chars → 1475
--                      total. 2048 is that number rounded up with real headroom
--                      (573 chars ≈ 429 more plaintext bytes), because the
--                      alternative to headroom is another ALTER on a table five
--                      services read. A 32-digit account number is 879.
--                      lib/field-crypto refuses to emit anything longer than
--                      2048 (MAX_CIPHERTEXT_CHARS), so a non-STRICT host can
--                      never truncate an envelope into an undecryptable one —
--                      THOSE TWO NUMBERS MUST BE CHANGED TOGETHER.
--                      Left on the table's default charset rather than forced to
--                      ascii: the content is pure base64 so ascii would be
--                      honest and would quarter the declared byte width, but
--                      InnoDB DYNAMIC stores a long varchar off-page anyway, so
--                      it buys nothing real and introduces a mixed-collation
--                      comparison hazard that does not exist today.
--                      Deliberately NOT indexed and NOT unique — a joint or
--                      family account legitimately repeats across employees,
--                      and a random IV and a random data key per value make two
--                      rows holding the same account number differ anyway, so
--                      an index on this column could not answer a single useful
--                      question.
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
-- bank_account_name    VARCHAR(2048), holding an ENVELOPE. The name as it
--                      appears at the bank, which is NOT always
--                      tbl_user.user_name — that mismatch is the single most
--                      common cause of a rejected payout, so it is captured
--                      separately rather than inferred. It is ENCRYPTED because
--                      it is the PII that ties an account number to a person:
--                      the number alone is a string, the number plus the holder
--                      is a payment instruction. Widened from 120 for the same
--                      envelope reason as the account number, and it is this
--                      column that SETS the width: the arithmetic above is
--                      driven by the 120-character name limit, not by the
--                      32-character account limit. The PLAINTEXT limit stays 120
--                      CHARACTERS and is enforced in the application — which is
--                      not 120 bytes, and the difference is the whole reason
--                      the worst case above is computed at 4 bytes per
--                      character rather than 1.
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
-- THE OPERATIONAL KEY IS NOT IN THE DATABASE. It is env EASYFIX_FIELD_ENC_KEY
-- (32 raw bytes, base64). A dump of this table without that env var yields no
-- account numbers. That is the entire threat model this buys: it does NOT
-- protect against an attacker who has the application's environment, and it is
-- not meant to.
--
-- ── THE SECOND DOOR, AND WHY IT DOES NOT WEAKEN THE FIRST ───────────────
-- Every envelope also carries its data key SEALED TO A RECOVERY PUBLIC KEY, so
-- losing or rotating the operational key is not a data-loss event. That costs
-- nothing in confidentiality: the seal can only be OPENED by the recovery
-- PRIVATE key, which lives in the owner's notes and has never been on a server,
-- in this repository, or in any environment. A dump of this table plus the whole
-- application environment still yields nothing through that door — which is
-- precisely why the recovery key had to be asymmetric rather than a second
-- shared secret. See the header of lib/field-crypto.js.
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
      ADD COLUMN bank_account_number VARCHAR(2048) NULL DEFAULT NULL AFTER date_of_birth;
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
      ADD COLUMN bank_account_name VARCHAR(2048) NULL DEFAULT NULL AFTER bank_ifsc;
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

  -- ── WIDEN AN EXISTING-BUT-NARROW CIPHERTEXT COLUMN ──────────────────────
  -- An earlier draft of this same file created these two at VARCHAR(255), which
  -- was correct for the single-key `v1:` envelope and is 1220 characters short
  -- of the v2 one. The existence probes above are ADD-only: on a host that
  -- already has the columns they are skipped, the column stays at 255, and the
  -- first real write is TRUNCATED — silently, on any host not in STRICT mode —
  -- into an envelope that fails its GCM tag forever after. That is an
  -- unrecoverable row produced by a request that returned 200.
  --
  -- So the width is repaired here rather than left to the post-apply note below,
  -- because a note is only read by someone who already suspects a problem.
  -- Guarded on the LENGTH, so this is a no-op on a correct host and cannot
  -- narrow anything: MODIFY only ever runs when the column is too small.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_user_personal_details'
       AND column_name = 'bank_account_number'
       AND character_maximum_length < 2048
  ) THEN
    ALTER TABLE tbl_user_personal_details
      MODIFY bank_account_number VARCHAR(2048) NULL DEFAULT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_user_personal_details'
       AND column_name = 'bank_account_name'
       AND character_maximum_length < 2048
  ) THEN
    ALTER TABLE tbl_user_personal_details
      MODIFY bank_account_name VARCHAR(2048) NULL DEFAULT NULL;
  END IF;
END$$

DELIMITER ;

CALL _ensure_hrms_personal_detail_columns();
DROP PROCEDURE _ensure_hrms_personal_detail_columns;

-- ── Read-only post-apply verification ─────────────────────────────────
-- Must list all six new columns alongside the original three, and the two
-- encrypted ones must read character_maximum_length = 2048. Anything smaller —
-- 32, 120 or 255 — means the MODIFY guards above did not run, and the first real
-- write will be TRUNCATED rather than rejected on a non-STRICT server, which is
-- silently unrecoverable. Do not write anything until this reads 2048:
--   ALTER TABLE tbl_user_personal_details MODIFY bank_account_number VARCHAR(2048) NULL DEFAULT NULL;
--   ALTER TABLE tbl_user_personal_details MODIFY bank_account_name   VARCHAR(2048) NULL DEFAULT NULL;
SELECT column_name, data_type, character_maximum_length, is_nullable
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_user_personal_details'
 ORDER BY ordinal_position;

-- Nothing may be readable here. Once the feature is live this must return only
-- `v2:`-prefixed envelopes and NULLs — a bare account number in either column
-- means a write bypassed lib/field-crypto.js, which is a defect, not a variant.
-- The two fingerprint fields are shown because they are safe to print (8 hex
-- chars of a SHA-256 digest, not key material) and because they answer the two
-- questions an incident starts with: which operational key would read this row,
-- and which recovery key from the owner's notes could break-glass it.
SELECT user_id,
       SUBSTRING_INDEX(bank_account_number, ':', 3) AS acct_scheme_and_keys,
       SUBSTRING_INDEX(bank_account_name,   ':', 3) AS name_scheme_and_keys,
       LENGTH(bank_account_number) AS acct_len,
       bank_account_last4, bank_ifsc, bank_name
  FROM tbl_user_personal_details
 WHERE bank_account_number IS NOT NULL
 ORDER BY user_id
 LIMIT 20;
