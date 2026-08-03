-- Store the Plivo recording URL/id PUSHED by the <Dial recordingCallbackUrl>
-- callback, so playback no longer depends on GUESSING which call_uuid the
-- recording is filed under. That lazy call_uuid lookup fails for web/WebRTC
-- calls — the recording can be associated with a different leg than the stored
-- call_uuid (observed on a completed web call with recording_requested=1 whose
-- Recording API lookup returned nothing).
--
-- Columns on tbl_plivo_call_log (EasyFix-owned, created by
-- executed/2026-06-19-plivo-call-log.sql), keyed to a call via
-- job_caller_info_id. The Play endpoint prefers recording_url when present and
-- falls back to the legacy call_uuid Recording-API lookup otherwise. All writes
-- are fail-soft, so a pre-migration deploy simply keeps the old lookup path.

ALTER TABLE tbl_plivo_call_log ADD COLUMN recording_url TEXT NULL;
ALTER TABLE tbl_plivo_call_log ADD COLUMN recording_id VARCHAR(80) NULL;
ALTER TABLE tbl_plivo_call_log ADD COLUMN recording_duration INT NULL;
