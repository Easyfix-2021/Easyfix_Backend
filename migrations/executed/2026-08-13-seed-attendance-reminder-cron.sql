-- =============================================================================
-- Seed attendance.reminder.cron so the send time is visible and editable.
--
-- WHAT THIS FIXES
--   The attendance-reminder cron has always been schedule-configurable:
--   server/scheduler.js reads `attendance.reminder.cron` and falls back to
--   '0 9 * * *' when it is unset or not a valid expression. But the ROW was
--   never seeded — only `attendance.reminder.enabled` was, back in
--   migrations/executed/2026-06-28-enable-attendance-reminder.sql.
--
--   The consequence is not that the cron misbehaves; it is that the 09:00 send
--   time exists only inside a JavaScript fallback. `GET /api/admin/properties`
--   lists what is in the table, so a key that was never inserted is invisible:
--   ops cannot see the current send time, and cannot discover that it is
--   changeable at all. Seeding the row with the same value the code already
--   uses changes no behaviour and makes the setting discoverable.
--
--   Companion to the same seed for the training reminder in
--   2026-08-13-lms-training-due-dates.sql.
--
-- WHY A MIGRATION AND NOT A SCREEN
--   There is no generic property editor. routes/admin/properties.js exposes
--   only GET / and POST /reload; the write helper (properties.service.js
--   ::setProperty) is wired ONLY to purpose-built toggles such as the
--   Web/Mobile calling switch. A key that no migration seeds can only be
--   created by hand-written SQL.
--
-- HOW TO APPLY
--   One statement. Idempotent by construction — it inserts only when the key
--   is absent, so re-running never clobbers a value ops has changed.
--
-- POST-APPLY
--   Changing this value requires a server RESTART. Cron schedules are
--   registered once at boot, so the properties cache flush
--   (POST /api/admin/properties/reload, or the 10-click logo gesture in the
--   CRM) will NOT move an already-registered schedule.
-- =============================================================================

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'attendance.reminder.cron', '0 9 * * *'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'attendance.reminder.cron');

-- ─── Verify ───────────────────────────────────────────────────────────
SELECT property_key, property_value
  FROM easyfix_properties
 WHERE property_key IN ('attendance.reminder.enabled', 'attendance.reminder.cron')
 ORDER BY property_key;
