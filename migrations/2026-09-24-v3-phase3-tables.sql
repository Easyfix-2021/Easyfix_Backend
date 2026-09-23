-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-24 — V3 Phase 3: the four tables the job-on-site flow needs.
--
-- ⚠⚠ RUN THIS BEFORE DEPLOYING THE PHASE 3 BACKEND — NOT AFTER. ⚠⚠
--
-- Unlike most migrations here, this one is NOT "safe either side of the
-- deploy". All four tables are in scripts/schema-verify.js EXPECTED as REQUIRED
-- (not FAIL_SOFT, not OPTIONAL), and a required table that does not exist makes
-- bootWouldFail() true: the server REFUSES TO START. On this backend that is
-- not a Phase 3 outage — the CRM, the technician app and the client dashboard
-- all run on it, so deploying the code first takes down all three, in QA or in
-- Production. Order: (1) run this file and the post-apply SELECTs below,
-- (2) confirm four tables, (3) only then deploy the code.
--
-- Also run 2026-09-23-index-job-logs-job-id.sql (dry run FIRST — it may already
-- be satisfied). That one IS safe either side: its schema-verify entry is an
-- index invariant, which only blocks boot under REQUIRE_SCHEMA_INVARIANTS=true.
--
-- WHAT: four NEW EasyFix-owned tables. Nothing existing is altered.
--
--   tbl_job_tx_report       a technician's on-site CLAIM that the desk resolves:
--                           additional work found (3.3), cannot complete (3.6a),
--                           need help (3.5), and the proof + visit-charge record
--                           of a cancel request (3.6b — the request itself stays
--                           on tbl_job.is_cancelled_by_app, where the CRM's
--                           Technician Requests queue already reads it).
--   tbl_job_chat            the in-job chat (3.4). One thread per job — design
--                           sheet 15: "It is not a general inbox".
--   tbl_job_verification    EasyFix check, client QC and the ledger post that
--                           follows it (3.6 / 3.8 / 3.11). One row per job.
--   tbl_client_qc_timing    per-client QC / check windows (3.8). A client with
--                           no row uses easyfix_properties job.qc.hours.default
--                           (24) and job.check.hours.default (2).
--
-- WHY: design sheets 10-15 ("Technician App — The Job" v0.5) turn four things
-- a technician used to PHONE the desk about into rows the desk and the app both
-- read. Services: services/job-tx-report.service.js, job-chat.service.js,
-- job-pending-on.js, job-verification.service.js.
--
-- SHARED-DB RULE — THE DOCUMENTED EXCEPTION, SAME AS
-- executed/2026-09-07-create-tbl-job-permission-request.sql: new tables that no
-- legacy service references. NOTHING existing is altered by this file.
--
-- ══════════════════════════════════════════════════════════════════════
-- IDEMPOTENCY — "ONE OPEN X PER JOB" IS A DB CONSTRAINT, NOT A SELECT FIRST
-- ══════════════════════════════════════════════════════════════════════
-- Copied from tbl_job_permission_request (see its header for the full
-- argument): a read-then-insert is not a guarantee on a phone that retries on a
-- bad connection, so the rule lives in a UNIQUE index over a VIRTUAL generated
-- column that is non-NULL only while the row is open. MySQL allows unlimited
-- NULLs in a UNIQUE index, so resolved history rows never collide.
--
--   tbl_job_tx_report.open_dedupe_key = 'job_id:kind' while status is
--     open | priced | returned — the three states in which the claim is still
--     in flight. approved / resolved / undone are history → NULL.
--   tbl_job_chat UNIQUE (job_id, client_msg_id) — a phone retrying a send gets
--     its first row back. client_msg_id NULL (a desk reply) never collides.
--   tbl_job_verification / tbl_client_qc_timing — the PK is the one-row rule.
--
-- The services catch ER_DUP_ENTRY, re-read and return the winner, so the loser
-- of a race gets the same body as the winner rather than a 500.
--
-- ── Column notes ────────────────────────────────────────────────────────
-- tbl_job_tx_report
--   kind              'additional_work' | 'cant_complete' | 'help' | 'cancel'.
--                     VARCHAR, not ENUM: a new kind must not need an ALTER.
--                     'cancel' holds the proof + visit charge of a cancel
--                     REQUEST; see WHAT above.
--   reason_code       help: gate|arguing|unsure|colour|unsafe. cant_complete /
--                     cancel: the action_taken_reason id, as text.
--   reason_text       the LABEL re-read from the master / fixed list at write
--                     time — never typed by the technician.
--   proof_image_ids   CSV of tbl_job_image.image_id. Bounded by the service to
--                     at most 10 ids, which fits 255 with room to spare.
--   status            open | priced | returned | approved | resolved | undone.
--   booked_meanwhile  additional_work: 'yes' | 'no' | NULL (not answered).
--   left_site_on      additional_work: when he tapped "Leaving now".
--   client_amount / tx_amount / price_note   desk pricing (additional_work).
--   return_note       desk "send back to him" (additional_work).
--   visit_charge_awarded  1 when THIS claim inserted the ₹250 job_material row,
--                     so an undo reverses only a charge this claim paid.
--   prev_job_status   cancel: the job status BEFORE the request, because the
--                     request model parks the job at 1 (mobile-job-lifecycle
--                     .service.js THE REQUEST MODEL) and an undo must put a
--                     checked-in job back to where he was working.
--   reported_on / resolved_on   new Date() + the pool's +05:30 session
--                     timezone = IST wall clock verbatim. NO DEFAULT
--                     CURRENT_TIMESTAMP — the container clock is UTC.
--   resolved_by       tbl_user.user_id of the desk user, NULL for a technician
--                     undo (the technician is on efr_id).
--
-- tbl_job_chat
--   sender_kind 'tx' | 'desk'; efr_id set for tx, user_id (tbl_user) for desk.
--   body is VARCHAR(500) — the app's box is capped at 500 too.
--
-- tbl_job_verification
--   qc_status pending | passed | auto | disputed. posted_on / post_error are
--   the ledger post that follows QC (job-verification.service.js postAfterQc).
--
-- INDEXES
--   idx_jtr_job (job_id)            detail read + pending-on's IN (?) batch.
--   idx_jtr_status (status, kind)   the desk's open-claim queues.
--   uq_jtr_open (open_dedupe_key)   the idempotency rule, not an access path.
--   idx_jc_job (job_id, id)         GET chat ?after=<id> ORDER BY id — the
--                                   whole read is a range scan of this index.
--   uq_jc_client (job_id, client_msg_id)   phone-retry dedupe.
--   idx_jv_qc (qc_status, qc_due_on)       the auto-pass cron's bounded scan.
--
-- HOW TO APPLY
--   Run each statement in order. Plain CREATE — no @-variables, no PREPARE,
--   nothing MariaDB-only. Generated columns need MySQL 5.7+ / MariaDB 10.2+;
--   tbl_job_permission_request already relies on the same feature here.
--
-- IDEMPOTENCY OF THIS FILE
--   Fully re-runnable: every CREATE is IF NOT EXISTS. No seed rows — a client
--   with no timing row uses the property defaults.
-- ─────────────────────────────────────────────────────────────────────

