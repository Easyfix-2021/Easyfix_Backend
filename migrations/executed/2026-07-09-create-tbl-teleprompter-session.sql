-- AI Teleprompter for Calls — durable per-call session for the guided (human-led,
-- AI-assisted) call flow. Flow #1 = guided_verification (New Technician Lead vetting).
-- EasyFix-owned table (no legacy service references it). Holds the on-screen question
-- list, the live current/next highlight, the actual asked-sequence, the diarized
-- transcript, the captured skills+areas (display/pre-fill only), and the coverage
-- score. Cross-replica safe: the media websocket runs on one replica; the SSE/poll
-- endpoints (any replica) read this table. Feature gated by easyfix_properties
-- 'teleprompter.enabled' — OFF (default) means no new code path is reachable.

CREATE TABLE IF NOT EXISTS tbl_teleprompter_session (
  session_id           VARCHAR(64)  NOT NULL PRIMARY KEY,
  flow                 VARCHAR(32)  NOT NULL DEFAULT 'guided_verification',
  target_type          VARCHAR(24)  NULL,
  target_id            INT          NULL,
  caller_user_id       INT          NULL,
  call_uuid            VARCHAR(128) NULL,
  status               VARCHAR(24)  NOT NULL DEFAULT 'calling',
  current_question_id  VARCHAR(64)  NULL,
  next_question_id     VARCHAR(64)  NULL,
  question_list_json   MEDIUMTEXT   NULL,
  asked_sequence_json  MEDIUMTEXT   NULL,
  transcript           MEDIUMTEXT   NULL,
  captured_result_json MEDIUMTEXT   NULL,
  coverage_json        MEDIUMTEXT   NULL,
  error                VARCHAR(255) NULL,
  created_on           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_on           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tp_created (created_on),
  INDEX idx_tp_call_uuid (call_uuid),
  INDEX idx_tp_caller (caller_user_id)
);

INSERT INTO easyfix_properties (property_key, property_value) VALUES ('teleprompter.enabled', 'false') ON DUPLICATE KEY UPDATE property_value = property_value;
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('stt.provider', 'indicconformer') ON DUPLICATE KEY UPDATE property_value = property_value;
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('teleprompter.emails', '') ON DUPLICATE KEY UPDATE property_value = property_value;
