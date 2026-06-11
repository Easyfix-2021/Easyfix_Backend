-- 2026-06-12 — Deep Skill Image Auto-Generation (DALL-E) — schema + property seeds
--
-- Adds two tracking columns to tbl_deep_skill so the auto-gen background
-- pipeline can record state ('pending' | 'failed' | NULL) and the last
-- attempt timestamp, then seeds the runtime kill switch + budget-alert
-- properties in easyfix_properties.
--
-- Schema change context: tbl_deep_skill is EasyFix-owned (no legacy
-- service references) — column ALTERs follow the precedent set by the
-- 2026-06-06 `deepskill_tag_words` migration. Both new columns are
-- nullable so existing rows stay valid without a backfill.
--
-- Property seeds: safe defaults — feature enabled, threshold every 500
-- images, notification recipient list empty (no spam until ops fills
-- it), running counter at 0, USD→INR conversion at 84.
--
-- Style: plain one-statement-per-line per the user's migration-style
-- rule (no @set/PREPARE/EXECUTE, no MariaDB-only IF NOT EXISTS).

ALTER TABLE tbl_deep_skill ADD COLUMN image_gen_status VARCHAR(20) NULL DEFAULT NULL;
ALTER TABLE tbl_deep_skill ADD COLUMN image_gen_attempted_at DATETIME NULL DEFAULT NULL;
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('deep_skill.auto_generate_image.enabled', 'true');
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('deep.skill.image.gen.count', '500');
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('deep.skill.image.gen.budget.notification', '');
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('deep.skill.image.gen.total_count', '0');
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('deep.skill.image.gen.usd_to_inr', '84');

-- Verify
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_NAME = 'tbl_deep_skill'
   AND COLUMN_NAME IN ('image_gen_status', 'image_gen_attempted_at');

SELECT property_key, property_value
  FROM easyfix_properties
 WHERE property_key IN (
       'deep_skill.auto_generate_image.enabled',
       'deep.skill.image.gen.count',
       'deep.skill.image.gen.budget.notification',
       'deep.skill.image.gen.total_count',
       'deep.skill.image.gen.usd_to_inr'
     );