-- ── Dry run (read-only) — which of the four exist already? ────────────
SELECT table_name, engine, table_rows
  FROM information_schema.tables
 WHERE table_schema = DATABASE()
   AND table_name IN ('tbl_job_tx_report', 'tbl_job_chat', 'tbl_job_verification', 'tbl_client_qc_timing');

CREATE TABLE IF NOT EXISTS tbl_job_tx_report (
  id                   INT NOT NULL AUTO_INCREMENT,
  job_id               INT NOT NULL,
  efr_id               INT NOT NULL,
  kind                 VARCHAR(24) NOT NULL,
  reason_code          VARCHAR(40) NULL DEFAULT NULL,
  reason_text          VARCHAR(160) NULL DEFAULT NULL,
  proof_image_ids      VARCHAR(255) NULL DEFAULT NULL,
  status               VARCHAR(16) NOT NULL DEFAULT 'open',
  booked_meanwhile     VARCHAR(3) NULL DEFAULT NULL,
  left_site_on         DATETIME NULL DEFAULT NULL,
  client_amount        INT NULL DEFAULT NULL,
  tx_amount            INT NULL DEFAULT NULL,
  price_note           VARCHAR(255) NULL DEFAULT NULL,
  return_note          VARCHAR(255) NULL DEFAULT NULL,
  visit_charge_awarded TINYINT(1) NOT NULL DEFAULT 0,
  prev_job_status      INT NULL DEFAULT NULL,
  reported_on          DATETIME NOT NULL,
  resolved_on          DATETIME NULL DEFAULT NULL,
  resolved_by          INT NULL DEFAULT NULL,
  open_dedupe_key      VARCHAR(64) AS (IF(status IN ('open', 'priced', 'returned'), CONCAT(job_id, ':', kind), NULL)) VIRTUAL,
  PRIMARY KEY (id),
  KEY idx_jtr_job (job_id),
  KEY idx_jtr_status (status, kind),
  UNIQUE KEY uq_jtr_open (open_dedupe_key)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tbl_job_chat (
  id            INT NOT NULL AUTO_INCREMENT,
  job_id        INT NOT NULL,
  sender_kind   VARCHAR(8) NOT NULL,
  efr_id        INT NULL DEFAULT NULL,
  user_id       INT NULL DEFAULT NULL,
  body          VARCHAR(500) NOT NULL,
  client_msg_id VARCHAR(64) NULL DEFAULT NULL,
  sent_on       DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_jc_job (job_id, id),
  UNIQUE KEY uq_jc_client (job_id, client_msg_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tbl_job_verification (
  job_id           INT NOT NULL,
  verified_on      DATETIME NULL DEFAULT NULL,
  verified_by      INT NULL DEFAULT NULL,
  qc_due_on        DATETIME NULL DEFAULT NULL,
  qc_status        VARCHAR(12) NULL DEFAULT NULL,
  qc_on            DATETIME NULL DEFAULT NULL,
  qc_by_contact_id INT NULL DEFAULT NULL,
  qc_note          VARCHAR(255) NULL DEFAULT NULL,
  posted_on        DATETIME NULL DEFAULT NULL,
  post_error       VARCHAR(255) NULL DEFAULT NULL,
  PRIMARY KEY (job_id),
  KEY idx_jv_qc (qc_status, qc_due_on),
  -- The 15-minute cron's second step ("QC done, not yet posted") filters on
  -- (qc_status, posted_on IS NULL). Without this the range it walks is every
  -- passed/auto row ever written, and it only grows.
  KEY idx_jv_post (qc_status, posted_on)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tbl_client_qc_timing (
  client_id   INT NOT NULL,
  qc_hours    INT NOT NULL DEFAULT 24,
  check_hours INT NOT NULL DEFAULT 2,
  updated_on  DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (client_id)
) ENGINE=InnoDB;

-- ── Read-only post-apply verification ─────────────────────────────────
-- Expect every declared column above (tx_report also shows open_dedupe_key as
-- VIRTUAL GENERATED), and uq_jtr_open / uq_jc_client with non_unique = 0.
SELECT table_name, column_name, data_type, character_maximum_length, is_nullable, column_default, extra
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name IN ('tbl_job_tx_report', 'tbl_job_chat', 'tbl_job_verification', 'tbl_client_qc_timing')
 ORDER BY table_name, ordinal_position;

SELECT table_name, index_name, seq_in_index, column_name, non_unique
  FROM information_schema.statistics
 WHERE table_schema = DATABASE()
   AND table_name IN ('tbl_job_tx_report', 'tbl_job_chat', 'tbl_job_verification', 'tbl_client_qc_timing')
 ORDER BY table_name, index_name, seq_in_index;

-- ── Hand verification once live (read-only) ───────────────────────────
-- 1. THE IDEMPOTENCY RULE. Must return ZERO rows, always:
-- SELECT job_id, kind, COUNT(*) FROM tbl_job_tx_report WHERE status IN ('open','priced','returned') GROUP BY job_id, kind HAVING COUNT(*) > 1;
-- 2. Chat retries that became two rows. Must return ZERO rows:
-- SELECT job_id, client_msg_id, COUNT(*) FROM tbl_job_chat WHERE client_msg_id IS NOT NULL GROUP BY job_id, client_msg_id HAVING COUNT(*) > 1;
-- 3. A visit charge flagged on a claim must exist in job_material (0 rows expected
--    unless the claim was undone, which clears the flag):
-- SELECT r.id, r.job_id FROM tbl_job_tx_report r WHERE r.visit_charge_awarded = 1 AND NOT EXISTS (SELECT 1 FROM job_material m WHERE m.job_id = r.job_id AND m.type = 'Incentive' AND m.reason = 'Visit charge — could not complete (system)');
