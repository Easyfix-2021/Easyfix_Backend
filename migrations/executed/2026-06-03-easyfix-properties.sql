-- ─────────────────────────────────────────────────────────────────────
-- 2026-06-03 — easyfix_properties (in-DB feature config table)
--
-- Replaces 4 process-env feature flags with a small DB-managed table
-- so that ops can flip them without redeploying. The first batch:
--
--   new.crm.visible.menu.ids       — was NEW_CRM_VISIBLE_MENU_IDS
--   new.crm.menu.override.emails   — was NEW_CRM_MENU_OVERRIDE_EMAILS
--   magic.link.cron.enabled        — was MAGIC_LINK_CRON_ENABLED
--   kaleyra.calling.enabled        — was KALEYRA_CALLING_ENABLED
--
-- Schema policy: brand-new EasyFix-owned table; no legacy service
-- references it. Same playbook as tbl_notice / tbl_holiday /
-- tbl_client_document. Per-environment values come from the existing
-- .env (matched verbatim during the cutover).
--
-- Property names use DOTS (Spring-style) on purpose so the table can
-- adopt non-EasyFix config later without a key-format churn.
--
-- Reader: services/properties.service.js. It loads the whole table
-- ONCE at boot into a module-level cache and exposes getProperty(key)
-- / getAllProperties(). Callers keep a process.env.* fallback so a
-- fresh dev DB without this migration still works.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS easyfix_properties (
  property_key    VARCHAR(120) NOT NULL PRIMARY KEY,
  property_value  TEXT,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Seed (idempotent — re-runnable safely) ────────────────────────
-- Menu id 67 added 2026-06-03 (Notice Board admin surface). Future
-- updates: append the new id to this CSV and re-run; the ON DUPLICATE
-- KEY UPDATE clause makes the migration idempotent for fresh boxes,
-- and the standalone UPDATE below catches QA/Prod hosts that already
-- ran the migration before 67 was added.
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('new.crm.visible.menu.ids', '1,47,48,6,7,8,9,11,12,13,16,67') ON DUPLICATE KEY UPDATE property_value = VALUES(property_value);
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('new.crm.menu.override.emails', 'shaifali@easyfix.in') ON DUPLICATE KEY UPDATE property_value = VALUES(property_value);
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('magic.link.cron.enabled', 'false') ON DUPLICATE KEY UPDATE property_value = VALUES(property_value);
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('kaleyra.calling.enabled', 'true') ON DUPLICATE KEY UPDATE property_value = VALUES(property_value);

-- ─── Forward-compat: append 67 to environments that ran the seed ──
-- BEFORE the menu was added (2026-06-03). Skipped on fresh boxes
-- because the seed above already includes 67. Uses FIND_IN_SET to
-- be idempotent: only appends if 67 isn't already in the list.
UPDATE easyfix_properties
   SET property_value = CONCAT(property_value, ',67')
 WHERE property_key = 'new.crm.visible.menu.ids'
   AND NOT FIND_IN_SET('67', property_value);

-- ─── Verify ────────────────────────────────────────────────────────
SELECT TABLE_NAME, ENGINE, TABLE_COMMENT
  FROM INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'easyfix_properties';

SELECT property_key, property_value, updated_at
  FROM easyfix_properties
 ORDER BY property_key;
