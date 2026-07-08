-- Call Analytics: LLM coaching analysis of call transcripts, cached per call.
--
-- Columns on tbl_plivo_call_log (EasyFix-owned; same table as the transcription
-- from 2026-07-06-add-plivo-transcription.sql). Analysis is generated ON-DEMAND
-- (Settings → Call Analytics → View Analysis) from the stored transcript and
-- cached here so re-opening is instant. Needs an OpenAI key
-- (OPENAI_API_KEY_CALL_ANALYTICS, else OPENAI_API_KEY_SKILL_MATRIX / OPENAI_API_KEY)
-- — the feature degrades gracefully when absent (like the skill-matrix feature).
--
-- Also seeds the Settings → Call Analytics page RBAC (isCallAnalyticsView),
-- granted to Admin (role_id = 2). Idempotent — re-run is a no-op.

ALTER TABLE tbl_plivo_call_log ADD COLUMN call_analysis TEXT NULL;
ALTER TABLE tbl_plivo_call_log ADD COLUMN call_analysis_status VARCHAR(32) NULL;
ALTER TABLE tbl_plivo_call_log ADD COLUMN call_analysis_generated_at DATETIME NULL;

INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, url, action_name, menu_status, sequence, icons, has_child)
SELECT 'Call Analytics', 13, 2, 'callAnalytics', 'CallAnalyticsAction', 1, 9.0060, 'fa fa-phone', 0
 WHERE NOT EXISTS (SELECT 1 FROM tbl_menu WHERE menu_name = 'Call Analytics');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isCallAnalyticsView', 'View Call Analytics', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.menu_name = 'Call Analytics'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isCallAnalyticsView');

UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isCallAnalyticsView');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name = 'isCallAnalyticsView' AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);
