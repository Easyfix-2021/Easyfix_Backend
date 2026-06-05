-- =============================================================================
-- Auto-Allocation settings — add the new keys the app expects.
-- Run on easyfix_core (QA first, then prod).
--
-- Safe to re-run: the INSERTs are guarded with NOT EXISTS so they're
-- idempotent. No DROPs, no ALTERs of existing rows — purely additive.
--
-- Schema already in use (no changes needed):
--   tbl_autoallocation_setting (id, `key`, default_value, description, data_type)
--   tbl_client_setting         (client_id, setting_id, value, deleted, …)
-- =============================================================================

-- 1. Failure-notification email (string).
--    Address that receives a notice when auto-assign can't find a match
--    for a freshly-created job. Empty = no notifications.
INSERT INTO tbl_autoallocation_setting (`key`, default_value, description, data_type)
SELECT 'auto_assign_failure_email',
       '',
       'Email to notify when auto-assign cannot find an eligible technician for a new job. Leave blank to skip.',
       'string'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_autoallocation_setting WHERE `key` = 'auto_assign_failure_email');

-- 2. (Optional future use) Max candidates returned by the engine for audit/preview.
--    Engine currently hardcodes limit=10 per the pipeline diagram; putting it
--    in settings lets ops widen the audit trail without a code deploy.
INSERT INTO tbl_autoallocation_setting (`key`, default_value, description, data_type)
SELECT 'auto_assign_top_candidates_count',
       '10',
       'Top-N candidates evaluated by the scoring layer (L3). Only the #1 is assigned; the rest are logged.',
       'integer'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_autoallocation_setting WHERE `key` = 'auto_assign_top_candidates_count');

-- 3. (Was: max_travel_distance_km.) Removed 2026-04-20 — eligibility switched
--    from haversine GPS distance to ZONE membership (tbl_zone_master via
--    tbl_easyfixer.efr_zone_city_id). Distance is no longer a filter or a
--    scoring dimension, so this setting key is intentionally not created.
--    If a previous run of this file already inserted the row, run:
--      DELETE FROM tbl_autoallocation_setting WHERE `key` = 'max_travel_distance_km';

-- 4. (Optional) Max concurrent active jobs per technician — L2 filter.
INSERT INTO tbl_autoallocation_setting (`key`, default_value, description, data_type)
SELECT 'max_concurrent_jobs',
       '5',
       'L2 availability filter: reject technicians who already have this many or more active jobs (status 0/1/2).',
       'integer'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_autoallocation_setting WHERE `key` = 'max_concurrent_jobs');

-- =============================================================================
-- 5. Sidebar menu entry for the new "Manage Auto Allocations" page.
--    Lives under Settings (menu_id 13). URL `manageAutoAllocations` is what
--    our Sidebar URL_MAP resolves to `/settings/auto-allocation`. Sequence
--    9.0091 slots it right after "Manage Deep Skills" (9.009) and before
--    "Admin Action" (9.007) — tune if you want a different position.
--    Legacy never built this menu entry (we verified — no row in tbl_menu
--    references auto/allocation), so this is net-new.
-- =============================================================================

INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'Manage Auto Allocations', 13, 2, 0, 'manageAutoAllocations', 1, 9.0091, 'fa-magic', 'NoAction'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_menu WHERE url = 'manageAutoAllocations' OR menu_name = 'Manage Auto Allocations');

-- =============================================================================
-- Verification
-- =============================================================================
-- After running, confirm with:
--
--   SELECT id, `key`, default_value, data_type
--     FROM tbl_autoallocation_setting
--    WHERE `key` IN (
--      'auto_assign_failure_email',
--      'auto_assign_top_candidates_count',
--      'max_concurrent_jobs'
--    );
--   -- Expected: 3 rows.
--
--   SELECT menu_id, menu_name, url, parent_menu, sequence, menu_status
--     FROM tbl_menu
--    WHERE url = 'manageAutoAllocations';
--   -- Expected: 1 row under parent_menu=13 (Settings), menu_status=1.
-- =============================================================================

-- =============================================================================
-- EXAMPLE: enable instant auto-assign globally + set ops email
-- Use the CRM Settings → Manage Auto Allocations page for this; SQL shown
-- only for break-glass / direct-DB scenarios:
-- =============================================================================
--
-- -- Turn ON instant auto-assign as the global default:
-- UPDATE tbl_autoallocation_setting
--    SET default_value = 'instant'
--  WHERE `key` = 'running_frequency';
--
-- -- Set a global ops email for failure notifications:
-- UPDATE tbl_autoallocation_setting
--    SET default_value = 'ops@easyfix.in'
--  WHERE `key` = 'auto_assign_failure_email';
--
-- -- Override: turn OFF auto-assign just for client_id=245:
-- INSERT INTO tbl_client_setting (client_id, setting_id, value, deleted, starttimestamp)
-- VALUES (
--   245,
--   (SELECT id FROM tbl_autoallocation_setting WHERE `key` = 'running_frequency'),
--   'schedule',
--   0,
--   NOW()
-- );
