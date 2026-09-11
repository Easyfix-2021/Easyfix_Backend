-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-11 — A SHARED store for the two guess caps that have no otp_details
-- row to count on: the checkout PIN (tbl_job.otp) and the profile/bank-change
-- OTP (tbl_easyfixer). Both allow 5 attempts per 30 minutes (per JOB, per
-- TECHNICIAN). Until this table exists they count in each backend process's
-- memory: a restart forgets the counts, and with more than one backend
-- container each keeps its own — 5 × containers guesses. With it, every
-- container counts in one place and the admin "Unlock OTP / PIN" action clears
-- it for all of them.
--
-- WHY A NEW TABLE. EasyFix_Backend/CLAUDE.md: easyfix_core — "never alter
-- schema, never add tables", except "an EasyFix-owned new table no legacy
-- service references". tbl_job and tbl_easyfixer are legacy tables, so the
-- count cannot be a column on them. (The LOGIN OTP cap needs no table: it
-- counts on otp_details.failed_attempts — migrations/executed/2026-09-10-otp-failed-attempts.sql.)
-- Referenced by exactly one module: services/attempt-window.service.js.
--
-- ── Column notes ────────────────────────────────────────────────────
-- attempt_key   '<namespace>:<id>' — 'checkout-pin:job:<job_id>' or
--               'profile-otp:efr:<efr_id>'. A string, not an FK: the two
--               stores are different tables, and an FK into a legacy table
--               would let this one block a legacy delete.
-- attempts      Attempts in the current window. Every attempt is claimed
--               BEFORE its compare; a right answer deletes the row.
-- window_start  When the current window opened. Written by the app as new
--               Date() through the pool's +05:30 timezone (IST wall clock) and
--               compared IN SQL against Date parameters — never NOW(): the
--               session time_zone is SYSTEM, not IST.
-- updated_on    Last write, for housekeeping. Rows exist only while someone is
--               mid-window without having got it right.
--
-- DEPLOY ORDER IS SAFE BOTH WAYS: the service probes for this table and, until
-- it exists, keeps counting in memory exactly as before — never unlimited,
-- never a 500. An absent table is re-probed each minute, so creating it on a
-- live environment switches over without a restart.
--
-- RUN ON PRODUCTION AS WELL AS QA: qa-db-refresh reloads QA from the
-- Production replica on the 1st and 16th, so a QA-only table disappears.
--
-- Style: one statement; idempotent (IF NOT EXISTS). InnoDB so the guarded
-- UPDATE that claims an attempt takes a ROW lock, not a table lock.

CREATE TABLE IF NOT EXISTS tbl_attempt_window (
  attempt_key  VARCHAR(100) NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  window_start DATETIME NULL DEFAULT NULL,
  updated_on   DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (attempt_key)
) ENGINE=InnoDB;


-- ── Verification ────────────────────────────────────────────────────
-- SELECT COUNT(*) FROM tbl_attempt_window;                   -- runs = exists
-- Who is mid-window right now:
-- SELECT attempt_key, attempts, window_start FROM tbl_attempt_window ORDER BY window_start DESC;
