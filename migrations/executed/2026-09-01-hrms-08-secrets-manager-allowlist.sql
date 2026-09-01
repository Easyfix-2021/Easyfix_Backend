-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-01 — Secrets Manager: the per-person email allowlist.
--
-- Seeds easyfix_properties['secrets.manager.emails'], the SOLE gate on who
-- may reach Admin Actions → Secrets Manager. Same mechanism as the other
-- property-gated admin capabilities (2026-06-24-property-gated-admin-features),
-- registered as `canManageSecrets` in services/feature-access.service.js.
--
-- WHY THIS SITS OUTSIDE RBAC
--   This screen can decrypt every bank account number in the company and
--   rewrite the key that protects them. A blast radius that large should
--   follow a PERSON, not a role: a role grant silently propagates to whoever
--   is given that role next, and nobody re-reads what a role can do at the
--   moment they hand it out. An email list has to be edited on purpose, by
--   name, and reads as a decision rather than an inheritance.
--
--   It is AND, not OR. The action keys isFieldRekeyRun / isRecoveryKeyManage
--   (2026-09-01-hrms-07) still apply on top: RBAC decides the screen exists,
--   this allowlist decides who may reach it, and BOTH must pass. Removing
--   someone from this list revokes them even if their role still carries the
--   action.
--
-- DENY-ALL BY DEFAULT
--   parseEmailAllowlist() returns an empty set for an absent or empty
--   property, and emailAllowed() then denies everyone. So a fresh environment
--   grants nobody until this runs — which is the correct direction to fail for
--   a screen that reads bank details.
--
-- NOT the UPDATE-only treatment that new.crm.visible.menu.ids needs. That
-- property is dangerous to CREATE because its absence means "filter inactive"
-- and creating it switches a filter on for a whole environment. This one is
-- the opposite: its absence means DENY, so creating it can only ever grant
-- the two people named here, and re-running is a no-op via NOT EXISTS.
--
-- Step 1 is read-only. Read it before running step 2.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. What is there now? Expect 0 rows on a first run ──────────────
SELECT property_key, property_value FROM easyfix_properties WHERE property_key = 'secrets.manager.emails';


-- ─── 2. Seed the allowlist ───────────────────────────────────────────
-- Guarded by NOT EXISTS, so a re-run never overwrites a list ops have since
-- edited by hand. To CHANGE the members later, UPDATE the row directly — this
-- file will not do it for you, deliberately: a migration that overwrites a
-- live access list would silently revoke whoever was added after it shipped.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'secrets.manager.emails', 'sundeep@easyfix.in,priyanka@easyfix.in'
 WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'secrets.manager.emails');


-- ─── 3. Verify ───────────────────────────────────────────────────────
SELECT 'property present' AS what, COUNT(*) AS ok FROM easyfix_properties WHERE property_key = 'secrets.manager.emails'
UNION ALL SELECT 'members', CHAR_LENGTH(property_value) - CHAR_LENGTH(REPLACE(property_value, ',', '')) + 1 FROM easyfix_properties WHERE property_key = 'secrets.manager.emails';

SELECT property_value AS members FROM easyfix_properties WHERE property_key = 'secrets.manager.emails';
