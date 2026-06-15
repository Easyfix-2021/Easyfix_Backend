-- =============================================================================
-- Auto-Allocation settings — add the configurable keys called out in the
-- updated "How It Works" copy on the Manage Auto Allocations page.
--
-- Each key surfaces automatically in the Advanced section of the UI once
-- inserted (no UI changes needed — the page renders all settings rows
-- that aren't on the explicit hidden list).
--
-- Run on easyfix_core (QA first, then prod). Idempotent: NOT EXISTS guard.
-- =============================================================================

-- 1. Travel distance cap (km). NEW spec re-introduces a kms-based travel
--    filter as a separate L2 criterion alongside zone membership: a tech
--    is "Travel-eligible" only if their efr_base_gps is within this many
--    km of the customer pincode. Distinct from the older
--    max_travel_distance_km key (deleted 2026-04-20) which was a hard
--    eligibility filter — this one feeds the Local/Travel classification.
INSERT INTO tbl_autoallocation_setting (`key`, default_value, description, data_type)
SELECT 'travel_distance_km',
       '100',
       'L2 travel cap (km). A technician is Travel-eligible for a job only if their base location is within this many kilometres of the job pincode. Local = exact-pincode match.',
       'integer'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_autoallocation_setting WHERE `key` = 'travel_distance_km');

-- 2. Default rating value used when a technician has no 90-day rating
--    history. Without this fallback the rating sub-score collapses to 0
--    for new joiners and unfairly penalises them.
-- data_type = 'double' (NOT 'decimal') — tbl_autoallocation_setting.data_type
-- is an ENUM that accepts string|integer|double|bool|json|time. The existing
-- *_weight rows (workload_weight = 0.45 etc.) all use 'double'; we follow the
-- same convention here. settings.service.js::coerce() parses 'double' via
-- parseFloat so 3.0 round-trips correctly.
INSERT INTO tbl_autoallocation_setting (`key`, default_value, description, data_type)
SELECT 'default_rating_value',
       '3.0',
       'Rating used in the performance score when a technician has no rated jobs in the scoring window. Range 0.0–5.0.',
       'double'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_autoallocation_setting WHERE `key` = 'default_rating_value');

-- 3. Reroute window (minutes). If the assigned technician hasn't accepted
--    the job within this many minutes, the engine re-runs allocation and
--    pushes the next-best candidate.
INSERT INTO tbl_autoallocation_setting (`key`, default_value, description, data_type)
SELECT 'reroute_after_minutes',
       '30',
       'Reroute the job to the next-best technician if the current assignee has not accepted within this many minutes.',
       'integer'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_autoallocation_setting WHERE `key` = 'reroute_after_minutes');

-- =============================================================================
-- Verify
-- =============================================================================
SELECT `key`, default_value, data_type
  FROM tbl_autoallocation_setting
 WHERE `key` IN (
   'max_concurrent_jobs',     -- pre-existing (seeded 2026-04-18)
   'travel_distance_km',
   'default_rating_value',
   'reroute_after_minutes'
 )
 ORDER BY `key`;
-- Expected: 4 rows.
