-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-01 — HRMS field encryption: the RECOVERY PUBLIC KEY store
--
-- WHAT: one row per recovery keypair ever used, holding its PUBLIC half and
-- its fingerprint. Exactly one row is ACTIVE; every superseded row stays.
--
-- ══════════════════════════════════════════════════════════════════════
-- WHY THE KEY LIVES IN THE DATABASE AND NOT IN env
-- ══════════════════════════════════════════════════════════════════════
-- EASYFIX_FIELD_RECOVERY_PUBLIC_KEY (lib/field-crypto.js) is the BOOTSTRAP —
-- it is what a database with no row here falls back to, and it is what seeds
-- the first row. It cannot be the permanent home, because rotating a key that
-- lives in env means a deploy: a new task definition, an approval, a restart,
-- and a window in which half the replicas seal to the old key and half to the
-- new one. A recovery key that can only be rotated by shipping is a recovery
-- key that never gets rotated, which is the same as not having a rotation
-- story at all.
--
-- NOTHING SECRET IS IN THIS TABLE. The PUBLIC half of an RSA keypair is safe
-- in git, in a screenshot and in a database dump — sealing needs only the
-- public key, opening needs the private half, and the private half is BORN IN
-- THE OPERATOR'S BROWSER (WebCrypto) and never reaches this server, its logs
-- or its memory. That asymmetry is the whole feature: the application can
-- write a break-glass path it cannot itself walk. A private key column here
-- would undo it in one ALTER, so there is deliberately no place to put one.
--
-- ══════════════════════════════════════════════════════════════════════
-- WHY HISTORY IS KEPT AND THE ACTIVE ROW IS NEVER OVERWRITTEN
-- ══════════════════════════════════════════════════════════════════════
-- Generating a new recovery keypair does NOT retroactively protect the rows
-- already written: each of those has its data key SEALED to the OLD public
-- key, and only the OLD private key can open it. So a row encountered after a
-- rotation has to be able to say WHICH recovery key it wants — and it says so
-- by fingerprint, which is meaningless unless the superseded key is still
-- identifiable here. `UPDATE … SET public_key = <new>` would erase exactly
-- the record needed at the moment someone is holding three PEMs from three
-- years and asking which one opens this row.
--
-- That is also why re-sealing exists (services/field-rekey.service.js, mode
-- `reseal`): with the OLD private key in hand, every data key can be unsealed
-- and re-sealed to the NEW public key, at which point the leaked key really is
-- worthless. Without the old private key, existing rows keep no break-glass
-- path — the data is NOT lost (the operational key still reads it perfectly),
-- only the emergency door is gone, and it returns as rows are rewritten.
--
-- ══════════════════════════════════════════════════════════════════════
-- WHY "EXACTLY ONE ACTIVE" IS NOT ENFORCED BY THIS SCHEMA
-- ══════════════════════════════════════════════════════════════════════
-- MySQL cannot express it, and every shape that looks like it can is worse:
--
--   * There is NO partial / filtered unique index. `UNIQUE (is_active) WHERE
--     is_active = 1` is PostgreSQL and SQL Server syntax with no MySQL
--     equivalent.
--   * A plain `UNIQUE (is_active)` permits one row with 1 AND ONE ROW WITH 0 —
--     i.e. it caps the whole table at two rows and makes the SECOND rotation
--     fail with an opaque ER_DUP_ENTRY. That destroys the history this table
--     exists to keep.
--   * The generated-column-of-NULLs trick (`active_flag` = 1 when active, NULL
--     otherwise, UNIQUE) does work, at the cost of a generated column on a
--     table we would then have to keep migrating, and of a schema that reads as
--     a puzzle. For a table that gains a row every few YEARS, that is a poor
--     trade.
--
-- So the invariant is owned by services/field-rekey.service.js
-- (storeRecoveryPublicKey), inside a TRANSACTION: it deactivates every active
-- row and inserts/reactivates the new one in one atomic step. The transaction
-- is the load-bearing part — a deactivate-then-insert without one leaves a
-- window with ZERO active keys, during which every encrypted write fails
-- closed. `idx_active` below is what makes the deactivating UPDATE and the
-- "which key is live" read index lookups rather than scans.
--
-- SHARED-DB RULE — THE DOCUMENTED EXCEPTION
--   CLAUDE.md forbids altering the shared easyfix_core schema; its stated
--   carve-out is an EASYFIX-OWNED NEW TABLE THAT NO LEGACY SERVICE REFERENCES,
--   already taken by tbl_pincode (2026-05-01), tbl_user_allowed_stages
--   (2026-07-29), tbl_user_personal_details (2026-08-03) and
--   tbl_sensitive_reveal_log (hrms-03). This table is written by
--   services/field-rekey.service.js and read by lib/field-crypto.js in this
--   backend, and by nothing legacy. NOTHING existing is altered by this file.
--
-- ── Column notes ────────────────────────────────────────────────────────
-- fingerprint      The PUBLIC NAME of the key: a SHA-256 prefix over the key's
--                  DER SPKI bytes, computed by the application so it cannot
--                  disagree with the key it names. UNIQUE — the same key must
--                  never appear twice, or "which row is this envelope sealed
--                  to" stops having one answer. It is the value the envelope
--                  carries, and therefore the join between a row of ciphertext
--                  and the key that can open it.
--                  DERIVED, never operator-assigned: a hand-typed id can be
--                  typo'd or reused across environments, and then two keys
--                  claim one name at exactly the moment someone is trusting it.
-- public_key       The SPKI PEM, multi-line, verbatim as generated. TEXT rather
--                  than VARCHAR because an RSA-4096 SPKI PEM is ~800 bytes and
--                  a future larger key must not need an ALTER. Stored as the
--                  PEM and not as DER so an operator can diff it against the
--                  file in their notes by eye.
--                  NAMED `public_key`, NOT `public_key_pem`, and the name is a
--                  CONTRACT: lib/field-crypto.js::keyFromRow reads
--                  `row.public_key` and cross-checks `row.fingerprint` against
--                  the bytes it derives. A row from this table is therefore fed
--                  to that module UNMAPPED, so there is no translation layer
--                  between the two to drift out of step.
-- is_active        TINYINT(1). Exactly one row carries 1 — see above for why
--                  the schema does not say so. Rows with 0 are SUPERSEDED, not
--                  deleted: they are how a row sealed years ago is matched to
--                  the PEM that opens it.
-- created_on       DATETIME written by the app as new Date(); the pool's +05:30
--                  session timezone (db.js) stores the IST wall clock verbatim.
--                  NO DEFAULT CURRENT_TIMESTAMP — the container clock is UTC, so
--                  a DB-side default would silently mix two timezones into one
--                  column (same reasoning as hrms-03).
-- created_by       tbl_user.user_id of the operator who registered the key.
--                  NULLABLE: the bootstrap row can be seeded by hand from env
--                  with no session behind it. No FK — the legacy schema does
--                  not use them here.
--
-- NOT STORED, DELIBERATELY: the PRIVATE key, or any part of it. There is no
-- column for one and there must never be. If a future migration adds one, this
-- feature has been inverted into the thing it protects against.
--
-- IDEMPOTENCY
--   Fully re-runnable: the CREATE is IF NOT EXISTS and nothing else writes.
--   Keys are registered through POST /api/admin/field-rekey/recovery-key, not
--   through SQL, so that the one-active invariant is held by the code that owns
--   it rather than by whoever happens to be at a prompt.
--
-- HOW TO APPLY
--   Run each statement in order. Plain CREATE — no prepared statements, no
--   @-variables, no PREPARE/EXECUTE, nothing MariaDB-specific.
-- ─────────────────────────────────────────────────────────────────────

