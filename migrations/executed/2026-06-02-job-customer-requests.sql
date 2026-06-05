-- ─────────────────────────────────────────────────────────────────────
-- 2026-06-02 — Job customer cancel / reschedule requests
--              (`tbl_job_customer_request`)
--
-- WHAT
--   • Introduces an EasyFix-owned table that LOGS a customer's request to
--     cancel or reschedule an Unconfirmed order, captured from the public
--     magic-link "Job Completion / Order" page
--     (/api/public/job-completion/:token/{cancel,reschedule}-request).
--
--   • A request is an OPS SIGNAL only. Inserting a row does NOT change
--     tbl_job.job_status — ops actions the request later inside the CRM.
--     `request_status` tracks that ops workflow (pending → actioned /
--     dismissed).
--
--   • Brand-new table, no legacy service touches it — explicit carve-out
--     per EasyFix_Backend/CLAUDE.md "no schema alteration of shared
--     tables / no new tables" rule (same carve-out as tbl_url_shortener
--     and tbl_pincode).
--
-- HOW TO APPLY
--   Run each statement below in order. Plain CREATE / no INDEX add needed
--   beyond the inline ones — no prepared statements, no @-variables, no
--   PREPARE / EXECUTE, no MariaDB-only `IF NOT EXISTS` on columns.
--   Works in MySQL CLI, DataGrip, DBeaver, Workbench.
--
-- IDEMPOTENCY
--   NOT idempotent — re-running surfaces "Table already exists" so you can
--   see exactly what is already in place. Stop only on errors you don't
--   recognise.
--
-- COLUMN NOTES
--   request_id         INT AUTO_INCREMENT PK.
--   job_id             INT — loose FK to tbl_job.job_id. NOT enforced as a
--                      DB-level FK (the shared schema does not enforce FKs
--                      cross-table; matches the rest of easyfix_core).
--   request_type       VARCHAR(20) — 'cancel' | 'reschedule'.
--   reason             VARCHAR(120) NULL — one of the BE-validated fixed
--                      reason lists (see CANCEL_REASONS / RESCHEDULE_REASONS
--                      in services/job-magic-link.service.js).
--   remarks            TEXT NULL — free-text customer note (max 1000 chars
--                      enforced at the Joi layer).
--   preferred_datetime DATETIME NULL — reschedule only; the slot the
--                      customer would prefer. NULL for cancel requests and
--                      when the customer omits it.
--   request_status     VARCHAR(20) — pending | actioned | dismissed.
--   created_at         DATETIME — insertion timestamp (server clock).
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE tbl_job_customer_request (
  request_id INT NOT NULL AUTO_INCREMENT,
  job_id INT NOT NULL,
  request_type VARCHAR(20) NOT NULL,
  reason VARCHAR(120) NULL,
  remarks TEXT NULL,
  preferred_datetime DATETIME NULL,
  request_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (request_id),
  INDEX idx_job_id (job_id),
  INDEX idx_status_created (request_status, created_at)
);
