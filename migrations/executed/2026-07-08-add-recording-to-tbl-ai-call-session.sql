-- AI-calling call recording. Optional (property ai.calling.record.enabled, default
-- false): when on, Plivo records the streamed call; on completion Plivo POSTs the
-- recording URL, and the post-call queue persists it here. Playback proxies Plivo.
-- EasyFix-owned table (tbl_ai_call_session).

ALTER TABLE tbl_ai_call_session ADD COLUMN recording_url VARCHAR(512) NULL;

ALTER TABLE tbl_ai_call_session ADD COLUMN recording_duration INT NULL;

INSERT INTO easyfix_properties (property_key, property_value) VALUES ('ai.calling.record.enabled', 'false') ON DUPLICATE KEY UPDATE property_value = property_value;
