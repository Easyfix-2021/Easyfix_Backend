-- ============================================================================
-- 2026-08-20 — Client SPOC access model + per-client contracted targets
--
-- Creates, in one idempotent pass:
--   1. easyfix_client_spoc_access  — role + tri-state override flags per SPOC
--   2. easyfix_client_target       — the SLA / FTFR / revisit / age targets the
--                                    Performance book is measured against
--   3. a seed for every currently active SPOC — role 3, all overrides NULL
--
-- Run on: easyfix_core (shared MySQL DB, port 3306)
--
-- SCHEMA POLICY. Both tables are brand-new and EasyFix-OWNED; no legacy service
-- references either. That is the explicit exception CLAUDE.md carves out of the
-- "never alter schema, never add tables" rule (same playbook as tbl_pincode /
-- easyfix_theme_variant). NOTHING EXISTING IS ALTERED — in particular
-- tbl_client_contacts is NOT given a spoc_role column, because five legacy
-- services read that table and an added column is a schema alteration.
--
-- WHY A SIDE TABLE IS ALSO THE BETTER MODEL. Overrides here are TRI-STATE:
--   NULL = inherit whatever the role grants   (the common case)
--   1    = granted to this SPOC alone         (role says no, this person may)
--   0    = revoked from this SPOC alone       (role says yes, this person may not)
-- A TINYINT column defaulting to 0 on the contacts table could only ever ADD
-- permission. Revocation is the half that matters on an invoicing screen.
--
-- IDEMPOTENT. Every write is IF NOT EXISTS / NOT EXISTS guarded, so a second
-- run is a no-op. The seed in step 3 deliberately inserts only rows that are
-- absent — re-running must never reset an administrator's edit.
-- ============================================================================

