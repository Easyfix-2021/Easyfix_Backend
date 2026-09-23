-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-21 — who actually did each step of a SHARED job.
--
-- A delegated job never changes hands: tbl_job.fk_easyfixter_id stays the
-- SHARER, so every write the delegate makes (check-in, selfie, materials,
-- permissions, checkout) is attributed to the sharer on the job's own rows.
-- This table records the real actor per action — the web-link contact's
-- number/name, or the delegate technician's efr_id — so ops can settle
-- "who was on site" and the sharer↔contact payout.
--
-- Written by middleware/share-action-log.js after each mutating response,
-- best-effort (a missing table or a failed insert never fails the action).
-- An EasyFix-owned table no legacy service references.
--
-- MINIMAL STYLE per feedback_easyfix_minimal_migration_style: one statement
-- per line, no @set, no PREPARE, nothing MariaDB-only.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE tbl_job_share_action_log (log_id BIGINT NOT NULL AUTO_INCREMENT, share_id INT NOT NULL, job_id INT NOT NULL, actor_type VARCHAR(16) NOT NULL, actor_efr_id INT NULL, actor_number VARCHAR(15) NULL, actor_name VARCHAR(150) NULL, action VARCHAR(64) NOT NULL, method VARCHAR(8) NOT NULL, path VARCHAR(255) NOT NULL, status_code SMALLINT NOT NULL, created_on DATETIME NOT NULL, PRIMARY KEY (log_id), KEY idx_share_action_share (share_id), KEY idx_share_action_job (job_id));
