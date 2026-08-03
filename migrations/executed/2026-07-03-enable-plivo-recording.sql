-- Enable Plivo call recording.
--
-- Sets the easyfix_properties flag that plivo.recordingEnabled() reads. When
-- 'true', the bridge answer XML adds record="true" so Plivo records the
-- conversation; recordings are then fetched lazily to our S3 on first play
-- (GET /api/admin/calls/:id/recording). See services/plivo.service.js.
--
-- ⚠️ COMPLIANCE: this records CUSTOMER calls — only run after consent/legal
--    sign-off for your region (a spoken consent announcement may be required).
-- ⚠️ CACHE: easyfix_properties is read through a cache, so RESTART the backend
--    (or wait out the cache TTL) after running this for it to take effect.
-- To DISABLE later: set property_value = 'false' (or delete the row).
-- Only calls placed AFTER this is enabled get recordings — nothing retroactive.

INSERT INTO easyfix_properties (property_key, property_value) VALUES ('plivo.recording.enabled', 'true') ON DUPLICATE KEY UPDATE property_value = 'true';
