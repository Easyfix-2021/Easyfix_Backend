-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-16 — the enable flag for the issue-screenshot retention cron.
--
-- Seeded 'false' ON PURPOSE. The cron deletes S3 objects irreversibly, so it
-- must not start running merely because a deploy carried the code to an
-- environment nobody expected it on. Per the owner (2026-09-16), cleanup stays
-- MANUAL until someone switches this on knowingly.
--
-- This row is for VISIBILITY, the same reason the 2026-07-14 per-cron flags
-- were seeded: server/scheduler.js reads the key with default-OFF semantics and
-- works whether or not the row exists, but ops cannot flip a key they cannot
-- see in the properties screen.
--
-- Registration is decided ONCE AT BOOT — flipping this to 'true' does nothing
-- until the backend restarts. The boot log then prints
--   "Issue screenshot cleanup cron registered (02:20 IST nightly)."
-- instead of the SKIPPED line.
--
-- No schema change: easyfix_properties already exists.
--
-- The NOT EXISTS guard rather than ON DUPLICATE KEY UPDATE, deliberately: it is
-- equally idempotent AND it is the shape scripts/migration-status.js can read a
-- property key out of, so `npm run verify:migrations` can actually tell whether
-- this file has been applied. A seed the tooling cannot probe reports UNKNOWN
-- forever. Same form as 2026-08-24-bank-change-app-otp-rollout.sql.
--
-- Style: one statement per line, no variables.

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'issue.screenshot_cleanup.enabled', 'false'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'issue.screenshot_cleanup.enabled');


-- ── Verification ────────────────────────────────────────────────────
-- SELECT property_key, property_value FROM easyfix_properties WHERE property_key = 'issue.screenshot_cleanup.enabled';
-- Expect one row, value 'false'. Set to 'true' + restart to enable the cron.
