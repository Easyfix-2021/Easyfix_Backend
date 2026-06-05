-- =============================================================================
-- Auto-Allocation settings — prune duplicates flagged on 2026-05-06.
--
-- 1. `no_rating_by_customer` is functionally identical to `default_rating_value`
--    (added 2026-05-06 in allocation-settings-spec-keys.sql). Both supply the
--    fallback rating used when a tech has no rated jobs. We canonicalise on
--    `default_rating_value` (declared `double`, lowercase snake_case to match
--    every other new key on the page) and DROP `no_rating_by_customer`.
--    Code grep across both EasyFix_Backend and Easyfix_CRM_UI shows zero
--    references to the old key — only a row in the table.
--
-- 2. `NotAllowedMessageCustomer` and `AllowMessageCustomer` are inverse
--    phrasings of the same boolean ("send a notification to the customer
--    when a technician is allocated?"). The legacy seed
--    (EasyFix_CRM/database/tables/from-01-to-02-client_setting_table.sql:37)
--    only inserts `AllowMessageCustomer` (default 'Yes'). `NotAllowedMessageCustomer`
--    has no seed in any committed migration and no consumer in any code path
--    we can find — it's an orphan duplicate. We DROP it; `AllowMessageCustomer`
--    survives and gets a friendlier display label in the UI ("Notify Client
--    on Technician Allocation?"). The KEY is preserved verbatim because legacy
--    Java code may still read it from the legacy `tbl_setting` (different
--    table, same string used as a discriminator).
--
-- Run on easyfix_core (QA first, then prod). Idempotent: DELETE is a no-op
-- if the row is already gone, and we cascade-clean any per-client overrides.
-- =============================================================================

-- Wipe per-client overrides for the soon-to-be-deleted settings first,
-- otherwise the FK on tbl_client_setting.setting_id would block the
-- parent DELETE.
DELETE cs
  FROM tbl_client_setting cs
  JOIN tbl_autoallocation_setting s ON s.id = cs.setting_id
 WHERE s.`key` IN ('no_rating_by_customer', 'NotAllowedMessageCustomer');

DELETE FROM tbl_autoallocation_setting
 WHERE `key` IN ('no_rating_by_customer', 'NotAllowedMessageCustomer');

-- =============================================================================
-- Verify — both should be gone, AllowMessageCustomer + default_rating_value
-- should remain.
-- =============================================================================
SELECT `key`, default_value, data_type
  FROM tbl_autoallocation_setting
 WHERE `key` IN (
   'no_rating_by_customer',         -- expect 0 rows
   'NotAllowedMessageCustomer',     -- expect 0 rows
   'default_rating_value',          -- expect 1 row (canonical replacement)
   'AllowMessageCustomer'           -- expect 1 row (canonical survivor)
 );
-- Expected: 2 rows (default_rating_value + AllowMessageCustomer).
