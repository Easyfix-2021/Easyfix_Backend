-- Kill switch for deleting the <Record> fallback once a conference's room recording replaces it
-- (services/plivo-conference.service.js pruneConferenceFallback). 'true' = prune; set 'false' to keep every fallback.
-- Absent behaves as 'true'; this row only makes the switch visible in Setting -> Admin Actions.
-- Idempotent (NOT EXISTS-guarded): a re-run never overwrites a value ops has since tuned.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'plivo.recording.prune_fallback', 'true'
 WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'plivo.recording.prune_fallback');
