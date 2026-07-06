-- Store the Plivo call transcription per call for later quality analysis.
--
-- Columns go on tbl_plivo_call_log (EasyFix-owned Plivo reconciliation table,
-- created by executed/2026-06-19-plivo-call-log.sql) — NOT tbl_job_caller_info,
-- which carries a pre-existing legacy `recording` column and is shared with the
-- coexisting legacy services (CLAUDE.md: never alter shared schema). The row is
-- keyed to a call via job_caller_info_id.
--
-- Runtime is gated by BOTH easyfix_properties 'plivo.transcription.enabled'
-- (seeded 'false' — opt-in AFTER you verify the Plivo Transcription API for your
-- account and turn on transcription for recordings) AND a column-presence probe
-- in routes/admin/calls.js, so the code no-ops until this migration runs.
-- Transcriptions are customer PII — set a retention/redaction policy before
-- enabling. Restart the backend (or the 10-click reload) after flipping the flag
-- (easyfix_properties is cached).

ALTER TABLE tbl_plivo_call_log ADD COLUMN transcription TEXT NULL;
ALTER TABLE tbl_plivo_call_log ADD COLUMN transcription_status VARCHAR(32) NULL;
ALTER TABLE tbl_plivo_call_log ADD COLUMN transcription_fetched_at DATETIME NULL;
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('plivo.transcription.enabled', 'false') ON DUPLICATE KEY UPDATE property_value = property_value;
