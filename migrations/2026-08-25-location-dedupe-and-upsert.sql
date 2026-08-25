-- ─────────────────────────────────────────────────────────────────────
-- 2026-08-25 — `location`: collapse to one row per user, in place
--
-- WHY
--   The CRM's "Live Technician Location" popover showed "Location
--   unavailable" for EVERY technician. It reads tbl_job_location_track,
--   which the NEW Expo app writes — and which has 0 rows, because
--   essentially every technician is still on the LEGACY Flutter app. That
--   app's GPS lands here, in `location`: 2.46M rows on prod, 2.12M on QA,
--   ~120 MB, MyISAM/latin1.
--
--   services/job-location.service.js::getLatestByEfr now falls back to this
--   table when tbl_job_location_track has nothing. That fallback is only
--   affordable WITH THIS MIGRATION APPLIED. Today the table's ONLY index is
--   PRIMARY KEY(id) — nothing on user_id — so `WHERE user_id = ? ORDER BY id
--   DESC LIMIT 1` full-scans 2.5M rows, and the popover re-polls every 15s
--   while an operator has it open. The index is a PRECONDITION, not a tuning
--   step.
--
-- WHAT
--   Deduplicate `location` in place down to its newest row per user_id, add
--   UNIQUE KEY (user_id), and add a NULLable captured_at for future writers.
--   Result: ~6,279 rows (the measured distinct-user count on QA — and
--   `SELECT COUNT(*) FROM (SELECT MAX(id) FROM location GROUP BY user_id) t`
--   equals it exactly, so the keep-set is one row per user, no more).
--
--   The table is NOT renamed and NOT rebuilt beside itself. Everything below
--   operates on `location` directly.
--
-- WHY IN PLACE RATHER THAN REBUILD-AND-SWAP
--   A copy-then-RENAME does the bulk work without locking the live table,
--   but it has one property that disqualifies it here: rows written BETWEEN
--   the copy and the rename are silently lost in the swap, and the two Java
--   writers post continuously. Getting that right needs a watermark, a
--   catch-up pass and a quiet window — three chances to lose a technician's
--   position for a saving that a chunked delete already achieves.
--
--   Operating in place cannot lose a write. The cost is lock time, and
--   step 2 below bounds that deliberately.
--
-- WHY MAX(id) IS "NEWEST"
--   `location` has NO timestamp column. `id` is the auto-increment PK, so
--   for a given user_id the largest id is the most recently inserted row.
--   That is the only ordering signal the table has, and it is sound: every
--   writer goes through a plain INSERT.
--
-- ⚠ ORDER IS LOAD-BEARING — DO NOT ADD THE UNIQUE KEY FIRST
--   Both Java writers (ACD_APIs and API_AngularClientDashboard,
--   AddressServiceImpl::updateCurrentLocation) do a plain INSERT today. Add
--   UNIQUE KEY (user_id) before they are switched to an upsert and EVERY
--   ping after a user's first one throws. Step 3 is safe only because
--   step 2 has already collapsed the duplicates — and it stays safe only
--   until the next ping arrives, so step 4 must follow promptly.
--
-- ⚠ TWO JAVA APPS WRITE THIS TABLE
--   ACD_APIs AND API_AngularClientDashboard carry an identical copy of
--   AddressServiceImpl. BOTH must be switched to
--   `INSERT … ON DUPLICATE KEY UPDATE` (stamping captured_at = NOW()).
--   Miss one and it re-inflates the table and starts throwing on its own
--   INSERTs. That deploy is SEPARATE from this SQL and should land
--   immediately after step 3 — ideally in the same maintenance window.
--
-- ⚠ captured_at IS NULL FOR EVERY SURVIVING ROW, AND THAT IS CORRECT
--   Those positions were recorded before the column existed; their age is
--   genuinely unknown. Do NOT backfill them with NOW() — that would make
--   6,279 stale positions render as "just now", which is the one outcome
--   worse than showing nothing. The CRM has an explicit "age unknown" state
--   for exactly this.
--
-- ROLLBACK
--   Step 2 is irreversible — the deleted history is gone. It is history
--   nothing has ever read (LocationRepository declares zero finder methods;
--   the only usage in either Java app is `locationRepository.save(...)`), so
--   this is deliberate, not incidental. If you want a safety net, take a
--   mysqldump of `location` before step 2.
--   Steps 3 and 4 reverse with DROP INDEX / DROP COLUMN.
-- ─────────────────────────────────────────────────────────────────────