-- ── Dry run (read-only) — does this host already have the table? ──────
-- Zero rows = a fresh apply. One row = a re-run, and the CREATE below is a
-- no-op via IF NOT EXISTS.
SELECT table_name, engine, table_rows
  FROM information_schema.tables
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_field_recovery_key';

CREATE TABLE IF NOT EXISTS tbl_field_recovery_key (
  id              INT NOT NULL AUTO_INCREMENT,
  fingerprint     VARCHAR(64) NOT NULL,
  public_key      TEXT NOT NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 0,
  created_on      DATETIME NOT NULL,
  created_by      INT NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_recovery_fingerprint (fingerprint),
  KEY idx_recovery_active (is_active, id)
) ENGINE=InnoDB;

-- ── Read-only post-apply verification ─────────────────────────────────
-- Expect the six columns above, then the unique fingerprint index and the
-- active lookup index.
SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_field_recovery_key'
 ORDER BY ordinal_position;

SELECT index_name, seq_in_index, column_name, non_unique
  FROM information_schema.statistics
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_field_recovery_key'
 ORDER BY index_name, seq_in_index;

-- ── Hand verification once the feature is live (read-only) ────────────
--
-- 1. THE INVARIANT. This must return exactly 1, always. A 0 means every
--    encrypted WRITE is failing closed (no key to seal to); a 2+ means the
--    service's transaction was bypassed — most likely by someone inserting a
--    row by hand — and which key new rows are sealed to is now a race.
-- SELECT COUNT(*) AS active_keys FROM tbl_field_recovery_key WHERE is_active = 1;
--
-- 2. The history, newest first. Every fingerprint here is one that some row of
--    ciphertext may still name; NONE of them is safe to delete.
-- SELECT id, fingerprint, is_active, created_on, created_by FROM tbl_field_recovery_key ORDER BY id DESC;
--
-- 3. NO PRIVATE KEY MAY EVER APPEAR HERE. The table has no column for one;
--    this confirms the shape has not been extended with one later:
-- SHOW CREATE TABLE tbl_field_recovery_key;
