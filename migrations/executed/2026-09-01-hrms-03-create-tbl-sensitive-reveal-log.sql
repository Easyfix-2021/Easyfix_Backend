-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-01 — HRMS profile: audit log for every REVEAL of an encrypted
--              bank value
--
-- WHAT: one row per successful reveal of a decrypted account number / account
-- holder name — from a user opening their own details (POST
-- /api/profile/bank/reveal) or from HR opening the bank block of a request they
-- are about to approve (POST /api/admin/profile-update-requests/:id/reveal).
--
-- ══════════════════════════════════════════════════════════════════════
-- WHY THIS TABLE IS THE POINT, AND THE ENCRYPTION IS ONLY HALF OF IT
-- ══════════════════════════════════════════════════════════════════════
-- Encrypting bank_account_number stops the DATABASE from being the leak: a
-- dump without EASYFIX_FIELD_ENC_KEY yields nothing. It does absolutely nothing
-- about the other leak, which is a person with a legitimate login reading their
-- colleagues' account numbers one at a time through a screen that was built to
-- show them. No cipher can distinguish that from the approval it is supposed
-- to support, because it IS the approval, performed for the wrong reason.
--
-- What makes that visible is attribution after the fact. So the values are
-- masked by default everywhere (lists, the profile payload, the approvals
-- queue), they cross the wire ONLY when someone deliberately clicks reveal,
-- and every one of those clicks lands here with a name on it. An HR user who
-- opens forty different employees' bank details in an afternoon has left forty
-- rows in this table; without it they have left nothing at all.
--
-- The write happens INSIDE the same transaction that reads the value and
-- BEFORE the response is sent. An audit written afterwards — in a `.then()`, in
-- a fire-and-forget, after the res.json — is exactly the audit that is missing
-- when the process is killed, the connection drops, or the pool is exhausted,
-- which is to say precisely during the incident it exists to explain.
--
-- SHARED-DB RULE — THIS IS THE DOCUMENTED EXCEPTION
--   CLAUDE.md forbids altering the shared `easyfix_core` schema. Its stated
--   carve-out is an EASYFIX-OWNED NEW TABLE THAT NO LEGACY SERVICE REFERENCES,
--   already used by tbl_pincode (2026-05-01), tbl_user_allowed_stages
--   (2026-07-29), tbl_user_personal_details (2026-08-03) and
--   tbl_easyfixer_sensitive_change_log (2026-08-17). This table is written by
--   services/profile-self.service.js and
--   services/profile-update-request.service.js in this backend and read by
--   nothing legacy. NOTHING existing is altered by this file.
--
-- ── RELATIONSHIP TO tbl_easyfixer_sensitive_change_log (2026-08-17) ─────
-- That table records CHANGES to a technician's payout account — who moved the
-- money, and did the technician consent. This one records READS of a CRM user's
-- payout account. Different subject table (tbl_user vs tbl_easyfixer),
-- different event (read vs write), different question. Folding reveals into the
-- change log would put two event classes with disjoint columns in one table and
-- make "every change to this account" and "every read of this account" the same
-- query, which is the one distinction an investigation actually needs.
--
-- ── Column notes ────────────────────────────────────────────────────────
-- actor_user_id     tbl_user.user_id of the PERSON WHO CLICKED. NOT NULL —
--                   there is no unattributed reveal: both routes sit behind
--                   requireAuth, and a row without an actor would be a row that
--                   answers nothing. No FK constraint (the legacy schema does
--                   not use them here, and a tbl_user write must never be
--                   blockable by this table).
-- subject_user_id   tbl_user.user_id whose bank details were revealed. Equal to
--                   actor_user_id on the self-service route — deliberately
--                   stored rather than left NULL, so "every read of MY details"
--                   is ONE predicate instead of a predicate plus a special case,
--                   and so a self-read is visibly a self-read rather than a
--                   missing value.
-- context           WHICH surface produced the reveal: 'profile_self' or
--                   'profile_update_request'. VARCHAR, not ENUM — a third
--                   reveal surface must not require an ALTER on a table the
--                   shared-DB rule says we should stop touching.
-- ref_id            The row the reveal was about, when there is one: the
--                   request_id for 'profile_update_request'. NULL for
--                   'profile_self', which reveals the live record and has no
--                   second id to name. Meaningless without `context` — the two
--                   are read as a pair, which is why there is no FK and no
--                   index on ref_id alone.
-- revealed_on       DATETIME written by the app as new Date(); the pool's
--                   +05:30 session timezone (db.js) stores the IST wall clock
--                   verbatim. NO DEFAULT CURRENT_TIMESTAMP — the container
--                   clock is UTC, so a DB-side default would silently mix two
--                   timezones into one column and nothing would report it (same
--                   reasoning as executed/2026-08-03-create-tbl-user-personal-
--                   details.sql and 2026-08-17-easyfixer-sensitive-change-log.sql).
--
-- NOT STORED, DELIBERATELY: the revealed VALUE, or any part of it. A log that
-- copied the account number would be an append-only, never-purged, unmasked
-- ledger of every account number ever viewed — strictly more dangerous than the
-- encrypted column it audits, and it would answer no question the pair
-- (subject_user_id, revealed_on) does not already answer.
--
-- INDEXES
--   (subject_user_id, revealed_on) — "who has read MY bank details", the
--                                    question an employee or a DPO asks.
--   (actor_user_id, revealed_on)   — "what has this person been reading", the
--                                    sweep that finds the forty-in-an-afternoon
--                                    pattern above.
--
-- HOW TO APPLY
--   Run each statement in order. Plain CREATE — no prepared statements, no
--   @-variables, no PREPARE/EXECUTE, nothing MariaDB-specific. Works identically
--   in MySQL CLI, DataGrip, DBeaver and Workbench.
--
-- IDEMPOTENCY
--   Fully re-runnable: the CREATE is IF NOT EXISTS. No permission seeds here —
--   the reveal routes reuse the isProfileApprovalProcess key seeded by the HRMS
--   RBAC migration (the admin route) and plain authentication (the self route),
--   so there is nothing new to grant.
-- ─────────────────────────────────────────────────────────────────────

