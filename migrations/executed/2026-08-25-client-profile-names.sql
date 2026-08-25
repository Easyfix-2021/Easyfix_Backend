-- ============================================================================
-- 2026-08-25 — Client Profile: the two MISSING presentation names
--
-- WHAT THIS DOES
--   Adds TWO nullable columns to tbl_client:
--
--     display_name  VARCHAR(255) NULL   -- how the client reads inside the CRM
--     tech_app_name VARCHAR(255) NULL   -- how the client reads to a technician
--
-- WHY ONLY TWO, WHEN THE DESIGN ASKS FOR THREE
--   The Client Profile screen shows four names: the legal/master client name
--   plus three presentation names (CRM display, Billing, Technician app).
--   `billing_name` ALREADY EXISTS on tbl_client — the legacy CRM writes it in
--   ClientDaoImpl#updateClient (`billing_name = ?`) and reads it back as
--   `setInvoiceName`. Adding a second billing-name column would have split
--   invoicing across two sources of truth, so this migration reuses it and
--   only adds the two that genuinely have no home.
--
-- WHY THEY EXIST AT ALL
--   One client is currently forced to read identically everywhere. Ops want
--   "Brightline Retail" in the CRM list, "Brightline Retail Private Limited"
--   on an invoice, and a short "Brightline" on a technician's phone where the
--   job card has ~14 characters of width. Today the only lever is client_name,
--   which is also the legal name on the master row.
--
-- ─── NULL IS LOAD-BEARING ───────────────────────────────────────────────────
--   Both columns are NULLABLE with NO default and NO backfill, and every read
--   path COALESCEs to client_name. That makes this migration behaviour-
--   preserving byte-for-byte: a client nobody has configured keeps rendering
--   exactly as it does today, on every surface, with no operator action.
--   Do NOT backfill them to client_name — a copied value is indistinguishable
--   from a deliberate one, and "has ops set this?" stops being answerable.
--
-- SAFE FOR THE LEGACY CONSUMER — checked, not assumed
--   tbl_client is shared with EasyFix_CRM (Java/Hibernate + JdbcTemplate), so
--   CLAUDE.md's "never alter schema" applies and this needed evidence:
--     • ClientDaoImpl#saveClient   — an explicit column-list INSERT. A column
--       it does not name is simply left at its default (NULL). No error.
--     • ClientDaoImpl#updateClient — an explicit `SET col = ?` list. It cannot
--       clobber a column it does not name, so a legacy Edit Client save leaves
--       display_name / tech_app_name intact.
--     • ClientDaoImpl#getClientDetails — `SELECT CL.*`, mapped field-by-field
--       via rs.getString("<name>"). Extra columns in the ResultSet are ignored.
--     • Client.hbm.xml (invoice module) maps a NAMED subset of properties, not
--       the whole table, so an unmapped column is invisible to Hibernate.
--   Net: purely additive, invisible to every legacy code path.
--
-- ─── HOW TO APPLY ───────────────────────────────────────────────────────────
--   Run STATEMENT BY STATEMENT, in order, against easyfix_core.
--
--   Section 1 is a read-only INFORMATION_SCHEMA preflight that tells you which
--   of the two ALTERs still need to run. Sections 2 and 3 are plain ALTERs and
--   are deliberately NOT wrapped in `SET @sql := … PREPARE … EXECUTE` — that
--   pattern was banned in this repo on 2026-05-30 because running it
--   statement-by-statement in a GUI client makes the column-add appear to
--   execute while its effect is invisible to the next statement in the same
--   prepared pipeline. MySQL has no `ADD COLUMN IF NOT EXISTS` (MariaDB-only),
--   so the honest idempotent apply is: read the preflight, then run or skip.
--
--   ON A RE-RUN, expect and ignore, if you run sections 2/3 anyway:
--     ERROR 1060 (42S21): Duplicate column name 'display_name'
--     ERROR 1060 (42S21): Duplicate column name 'tech_app_name'
--   Nothing else in this file errors on a re-run — section 4 is read-only.
--
-- IDEMPOTENCY
--   1. Preflight  read-only, always safe.
--   2/3. ALTERs   guarded by the preflight; re-running errors 1060, changes
--                 nothing.
--   4. Verify     read-only.
--
-- POST-APPLY
--   No restart, no cache flush, no re-login. Note that client.service.js probes
--   INFORMATION_SCHEMA ONCE per process and memoises the result, so a backend
--   already running when this is applied keeps skipping the two columns until
--   it restarts. Until then the Client Profile hides both inputs (it gates them
--   on the keys being present in the detail payload) rather than showing fields
--   that would silently discard what an operator typed.
-- ============================================================================

-- ─── 1. Preflight — which columns already exist? ────────────────────────────
-- Expect 0 rows on a fresh apply (run both ALTERs), 2 rows if fully applied.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'tbl_client'
   AND COLUMN_NAME IN ('display_name', 'tech_app_name');

-- ─── 2. CRM display name ────────────────────────────────────────────────────
-- NULL = "not configured"; every read path falls back to client_name.
ALTER TABLE tbl_client ADD COLUMN display_name VARCHAR(255) NULL;

-- ─── 3. Technician-app name ─────────────────────────────────────────────────
-- Deliberately the same width as the others rather than a short VARCHAR(40):
-- the technician app truncates for display, and a DB-level cap would reject an
-- ops paste instead of shortening it.
ALTER TABLE tbl_client ADD COLUMN tech_app_name VARCHAR(255) NULL;

-- ─── 4. Verification ────────────────────────────────────────────────────────
-- Expect exactly three rows — the two new columns plus the pre-existing
-- billing_name the profile screen reuses. All three varchar(255) / YES.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'tbl_client'
   AND COLUMN_NAME IN ('display_name', 'billing_name', 'tech_app_name')
 ORDER BY COLUMN_NAME;

-- Nothing is backfilled, so every client must still report NULL for both.
-- `configured_display` and `configured_tech_app` must both be 0 immediately
-- after apply.
SELECT COUNT(*)                                        AS total_clients,
       SUM(display_name  IS NOT NULL AND display_name  <> '') AS configured_display,
       SUM(tech_app_name IS NOT NULL AND tech_app_name <> '') AS configured_tech_app,
       SUM(billing_name  IS NOT NULL AND billing_name  <> '') AS configured_billing
  FROM tbl_client;
