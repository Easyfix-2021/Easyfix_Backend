-- 2026-06-16 — Technician email verification tokens.
--
-- Backs the net-new "verify your email" flow on the EasyFixer app. A
-- technician edits their email (tbl_easyfixer.efr_email) and we mail them a
-- tokenised confirmation link; opening it flips tbl_easyfixer.is_email_verified
-- to 1 (that status flag already exists and is read by the CRM verification
-- screen, but until now nothing wrote it). This table is the token ledger:
-- one row per send, single-use, 24h TTL.
--
-- tbl_efr_email_verification is EasyFix-owned and referenced by no legacy
-- service, so a new owned table is the sanctioned route under the CLAUDE.md
-- shared-DB carve-out (the same precedent as tbl_pincode /
-- tbl_zone_pincode_mapping). No existing table is altered.

CREATE TABLE IF NOT EXISTS tbl_efr_email_verification (
  id INT NOT NULL AUTO_INCREMENT,
  efr_id INT NOT NULL,
  email VARCHAR(255) NOT NULL,
  token VARCHAR(64) NOT NULL,
  valid_up_to DATETIME NOT NULL,
  verified_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_token (token),
  KEY idx_efr (efr_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
