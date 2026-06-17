-- ─────────────────────────────────────────────────────────────────────
-- 2026-06-11 — Easyfixer Profile-Update Magic-Link
--
-- WHAT
--   • Adds three audit columns to `tbl_easyfixer` that the new profile-
--     update magic-link feature writes whenever an operator sends an
--     easyfixer a self-serve "update your details" WhatsApp link.
--     Mirrors the tbl_job magic-link audit pattern introduced in
--     migrations/executed/2026-05-28-magic-link-feature.sql.
--   • Seeds the `isProfileUpdateLinkSend` menu_action + grants to Admin
--     (role 2), Executive Supply (role 3), and Call Flow + Quality
--     (role 11).
--
--   NOTE: This migration does NOT add an index on the new send_at
--   column. Unlike the tbl_job magic-link path (which the cron sweeps
--   on every tick), the profile-update flow is operator-triggered only
--   — no scheduled job filters by send_at, so an index would burn
--   write bandwidth for no read win. Add later if a "Last Link Sent"
--   list-column ever needs sorting.
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
--   Section 1 is NOT idempotent — it intentionally surfaces "Duplicate
--   column" errors on re-run so you can see exactly which lines were
--   already applied. Section 2 IS idempotent (NOT EXISTS subqueries on
--   inserts; soft-delete-reactivate on grants). The permission seed is
--   safe to re-run unconditionally.
--
-- POST-APPLY
--   Have any logged-in operator log out + back in so their JWT picks up
--   the new `isProfileUpdateLinkSend` action grant.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. tbl_easyfixer columns ────────────────────────────────────────
-- profile_update_sent_at      — last WhatsApp send time
-- profile_update_send_count   — total sends; resends increment
-- profile_update_last_action  — 'first' | 'reminder' | 'resend'

ALTER TABLE tbl_easyfixer ADD COLUMN profile_update_sent_at      DATETIME    NULL;
ALTER TABLE tbl_easyfixer ADD COLUMN profile_update_send_count   INT         NOT NULL DEFAULT 0;
ALTER TABLE tbl_easyfixer ADD COLUMN profile_update_last_action  VARCHAR(20) NULL;


-- ─── 2. Permission seed: isProfileUpdateLinkSend on Manage Easyfixers ─
-- INSERT the action row only if it doesn't already exist (NOT EXISTS
-- subquery), then soft-delete-reactivate any prior grants and INSERT
-- never-created grants for Admin (role 2), Executive Supply (role 3),
-- and Call Flow + Quality (role 11). Safe to re-run.

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM tbl_menu
         WHERE url = 'easyfixer' AND menu_status = 1
         ORDER BY menu_id ASC LIMIT 1),
       'isProfileUpdateLinkSend',
       'Send Profile Update Link (WhatsApp) to Easyfixer',
       1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isProfileUpdateLinkSend');

UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id IN (2, 3, 11)
   AND isDeleted = 1
   AND menu_action_id IN (
     SELECT id FROM menu_action WHERE action_name = 'isProfileUpdateLinkSend'
   );

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT r.role_id, ma.id, 0
  FROM (SELECT 2 AS role_id UNION ALL SELECT 3 UNION ALL SELECT 11) r
  JOIN menu_action ma ON ma.action_name = 'isProfileUpdateLinkSend'
 WHERE NOT EXISTS (
   SELECT 1 FROM role_menu_action rma
    WHERE rma.role_id = r.role_id AND rma.menu_action_id = ma.id
 );


-- ─── 3. Verify (optional — read-only) ───────────────────────────────
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME   = 'tbl_easyfixer'
   AND COLUMN_NAME IN (
     'profile_update_sent_at', 'profile_update_send_count', 'profile_update_last_action'
   )
 ORDER BY COLUMN_NAME;

SELECT ma.id, ma.action_name, ma.name,
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.menu_action_id = ma.id
           AND rma.role_id IN (2, 3, 11)
           AND rma.isDeleted = 0) AS granted_roles
  FROM menu_action ma
 WHERE ma.action_name = 'isProfileUpdateLinkSend';
