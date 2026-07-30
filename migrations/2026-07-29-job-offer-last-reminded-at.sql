-- ─────────────────────────────────────────────────────────────────────
-- 2026-07-29 — tbl_job_offer.last_reminded_at (job-offer escalation reminder)
--
-- WHAT: records when the offer-reminder cron last re-pushed THIS offer.
--   NULL = never reminded (every pre-migration row, and every fresh offer).
--   No backfill is needed or wanted: NULL is exactly "not yet reminded", which
--   is the correct starting state for existing open offers.
--
-- WHY: services/job-offer-reminder-cron.js re-pushes offers that are still
-- OFFERED and unanswered ~5 minutes in. This column is the IDEMPOTENCY key —
-- the cron claims a row with a conditional
--   UPDATE ... SET last_reminded_at = NOW() WHERE job_offer_id = ? AND <eligible>
-- and only pushes when that UPDATE reports affectedRows = 1. Without the column
-- every 2-minute tick would re-push the same offer and spam the technician.
-- It also DERIVES the 2-reminder cap: reminders are forced >= 5 minutes apart
-- inside a 10-minute-wide eligibility window, so at most two can ever land.
--
-- The index supports the cron's eligibility scan, which filters on
-- (offer_status, offered_at, last_reminded_at) every 2 minutes.
--
-- tbl_job_offer is EasyFix-owned (referenced by NO legacy service), so adding a
-- nullable column + an index here is within the schema rules and is
-- non-destructive: existing reads/writes are unaffected, and the backend
-- degrades to a silent no-op (ER_BAD_FIELD_ERROR is caught) if this migration
-- has not been applied yet.
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE tbl_job_offer ADD COLUMN last_reminded_at DATETIME NULL;
ALTER TABLE tbl_job_offer ADD INDEX idx_job_offer_reminder (offer_status, offered_at, last_reminded_at);
