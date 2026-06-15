-- ─────────────────────────────────────────────────────────────────────
-- 2026-05-28 — Customer Magic-Link Completion for Unconfirmed Orders
--
-- WHAT
--   • Adds five audit columns + two indexes to `tbl_job` that the new
--     magic-link feature writes during the customer self-serve flow.
--   • Seeds the `isJobMagicLinkSend` menu_action + grants to Admin
--     (role 2) and Executive Supply (role 3).
--
--   NOTE: This migration does NOT touch `tbl_client_custom_properties`.
--   The per-client opt-in row (`auto_process_unconfirmed_order`) is
--   stored using the table's existing `c_prop_*` columns
--   (`c_prop_name` / `c_prop_values` / `c_prop_mandatory` / `status`).
--   BE code reads + writes those columns directly — no schema change
--   needed for that table.
--
-- HOW TO APPLY
--   Run each statement below in order. Plain ALTER / INSERT — no
--   prepared statements, no @-variables, no PREPARE/EXECUTE blocks.
--   Works identically in MySQL CLI, DataGrip, DBeaver, MySQL Workbench.
--   Per-statement execution gives clear pass/fail boundaries — a
--   "Duplicate column name" or "Duplicate key name" error simply means
--   that piece is already in place; skip it and continue. Stop only on
--   errors you don't recognise.
--
-- IDEMPOTENCY
--   Sections 1 and 2 are NOT idempotent — they intentionally surface
--   "Duplicate column / Duplicate key" errors on re-run so you can see
--   exactly which lines were already applied. Section 3 IS idempotent
--   (NOT EXISTS subqueries on inserts; soft-delete-reactivate on
--   grants). The permission seed is safe to re-run unconditionally.
--
-- POST-APPLY
--   Have any logged-in user log out + back in so their JWT picks up
--   the new `isJobMagicLinkSend` action grant.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. tbl_job columns + indexes ────────────────────────────────────
-- customer_submitted_at      — drives the FE "Customer Submitted" pill
-- customer_submitted_payload — JSON snapshot of the customer's submit
-- magic_link_sent_at         — last WhatsApp send time
-- magic_link_send_count      — total sends; cron + admin route both
--                              cap at < 3 atomically
-- magic_link_last_action     — 'first' | 'reminder' | 'resend'

ALTER TABLE tbl_job ADD COLUMN customer_submitted_at      DATETIME     NULL;
ALTER TABLE tbl_job ADD COLUMN customer_submitted_payload JSON         NULL;
ALTER TABLE tbl_job ADD COLUMN magic_link_sent_at         DATETIME     NULL;
ALTER TABLE tbl_job ADD COLUMN magic_link_send_count      INT          NOT NULL DEFAULT 0;
ALTER TABLE tbl_job ADD COLUMN magic_link_last_action     VARCHAR(20)  NULL;

ALTER TABLE tbl_job ADD INDEX idx_customer_submitted_at (customer_submitted_at);
ALTER TABLE tbl_job ADD INDEX idx_magic_link_sent_at    (magic_link_sent_at);


-- ─── 2. Permission seed: isJobMagicLinkSend on Manage Jobs ──────────
-- INSERT the action row only if it doesn't already exist (NOT EXISTS
-- subquery), then soft-delete-reactivate any prior grants and INSERT
-- never-created grants for Admin (role 2) + Executive Supply (role 3).
-- Safe to re-run.

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM tbl_menu
         WHERE url = 'job' AND menu_status = 1
         ORDER BY menu_id ASC LIMIT 1),
       'isJobMagicLinkSend',
       'Send Magic Link (WhatsApp) for Unconfirmed Order',
       1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isJobMagicLinkSend');

UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id IN (2, 3)
   AND isDeleted = 1
   AND menu_action_id IN (
     SELECT id FROM menu_action WHERE action_name = 'isJobMagicLinkSend'
   );

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT r.role_id, ma.id, 0
  FROM (SELECT 2 AS role_id UNION ALL SELECT 3) r
  JOIN menu_action ma ON ma.action_name = 'isJobMagicLinkSend'
 WHERE NOT EXISTS (
   SELECT 1 FROM role_menu_action rma
    WHERE rma.role_id = r.role_id AND rma.menu_action_id = ma.id
 );


-- ─── 3. Verify (optional — read-only) ───────────────────────────────
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME   = 'tbl_job'
   AND COLUMN_NAME IN (
     'customer_submitted_at', 'customer_submitted_payload',
     'magic_link_sent_at', 'magic_link_send_count', 'magic_link_last_action'
   )
 ORDER BY COLUMN_NAME;

SELECT ma.id, ma.action_name, ma.name,
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.menu_action_id = ma.id
           AND rma.role_id IN (2, 3)
           AND rma.isDeleted = 0) AS granted_roles
  FROM menu_action ma
 WHERE ma.action_name = 'isJobMagicLinkSend';
