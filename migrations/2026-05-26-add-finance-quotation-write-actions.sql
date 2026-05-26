-- ─────────────────────────────────────────────────────────────────────
-- 2026-05-26 — Finance + Quotation write permissions
--
-- Adds action keys for the new write surfaces that landed on
-- /admin-actions, /finance and the JobModal Quotations tab. Each row
-- gates a Create / Approve / Reject button so the FE can respect the
-- mandatory permission-gating rule (per memory
-- `project_easyfix_permission_gating`).
--
-- Keys:
--   isInvoiceGenerate       → POST /admin/finance/invoices/generate
--   isInvoicePay            → POST /admin/finance/invoices/:id/payment
--   isInvoiceStatusChange   → PATCH /admin/finance/invoices/:id/status
--   isTransactionAdd        → POST /admin/finance/transactions
--   isPurchaseOrderAdd      → POST /admin/finance/purchase-orders
--   isPayoutCreate          → POST /admin/finance/payouts
--   isPayoutBulkApprove     → POST /admin/finance/payouts/bulk-ops-approve
--   isNdmRechargeAdd        → POST /admin/finance/ndm-recharges
--   isQuotationApprove      → PATCH /admin/quotations/:id/approve | reject
--
-- All rows attach to the Finance menu (url='finance'); the JobModal
-- Quotations tab piggy-backs on the Finance menu because quotations
-- approval is a finance-shaped operation (price negotiation).
-- ─────────────────────────────────────────────────────────────────────

-- ─── 0. Locate the Finance menu ──────────────────────────────────────
SET @finance_menu_id := (
  SELECT menu_id FROM tbl_menu
   WHERE url = 'finance' OR menu_name = 'Finance'
   ORDER BY menu_id ASC LIMIT 1
);

-- Hard abort if the Finance menu doesn't exist. The previous shape
-- (a SELECT against a UNION/EXISTS) only printed a warning and let
-- the downstream INSERTs run with menu_id=NULL, relying on the FK
-- constraint to fail later. Forcing a divide-by-zero in the failing
-- branch guarantees the script exits non-zero at this exact line, so
-- the operator sees the real cause instead of a misleading FK error.
SELECT IF(
  @finance_menu_id IS NULL,
  (SELECT 1/0 FROM dual),                  -- forces error: division by zero
  'OK'
) AS preflight;

-- ─── 1. Insert the menu_action rows ──────────────────────────────────
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @finance_menu_id, 'isInvoiceGenerate',     'Generate Client Invoice',           1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isInvoiceGenerate');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @finance_menu_id, 'isInvoicePay',          'Record Invoice Payment',            1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isInvoicePay');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @finance_menu_id, 'isInvoiceStatusChange', 'Change Invoice Status',             1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isInvoiceStatusChange');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @finance_menu_id, 'isTransactionAdd',      'Add Client Transaction',            1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isTransactionAdd');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @finance_menu_id, 'isPurchaseOrderAdd',    'Add Purchase Order',                1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isPurchaseOrderAdd');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @finance_menu_id, 'isPayoutCreate',        'Create Easyfixer Payout',           1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isPayoutCreate');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @finance_menu_id, 'isPayoutBulkApprove',   'Bulk Approve Payouts (Ops)',        1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isPayoutBulkApprove');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @finance_menu_id, 'isNdmRechargeAdd',      'Submit NDM Recharge',               1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isNdmRechargeAdd');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @finance_menu_id, 'isQuotationApprove',    'Approve / Reject Quotations',       1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isQuotationApprove');

-- ─── 2. Grant to Admin (role_id = 2) ─────────────────────────────────
UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (
     SELECT id FROM menu_action WHERE action_name IN (
       'isInvoiceGenerate', 'isInvoicePay', 'isInvoiceStatusChange',
       'isTransactionAdd', 'isPurchaseOrderAdd',
       'isPayoutCreate', 'isPayoutBulkApprove',
       'isNdmRechargeAdd', 'isQuotationApprove'
     )
   );

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name IN (
         'isInvoiceGenerate', 'isInvoicePay', 'isInvoiceStatusChange',
         'isTransactionAdd', 'isPurchaseOrderAdd',
         'isPayoutCreate', 'isPayoutBulkApprove',
         'isNdmRechargeAdd', 'isQuotationApprove'
       )
   AND NOT EXISTS (
     SELECT 1 FROM role_menu_action rma
      WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id
   );

-- ─── 3. Verify ───────────────────────────────────────────────────────
SELECT ma.id, ma.action_name, ma.name,
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
  FROM menu_action ma
 WHERE ma.action_name IN (
         'isInvoiceGenerate', 'isInvoicePay', 'isInvoiceStatusChange',
         'isTransactionAdd', 'isPurchaseOrderAdd',
         'isPayoutCreate', 'isPayoutBulkApprove',
         'isNdmRechargeAdd', 'isQuotationApprove'
       )
 ORDER BY ma.action_name;
