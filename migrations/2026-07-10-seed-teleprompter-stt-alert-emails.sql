-- Recipients (comma-separated emails) for STT sidecar OOM-kill alerts.
-- Read by routes/webhook/stt-oom.js when the stt-oom-watch sidecar reports that
-- the easyfix-stt container was OOM-killed. Empty (default) = alerting OFF.
-- Additive; no legacy service references this key.
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('teleprompter.stt.alert.emails', '') ON DUPLICATE KEY UPDATE property_value = property_value;
