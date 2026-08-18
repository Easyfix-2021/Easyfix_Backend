-- Seed 'rewards.earn.lookback.days', the one earning property that was
-- referenced in code but never created in easyfix_properties.
--
-- WHY THIS MATTERS MORE THAN A MISSING DEFAULT NORMALLY WOULD
--
-- propNumber() read the absent key as '', and Number('') is 0 — not NaN — so
-- its `raw >= 0` guard accepted the zero and never reached the intended
-- fallback of 3. The earning pass then computed
--
--     since = new Date(Date.now() - 0 * 86400000)   -- i.e. this instant
--
-- and asked for ratings and check-ins timestamped in the FUTURE. Both queries
-- returned no rows, raised no error, and logged "rating=0 · sda=0", which is
-- indistinguishable from a genuinely quiet night. The programme therefore
-- awarded nothing at all from 2026-08-13 (go-live) onward while eligible rows
-- accumulated: 862 ratings and 171 same-day appointments were waiting by
-- 2026-08-18.
--
-- WHY 3 AND NOT 1
--
-- The window is NOT what prevents double-crediting; uq_reward_award
-- (reason_code, ref_type, ref_id) in 2026-08-13-rewards-foundation.sql is a
-- DATABASE-level guarantee, so re-scanning an already-awarded job raises
-- ER_DUP_ENTRY and is reported as alreadyPaid. Overlap costs nothing.
--
-- What the window controls is how much MISSED work a run can repair. At 1 day
-- a single skipped night — a deploy, a restart, a container that is not up at
-- the scheduled hour — loses that day's earnings permanently, because no later
-- run can reach back to them. At 3 days the pass self-heals two consecutive
-- misses. That safety margin is exactly what made the 2026-08-18 recovery
-- possible.
--
-- Read fresh on EVERY run (pointsConfig -> propNumber), unlike
-- rewards.earn.enabled and rewards.earn.cron which are read once at server
-- start. So this value takes effect on the next run with no restart, and may
-- be raised temporarily to backfill a longer gap and then set back to 3.

-- The WHERE NOT EXISTS form is deliberate, not stylistic: scripts/migration-status.js
-- extracts a probeable artifact from exactly this shape (its property matcher keys
-- off "NOT EXISTS ( … property_key = '…' )"), so `npm run verify:migrations` can
-- report whether this file has been applied. An ON DUPLICATE KEY UPDATE spelling
-- is equally idempotent but leaves no artifact, and the migration would report
-- UNKNOWN forever. It also preserves an operator's tuned value on re-run.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'rewards.earn.lookback.days', '3'
WHERE NOT EXISTS (
  SELECT 1
    FROM easyfix_properties
   WHERE property_key = 'rewards.earn.lookback.days'
);

-- Read-only post-apply verification.
SELECT property_key, property_value
  FROM easyfix_properties
 WHERE property_key IN ('rewards.earn.enabled', 'rewards.earn.cron', 'rewards.earn.lookback.days')
 ORDER BY property_key;

-- ─────────────────────────────────────────────────────────────────────
-- Diagnostic funnels — kept here deliberately.
--
-- Each column drops one more condition, so the first count that collapses to
-- zero names the failing predicate. Run these whenever an earning pass reports
-- rating=0 or sda=0: they answer "is it the window, the predicates, or the
-- data?" directly, which the award counts alone cannot.
--
-- Replace the '2026-08-15 12:37:00' literal below with the window the run
-- actually used — it is now printed on every pass as
-- "window=Nd from YYYY-MM-DD HH:MM:SS" (IST). A literal is used rather than
-- NOW() on purpose: these columns hold IST wall-clock, and a mysql CLI session
-- on a UTC host would silently shift the boundary by 5h30m.
-- ─────────────────────────────────────────────────────────────────────

-- Rating awards: 5-star, not escalated, with both foreign keys present.
SELECT COUNT(*) AS total,
       SUM(insert_date_time >= '2026-08-15 12:37:00') AS in_window,
       SUM(insert_date_time >= '2026-08-15 12:37:00'
           AND customer_rating = 5) AS five_star,
       SUM(insert_date_time >= '2026-08-15 12:37:00'
           AND customer_rating = 5
           AND COALESCE(is_escalated, 0) <> 1) AS not_escalated,
       SUM(insert_date_time >= '2026-08-15 12:37:00'
           AND customer_rating = 5
           AND COALESCE(is_escalated, 0) <> 1
           AND easyfixer_id IS NOT NULL
           AND job_id IS NOT NULL) AS awardable
  FROM tbl_easyfixer_rating_by_customer;

-- SDA awards: completed, assigned, and checked in on the appointment's own
-- calendar day. The final predicate is the same one mobile-performance.service
-- uses for the SDA % shown in the app, so the two can never disagree.
SELECT COUNT(*) AS total,
       SUM(checkin_date_time >= '2026-08-15 12:37:00') AS in_window,
       SUM(checkin_date_time >= '2026-08-15 12:37:00'
           AND job_status IN (3, 5)) AS completed,
       SUM(checkin_date_time >= '2026-08-15 12:37:00'
           AND job_status IN (3, 5)
           AND fk_easyfixter_id IS NOT NULL) AS has_technician,
       SUM(checkin_date_time >= '2026-08-15 12:37:00'
           AND job_status IN (3, 5)
           AND fk_easyfixter_id IS NOT NULL
           AND DATE(checkin_date_time)
               = DATE(COALESCE(original_appointment_date_time, requested_date_time))) AS awardable
  FROM tbl_job;
