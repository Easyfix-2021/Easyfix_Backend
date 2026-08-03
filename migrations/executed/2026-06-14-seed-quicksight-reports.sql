-- =============================================================================
-- Seed the per-report QuickSight action keys and grant them to Admin (role_id=2).
--
-- MODEL (corrected 2026-06-14): QuickSight is NOT a sidebar menu. It is the
-- existing dashboard-header button gated on the family key `ef-QuickSight`
-- (already seeded on the Home menu). Clicking it opens the in-app /quicksight
-- landing, which shows cards for the reports the user's role can access. Each
-- report is gated INDIVIDUALLY by its own `isQuickSight<Report>View` action key.
--
-- Therefore this migration:
--   1. Attaches the 10 per-report action keys to the SAME menu as
--      `ef-QuickSight` (the Home menu) — so Manage Roles shows the QuickSight
--      button + all 10 reports together, individually grant/revokable, with
--      NO new sidebar menu.
--   2. Grants all 11 keys (ef-QuickSight + 10 reports) to Admin (role_id=2).
--
-- It deliberately does NOT create any tbl_menu rows and does NOT touch
-- tbl_role.menu_ids — adding a menu_id is what makes an item render in the
-- sidebar, which is exactly what we must avoid here.
--
-- PRECONDITION: `ef-QuickSight` already exists in menu_action (seeded by the
-- Home-actions bootstrap; granted to Admin by 2026-05-13-grant-home-actions
-- -to-admin.sql). Every insert below is guarded by EXISTS(ef-QuickSight) so a
-- DB missing it is a loud no-op rather than inserting NULL menu_ids.
--
-- STYLE (minimal-migration): plain one-statement-per-line, NOT EXISTS guards
-- for idempotency, menu_id resolved by subquery (never hardcoded), no
-- @set / PREPARE / EXECUTE. Re-runs are a no-op.
--
-- DO NOT MOVE THIS FILE INTO migrations/executed/ — it stays pending.
-- =============================================================================

-- ─── 1. Per-report action keys, attached to ef-QuickSight's menu (Home) ──────
-- menu_id is resolved from the existing ef-QuickSight row so the report keys
-- land on the same menu as the button — no hardcoded id, no new menu.

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightOpenOrdersView', 'View QuickSight - Open Orders', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightOpenOrdersView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightClientPerformanceView', 'View QuickSight - Client Performance', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightClientPerformanceView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightVerticalOrdersView', 'View QuickSight - Vertical Orders', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightVerticalOrdersView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightPriorityJobsView', 'View QuickSight - Priority Jobs', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightPriorityJobsView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightMaterialReportView', 'View QuickSight - Material Report', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightMaterialReportView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightCityPerformanceView', 'View QuickSight - City Performance', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightCityPerformanceView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightTechnicianPerformanceView', 'View QuickSight - Technician Performance', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightTechnicianPerformanceView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightSupplyGapView', 'View QuickSight - Supply Gap Analysis', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightSupplyGapView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightEmployeeProductivityView', 'View QuickSight - Employee Productivity', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightEmployeeProductivityView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1), 'isQuickSightAdminDashboardView', 'View QuickSight - Admin Dashboard', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightAdminDashboardView');

-- ─── 2. Grant all 11 keys to Admin (role_id = 2): restore then insert ────────
UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (
     SELECT id FROM menu_action
      WHERE action_name IN (
        'ef-QuickSight',
        'isQuickSightOpenOrdersView',
        'isQuickSightClientPerformanceView',
        'isQuickSightVerticalOrdersView',
        'isQuickSightPriorityJobsView',
        'isQuickSightMaterialReportView',
        'isQuickSightCityPerformanceView',
        'isQuickSightTechnicianPerformanceView',
        'isQuickSightSupplyGapView',
        'isQuickSightEmployeeProductivityView',
        'isQuickSightAdminDashboardView'
      )
   );

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name IN (
   'ef-QuickSight',
   'isQuickSightOpenOrdersView',
   'isQuickSightClientPerformanceView',
   'isQuickSightVerticalOrdersView',
   'isQuickSightPriorityJobsView',
   'isQuickSightMaterialReportView',
   'isQuickSightCityPerformanceView',
   'isQuickSightTechnicianPerformanceView',
   'isQuickSightSupplyGapView',
   'isQuickSightEmployeeProductivityView',
   'isQuickSightAdminDashboardView'
 )
   AND NOT EXISTS (
     SELECT 1 FROM role_menu_action rma
      WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id
   );

-- ─── 3. Verify. Expect 11 rows, each admin_granted = 1, all on the same
-- menu_id as ef-QuickSight (the Home menu). ─────────────────────────────────
SELECT ma.id, ma.action_name, ma.name, ma.menu_id,
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
  FROM menu_action ma
 WHERE ma.action_name IN (
   'ef-QuickSight',
   'isQuickSightOpenOrdersView',
   'isQuickSightClientPerformanceView',
   'isQuickSightVerticalOrdersView',
   'isQuickSightPriorityJobsView',
   'isQuickSightMaterialReportView',
   'isQuickSightCityPerformanceView',
   'isQuickSightTechnicianPerformanceView',
   'isQuickSightSupplyGapView',
   'isQuickSightEmployeeProductivityView',
   'isQuickSightAdminDashboardView'
 )
 ORDER BY ma.action_name;
