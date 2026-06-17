-- Add inline OTP columns to tbl_easyfixer for the public profile-update flow.
-- Replaces the separate tbl_easyfixer_otp table (migration
-- 2026-06-15-create-easyfixer-otp.sql, which was never applied).
-- Both columns are nullable: NULL = no pending OTP.
ALTER TABLE tbl_easyfixer ADD COLUMN profile_update_otp INT NULL;
ALTER TABLE tbl_easyfixer ADD COLUMN profile_update_otp_valid_up_to DATETIME NULL;
