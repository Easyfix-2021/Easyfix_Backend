-- First-touch registration attribution for the Technician App R.03 flow.
--
-- This is an additive EasyFix-owned side table: the shared legacy technician
-- tables have no referral column, and adding one there would couple every old
-- service to a field only the new app needs. One row per efr_id makes writes
-- naturally idempotent. Application SQL deliberately performs a no-op on a
-- duplicate key, so the original answer is never overwritten by later logins.
-- No FK is declared because the legacy schema does not consistently use them;
-- a referral write must never make an existing technician row undeletable.

CREATE TABLE IF NOT EXISTS tbl_easyfixer_registration_attribution (
  efr_id          INT NOT NULL,
  referral_source VARCHAR(255) NOT NULL,
  captured_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (efr_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Verification:
-- SHOW CREATE TABLE tbl_easyfixer_registration_attribution;
