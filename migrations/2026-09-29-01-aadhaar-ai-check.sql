-- ============================================================================
-- 2026-09-29 — tbl_easyfixer_aadhaar_ai_check: every AI Aadhaar check, on record
--
-- ⚠ RUN THIS BEFORE DEPLOYING THE BACKEND THAT READS IT. The table is in
-- scripts/schema-verify.js EXPECTED (required), so a backend booting without it
-- refuses to start. (The code itself tolerates the table's absence — checks go
-- unrecorded and identity saves are not enforced, with a warning — but the boot
-- gate is stricter than the code on purpose.)
--
-- WHAT: ONE new EasyFix-owned table. Nothing existing is altered, no seed rows.
--   One row per AI check the technician app runs (POST /mobile/kyc/aadhaar-ocr).
--   The identity save (POST /mobile/profile/identity-details) refuses a new
--   Aadhaar identity unless a row here carries the fingerprint of exactly the
--   inputs it saves, and stamps that row's submitted_at. The CRM verification
--   page shows the latest submitted row.
--
-- COLUMNS — the minimum, never the full Aadhaar number, never an image:
--   status            matched | mismatch | unmatched | unavailable (raw outcome)
--   verdict           verified | mismatch | not_run (what the CRM shows)
--   reason            not_configured | unreadable | name_not_compared | NULL
--   aadhaar_last4     last 4 digits of the number READ OFF THE CARD, if read
--   name_score        0..1 name-overlap score, if one was computed
--   discrepancies     JSON array [{field, expected, found}] — name, masked
--                     Aadhaar number ("XXXX XXXX 1234"), DOB. NULL when none.
--   input_fingerprint HMAC-SHA256 (hex) of name + number + DOB + both photo
--                     MD5s — tells a stale check from a current one.
--   created_at / submitted_at   new Date() + the pool's +05:30 session timezone
--                     (IST verbatim). NO DEFAULT CURRENT_TIMESTAMP.
--
-- SHARED-DB RULE — the documented exception: a new table no legacy service reads.
-- HOW TO APPLY: one plain statement; no @-variables, no PREPARE, nothing
-- MariaDB-only. IDEMPOTENT: CREATE TABLE IF NOT EXISTS — re-running is a no-op.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tbl_easyfixer_aadhaar_ai_check (
  id                INT NOT NULL AUTO_INCREMENT,
  efr_id            INT NOT NULL,
  status            VARCHAR(16) NOT NULL,
  verdict           VARCHAR(16) NOT NULL,
  reason            VARCHAR(32) NULL DEFAULT NULL,
  aadhaar_last4     CHAR(4) NULL DEFAULT NULL,
  name_score        DECIMAL(4,3) NULL DEFAULT NULL,
  discrepancies     TEXT NULL,
  input_fingerprint CHAR(64) NOT NULL,
  created_at        DATETIME NOT NULL,
  submitted_at      DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_aic_efr_submitted (efr_id, submitted_at)
) ENGINE=InnoDB;

-- ── Post-apply check (read-only): expect 11 ──────────────────────────────────
-- SELECT COUNT(*) FROM information_schema.columns
--  WHERE table_schema = DATABASE() AND table_name = 'tbl_easyfixer_aadhaar_ai_check';
