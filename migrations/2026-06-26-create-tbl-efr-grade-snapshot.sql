-- 2026-06-26 — Technician grade snapshot (EasyFix-owned).
--
-- The mobile app showed a HARDCODED 'A' grade for every technician; the web
-- Schedule & Assign computes a real A+…E live but never stores it. This table
-- caches ONE computed grade per technician so the mobile profile/dashboard/
-- performance surfaces show a real, improvable grade (and both surfaces can
-- agree on it). Recomputed on read when older than a TTL (see grade.service.js);
-- no cron required.
--
-- tbl_efr_grade_snapshot is EasyFix-owned and referenced by no legacy service,
-- so a new owned table is the sanctioned route under the CLAUDE.md shared-DB
-- carve-out (same precedent as tbl_idempotency_key / tbl_pincode). No existing
-- table is altered.
--
-- Columns:
--   efr_id            tbl_easyfixer.efr_id (PK — one snapshot per tech).
--   grade             A+ / A / B / C / D / E (same cutoffs as candidate-ranking).
--   composite         0..1 score the grade was bucketed from.
--   onboarding_score  0..1 onboarding-readiness component (training/KYC/profile/tenure).
--   performance_score 0..1 customer-rating component (null until rating history).
--   completed_jobs    completed-job count at compute time (basis selector).
--   basis             'onboarding' | 'performance' — which score drove the grade.
--   computed_at       when this snapshot was computed (TTL / audit anchor).

CREATE TABLE IF NOT EXISTS tbl_efr_grade_snapshot (
  efr_id INT NOT NULL,
  grade VARCHAR(2) NOT NULL,
  composite DECIMAL(6,4) NOT NULL DEFAULT 0,
  onboarding_score DECIMAL(6,4) DEFAULT NULL,
  performance_score DECIMAL(6,4) DEFAULT NULL,
  completed_jobs INT NOT NULL DEFAULT 0,
  basis VARCHAR(16) NOT NULL DEFAULT 'onboarding',
  computed_at DATETIME NOT NULL,
  PRIMARY KEY (efr_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
