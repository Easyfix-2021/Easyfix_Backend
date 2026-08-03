-- 2026-06-26 — Real-time technician location track (EasyFix-owned).
--
-- Captures the periodic GPS pings the technician app sends while a job is in
-- progress (from "Start Job"/check-in through completion) so the EasyFix CRM
-- can show a live / last-known location on demand. The single point-in-time
-- fix already lives on tbl_job.checkin_gps_location (stamped at check-in);
-- THIS table holds the continuous trail.
--
-- tbl_job_location_track is EasyFix-owned and referenced by no legacy service,
-- so a new owned table is the sanctioned route under the CLAUDE.md shared-DB
-- carve-out (same precedent as tbl_idempotency_key / tbl_pincode). No existing
-- table is altered. job_id / efr_id are LOGICAL references to tbl_job /
-- tbl_easyfixer with NO foreign-key constraint — a write-heavy owned table must
-- not couple its locking/cascade behaviour to the shared schema.
--
-- Columns:
--   job_id        the job being tracked (tbl_job.job_id).
--   efr_id        the technician sending the ping (tbl_easyfixer.efr_id).
--   latitude      DECIMAL(10,7) ≈ centimetre precision.
--   longitude     DECIMAL(10,7).
--   accuracy      reported horizontal accuracy in metres (nullable).
--   captured_at   server receipt time (NOW(), Asia/Kolkata) — stored DATETIME,
--                 displayed IST on the CRM per the platform date convention.
--   created_at    audit / retention-sweep anchor.

CREATE TABLE IF NOT EXISTS tbl_job_location_track (
  id BIGINT NOT NULL AUTO_INCREMENT,
  job_id INT NOT NULL,
  efr_id INT NOT NULL,
  latitude DECIMAL(10,7) NOT NULL,
  longitude DECIMAL(10,7) NOT NULL,
  accuracy FLOAT DEFAULT NULL,
  captured_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_job_captured (job_id, captured_at),
  KEY idx_efr_captured (efr_id, captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
