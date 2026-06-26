-- Web Call vs Mobile Call topology toggle (Setting → Admin Actions).
-- 'mobile' = phone bridge (operator's phone rung first, then customer — today's
-- default). 'web' = operator talks from the browser (Plivo WebRTC, customer
-- dialled directly). Read by voice.service.js::callMode(); switched at runtime
-- via POST /api/admin/calls/mode (admin-only) + flushCache (no restart needed).
-- Web mode is Plivo-only.
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('voice.call.mode', 'mobile');
