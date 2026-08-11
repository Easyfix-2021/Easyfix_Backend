-- ─────────────────────────────────────────────────────────────────────
-- 2026-08-03 — Personal (non-corporate) contact details for CRM users
--
-- WHY: Add/Edit User now carries a MANDATORY "Personal Email", and the moment a
-- new user's Microsoft 365 mailbox actually provisions we mail their sign-in
-- details there. That address cannot live on the corporate mailbox we are about
-- to hand them (they cannot read it yet, which is the entire point), and it
-- cannot live on tbl_user either.
--
-- WHY NOT A COLUMN ON tbl_user: tbl_user is a LEGACY table shared by five
-- services and CLAUDE.md forbids altering it. This is the same EasyFix-OWNED
-- SIDE TABLE route already taken twice — tbl_user_allowed_stages (2026-07-29)
-- and tbl_user_entra_provisioning (2026-07-30) — and the same explicit
-- exception to the "never add tables" rule first used for tbl_pincode
-- (2026-05-01): a new table that NO legacy service references. Additive only.
-- NOTHING on tbl_user is touched.
--
-- WHY "PERSONAL CONTACT" AND NOT "PERSONAL EMAIL": the next request in this
-- shape is a personal mobile or a home address. Naming the table for the
-- CONTACT concept means that becomes an ADD COLUMN here rather than a fourth
-- side table keyed on the same user_id.
--
-- ── Column notes ────────────────────────────────────────────────────────
-- user_id         tbl_user.user_id, and the PRIMARY KEY — exactly one personal
--                 contact record per CRM user, which is what makes the app-side
--                 write an idempotent INSERT … ON DUPLICATE KEY UPDATE. No FK
--                 constraint: the legacy schema does not use them here and a
--                 tbl_user write must never be blockable by this table.
-- personal_email  NULLABLE on purpose. ~7.5k pre-existing active users have no
--                 personal address today; the requirement is enforced in the
--                 APPLICATION for the Add User flow and for edits of ACTIVE
--                 users (routes/admin/users.js Joi + services/user.service.js),
--                 NOT by the schema. A NOT NULL column would mean back-filling
--                 every legacy user before anyone could be edited at all, and
--                 would make the deliberate INACTIVE-user exemption
--                 unrepresentable.
-- created_on /    Written by the app as new Date() so the pool's +05:30 session
-- updated_on      timezone stores the IST wall clock verbatim. No DEFAULT
--                 CURRENT_TIMESTAMP: the server clock is UTC and would silently
--                 mix two timezones into these columns.
--
-- idx_personal_email is a plain, NON-UNIQUE index. Deliberately not unique:
-- tbl_user itself has no unique key on official_email (legacy rows duplicate),
-- shared family addresses are a real thing in this workforce, and a unique
-- index here could reject a legitimate user record. It exists only so ops can
-- answer "who did we send that to?" without a full scan.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tbl_user_personal_details (
  user_id        INT NOT NULL,
  personal_email VARCHAR(255) NULL,
  created_on     DATETIME NULL,
  updated_on     DATETIME NULL,
  PRIMARY KEY (user_id),
  KEY idx_personal_email (personal_email)
);

-- NOTE: an earlier draft of this migration also seeded a `user.welcome.cc.emails`
-- property to hold the CC list for the "your EasyFix account is ready" credential
-- mail. It was removed before this file was ever applied anywhere. The CC address
-- is now the constant WELCOME_MAIL_CC in services/user-welcome-mail.service.js —
-- a key nobody would ever have edited only added a way for the value to go
-- missing, and an unset property reads as "no CC" with nothing reporting it.

-- Verification:
-- SHOW CREATE TABLE tbl_user_personal_details;
