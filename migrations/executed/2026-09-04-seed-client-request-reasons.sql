-- Seed the two reason rows a CLIENT can raise against an unreachable job.
--
-- Consumed by services/client-request.service.js, which resolves them by
-- (action_type, user_type, action_desc) at write time and stamps the id into
-- tbl_job_comment.enum_reason_id. Until this runs, the feature resolves to no
-- ids and the client actions return 503 rather than writing an unmarked
-- comment — a request ops cannot see is worse than a request that failed.
--
-- Idempotent (NOT EXISTS on action_type + action_desc), one statement per line,
-- no @set / PREPARE / MariaDB-only IF NOT EXISTS.
--
-- action_type: 1 = Cancel (CRM), 25 = Un Reachable. Both are established
-- buckets (services/reason-codes.js ACTION_TYPE, proven from the legacy
-- JobAction.java) — no new action_type is introduced, because that table is a
-- legacy label lookup the old Java CRM also reads.
--
-- user_type = 3 = CLIENT, per services/reason-codes.js DUE_TO_USER_TYPE
-- (1=EasyFix, 2=Customer, 3=Client, 4=Technician).
--
-- ⚠ Do NOT take the mapping from the header of
-- migrations/executed/2026-07-10-seed-reschedule-reasons-action-type-8.sql.
-- That comment still describes the pre-2026-07-14 order (1=Customer, 2=Client,
-- 3=EasyFix), which was corrected precisely because it shifted three of the
-- four parties and made every Cancel/Enquiry/Unreachable dropdown show the
-- wrong list. The file is executed and frozen, so the stale prose stays there;
-- reason-codes.js is the source of truth.
--
-- action_desc must match REASON[kind].desc in client-request.service.js
-- EXACTLY — resolution is by description, so a wording change here without the
-- matching change there silently turns the feature off.
--
-- ⚠ is_new = 0, AND IT HAS TO BE SET AT ALL.
--
-- is_new is NOT NULL with no default on this table, so omitting it fails the
-- whole statement: the first run of this file died with "Field 'is_new' doesn't
-- have a default value". `npm run check:migrations` now catches that class
-- before a migration is ever run.
--
-- Semantically these are new curated rows, which argues for 1. The reason to
-- prefer 0 is below, and it is narrower than it first appeared.
--
-- GET /api/admin/jobs/cancel-reasons filters `is_new = MAX(is_new)` per
-- (action_type, user_type) — "curated-else-legacy": show the curated set when a
-- bucket has one, else fall back to the migrated legacy rows.
--
-- ⚠ AN EARLIER VERSION OF THIS COMMENT OVERSTATED THE RISK, and the correction
-- matters more than the original claim. It said a 1 would flip MAX and collapse
-- the operator's "Cancellation Due To -> Client" dropdown to this row alone.
-- Checked against the database after the seed ran, that is NOT what would have
-- happened: action_type 1 + user_type 3 already holds 6 live rows, 4 of them
-- curated, so MAX(is_new) was ALREADY 1 and a 1 here would have changed nothing
-- about visibility. The collapse scenario is real for a bucket that is entirely
-- legacy; these two buckets are not that.
--
-- So 0 is kept for the plainer reason: it keeps these BOOKKEEPING rows out of a
-- dropdown ops never needs to pick them from. Both buckets have MAX(is_new) = 1
-- (cancel 4 curated of 6, unreachable 4 of 5), so at is_new = 0 these are not
-- offered to an operator at all — which costs nothing, because the path that
-- matters resolves them by (action_type, user_type, action_desc) and does NOT
-- filter is_new. Verified live: ids 318 and 319 resolve.
--
-- ⚠ OPEN QUESTION, deliberately not decided here. Because these are hidden,
-- an operator cancelling a job BECAUSE the client asked cannot pick
-- "Cancellation requested by client" as the cancel reason — they will pick
-- something else. If ops wants that reason selectable, flip the cancel row (and
-- only that one) to is_new = 1 with an UPDATE: it is safe in this bucket, for
-- the reason above. The retry row should stay hidden either way — "client asked
-- to retry" is not an Un Reachable outcome and would be noise in that dropdown.
--
-- Columns set: action_type, action_desc, user_type, status(=1 active), is_new.
-- id is AUTO_INCREMENT and deliberately NOT hardcoded anywhere: it differs per
-- environment, so a literal that is right on QA is silently wrong on Production.

INSERT INTO action_taken_reason (action_type, action_desc, user_type, status, is_new)
SELECT 1, 'Cancellation requested by client', 3, 1, 0
 WHERE NOT EXISTS (SELECT 1 FROM action_taken_reason WHERE action_type = 1 AND action_desc = 'Cancellation requested by client');

INSERT INTO action_taken_reason (action_type, action_desc, user_type, status, is_new)
SELECT 25, 'Client asked to retry contacting the customer', 3, 1, 0
 WHERE NOT EXISTS (SELECT 1 FROM action_taken_reason WHERE action_type = 25 AND action_desc = 'Client asked to retry contacting the customer');
