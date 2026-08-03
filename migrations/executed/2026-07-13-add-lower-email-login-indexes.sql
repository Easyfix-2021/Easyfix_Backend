-- Functional indexes backing the case-insensitive email login lookups.
-- auth.service.js findActiveUserByIdentifier now matches LOWER(official_email)=?
-- and client-auth.service.js findSpoc matches LOWER(contact_email)=?; without a
-- functional index those scan the table. MySQL 8.0.13+ functional key parts —
-- same pattern as executed/2026-06-11-add-tbl-city-uniqueness.sql.
-- Shared DB: additive index only (no column/behaviour change), transparent to
-- the legacy services. Needs DBA sign-off before running on prod.
ALTER TABLE tbl_user ADD INDEX idx_user_official_email_lower ((LOWER(official_email)));
ALTER TABLE tbl_client_contacts ADD INDEX idx_client_contacts_contact_email_lower ((LOWER(contact_email)));
