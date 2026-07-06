-- Amazon Transcribe Call Analytics metrics (sentiment, talk-time, interruptions)
-- per call — the OBJECTIVE half of the hybrid Call Analytics. Async: a Transcribe
-- Call Analytics job runs on the S3 recording; the call-metrics cron starts it +
-- retrieves the result. The LLM coaching narrative
-- (2026-07-06-add-call-analysis.sql) is the other half. Columns on
-- tbl_plivo_call_log (EasyFix-owned).
--
-- Gated at runtime by easyfix_properties 'transcribe.analytics.enabled' AND AWS
-- config: S3_BUCKET_NAME + TRANSCRIBE_DATA_ACCESS_ROLE_ARN (an IAM role Transcribe
-- assumes to read the recording + write results back to S3). No-ops until set.
-- Confirm Call Analytics is available in your AWS_REGION (default ap-south-1).

ALTER TABLE tbl_plivo_call_log ADD COLUMN call_metrics TEXT NULL;
ALTER TABLE tbl_plivo_call_log ADD COLUMN call_metrics_status VARCHAR(32) NULL;
ALTER TABLE tbl_plivo_call_log ADD COLUMN call_analytics_job_name VARCHAR(200) NULL;
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('transcribe.analytics.enabled', 'false') ON DUPLICATE KEY UPDATE property_value = property_value;
