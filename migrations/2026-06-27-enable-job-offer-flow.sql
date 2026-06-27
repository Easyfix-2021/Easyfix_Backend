-- ─────────────────────────────────────────────────────────────────────
-- 2026-06-27 — job.offer.flow.enabled (THE OFFER MODEL kill-switch)
--
-- This property is the KILL-SWITCH for the pool-offer flow. The code default
-- is already ON (offerFlowEnabled() in services/job.service.js treats a
-- missing/any-non-"false" value as enabled), so seeding 'true' here is a
-- no-op for behaviour — it just makes the flag VISIBLE in easyfix_properties
-- so ops can flip it to 'false' to disable the flow without a redeploy.
--
-- NOTE: this row does NOT activate the flow on its own. What truly activates
-- the pool-offer model is the tbl_job_offer table migration
-- (2026-06-27-create-tbl-job-offer.sql) — until that table exists, the code
-- degrades gracefully to a legacy direct single-assign regardless of this flag.
--
-- Idempotent: only inserts when the key is absent, so re-running on a host
-- where ops has already set 'false' will NOT clobber their value.
-- ─────────────────────────────────────────────────────────────────────

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'job.offer.flow.enabled', 'true'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'job.offer.flow.enabled');
