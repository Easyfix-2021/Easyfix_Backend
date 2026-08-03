-- ─────────────────────────────────────────────────────────────────────
-- 2026-07-30 — Microsoft 365 / Entra mailbox provisioning for CRM users
--
-- WHY: creating a CRM user (tbl_user) never created a Microsoft 365 mailbox.
-- The row carried official_email, the CRM showed it as real, OTP email to it
-- was "delivered" (Graph 202-accepts a send to a mailbox that does not exist)
-- and the bounce went to the sender mailbox nobody reads. Reported case:
-- user_id 8710 / ankitjha@easyfix.in could not log in and no screen could say
-- why. This table is the record that makes a missing mailbox DISCOVERABLE.
--
-- TWO OUTCOMES, NEVER ONE: an Entra account is not a mailbox. Exchange Online
-- only provisions a mailbox once the account holds a LICENCE, so
-- account_status and licence_status are separate columns on purpose — the
-- silent failure mode is precisely "account created, licence not assigned".
--
-- Schema-rule exception (CLAUDE.md "never add tables"): this is a NEW
-- EasyFix-owned table that no legacy service references — the same explicit
-- exception used for tbl_pincode (2026-05-01) and tbl_user_allowed_stages
-- (2026-07-29). Additive only. NOTHING on tbl_user is altered: provisioning
-- state deliberately does NOT become a new column on that legacy, five-service-
-- shared table.
--
-- ── Column notes ────────────────────────────────────────────────────────
-- user_id              tbl_user.user_id. UNIQUE — exactly one provisioning
--                      record per CRM user, which is what makes the retry
--                      endpoint an idempotent upsert (attempts increments,
--                      the row does not multiply). No FK constraint: the
--                      legacy schema does not use them here and we must never
--                      be able to block a tbl_user write.
-- user_principal_name  The UPN we used = tbl_user.official_email verbatim.
--                      INDEXED, deliberately NOT UNIQUE: tbl_user has no
--                      unique key on official_email (legacy rows duplicate,
--                      inactive duplicates are tolerated by
--                      services/user.service.js), so a unique index here could
--                      reject a legitimate provisioning record.
-- entra_object_id      Graph user object id (GUID) once known.
-- account_status       skipped_disabled | skipped_not_allowed | skipped_domain
--                      | skipped_invalid_email | created | already_exists | failed
--                      (skipped_not_allowed = the operator who triggered it is
--                      not on the access.entraprovision.emails allowlist below,
--                      so no directory write was attempted)
-- licence_status       not_attempted | skipped | no_sku_configured
--                      | sku_not_found | sku_not_active | no_seats_available
--                      | already_licensed | assigned | failed
--                      (vocabularies live in services/entra-provisioning.service.js)
-- sku_part_number      The licence SKU part number actually used, e.g.
--                      'O365_BUSINESS_ESSENTIALS'. Never a GUID in config.
-- last_error           Human-readable reason for the most recent non-success.
-- graph_request_id     Microsoft's correlation id for the last failing call —
--                      the first thing MS support asks for.
-- attempts             Count of runs that actually reached Graph. Skipped runs
--                      (feature off / unmanaged domain) record a row but do
--                      NOT increment it.
-- created_on/updated_on  Written by the app as new Date() so the pool's +05:30
--                      session timezone stores IST verbatim. No DEFAULT
--                      CURRENT_TIMESTAMP on purpose — server-clock UTC would
--                      silently mix timezones into these columns.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tbl_user_entra_provisioning (
  id                  INT NOT NULL AUTO_INCREMENT,
  user_id             INT NOT NULL,
  user_principal_name VARCHAR(255) NULL,
  entra_object_id     VARCHAR(64) NULL,
  account_status      VARCHAR(32) NOT NULL,
  licence_status      VARCHAR(32) NOT NULL,
  sku_part_number     VARCHAR(64) NULL,
  last_error          VARCHAR(500) NULL,
  graph_request_id    VARCHAR(64) NULL,
  attempts            INT NOT NULL DEFAULT 0,
  created_on          DATETIME NULL,
  updated_on          DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_user (user_id),
  KEY idx_upn (user_principal_name),
  KEY idx_account_status (account_status)
);

-- ─────────────────────────────────────────────────────────────────────
-- Feature keys. Each row is inserted ONLY when absent, so re-running this
-- never clobbers a value ops has already tuned.
-- ─────────────────────────────────────────────────────────────────────

-- MASTER kill-switch for every directory WRITE (create account, assign
-- licence). Seeded 'false' and code-defaulted to false, so merging this
-- CANNOT start creating Entra accounts in production. Turn it on only after
-- User.ReadWrite.All + Organization.Read.All have admin consent and the SKU
-- part number below is set. Flipping it back to 'false' restores exactly the
-- pre-2026-07-30 behaviour with no redeploy.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'entra.provisioning.enabled', 'false'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'entra.provisioning.enabled');

-- Licence SKU chosen by PART NUMBER (never a hardcoded GUID). Seeded EMPTY on
-- purpose: with no SKU configured the provisioning flow records the precise
-- reason 'no_sku_configured' instead of guessing a licence to spend. Find the
-- value in M365 admin centre > Billing > Your products, or GET
-- /v1.0/subscribedSkus. Env fallback: MS_GRAPH_LICENSE_SKU_PART_NUMBER.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'entra.provisioning.sku.part.number', ''
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'entra.provisioning.sku.part.number');

-- Domains this tenant owns. Guards two things: we never try to create an
-- account for an address we don't control, and the OTP mailbox pre-check only
-- applies to these domains (a user who signs in with a personal gmail.com
-- address would ALWAYS 404 in our directory — suppressing their OTP email
-- would lock them out).
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'entra.managed.domains', 'easyfix.in'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'entra.managed.domains');

-- READ-ONLY mailbox-existence pre-check on the OTP email channel. Seeded
-- 'true' — unlike the provisioning master switch — because it writes nothing,
-- fails OPEN on every outcome except a clean 404 in a managed domain (so
-- before admin consent it answers 403 → unknown → the email is attempted
-- exactly as today), and it is the actual fix for the reported bug: an OTP to
-- a non-existent mailbox no longer reports success and no longer starves the
-- WhatsApp/SMS fallback. Set to 'false' to disable with no redeploy.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'login.otp.email.mailbox.precheck', 'true'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'login.otp.email.mailbox.precheck');

-- Per-user allowlist for EVERY entry point that performs a directory write —
-- the manual repair endpoint POST /api/admin/users/:userId/provision-mailbox
-- AND the provisioning side-effect of POST /api/admin/users (Add User), which
-- reaches the identical "create enabled Entra account + spend a licence seat"
-- path. FEATURES.canProvisionMailboxes in services/feature-access.service.js.
-- Seeded EMPTY = deny-all (fail closed); add operator emails as a
-- comma-separated list to grant it. A non-allowlisted Admin can still add CRM
-- users — the mailbox step simply records 'skipped_not_allowed'. This is
-- deliberately outside RBAC/Manage Role, like every other
-- requirePropertyAllowlist capability.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'access.entraprovision.emails', ''
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'access.entraprovision.emails');
