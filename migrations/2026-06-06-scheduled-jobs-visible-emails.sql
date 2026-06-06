-- 2026-06-06 — Seed the email allowlist for the Settings → Scheduled Jobs
-- page (BE+FE both check this property to gate access).
--
-- Property key: `scheduled.jobs.visible.emails`
-- Property value: comma-separated lower-case email addresses. Only
-- operators whose `tbl_user.official_email` matches one of these
-- entries will see the "Scheduled Jobs" menu item in the Settings
-- sidebar AND only those operators can hit the
-- `/api/admin/scheduled-jobs` endpoints (BE returns 403 otherwise).
--
-- Why a property and not a role/menu_action: the page is intentionally
-- ops-internal — surfaces cron metadata + a "Trigger Now" button that
-- skips the normal schedule. The user explicitly asked for no
-- tbl_menu entry. An email allowlist via easyfix_properties lets ops
-- toggle access without a deploy.
--
-- Schema reminder (from migrations/executed/2026-06-03-easyfix-properties.sql):
--   easyfix_properties(property_key PK, property_value TEXT,
--                      updated_at DATETIME ON UPDATE CURRENT_TIMESTAMP)
--
-- Style: plain one-statement-per-line, no @set/PREPARE, per the
-- user's migration-style rule. Idempotent via INSERT … ON DUPLICATE
-- KEY UPDATE (mirrors the canonical seed pattern). `updated_at`
-- auto-refreshes on every UPDATE thanks to the column's
-- ON UPDATE CURRENT_TIMESTAMP default — no need to set it manually.

INSERT INTO easyfix_properties (property_key, property_value) VALUES ('scheduled.jobs.visible.emails', 'harshit@channelplay.in') ON DUPLICATE KEY UPDATE property_value = VALUES(property_value);

-- Verify
SELECT property_key, property_value, updated_at
  FROM easyfix_properties
 WHERE property_key = 'scheduled.jobs.visible.emails';
