-- tbl_client_custom_properties.is_config — discriminator separating client-level
-- CONFIG/CONTROL settings from per-booking DATA-ENTRY fields.
--
-- The table is an overloaded key/value store (legacy c_prop_* schema). Some rows
-- are OPERATOR CONFIG (auto-process-unconfirmed toggle, magic-link send cap,
-- collected-by preference, order-confirmation mode) and must NEVER surface on the
-- customer-facing booking form nor the bulk-upload template. Everything else
-- (Warranty Number, Bill Number, …) is a real per-booking field the customer fills.
--   1 = client-level CONFIG/CONTROL setting (hidden from booking forms + templates)
--   0 = per-booking DATA-ENTRY field
--
-- The Node BE already column-probes this exact column (services/client.service.js
-- customPropCols() + detectCustomPropsShape()) — the create/update/list paths only
-- reference is_config when the probe finds it, so pre-migration deploys silently
-- no-op the flag. Adding the column flips those paths on with no code change, and
-- job-magic-link.service.js then strips is_config=1 rows from the customer form.
--
-- Statement (b) is a one-time backfill: flag the 4 known control properties on
-- every client, matched NORMALIZED (lowercase, '_'/'-' → space, trimmed) so the
-- inconsistent legacy naming ("Collected By", "collected_by", "collected-by") all
-- match. The name safety-net in job-magic-link.service.js still strips these
-- defensively for any pre-migration or unflagged row.
--
-- Safety for the legacy Java services that share easyfix_core:
--   - Nullable/defaulted additive column → Hibernate DTOs ignore the unmapped field.
--   - SELECT * returns one extra column; INSERT (named cols) is unaffected.
--   - No existing legacy code reads or writes this column.

ALTER TABLE tbl_client_custom_properties ADD COLUMN is_config TINYINT(1) NOT NULL DEFAULT 0;

UPDATE tbl_client_custom_properties SET is_config = 1 WHERE LOWER(TRIM(REPLACE(REPLACE(c_prop_name,'_',' '),'-',' '))) IN ('auto process unconfirmed order','max magic link send count','collected by','order confirmation mode');
