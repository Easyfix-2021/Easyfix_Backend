-- ============================================================================
-- 2026-09-23 — QuickSight Custom Reports: who may transfer a report's owner
--
-- WHAT: seeds the easyfix_properties key `access.dynamicreport.owner.emails`,
-- a CSV email allowlist read by services/feature-access.service.js
-- (FEATURES.canTransferReportOwner).
--
-- WHO MAY TRANSFER after this runs: the report's OWNER, or an email listed
-- here. NO ROLE grants it — not even isQuickSightDynamicReportAdmin, which
-- still grants see-all / edit / upload / archive. That is deliberate: the case
-- this exists for is an owner who LOST QuickSight access, so the rescue must
-- not sit behind a role grant the same reorganisation can revoke.
--
-- FAIL-CLOSED: an absent or empty value denies everyone except each report's
-- own owner, and the CRM simply does not show the Transfer Owner action.
-- Edit the CSV to change the list — no deploy needed, the property is read at
-- request time. Emails must also be admin-group CRM users (the parent admin
-- router's role gate still applies) and must match tbl_user.official_email.
--
-- HOW TO APPLY: statement by statement. NOT EXISTS-guarded, so a re-run is a
-- no-op and will NOT overwrite a list edited on the server. To change the list
-- later, UPDATE it (section 2) rather than re-running the INSERT.
-- Leave this file in migrations/ (pending) — do not move it into executed/.
-- ============================================================================

-- ─── 1. Seed (idempotent; skipped when the key already exists) ──────────────
-- easyfix_properties is (property_key, property_value, updated_at) — no description
-- column, and updated_at defaults, so only the two columns are named here.
INSERT INTO easyfix_properties (property_key, property_value) SELECT 'access.dynamicreport.owner.emails', 'sundeep@easyfix.in,shaifali@easyfix.in,priyanka@easyfix.in,harkirpa@easyfix.in' WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'access.dynamicreport.owner.emails');

-- ─── 2. Change the list later (edit the CSV, then run this line) ────────────
-- UPDATE easyfix_properties SET property_value = 'a@easyfix.in,b@easyfix.in' WHERE property_key = 'access.dynamicreport.owner.emails';

-- ─── 3. Verify (read-only) ──────────────────────────────────────────────────
-- SELECT property_key, property_value FROM easyfix_properties WHERE property_key = 'access.dynamicreport.owner.emails';
-- Every listed email should match a CRM user:
-- SELECT user_id, user_name, official_email FROM tbl_user WHERE official_email IN ('sundeep@easyfix.in','shaifali@easyfix.in','priyanka@easyfix.in','harkirpa@easyfix.in');
