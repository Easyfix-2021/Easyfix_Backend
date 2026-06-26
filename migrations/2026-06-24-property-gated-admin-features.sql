-- 2026-06-24 — Property-gated admin capabilities (user-specific access)
--
-- Seeds the easyfix_properties allowlists that restrict two sensitive Admin
-- Actions to SPECIFIC users (by official email):
--   • access.callmode.emails     → Switch Call Mode (Web⇄Mobile + default provider)
--   • access.entitydelete.emails → Delete / Restore Easyfixer & User
--
-- These keys are the SOLE gate (BE middleware/require-property-allowlist.js +
-- FE GET /admin/access/features). They are intentionally NOT in
-- menu_action / role_menu_action, so the features can NEVER be granted from the
-- Manage Role screen.
--
-- EDIT each CSV to the exact operators who should hold the capability. An empty
-- value = deny-all (fail closed). Seeded with a bootstrap set so the features
-- aren't dead on arrival — adjust to the real list.
--
-- Style: plain one-statement-per-line; idempotent (re-run = no-op).

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'access.callmode.emails', 'shaifali@easyfix.in,sundeep@easyfix.in,priyanka@easyfix.in'
 WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'access.callmode.emails');

INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'access.entitydelete.emails', 'shaifali@easyfix.in,sundeep@easyfix.in,priyanka@easyfix.in'
 WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'access.entitydelete.emails');
