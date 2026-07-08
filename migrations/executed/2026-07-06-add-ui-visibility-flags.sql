-- Two runtime UI visibility toggles (easyfix_properties, global, DB-flipped).
--
-- ui.customer.number.visible = 'true'  → CRM shows CUSTOMER mobile numbers
--   UNMASKED across operational screens (jobs, my-orders, unconfirmed, call
--   history, schedule & assign, customers, search). Only customer-facing
--   fields are unmasked — technician (efr_no) and client-SPOC numbers stay
--   masked, and QuickSight reports/exports stay masked (report paths are
--   excluded in middleware/mask-mobile.js). Absent/'false' → masked (the
--   long-standing default).
--
-- ui.map.clickable = 'false' → the interactive Google Map is made
--   NON-interactive (marker not draggable, no click-to-drop, gestures off,
--   and the "Open in Google Maps" location link is disabled) in the CRM
--   address picker + LiveLocationPopover AND on the customer magic-link
--   job-completion page. Absent/'true' → clickable (the default).
--
-- Seeded to the state requested NOW (numbers visible, map non-clickable).
-- To REVERT later, flip the values and refresh the cache:
--   UPDATE easyfix_properties SET property_value = 'false' WHERE property_key = 'ui.customer.number.visible';
--   UPDATE easyfix_properties SET property_value = 'true'  WHERE property_key = 'ui.map.clickable';
-- then restart the backend OR use the 10-quick-clicks logo reload gesture
-- (POST /api/admin/properties/reload) — easyfix_properties is cached (1h TTL).
--
-- Re-runnable: ON DUPLICATE KEY UPDATE keeps an existing operator-set value.

INSERT INTO easyfix_properties (property_key, property_value) VALUES ('ui.customer.number.visible', 'true') ON DUPLICATE KEY UPDATE property_value = property_value;
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('ui.map.clickable', 'false') ON DUPLICATE KEY UPDATE property_value = property_value;
