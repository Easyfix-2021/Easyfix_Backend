-- 2026-06-24 — Admin Actions: OTP-gated Delete Easyfixer/User + Restore
--
-- Adds the infrastructure for the new "Delete Easyfixer/User" admin flow:
--   1. tbl_admin_deleted_archive — NEW EasyFix-owned table (no legacy service
--      references it; permitted per CLAUDE.md). Stores a full JSON snapshot of
--      a tombstoned easyfixer/user (parent row + all purged child rows) so an
--      OTP-gated restore can rebuild it on the SAME id. NEVER alters the shared
--      tbl_easyfixer / tbl_user schema.
--   2. Seeds the deletion-notice recipient emails into easyfix_properties.
--
-- Access is HARD-GATED to the Admin role in code (BE roleByName(['Admin']) on
-- routes/admin/entity-deletion.js + FE role_id===2 on admin-actions/page.tsx),
-- so NO menu_action / role_menu_action RBAC seeds are needed for this flow.
--
-- Style: plain one-statement-per-line; every statement idempotent (re-run = no-op).

-- ─── 1. Archive table (NEW, EasyFix-owned) ──────────────────────────
CREATE TABLE IF NOT EXISTS tbl_admin_deleted_archive (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(20) NOT NULL,
  entity_id INT NOT NULL,
  entity_label VARCHAR(255) NULL,
  snapshot_json LONGTEXT NOT NULL,
  deletion_reason VARCHAR(500) NOT NULL,
  strategy VARCHAR(20) NOT NULL DEFAULT 'tombstone',
  status VARCHAR(20) NOT NULL DEFAULT 'deleted',
  deleted_by INT NULL,
  deleted_by_name VARCHAR(255) NULL,
  deleted_at DATETIME NOT NULL,
  restored_by INT NULL,
  restored_by_name VARCHAR(255) NULL,
  restored_at DATETIME NULL,
  KEY idx_entity (entity_type, entity_id),
  KEY idx_status (status),
  KEY idx_deleted_at (deleted_at)
) ENGINE=InnoDB;

-- ─── 2. Deletion-notice recipients (CSV in easyfix_properties) ──────
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'deletion.notice.recipient.emails', 'shaifali@easyfix.in,sundeep@easyfix.in,priyanka@easyfix.in'
 WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'deletion.notice.recipient.emails');
