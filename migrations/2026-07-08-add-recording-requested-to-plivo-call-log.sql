-- Persist, per Plivo call, whether recording was ON at answer time.
--
-- Column goes on tbl_plivo_call_log (EasyFix-owned Plivo reconciliation table,
-- created by executed/2026-06-19-plivo-call-log.sql) — NOT tbl_job_caller_info,
-- which is shared with the coexisting legacy services (CLAUDE.md: never alter
-- shared schema). Keyed to a call via job_caller_info_id.
--
-- Set at the Plivo answer callback from plivo.recordingEnabled():
--   1    = <Dial record="true"> was sent → Plivo was asked to record this call
--   0    = recording was OFF for this call
--   NULL = call never reached the answer callback, or pre-migration row
--
-- Purpose: distinguish "no recording because it was never recorded" from
-- "recorded but the lazy CallUUID lookup/fetch failed" when a completed call
-- shows no playable recording. The write is fail-soft (a pre-migration deploy
-- where this column is absent simply no-ops the flag, never the status write).

ALTER TABLE tbl_plivo_call_log ADD COLUMN recording_requested TINYINT(1) NULL;
