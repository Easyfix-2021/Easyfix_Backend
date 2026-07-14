-- Per-cron individual enable flags (2026-07-14).
-- CRON_DISABLED is the MASTER kill-switch (env). On top of it, each cron can now
-- be toggled individually via easyfix_properties. These 4 always-on infra crons
-- previously had NO individual gate (they ran whenever CRON_DISABLED != true).
-- server/scheduler.js now reads a per-cron flag with DEFAULT-ON semantics
-- (registers unless the value is 'false'), so these seeds are for VISIBILITY —
-- ops can see the keys and set any to 'false' to silence just that cron.
-- Registration is decided once at boot → RESTART the backend after flipping.
-- No schema change: easyfix_properties already exists.
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('kaleyra.report_sync.enabled', 'true') ON DUPLICATE KEY UPDATE property_value = property_value;
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('notice.publish.enabled', 'true') ON DUPLICATE KEY UPDATE property_value = property_value;
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('job.offer_expiry.enabled', 'true') ON DUPLICATE KEY UPDATE property_value = property_value;
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('recording.backfill.enabled', 'true') ON DUPLICATE KEY UPDATE property_value = property_value;
