-- ============================================================================
-- 2026-09-23 — QuickSight Custom (dynamic) Reports
--
-- WHAT:
--   1. tbl_qs_dynamic_report         — a report definition: name, typed columns,
--                                      optional chart, public-link token, owner.
--   2. tbl_qs_dynamic_report_role    — per-report audience. NO rows = everyone
--                                      holding isQuickSightDynamicReportView.
--   3. tbl_qs_dynamic_report_upload  — one row per upload: METADATA ONLY. The
--                                      rows themselves are a gzipped JSON object
--                                      in private S3 at data_key
--                                      (QuickSight/DynamicReports/<id>/<uuid>.json.gz).
--   4. Three action keys on the Home menu (like every QuickSight report key)
--      + Admin (role_id 2) grants:
--        isQuickSightDynamicReportView   — open Custom Reports
--        isQuickSightDynamicReportManage — create; edit/upload/share own reports
--        isQuickSightDynamicReportAdmin  — owner-equivalent on every report
--
-- RETENTION: uploads older than 30 days are deleted (S3 object, then row) by the
-- scheduler job `dynamic-report-retention` — except each report's CURRENT
-- upload, which is kept however old. Nothing here depends on it.
--
-- TIMESTAMPS are IST wall-clock written by the app (new Date() through the
-- pool's '+05:30'), like the rest of easyfix_core — no DEFAULT CURRENT_TIMESTAMP,
-- which would stamp the DB server's zone.
--
-- HOW TO APPLY: statement by statement. Sections 1-3 are CREATE TABLE IF NOT
-- EXISTS (re-runs are no-ops); section 4 is NOT EXISTS-guarded. After applying,
-- permissions are cached up to 60s (PERMISSIONS_CACHE_TTL_MS); hard-refresh the CRM.
-- Other roles get the keys via Manage Role → Home.
-- Leave this file in migrations/ (pending) — do not move it into executed/.
-- ============================================================================

-- ─── 1. Report definitions ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tbl_qs_dynamic_report (id INT NOT NULL AUTO_INCREMENT, name VARCHAR(150) NOT NULL, columns_json MEDIUMTEXT NOT NULL, chart_json MEDIUMTEXT NULL, share_token CHAR(32) NULL, is_active TINYINT(1) NOT NULL DEFAULT 1, created_by INT NOT NULL, created_at DATETIME NOT NULL, updated_by INT NULL, updated_at DATETIME NOT NULL, PRIMARY KEY (id), UNIQUE KEY uq_qs_dynamic_report_share_token (share_token), KEY idx_qs_dynamic_report_active (is_active, name)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 2. Per-report audience ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tbl_qs_dynamic_report_role (report_id INT NOT NULL, role_id INT NOT NULL, PRIMARY KEY (report_id, role_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 3. Uploads (metadata; rows live in S3 at data_key) ─────────────────────
CREATE TABLE IF NOT EXISTS tbl_qs_dynamic_report_upload (id INT NOT NULL AUTO_INCREMENT, report_id INT NOT NULL, mode VARCHAR(10) NOT NULL, columns_json MEDIUMTEXT NOT NULL, row_count INT NOT NULL, added_rows INT NOT NULL, data_key VARCHAR(200) NOT NULL, original_name VARCHAR(255) NULL, size_bytes INT NULL, uploaded_by INT NOT NULL, uploaded_at DATETIME NOT NULL, PRIMARY KEY (id), KEY idx_qs_dynamic_upload_report (report_id, id), KEY idx_qs_dynamic_upload_uploaded_at (uploaded_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 4. Action keys (Home menu, like 2026-07-02-seed-quicksight-offer-acceptance.sql) + Admin grants
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on) SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightDynamicReportView', 'View QuickSight - Custom Reports', 1, 0, NOW() WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight') AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightDynamicReportView');
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on) SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightDynamicReportManage', 'Manage QuickSight - Custom Reports (own)', 1, 0, NOW() WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight') AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightDynamicReportManage');
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on) SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightDynamicReportAdmin', 'Administer QuickSight - Custom Reports (all)', 1, 0, NOW() WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight') AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightDynamicReportAdmin');

UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name IN ('isQuickSightDynamicReportView', 'isQuickSightDynamicReportManage', 'isQuickSightDynamicReportAdmin'));
INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted) SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name IN ('isQuickSightDynamicReportView', 'isQuickSightDynamicReportManage', 'isQuickSightDynamicReportAdmin') AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

-- ─── 5. Verify (read-only) ──────────────────────────────────────────────────
-- SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'tbl_qs_dynamic_report%';
-- SELECT ma.id, ma.menu_id, ma.action_name, rma.isDeleted FROM menu_action ma LEFT JOIN role_menu_action rma ON rma.menu_action_id = ma.id AND rma.role_id = 2 WHERE ma.action_name LIKE 'isQuickSightDynamicReport%';
