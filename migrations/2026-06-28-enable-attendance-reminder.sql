-- ─────────────────────────────────────────────────────────────────────
-- 2026-06-28 — attendance.reminder.enabled (daily attendance-reminder cron)
--
-- Activates the daily 09:00 IST attendance-reminder push cron
-- (server/scheduler.js → services/attendance-reminder-cron.js). The cron is
-- property-gated and DEFAULT-OFF in code (it registers only when this property
-- reads 'true' at server start), so this row is what turns it ON.
--
-- Seeds 'true' = ON. After running this, RESTART the backend for the schedule
-- to register. To disable later (e.g. to pause the daily fan-out — it pushes
-- every active+verified technician who hasn't marked attendance for the day),
-- set the value to 'false' and restart; Trigger Now still works for testing.
--
-- Idempotent: only inserts when the key is absent, so re-running on a host
-- where ops has already set 'false' will NOT clobber their value.
-- ─────────────────────────────────────────────────────────────────────

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'attendance.reminder.enabled', 'true'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'attendance.reminder.enabled');
