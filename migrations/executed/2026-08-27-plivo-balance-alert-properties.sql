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

-- Who hears about it, and whether it runs at all.
--
-- THIS KEY IS ALSO THE ON/OFF SWITCH. There is no separate enabled flag: the
-- job is always registered, and blanking this list silences it. That is one
-- switch instead of two, and it removes the state an alert can least afford --
-- being quietly off while a second flag still reads "on".
--
-- Because it is the switch, the code has NO built-in fallback list. Seeding it
-- here is what makes the alert work out of the box; clearing it here is what
-- turns it off. If this row is missing, nobody is told.
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

-- The repeat cadence is NOT a property: it is fixed at one hour in code. A knob
-- there only invites a value that turns the alert into noise or into silence,
-- and neither is worth a config row.

-- Verify -- expect 2 rows.
SELECT property_key, property_value
  FROM easyfix_properties
 WHERE property_key LIKE 'plivo.balance%'
 ORDER BY property_key;
