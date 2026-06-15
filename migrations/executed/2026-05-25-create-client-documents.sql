-- ─────────────────────────────────────────────────────────────────────
-- 2026-05-25 — Client Document storage
--
-- New table `tbl_client_document` for the Manage Clients → Documents
-- tab. Stores PAN / TAN / GSTIN / Aadhaar / other document references.
-- Files live in S3 under the `ClientDocs/` key prefix; this table
-- holds the metadata.
--
-- Schema policy: brand-new EasyFix-owned tables are fair game per the
-- migration policy that allows new tables for new features (tbl_notice,
-- tbl_holiday etc. all landed via the same playbook).
--
-- Service-layer (services/client-documents.service.js) probes for this
-- table's presence at boot; if the table is absent, document routes
-- return 503 with a clear "documents table not migrated yet" error
-- rather than crashing the process. Run this migration to enable the
-- Documents tab end-to-end.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tbl_client_document (
  document_id        INT PRIMARY KEY AUTO_INCREMENT,
  client_id          INT NOT NULL,
  doc_type           VARCHAR(20) NOT NULL,  -- 'pan' | 'tan' | 'gstin' | 'aadhaar' | 'other'
  doc_label          VARCHAR(255),          -- operator-visible label, optional
  s3_key             VARCHAR(500) NOT NULL, -- e.g. 'ClientDocs/<ts>_<rand>'
  original_filename  VARCHAR(255),          -- for download UX
  content_type       VARCHAR(100),          -- MIME type captured at upload
  uploaded_by        INT,                   -- tbl_user.user_id
  uploaded_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_deleted         TINYINT(1) DEFAULT 0,  -- soft-delete only
  INDEX idx_client_active (client_id, is_deleted),
  INDEX idx_doc_type (doc_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Verify ────────────────────────────────────────────────────────
SELECT TABLE_NAME, ENGINE, TABLE_COMMENT
  FROM INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'tbl_client_document';
