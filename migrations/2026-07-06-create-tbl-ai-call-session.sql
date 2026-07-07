-- AI-calling test flow (Validate Flows → AI Calling → Profile Update). Durable
-- per-call session so the poll endpoint returns status/transcript/mapped result
-- regardless of which replica handled the media websocket. EasyFix-owned table
-- (no legacy service references it). Display-only POC — no writes to real
-- profile tables. Feature gated by easyfix_properties 'ai.calling.enabled'.

CREATE TABLE IF NOT EXISTS tbl_ai_call_session (
  session_id   VARCHAR(64)  NOT NULL PRIMARY KEY,
  flow         VARCHAR(32)  NOT NULL DEFAULT 'profile_update',
  status       VARCHAR(24)  NOT NULL DEFAULT 'calling',
  mobile       VARCHAR(20)  NULL,
  efr_id       INT          NULL,
  call_uuid    VARCHAR(128) NULL,
  transcript   MEDIUMTEXT   NULL,
  result_json  MEDIUMTEXT   NULL,
  error        VARCHAR(255) NULL,
  created_on   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_on   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ai_call_created (created_on)
);

INSERT INTO easyfix_properties (property_key, property_value) VALUES ('ai.calling.enabled', 'false') ON DUPLICATE KEY UPDATE property_value = property_value;
