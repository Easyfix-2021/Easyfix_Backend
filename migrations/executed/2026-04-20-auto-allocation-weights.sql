-- =============================================================================
-- Auto-Allocation L3 scoring weights — seed the rows the CRM Settings page
-- "Scoring Weights" section expects. Run on easyfix_core (QA first, then prod).
--
-- Idempotent: every INSERT is `WHERE NOT EXISTS`, no DROPs, no ALTERs.
--
-- Model (mirrored in backend services/auto-assign.service.js + the CRM
-- /settings/auto-allocation page):
--
--   3 DIMENSION weights — must SUM TO 1.0 across the three:
--     workload_weight    = 0.45
--     rating_weight      = 0.30
--     completion_weight  = 0.25
--
--   Within Completion, 3 SUB-WEIGHT PROPORTIONS — must SUM TO 1.0:
--     cancellation_weight        = 0.40   → contributes 0.25 × 0.40 = 0.10
--     escalation_weight          = 0.30   → contributes 0.25 × 0.30 = 0.075
--     estimate_rejection_weight  = 0.30   → contributes 0.25 × 0.30 = 0.075
--
-- Workload and Rating are atomic — no sub-weight rows for them.
-- =============================================================================

-- ── Dimension weights ────────────────────────────────────────────────────────

INSERT INTO tbl_autoallocation_setting (`key`, default_value, description, data_type)
SELECT 'workload_weight', '0.45',
       'L3 dimension weight: how heavily current job-load (active job count) influences technician ranking. Workload + Rating + Completion must sum to 1.0.',
       'double'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_autoallocation_setting WHERE `key` = 'workload_weight');

INSERT INTO tbl_autoallocation_setting (`key`, default_value, description, data_type)
SELECT 'rating_weight', '0.30',
       'L3 dimension weight: how heavily 90-day customer ratings influence technician ranking. Workload + Rating + Completion must sum to 1.0.',
       'double'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_autoallocation_setting WHERE `key` = 'rating_weight');

INSERT INTO tbl_autoallocation_setting (`key`, default_value, description, data_type)
SELECT 'completion_weight', '0.25',
       'L3 dimension weight: how heavily completion reliability influences technician ranking. The four sub-weights below (cancellation, escalation, estimate_rejection) split this proportionally.',
       'double'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_autoallocation_setting WHERE `key` = 'completion_weight');

-- ── Completion sub-weight PROPORTIONS (must sum to 1.0 within bucket) ────────

INSERT INTO tbl_autoallocation_setting (`key`, default_value, description, data_type)
SELECT 'cancellation_weight', '0.40',
       'Completion sub-weight: proportion of W_completion attributed to cancellation rate. Cancellation + Escalation + Estimate Rejection must sum to 1.0.',
       'double'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_autoallocation_setting WHERE `key` = 'cancellation_weight');

INSERT INTO tbl_autoallocation_setting (`key`, default_value, description, data_type)
SELECT 'escalation_weight', '0.30',
       'Completion sub-weight: proportion of W_completion attributed to escalation rate.',
       'double'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_autoallocation_setting WHERE `key` = 'escalation_weight');

INSERT INTO tbl_autoallocation_setting (`key`, default_value, description, data_type)
SELECT 'estimate_rejection_weight', '0.30',
       'Completion sub-weight: proportion of W_completion attributed to estimate-rejection rate.',
       'double'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_autoallocation_setting WHERE `key` = 'estimate_rejection_weight');

-- =============================================================================
-- Verification:
--   SELECT id, `key`, default_value, data_type
--     FROM tbl_autoallocation_setting
--    WHERE `key` IN (
--      'workload_weight', 'rating_weight', 'completion_weight',
--      'cancellation_weight', 'escalation_weight', 'estimate_rejection_weight'
--    );
--   -- Expected: 6 rows.
--
--   -- Sanity check the dimension sum:
--   SELECT SUM(default_value) AS dimension_sum
--     FROM tbl_autoallocation_setting
--    WHERE `key` IN ('workload_weight', 'rating_weight', 'completion_weight');
--   -- Expected: 1.00
--
--   -- Sanity check the completion sub-weight sum:
--   SELECT SUM(default_value) AS sub_sum
--     FROM tbl_autoallocation_setting
--    WHERE `key` IN ('cancellation_weight', 'escalation_weight', 'estimate_rejection_weight');
--   -- Expected: 1.00
-- =============================================================================
