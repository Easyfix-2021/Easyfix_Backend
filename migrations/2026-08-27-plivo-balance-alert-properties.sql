-- Configure the Plivo low-balance alert. Idempotent (NOT EXISTS-guarded), so a
-- re-run never overwrites a value ops has since tuned.
--
-- WHY THIS EXISTS. On 2026-08-27 calling was dead on production with an empty
-- Plivo account, and nothing reported it: the API accepted every call, the
-- conference was created, /web-start returned 200 in 29ms, and the browser leg
-- died at signalling. Operators saw "Busy"; every server log line was green. It
-- was found by opening the Plivo billing page by hand.
--
-- The call panel now warns whoever opens it, but that only reaches somebody who
-- is ALREADY blocked. These keys drive the cron that reaches the people who can
-- top the account up, while there is still credit to work with.
--
-- Everything here is deliberately a property rather than an env var: recipients
-- and thresholds are the settings most likely to need changing at 9pm on a
-- Friday, and a property is one edit in Setting -> Admin Actions instead of a
-- redeploy.

-- Register the job at boot. The scheduler reads this ONCE at start, so flipping
-- it later needs a restart -- same contract as every other cron gate here.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'plivo.balance.alert.enabled', 'true'
 WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'plivo.balance.alert.enabled');

-- Who hears about it. Comma separated. The code falls back to these same two if
-- the key is missing or blank, so the alert can never end up addressed to
-- nobody through a config slip.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'plivo.balance.alert.recipients', 'priyanka@easyfix.in,harshit@channelplay.in'
 WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'plivo.balance.alert.recipients');

-- What counts as low. SHARED with the warning shown in the call panel, so the
-- banner an operator sees and the email ops receives cannot disagree.
-- Deliberately not 0: at 0 the calls are already failing and the warning has
-- arrived too late.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'plivo.balance.threshold', '5'
 WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'plivo.balance.threshold');

-- How often to repeat while it stays low. Clamped in code to 1..168 hours, so a
-- mistyped 0 cannot turn this into a mail loop and a mistyped 100000 cannot
-- silence it for a month.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'plivo.balance.alert.repeat_hours', '12'
 WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'plivo.balance.alert.repeat_hours');

-- Verify -- expect 4 rows.
SELECT property_key, property_value
  FROM easyfix_properties
 WHERE property_key LIKE 'plivo.balance%'
 ORDER BY property_key;
