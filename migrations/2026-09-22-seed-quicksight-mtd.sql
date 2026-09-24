-- Seed the MTD QuickSight key + grant it to Admin (role_id = 2). Mirrors
-- 2026-09-15-seed-quicksight-employee-performance.sql: the key attaches to the
-- SAME menu as ef-QuickSight (Home), so Manage Roles shows it with NO new
-- sidebar menu. NOT EXISTS-guarded -> re-runs are a no-op.
--
--   isQuickSightMtdView  -- the MTD tab on the Performance report, and the
--                           GET /api/admin/quicksight/mtd endpoints behind it.
--                           Joins the QuickSight family tree in Manage Roles on
--                           its own (matched by shape), like every other
--                           isQuickSight*View key.
--
-- WHAT THE REPORT IS: month-to-date job counts -- Ticket Created, In Progress,
-- Open, Completed, Cancelled -- with ONE ROW PER PERSON, where the person is
-- the CLIENT'S PRIMARY SPOC. It answers "whose book of business is this".
--
-- WARNING IT WILL DISAGREE WITH EMPLOYEE PRODUCTIVITY, ON PURPOSE. That report
-- attributes a job to whoever performed the action ("who did the work"); this
-- one attributes it to the account's Primary SPOC. The same window will show
-- different numbers in the two tabs and both are correct. See the header of
-- services/quicksight/mtd.service.js for the owner's decision in full before
-- anyone reports the difference as a bug.
--
-- WARNING GRANT THIS DELIBERATELY. Every row names an employee and counts the
-- accounts they own -- a performance-review surface, the same caution as
-- Employee Performance, Call Tracking and User Performance. Admin only by
-- default. It is NOT a reporting manager's view of their own team (unlike
-- Employee Productivity, which is gated by relation as well as by key), so a
-- grant here is a grant to the WHOLE company's book of business.
--
-- Until this runs the page answers 403 "Missing permission: isQuickSightMtdView"
-- and the tab stays hidden -- the Performance page hides a tab whose key does
-- not exist, which is indistinguishable from a revoked grant and is the
-- intended fail-closed behaviour.

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM (SELECT menu_id FROM menu_action WHERE action_name = 'ef-QuickSight' AND (delete_status IS NULL OR delete_status = 0) LIMIT 1) AS home), 'isQuickSightMtdView', 'View QuickSight - MTD', 1, 0, NOW()
 WHERE EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'ef-QuickSight')
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuickSightMtdView');

UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name IN ('isQuickSightMtdView'));

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name IN ('isQuickSightMtdView')
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

-- ── Verification ────────────────────────────────────────────────────
-- SELECT ma.id, ma.menu_id, ma.action_name, ma.name,
--        (SELECT COUNT(*) FROM role_menu_action rma
--          WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
--   FROM menu_action ma
--  WHERE ma.action_name IN ('ef-QuickSight', 'isQuickSightMtdView');
-- Then log out/in: permissions are cached 60 s.
