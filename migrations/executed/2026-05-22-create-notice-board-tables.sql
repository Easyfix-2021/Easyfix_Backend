-- =============================================================================
-- Notice Board feature — DB schema (Phase 1: CRM management surfaces only).
-- Consumer surfaces (Client_UI + EasyFixer_App) will land in a separate
-- migration once those frontends ship.
--
-- THREE new EasyFix-owned tables (no legacy service references them, so the
-- "never alter schema" rule's allowed-exception clause applies — see
-- CLAUDE.md, tbl_pincode precedent):
--
--   tbl_notice           — the notices themselves
--   tbl_notice_category  — admin-managed coloured category tags
--   tbl_notice_read      — per-user read receipts (drives unread badge +
--                          Read% column in the All-Notices table)
--
-- Holidays for the "Upcoming Events" rail are NOT a DB table — they are
-- pulled from the free open-source Nager.Date API and cached in BE memory.
-- See services/holiday.service.js.
--
-- IDEMPOTENT: every CREATE TABLE uses IF NOT EXISTS, every INSERT is guarded
-- with NOT EXISTS so re-runs of this migration are a no-op.
-- =============================================================================

-- ─── 1. tbl_notice_category ───────────────────────────────────────────
-- Admin-managed category list. Each notice carries a single category,
-- whose `color` becomes the chip tint on every surface that renders it.
-- `applies_to_surfaces` is a CSV subset of {crm,client,technician} —
-- lets us hide a category (e.g. "Driver Incentive") from surfaces it
-- doesn't make sense on.
CREATE TABLE IF NOT EXISTS tbl_notice_category (
  category_id          INT          NOT NULL AUTO_INCREMENT,
  name                 VARCHAR(60)  NOT NULL,
  color                VARCHAR(20)  NOT NULL,                              -- hex, e.g. '#2E86DE'
  applies_to_surfaces  VARCHAR(50)  NOT NULL DEFAULT 'crm,client,technician',
  sort_order           INT          NOT NULL DEFAULT 0,
  is_active            TINYINT(1)   NOT NULL DEFAULT 1,
  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                              ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (category_id),
  UNIQUE KEY uq_notice_category_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 2. tbl_notice ────────────────────────────────────────────────────
-- The notice itself. Status lifecycle:
--   draft  → (publish_at in future) scheduled  → published  → archived
--   draft  → (publish_at = now)                  published  → archived
-- "expired" is DERIVED from expire_at < NOW(), not a stored state.
-- target_surfaces is the spec's recipient_type generalised — CSV subset
-- of {crm,client,technician}. v1 only uses audience_scope='all'; the
-- audience_ref_id column is reserved for future city/specific targeting.
-- reviewed_by/published_by are reserved for the maker-checker rights
-- model (Phase 2); v1 collapses all transitions onto isNoticeManage.
CREATE TABLE IF NOT EXISTS tbl_notice (
  notice_id        INT           NOT NULL AUTO_INCREMENT,
  title            VARCHAR(255)  NOT NULL,
  body             TEXT          NOT NULL,
  category_id      INT           NOT NULL,
  target_surfaces  VARCHAR(50)   NOT NULL,                                   -- CSV: 'crm,client,technician' subset
  audience_scope   ENUM('all','city','specific') NOT NULL DEFAULT 'all',
  audience_ref_id  INT           NULL,                                       -- city_id / recipient_id when scope ≠ all
  action_url       VARCHAR(500)  NULL,
  is_pinned        TINYINT(1)    NOT NULL DEFAULT 0,
  status           ENUM('draft','scheduled','published','archived')
                                 NOT NULL DEFAULT 'draft',
  publish_at       DATETIME      NULL,
  expire_at        DATETIME      NULL,
  created_by       INT           NOT NULL,
  reviewed_by      INT           NULL,                                       -- reserved for maker-checker v2
  published_by     INT           NULL,                                       -- reserved for maker-checker v2
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                          ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (notice_id),
  KEY idx_notice_status_publish (status, publish_at, expire_at),
  KEY idx_notice_pinned_pubat   (is_pinned, publish_at),
  KEY idx_notice_category       (category_id),
  KEY idx_notice_created_by     (created_by)
  -- No FKs to tbl_user / tbl_notice_category: keeping the table independent
  -- of legacy schema referential integrity matches the project's existing
  -- convention (tbl_job, tbl_easyfixer also avoid hard FKs to tbl_user).
  -- Service layer validates foreign keys before insert.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 3. tbl_notice_read ───────────────────────────────────────────────
-- Per-user read receipts. `surface` distinguishes a read on CRM from a
-- read on the same user's app (a SPOC can be both a tbl_user and a
-- tbl_client_contacts row, so this matters). `reader_type` + `reader_id`
-- maps to the right user table:
--   crm_user → tbl_user.user_id
--   client   → tbl_client_contacts.id  (or tbl_client.client_id — TBD on Phase 2)
--   efr      → tbl_easyfixer.efr_id
-- UNIQUE ensures one row per (notice, surface, reader); subsequent
-- mark-as-read calls are idempotent.
CREATE TABLE IF NOT EXISTS tbl_notice_read (
  id            INT          NOT NULL AUTO_INCREMENT,
  notice_id     INT          NOT NULL,
  surface       ENUM('crm','client','technician') NOT NULL,
  reader_type   ENUM('crm_user','client','efr')   NOT NULL,
  reader_id     INT          NOT NULL,
  read_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_notice_read (notice_id, surface, reader_type, reader_id),
  KEY idx_notice_read_reader (reader_type, reader_id),
  KEY idx_notice_read_notice (notice_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 4. Seed default categories ───────────────────────────────────────
-- Five default chips matching the spec's examples (INCENTIVE, WEATHER,
-- POLICY, UPDATE, General). Admin can edit/add more from the Compose
-- form. Colours chosen from a colour-blind-friendly palette.
INSERT INTO tbl_notice_category (name, color, applies_to_surfaces, sort_order, is_active)
SELECT * FROM (
  SELECT 'Incentive' AS name, '#16a34a' AS color, 'crm,client,technician' AS applies_to_surfaces, 1 AS sort_order, 1 AS is_active UNION ALL
  SELECT 'Weather',           '#f59e0b',          'crm,client,technician',                         2,             1                 UNION ALL
  SELECT 'Policy',            '#7c3aed',          'crm,client,technician',                         3,             1                 UNION ALL
  SELECT 'Update',            '#2563eb',          'crm,client,technician',                         4,             1                 UNION ALL
  SELECT 'General',           '#64748b',          'crm,client,technician',                         5,             1
) AS seed
WHERE NOT EXISTS (
  SELECT 1 FROM tbl_notice_category WHERE name = seed.name
);

-- ─── 5. Verify ────────────────────────────────────────────────────────
SELECT 'tbl_notice'           AS table_name, (SELECT COUNT(*) FROM tbl_notice)          AS row_count
UNION ALL
SELECT 'tbl_notice_category', (SELECT COUNT(*) FROM tbl_notice_category)
UNION ALL
SELECT 'tbl_notice_read',     (SELECT COUNT(*) FROM tbl_notice_read);
