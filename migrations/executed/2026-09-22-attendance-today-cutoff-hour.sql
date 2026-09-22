-- 2026-09-22 — attendance.today.cutoff_hour
-- IST hour (0-24) from which a technician can no longer mark TODAY present
-- (services/mobile-attendance.service.js markDay; also sent to the tech app
-- on the dashboard to grey out the Today toggle). 24 = no cutoff. Code
-- defaults to 12 without this row; seeded so ops can find and edit it.
-- Picked up within the 1h properties cache TTL, or immediately via
-- POST /api/admin/properties/reload. Idempotent: never clobbers an edit.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'attendance.today.cutoff_hour', '12'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'attendance.today.cutoff_hour');
