-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-10 — tbl_job_share_link becomes the JOB DELEGATION record.
--
-- WHAT CHANGES. The table was an audit stub for the technician "share a
-- public link" feature (share_id, job_id, fk_easyfixer_id, short_code,
-- created_on — 5 rows, all one 2026-07-27 smoke test). That feature is
-- RETIRED by this release. The same table now records a technician
-- DELEGATING a job to someone else:
--
--   · the job stays ASSIGNED to the original technician
--     (tbl_job.fk_easyfixter_id never moves),
--   · while the share is LIVE the original is read-only,
--   · the delegate does the work in his place.
--
-- fk_easyfixer_id keeps its meaning: it is the SHARER. delegate_efr_id is
-- the technician doing the work; contact_name / contact_number carry the
-- non-technician case (a plain phone number). Both are stored now so the
-- public-link delegate path can be added later WITHOUT a second migration —
-- only the technician path is built in this release.
--
-- STATE MACHINE (services/job-share-delegation.service.js owns it):
--   LIVE     pending → accepted → started
--   TERMINAL rejected · cancelled · expired · completed · handed_back · released
--
-- MINIMAL STYLE per feedback_easyfix_minimal_migration_style: one statement
-- per line, no @set, no PREPARE, nothing MariaDB-only. Re-running this file
-- fails loudly on the ALTERs (duplicate column) rather than half-applying —
-- that is the intended behaviour for a one-shot forward migration.
-- ─────────────────────────────────────────────────────────────────────

-- ─── 1. What exists now (read-only) ──────────────────────────────────
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_job_share_link' ORDER BY ORDINAL_POSITION;

SELECT COUNT(*) AS existing_rows, MIN(created_on) AS oldest, MAX(created_on) AS newest FROM tbl_job_share_link;

-- ─── 2. The delegation columns ───────────────────────────────────────
ALTER TABLE tbl_job_share_link ADD COLUMN delegate_efr_id INT NULL COMMENT 'tbl_easyfixer.efr_id of the technician doing the work; NULL on the phone-number path';

ALTER TABLE tbl_job_share_link ADD COLUMN contact_name VARCHAR(150) NULL COMMENT 'non-technician delegate name (public-link path, not built yet)';

ALTER TABLE tbl_job_share_link ADD COLUMN contact_number VARCHAR(15) NULL COMMENT 'non-technician delegate mobile (public-link path, not built yet)';

ALTER TABLE tbl_job_share_link ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT 'pending|accepted|started|rejected|cancelled|expired|completed|handed_back|released';

ALTER TABLE tbl_job_share_link ADD COLUMN responded_on DATETIME NULL COMMENT 'when the delegate accepted or rejected';

ALTER TABLE tbl_job_share_link ADD COLUMN started_on DATETIME NULL COMMENT 'when the delegate began work — the cancel window closes here';

ALTER TABLE tbl_job_share_link ADD COLUMN ended_on DATETIME NULL COMMENT 'when the share reached a terminal status';

ALTER TABLE tbl_job_share_link ADD COLUMN end_reason VARCHAR(32) NULL COMMENT 'free-text-ish reason accompanying the terminal status';

-- ─── 3. Neutralise the 5 legacy share-LINK rows ──────────────────────
-- They predate the delegation model and would otherwise all default to
-- 'pending' — i.e. read as five live delegations, and (if any two share a
-- job_id) break the UNIQUE index added below. Scoped by created_on rather
-- than by "looks empty": a date bound cannot match a row this release
-- creates later, whereas `delegate_efr_id IS NULL` would match every real
-- phone-number share forever.
UPDATE tbl_job_share_link SET status = 'expired', ended_on = created_on, end_reason = 'legacy_share_link' WHERE created_on < '2026-09-10 00:00:00';

-- ─── 4. At most ONE live share per job, enforced by the DB ───────────
-- MySQL has no partial/filtered index, and the two ways to get one are a
-- generated column or a trigger. GENERATED COLUMN, because:
--   · a trigger is invisible to anyone reading the schema and has to
--     re-implement the LIVE set in a second place,
--   · the column is VIRTUAL, so it costs no row storage,
--   · the LIVE set is written once, here, and the unique key follows it.
-- live_job_id is the job_id while the share is live and NULL once it is
-- terminal; MySQL permits unlimited NULLs in a unique index, so any number
-- of finished shares may exist per job while a second live one is refused
-- at INSERT with ER_DUP_ENTRY (the service maps that to 409).
--
-- Keep this CASE and LIVE_STATUSES in job-share-delegation.service.js in
-- step: they are the same rule expressed twice, and only this one is
-- enforced.
ALTER TABLE tbl_job_share_link ADD COLUMN live_job_id INT GENERATED ALWAYS AS (CASE WHEN status IN ('pending','accepted','started') THEN job_id ELSE NULL END) VIRTUAL;

ALTER TABLE tbl_job_share_link ADD UNIQUE INDEX uq_job_share_live (live_job_id);

-- Read path for "which jobs are delegated TO me" (mobile job list + the
-- /jobs mutation lock). status is second so the index also serves the
-- delegate-only lookups that do not filter status.
ALTER TABLE tbl_job_share_link ADD INDEX idx_share_delegate (delegate_efr_id, status);

-- ─── 5. The feature gate, seeded EMPTY = deny-all ────────────────────
-- CSV of tbl_easyfixer.efr_id values allowed to CREATE a share ('*' = every
-- technician). Read by services/job-share-delegation.service.canCreateShare,
-- which fails CLOSED on an absent or empty value — so this row grants nobody
-- and exists only so the key is visible and editable in the properties admin
-- screen. Seeding it empty rather than leaving it absent is the lesson of
-- migrations/2026-09-09-job-charges-rbac-action.sql: a gate no migration ever
-- seeded denied everyone for a month and no screen could grant it.
--
-- THE LOCK IS NOT GATED, and does not need to be: it activates only where a
-- tbl_job_share_link row is live, and until this property names somebody no
-- such row can be created. It is inert by construction.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'job.share.delegate.efr_ids', ''
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'job.share.delegate.efr_ids');

-- ─── 6. Verify ───────────────────────────────────────────────────────
SELECT 'all 9 columns added' AS what, COUNT(*) AS ok FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_job_share_link' AND COLUMN_NAME IN ('delegate_efr_id','contact_name','contact_number','status','responded_on','started_on','ended_on','end_reason','live_job_id')
UNION ALL SELECT 'live_job_id is generated', COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_job_share_link' AND COLUMN_NAME = 'live_job_id' AND EXTRA LIKE '%GENERATED%'
UNION ALL SELECT 'unique live index', COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_job_share_link' AND INDEX_NAME = 'uq_job_share_live' AND NON_UNIQUE = 0
UNION ALL SELECT 'delegate index', COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_job_share_link' AND INDEX_NAME = 'idx_share_delegate'
UNION ALL SELECT 'legacy rows retired (expect 5)', COUNT(*) FROM tbl_job_share_link WHERE end_reason = 'legacy_share_link'
UNION ALL SELECT 'live shares now (expect 0)', COUNT(*) FROM tbl_job_share_link WHERE live_job_id IS NOT NULL
UNION ALL SELECT 'gate property seeded (deny-all)', COUNT(*) FROM easyfix_properties WHERE property_key = 'job.share.delegate.efr_ids';

-- AFTER RUNNING: nobody can share a job until an operator puts efr_ids into
-- easyfix_properties['job.share.delegate.efr_ids'] (or '*'), and flushes the
-- property cache (the 10-click gesture on the logo, or the admin reload).
