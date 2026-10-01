-- Kill switch for deleting the <Record> fallback once a conference's room recording replaces it
-- (services/plivo-conference.service.js pruneConferenceFallback). 'true' = prune; set 'false' to keep every fallback.
-- Absent behaves as 'true'; this row only makes the switch visible in Setting -> Admin Actions. Never overwrites a tuned value.
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('plivo.recording.prune_fallback', 'true') ON DUPLICATE KEY UPDATE property_value = property_value;
