-- Per-call Plivo transcription charge, in USD, exactly as the Transcription API
-- returns it (`cost` = max(1, ceil(seconds / 60)) x $0.0095). Written by
-- saveTranscript() in services/call-transcription-cron.js. NULL = transcript
-- fetched before this column existed (backfillable from the Transcription LIST API).
ALTER TABLE tbl_plivo_call_log ADD COLUMN transcription_cost_usd DECIMAL(10,5) NULL;
