-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-02 — HRMS profile: the HR master-data identifiers on
-- tbl_user_personal_details — UAN, PAN, Aadhaar, date of joining, address.
--
-- tbl_user is NEVER altered — easyfix_core is shared by five legacy services
-- and that rule protects them. tbl_user_personal_details is EasyFix-owned
-- (created 2026-08-03, extended 2026-09-01 by hrms-01), which is the
-- documented exception, so the new columns go here.
--
-- ── WHY THESE FIVE AND NOT THE REST OF THE SPREADSHEET ───────────────
-- Every field was checked against tbl_user first, and only the ones with no
-- equivalent there are added. The check found:
--
--   date of joining  NOT on tbl_user. insert_date is the CRM ACCOUNT row's
--                    creation date — a different fact: an employee who joined
--                    years before the CRM existed, or who got a login months
--                    after joining, has an insert_date that is not their
--                    joining date. → added.
--   aadhaar / pan    NOT on tbl_user → added.
--   uan              NOT on tbl_user → added.
--   address          NOT on tbl_user → added.
--
--                    tbl_user DOES carry pin_code / city / state / district,
--                    and it is tempting to read those as "the address is
--                    already there". THEY ARE A DIFFERENT FACT. Those four
--                    describe where the user is POSTED — they drive city
--                    scoping, job routing and the region filters, and they
--                    change when someone transfers branch. `address` here is
--                    the employee's own PERSONAL address off the HR master
--                    sheet, and it does not change when they transfer.
--
--                    So this column is NOT a duplicate of them and must never
--                    be back-filled from them, or kept in step with them. It
--                    is stored whole (one free-text value, which is the shape
--                    the HR sheet holds) rather than split into its own
--                    pincode/city/state, because nothing reads it
--                    structurally — it is correspondence text, not a scope.
--
-- ── WHAT IS ENCRYPTED, AND WHY NOT ALL OF IT ────────────────────────
-- The test hrms-01 applied to the bank columns: is the value already
-- published to the employee in the ordinary course of business, and does
-- holding it enable someone to impersonate them?
--
--   pan             ENCRYPTED. AES-256-GCM envelope (lib/field-crypto.js). A
--                   taxpayer identity — with a name and a date of birth it is
--                   enough to impersonate someone to a bank or a tax portal.
--   aadhaar         ENCRYPTED, same envelope. India's strongest civil
--                   identifier; storing 12 clear digits per employee makes
--                   this table worth stealing on its own.
--   pan_last4       CLEAR — so a profile page or an admin list renders a
--   aadhaar_last4   masked value without decrypting every row. Derived from
--                   the plaintext at write time, exactly like
--                   bank_account_last4.
--   uan             CLEAR. A 12-digit EPFO account number, printed on every
--                   payslip and quoted on every PF transfer form. Treating it
--                   as a secret would be theatre, and HR needs to read it back
--                   to verify what they typed.
--   date_of_joining CLEAR. Appears on the org chart and every offer letter.
--   address         CLEAR. Correspondence text, already collected in the
--                   clear for technicians; encrypting it would break the only
--                   thing anyone does with it (read it).
--
-- NOTE ON THE ASYMMETRY WITH TECHNICIANS: tbl_easyfixer.adhaar_card_number is
-- a legacy CLEAR column. It is not the precedent for this table — it predates
-- lib/field-crypto.js and cannot be changed without touching five services.
-- New storage gets the envelope.
--
-- VARCHAR(2048) for the two encrypted columns is not generous, it is the
-- envelope size: ~835 characters of fixed overhead (two key fingerprints,
-- three IV/tag pairs, a 684-character RSA-sealed data key) before any payload.
-- It matches the existing encrypted columns for the reason they chose it —
-- the alternative to headroom is another ALTER on a table five services read.
--
-- ⚠ ADDING THE COLUMN IS HALF THE JOB. `pan` and `aadhaar` are also added to
-- the `pan` and `aadhaar` groups in services/field-rekey.service.js. A
-- protected column missing from that registry is silently SKIPPED by a key
-- rotation, and its rows become undecryptable the moment the old key retires.
--
-- ── PLAIN STATEMENTS, NO STORED PROCEDURE ────────────────────────────
-- One statement per line, no DELIMITER, no PREPARE — a file containing them
-- cannot be run from DBeaver or any tool that is not the mysql CLI, which is
-- exactly when someone needs to run a migration by hand at speed. The cost is
-- that these are NOT idempotent: re-running an ADD COLUMN that already exists
-- errors. That is why step 1 exists. READ IT FIRST and run only the
-- statements for the columns it shows are missing.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. READ THIS FIRST — what already exists ────────────────────────
SELECT column_name, data_type, character_maximum_length, is_nullable
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_user_personal_details'
 ORDER BY ordinal_position;


-- ─── 2. Add the columns ──────────────────────────────────────────────
-- Skip any whose column step 1 already listed.
ALTER TABLE tbl_user_personal_details ADD COLUMN date_of_joining DATE NULL DEFAULT NULL AFTER date_of_birth;

ALTER TABLE tbl_user_personal_details ADD COLUMN uan VARCHAR(12) NULL DEFAULT NULL AFTER date_of_joining;

ALTER TABLE tbl_user_personal_details ADD COLUMN pan VARCHAR(2048) NULL DEFAULT NULL AFTER uan;

ALTER TABLE tbl_user_personal_details ADD COLUMN pan_last4 VARCHAR(4) NULL DEFAULT NULL AFTER pan;

ALTER TABLE tbl_user_personal_details ADD COLUMN aadhaar VARCHAR(2048) NULL DEFAULT NULL AFTER pan_last4;

ALTER TABLE tbl_user_personal_details ADD COLUMN aadhaar_last4 VARCHAR(4) NULL DEFAULT NULL AFTER aadhaar;

ALTER TABLE tbl_user_personal_details ADD COLUMN address VARCHAR(512) NULL DEFAULT NULL AFTER aadhaar_last4;


-- ─── 3. Verify ───────────────────────────────────────────────────────
-- Expect seven rows, and 2048 for both pan and aadhaar.
SELECT column_name, data_type, character_maximum_length, is_nullable
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_user_personal_details'
   AND column_name IN ('date_of_joining', 'uan', 'pan', 'pan_last4', 'aadhaar', 'aadhaar_last4', 'address')
 ORDER BY ordinal_position;