-- ── Dry run (read-only) — does this host already have the table? ──────
-- Zero rows = a fresh apply. One row = a re-run, and the CREATE below is a
-- no-op via IF NOT EXISTS.
SELECT table_name, engine, table_rows
  FROM information_schema.tables
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_sensitive_reveal_log';

-- ip_address (added before first apply, 2026-09-01): the sibling audit table
-- tbl_easyfixer_sensitive_change_log carries one, and an audit row that cannot
-- say WHERE a reveal came from answers half the question it exists to answer.
-- Added now because this migration has never been applied anywhere — it is a
-- free edit today and an ALTER on a growing audit table afterwards. NULLABLE
-- on purpose: a reveal must never fail because the address could not be
-- resolved. A missing address is a worse audit row; a missing ROW is no audit
-- at all.
CREATE TABLE IF NOT EXISTS tbl_sensitive_reveal_log (
  id              INT NOT NULL AUTO_INCREMENT,
  actor_user_id   INT NOT NULL,
  subject_user_id INT NOT NULL,
  context         VARCHAR(64) NOT NULL,
  ref_id          INT NULL DEFAULT NULL,
  ip_address      VARCHAR(64) NULL DEFAULT NULL,
  revealed_on     DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_reveal_subject (subject_user_id, revealed_on),
  KEY idx_reveal_actor (actor_user_id, revealed_on)
) ENGINE=InnoDB;

-- ── Read-only post-apply verification ─────────────────────────────────
-- Expect the six columns above, then both secondary indexes.
SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_sensitive_reveal_log'
 ORDER BY ordinal_position;

SELECT index_name, seq_in_index, column_name, non_unique
  FROM information_schema.statistics
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_sensitive_reveal_log'
 ORDER BY index_name, seq_in_index;

-- ── Hand verification once the feature is live (read-only) ────────────
--
-- 1. Every reveal, newest first, with the actor and the subject NAMED. This is
--    the query the whole table exists to serve:
-- SELECT l.revealed_on, l.context, l.ref_id, a.user_name AS actor, s.user_name AS subject FROM tbl_sensitive_reveal_log l LEFT JOIN tbl_user a ON a.user_id = l.actor_user_id LEFT JOIN tbl_user s ON s.user_id = l.subject_user_id ORDER BY l.id DESC LIMIT 50;
--
-- 2. The sweep: who is reading OTHER people's details, and how often. A self
--    reveal is unremarkable; volume against colleagues is the signal.
-- SELECT a.user_name AS actor, COUNT(*) AS reveals, COUNT(DISTINCT l.subject_user_id) AS distinct_subjects FROM tbl_sensitive_reveal_log l LEFT JOIN tbl_user a ON a.user_id = l.actor_user_id WHERE l.actor_user_id <> l.subject_user_id GROUP BY l.actor_user_id, a.user_name ORDER BY reveals DESC;
--
-- 3. NO ACCOUNT NUMBER MAY EVER APPEAR HERE. The table has no column for one;
--    this confirms the shape has not been extended with one later:
-- SHOW CREATE TABLE tbl_sensitive_reveal_log;
