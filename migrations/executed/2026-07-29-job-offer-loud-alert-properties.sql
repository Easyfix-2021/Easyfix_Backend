-- ─────────────────────────────────────────────────────────────────────
-- 2026-07-29 — job.offer.loud_alert.* + job.offer.reminder.enabled
--
-- Seeds the three properties behind the LOUD JOB-OFFER ALERT feature so ops can
-- see and flip them in easyfix_properties without a redeploy.
--
-- THE NET EFFECT OF THIS FILE IS ZERO BEHAVIOUR CHANGE. The master seeds
-- 'false', and every sub is AND-ed with the master in
-- services/job-offer-alert-flags.js — so with the master off, the sub values
-- below are inert. Flipping the MASTER to 'true' is the single action that
-- lights the feature up; flipping it back to 'false' reverts to exactly the
-- pre-2026-07-29 behaviour, with no deploy.
--
--   job.offer.loud_alert.enabled         MASTER kill-switch. 'false' here.
--                                        Code default is also OFF, so a missing
--                                        row means off too (fail-safe).
--   job.offer.loud_alert.sound.enabled   Dedicated notification channel + alert
--                                        sound on the offer push, and the
--                                        data.loudAlert='1' the app reads to
--                                        play its own in-app alert. Code default
--                                        ON, so this row only exists to let ops
--                                        turn the SOUND off while keeping the
--                                        rest of the feature on.
--
-- THERE IS NO BANNER KEY, ON PURPOSE. Both banner surfaces —
-- flags.loudOfferAlert on the mobile dashboard payload (the Home offer card)
-- and data.loudBanner='1' on the offer push (the in-app top-strip alert) — read
-- the MASTER directly. The banner IS the loud alert, so it has no independent
-- switch; the sound sub above is the only piece that can be turned off on its
-- own. Do not seed a `job.offer.loud_alert.banner.enabled` row.
--
-- Both push keys are OMITTED while their flag is off — the app reads a missing
-- key as off — so with the master off the offer push carries exactly the four
-- routing keys it carried before this feature. That is what makes the revert
-- below a byte-for-byte revert rather than "almost".
--   job.offer.reminder.enabled           The escalation re-push cron
--                                        (server/scheduler.js 'job-offer-reminder').
--                                        Seeded 'false' and code-defaulted OFF —
--                                        it SENDS extra notifications, so
--                                        enabling the master alone must not
--                                        start it. Requires a server restart
--                                        after flipping (cron registration is
--                                        evaluated at boot).
--
-- Idempotent: each row is inserted ONLY when the key is absent, so re-running
-- this on a host where ops has already tuned a value will NOT clobber it.
-- ─────────────────────────────────────────────────────────────────────

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'job.offer.loud_alert.enabled', 'false'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'job.offer.loud_alert.enabled');

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'job.offer.loud_alert.sound.enabled', 'true'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'job.offer.loud_alert.sound.enabled');

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'job.offer.reminder.enabled', 'false'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'job.offer.reminder.enabled');
