-- ─────────────────────────────────────────────────────────────────────
-- 2026-08-24 — Bank change: APP-side OTP gate, OFF for the client rollout
--
-- WHAT
--   • ONE new easyfix_properties key, `bank.change.app.otp.required`,
--     seeded 'false'.
--
-- NOTHING IS ALTERED. No new table, no ALTER, no index.
--
-- ══════════════════════════════════════════════════════════════════════
-- THIS FLAG IS MEANT TO BE ON. IT SHIPS OFF FOR ONE REASON ONLY.
-- ══════════════════════════════════════════════════════════════════════
--
-- POST /api/mobile/bank-details is now OTP-gated. Every technician app
-- ALREADY INSTALLED predates that and sends no `otp` field, and the bank form
-- is reachable in production at withdrawal time (BankDetailsForm, via
-- withdraw.tsx). Shipping a hard requirement would therefore break the bank
-- save for every existing install the moment this backend deploys — on the
-- money path, with nothing on screen explaining why. The RN app's
-- /public/app-version check is FAIL-OPEN, so no technician is compelled onto a
-- build that would send the code.
--
-- WHAT IS STILL ENFORCED WHILE THIS IS 'false':
--   • The vendor bank verification is UNCONDITIONAL. A non-existent or closed
--     account is still rejected with 422, and the client can no longer assert
--     its own `isVerified` — that trust-boundary hole is closed regardless of
--     this flag. THAT was the security bug; this flag does not reopen it.
--   • An OTP that IS supplied is still verified. A new build sending a wrong
--     or expired code is rejected exactly as if the flag were on. The flag
--     only decides whether an ABSENT code is tolerated.
--
-- So this buys old clients a working save and buys an attacker nothing they
-- did not already have before today's change.
--
-- ── TURNING IT ON (do this once the new build is the floor) ───────────
--
-- UPDATE easyfix_properties SET property_value = 'true' WHERE property_key = 'bank.change.app.otp.required';
--
-- The properties cache (services/properties.service.js) has a 1-HOUR TTL. Use
-- the admin properties-reload endpoint (or the 10-click flush gesture) for the
-- change to take effect immediately rather than within the hour.
--
-- BEFORE flipping it, confirm the old builds are actually gone — e.g. check
-- the app versions reporting in over the last week. Flipping early reintroduces
-- exactly the breakage this flag exists to avoid.
--
-- HOW TO APPLY
--   Run the statement below. Plain INSERT … SELECT … WHERE NOT EXISTS — no
--   prepared statements, no @-variables, no PREPARE/EXECUTE, nothing
--   MariaDB-specific.
--
-- IDEMPOTENCY
--   Fully re-runnable. Only inserts when the key is absent, so a re-run never
--   clobbers a value ops has already changed.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. The rollout gate ─────────────────────────────────────────────
-- Seeded with the SAME value the code falls back to when the key is missing
-- (appOtpRequired() reads `?? 'false'`), so the default is visible and
-- editable in Manage Properties rather than buried in a service file.

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'bank.change.app.otp.required', 'false'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'bank.change.app.otp.required');


-- ─── 2. Verify (read-only) ───────────────────────────────────────────
--
-- 1. Both bank-change gates, side by side:
-- SELECT property_key, property_value FROM easyfix_properties WHERE property_key IN ('bank.change.crm.otp.required', 'bank.change.app.otp.required');
--
-- 2. After the flag is turned ON, app-initiated bank rows must all show
--    otp_verified = 1. A 0 with changed_by_source = 'app' after that date
--    means an old client is still in the field:
-- SELECT id, efr_id, changed_by_source, otp_verified, created_at FROM tbl_easyfixer_sensitive_change_log WHERE change_type = 'bank' AND changed_by_source = 'app' ORDER BY id DESC LIMIT 20;