-- ─── 1. Per-SPOC access ─────────────────────────────────────────────
-- contact_id is a foreign key BY CONVENTION to tbl_client_contacts.id. No real
-- FK constraint: declaring one would be an ALTER against a legacy-owned table
-- (it installs an index and a referential action on tbl_client_contacts), which
-- the schema policy forbids. Orphan rows are harmless — resolveAccess() only
-- ever reads this table via a LEFT JOIN from an already-authenticated SPOC.
--
-- spoc_role: 1 Store SPOC · 2 Regional manager · 3 Senior leader · 4 Finance
-- Kept as a small integer rather than an ENUM so adding a role later is an
-- application change, not a schema alteration.
CREATE TABLE IF NOT EXISTS easyfix_client_spoc_access (
  contact_id INT NOT NULL PRIMARY KEY,
  client_id INT NOT NULL,
  spoc_role TINYINT NOT NULL DEFAULT 1,
  can_view_performance TINYINT(1) NULL DEFAULT NULL,
  can_view_invoicing TINYINT(1) NULL DEFAULT NULL,
  can_approve_estimates TINYINT(1) NULL DEFAULT NULL,
  can_view_all_stores TINYINT(1) NULL DEFAULT NULL,
  updated_by INT NULL,
  updated_at DATETIME NOT NULL,
  INDEX idx_spoc_access_client (client_id, spoc_role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 2. Per-client contracted targets ───────────────────────────────
-- One row per client. A MISSING ROW IS NOT AN ERROR: client-target.service.js
-- falls back to the platform defaults below, so Performance renders for a
-- client nobody has configured yet. That is why there is no seed for this
-- table — an unconfigured client should read as "platform default", not as a
-- contract someone agreed to.
--
-- Percentages are stored as percentages (90.00 = 90%), not fractions, so the
-- values in the DB read the same as the values in the contract PDF.
CREATE TABLE IF NOT EXISTS easyfix_client_target (
  client_id INT NOT NULL PRIMARY KEY,
  sla_pct DECIMAL(5,2) NOT NULL DEFAULT 90.00,
  ftfr_pct DECIMAL(5,2) NOT NULL DEFAULT 85.00,
  revisit_pct DECIMAL(5,2) NOT NULL DEFAULT 10.00,
  avg_age_days DECIMAL(5,2) NOT NULL DEFAULT 3.00,
  approval_response_hours INT NOT NULL DEFAULT 24,
  updated_by INT NULL,
  updated_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 3. Seed ────────────────────────────────────────────────────────
-- Every active SPOC starts at spoc_role = 3 (Senior Leader), with EVERY
-- override left NULL — meaning "inherit the role".
--
-- WHAT THAT GRANTS: Home, Open, Completed, My Actions, Invoicing AND
-- Performance. Nothing is withheld on day one.
--
-- TWO SEPARATE DECISIONS ARE ENCODED HERE, AND ONLY ONE OF THEM IS OBVIOUS.
--
--   Invoicing at role 3 preserves the STATUS QUO. Every active client SPOC can
--   already reach Invoices, Wallet and Ratecard in the portal today. Seeding
--   role 1 instead would silently strip Invoices from everyone on deploy day.
--
--   Performance is granted DELIBERATELY, not by omission. It is a brand-new
--   surface, so the cautious default would have been to revoke it with
--   can_view_performance = 0 and let administrators grant it person by person.
--   That was the original seed. It was changed on the product owner's call:
--   a client seeing their OWN turn-around-time performance is not a
--   confidentiality concern — it is the number both sides quote in a review,
--   and the client already lives every job in it. The commercially sensitive
--   surface is Invoicing, and that one is only preserved, never widened.
--
--   The mobile client app's Insights card reads the same grant, so revoking it
--   here would blank that card too.
--
-- ALL OVERRIDES NULL, NOT 1. Null inherits, so a later change to what role 3
-- grants flows through to everyone automatically. Seeding literal 1s would
-- freeze today's answer into 8,000 rows and quietly defeat the role model.
--
-- To WITHHOLD Performance from someone later, set their
-- can_view_performance = 0 — the tri-state override exists precisely so a
-- single person can be an exception without changing anybody else.
INSERT INTO easyfix_client_spoc_access (contact_id, client_id, spoc_role, updated_at)
SELECT cc.id, cc.client_id, 3, NOW()
  FROM tbl_client_contacts cc
 WHERE cc.status = 1
   AND NOT EXISTS (SELECT 1 FROM easyfix_client_spoc_access a WHERE a.contact_id = cc.id);

-- ─── Verification ───────────────────────────────────────────────────
-- Both tables must report present = 1. seeded_spocs must equal active_spocs.
SELECT 'easyfix_client_spoc_access table' AS what, COUNT(*) AS present
  FROM INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'easyfix_client_spoc_access'
UNION ALL
SELECT 'easyfix_client_target table', COUNT(*)
  FROM INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'easyfix_client_target'
UNION ALL
SELECT 'idx_spoc_access_client index', COUNT(DISTINCT INDEX_NAME)
  FROM INFORMATION_SCHEMA.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'easyfix_client_spoc_access'
   AND INDEX_NAME = 'idx_spoc_access_client';

-- Seed coverage. These two numbers MUST match after a run.
SELECT COUNT(*) AS active_spocs FROM tbl_client_contacts WHERE status = 1;

SELECT COUNT(*) AS seeded_spocs
  FROM easyfix_client_spoc_access a
  JOIN tbl_client_contacts cc ON cc.id = a.contact_id
 WHERE cc.status = 1;

-- Every seeded SPOC should hold Performance (role 3 grants it, and the seed
-- leaves the override NULL = inherit). This count must equal seeded_spocs.
SELECT COUNT(*) AS spocs_with_performance
  FROM easyfix_client_spoc_access
 WHERE spoc_role = 3 AND (can_view_performance IS NULL OR can_view_performance = 1);

-- And nobody should have been seeded with a hard-coded override — every
-- override column must be NULL immediately after this runs, so the role model
-- stays the single lever. This must return 0.
SELECT COUNT(*) AS spocs_with_seeded_overrides
  FROM easyfix_client_spoc_access
 WHERE can_view_performance IS NOT NULL
    OR can_view_invoicing IS NOT NULL
    OR can_approve_estimates IS NOT NULL
    OR can_view_all_stores IS NOT NULL;
