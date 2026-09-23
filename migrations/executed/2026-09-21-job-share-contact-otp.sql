-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-21 — OTP for the shared-job web link.
--
-- A technician can share a job with an outside contact (contact_number).
-- The contact gets a WhatsApp link to a web copy of the technician app and
-- proves they hold that phone with a one-time code before a guest session
-- is issued (services/job-share-guest.service.js).
--
-- The code lives on the share row itself, like profile_update_otp lives on
-- tbl_easyfixer: one live code per share, a resend overwrites it, a correct
-- verify NULLs it. Guess attempts are capped in tbl_attempt_window.
--
-- MINIMAL STYLE per feedback_easyfix_minimal_migration_style: one statement
-- per line, no @set, no PREPARE, nothing MariaDB-only.
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE tbl_job_share_link ADD COLUMN otp INT NULL AFTER contact_number;
ALTER TABLE tbl_job_share_link ADD COLUMN otp_valid_up_to DATETIME NULL AFTER otp;
