-- ─────────────────────────────────────────────────────────────────────
-- 2026-06-30 — profile_update.otp.enabled = 'false' (disable Profile-Update OTP)
--
-- Disables the WhatsApp-OTP gate on the PUBLIC easyfixer profile-update form
-- (the OTP check on PUT /save + the OtpGate step on the FE). Per product
-- 2026-06-30 the technician saves Skills / Service Area without an OTP step.
--
-- Mechanism: profileOtpRequired() in
-- services/easyfixer-profile-update-link.service.js reads this property; the
-- code default is ON (only the literal 'false' disables it), and fetchPrefill
-- surfaces the effective value to the FE as `otp_required` so the form hides
-- the OtpGate. Setting the row to 'false' disables OTP without a redeploy —
-- flip it to 'true' to re-enable.
--
-- Idempotent: only inserts when the key is absent, so re-running on a host
-- where ops has already changed the value will NOT clobber their choice.
-- ─────────────────────────────────────────────────────────────────────

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'profile_update.otp.enabled', 'false'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'profile_update.otp.enabled');