-- ── Step 0 · Read-only. Record these numbers before changing anything. ──
SELECT COUNT(*) AS rows_before, COUNT(DISTINCT user_id) AS distinct_users FROM location;
SELECT COUNT(*) AS will_survive FROM (SELECT MAX(id) FROM location GROUP BY user_id) t;


-- ── Step 1 · The keep-set, materialised. ──
-- A plain temp table rather than a correlated subquery in the DELETE:
-- MySQL cannot read from the table it is deleting inside a subquery, and
-- materialising once means the 2.4M-row scan happens ONCE rather than per
-- delete chunk.
DROP TABLE IF EXISTS location_keep;
CREATE TABLE location_keep (id INT NOT NULL, PRIMARY KEY (id)) ENGINE=MyISAM;
INSERT INTO location_keep (id) SELECT MAX(id) FROM location GROUP BY user_id;

-- Sanity: this must equal `will_survive` from step 0.
SELECT COUNT(*) AS keep_rows FROM location_keep;


-- ── Step 2 · Delete the history, in bounded chunks. ──
-- CHUNKED ON PURPOSE. MyISAM takes a table-level write lock for the whole
-- statement, so one 2.45M-row DELETE would block both Java writers for its
-- entire duration. 50k at a time keeps each lock short enough that a ping
-- waits rather than times out.
--
-- Re-run this statement until it reports 0 rows affected. It is idempotent:
-- once every non-keep row is gone it matches nothing.
DELETE l FROM location l LEFT JOIN location_keep k ON k.id = l.id WHERE k.id IS NULL LIMIT 50000;

-- ...repeat the line above until "0 rows affected", then verify:
SELECT COUNT(*) AS rows_after FROM location;


-- ── Step 3 · Now the unique key is safe to add. ──
ALTER TABLE location ADD UNIQUE KEY uq_location_user (user_id);


-- ── Step 4 · Somewhere for a real timestamp to live. ──
-- NULLable with no default: existing rows keep an honest "unknown age", and
-- the upserting writers stamp NOW() from here on.
ALTER TABLE location ADD COLUMN captured_at DATETIME NULL;


-- ── Step 5 · Reclaim the disk. ──
-- A MyISAM DELETE leaves the .MYD at its original size, full of holes —
-- ~120 MB for 6,279 rows. OPTIMIZE rewrites the file and rebuilds the
-- indexes. It takes a table lock for the rewrite, but on a table that is now
-- a few hundred KB that is measured in milliseconds rather than minutes.
OPTIMIZE TABLE location;


-- ── Step 6 · Cleanup. ──
DROP TABLE IF EXISTS location_keep;


-- ── Verification ──
-- rows ≈ distinct users, one unique index on user_id, captured_at present
-- and NULL everywhere, and the lookup the CRM makes is now a single-row
-- index hit rather than a 2.5M-row scan.
SELECT COUNT(*) AS rows_final, COUNT(DISTINCT user_id) AS users_final FROM location;
SELECT ROUND((data_length + index_length) / 1048576, 2) AS size_mb FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'location';
SHOW INDEX FROM location WHERE Key_name = 'uq_location_user';
SELECT COUNT(*) AS with_timestamp FROM location WHERE captured_at IS NOT NULL;
EXPLAIN SELECT l.id FROM tbl_easyfixer e JOIN location l ON l.user_id = e.user_id WHERE e.efr_id = 6634 ORDER BY l.id DESC LIMIT 1;
