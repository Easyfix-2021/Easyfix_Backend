-- Seed RBAC for the CRM "Payout Requests" page (finance processor for technician
-- wallet withdrawals). Three things, all idempotent (NOT EXISTS / FIND_IN_SET
-- guarded), minimal one-statement-per-line style (no @set, no MariaDB IF NOT EXISTS):
--
--   1. A tbl_menu row "Payout Requests" as a child of the Finance parent
--      (url='payoutRequests'; Sidebar.tsx URL_MAP resolves it → /finance/payout-requests).
--   2. Two menu_action keys attached to that menu:
--        isPayoutRequestsView     → gates the page (GET  /admin/withdrawals)
--        isPayoutRequestsProcess  → gates Pay/Reject (POST /admin/withdrawals/:id/process)
--   3. Grants to Admin (role_id=2) AND Finance (role_id=7): menu visibility via
--      tbl_role.menu_ids CSV + the two action keys via role_menu_action. Finance
--      is granted because it is the primary user of this feature (the mobile
--      withdrawal request is finance's to settle); other roles can be granted
--      later via Manage Roles.

-- 1. Sidebar menu row (child of Finance). Scalar subquery resolves the Finance
--    parent menu_id; NOT EXISTS on url keeps re-runs a no-op.
INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'Payout Requests', (SELECT menu_id FROM tbl_menu WHERE url = 'finance' OR menu_name = 'Finance' ORDER BY menu_id ASC LIMIT 1), 2, 0, 'payoutRequests', 1, 90.0000, 'fa-money', 'payoutRequests'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_menu WHERE url = 'payoutRequests');

-- 2. Action permission keys, attached to the Payout Requests menu.
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM tbl_menu WHERE url = 'payoutRequests' LIMIT 1), 'isPayoutRequestsView', 'View Payout Requests', 1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isPayoutRequestsView');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM tbl_menu WHERE url = 'payoutRequests' LIMIT 1), 'isPayoutRequestsProcess', 'Process Payout Requests (Pay / Reject)', 1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isPayoutRequestsProcess');

-- 3a. Grant sidebar visibility: append the new menu_id to Admin + Finance menu_ids CSV.
UPDATE tbl_role SET menu_ids = CASE WHEN menu_ids IS NULL OR menu_ids = '' THEN CAST((SELECT menu_id FROM tbl_menu WHERE url = 'payoutRequests' LIMIT 1) AS CHAR) WHEN FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'payoutRequests' LIMIT 1), menu_ids) > 0 THEN menu_ids ELSE CONCAT(menu_ids, ',', (SELECT menu_id FROM tbl_menu WHERE url = 'payoutRequests' LIMIT 1)) END WHERE role_id IN (2, 7);

-- 3b. Grant the two action keys to Admin + Finance via role_menu_action.
--     Restore any soft-deleted rows first, then insert the never-created ones.
UPDATE role_menu_action SET isDeleted = 0 WHERE role_id IN (2, 7) AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name IN ('isPayoutRequestsView', 'isPayoutRequestsProcess'));

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT r.role_id, ma.id, 0 FROM (SELECT 2 AS role_id UNION SELECT 7) r CROSS JOIN menu_action ma WHERE ma.action_name IN ('isPayoutRequestsView', 'isPayoutRequestsProcess') AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = r.role_id AND rma.menu_action_id = ma.id);

-- 4. Verify (read-only).
SELECT 'menu' AS what, menu_id, menu_name, parent_menu, url FROM tbl_menu WHERE url = 'payoutRequests';
SELECT 'action' AS what, ma.id, ma.action_name, (SELECT COUNT(*) FROM role_menu_action rma WHERE rma.menu_action_id = ma.id AND rma.role_id IN (2, 7) AND rma.isDeleted = 0) AS granted_roles FROM menu_action ma WHERE ma.action_name IN ('isPayoutRequestsView', 'isPayoutRequestsProcess');
