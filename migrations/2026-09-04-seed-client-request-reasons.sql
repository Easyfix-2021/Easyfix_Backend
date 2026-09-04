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
-- Columns set: action_type, action_desc, user_type, status(=1 active). id is
-- AUTO_INCREMENT and is deliberately NOT hardcoded anywhere: it differs per
-- environment, so a literal that is right on QA is silently wrong on Production.

INSERT INTO action_taken_reason (action_type, action_desc, user_type, status)
SELECT 1, 'Cancellation requested by client', 3, 1
 WHERE NOT EXISTS (SELECT 1 FROM action_taken_reason WHERE action_type = 1 AND action_desc = 'Cancellation requested by client');

INSERT INTO action_taken_reason (action_type, action_desc, user_type, status)
SELECT 25, 'Client asked to retry contacting the customer', 3, 1
 WHERE NOT EXISTS (SELECT 1 FROM action_taken_reason WHERE action_type = 25 AND action_desc = 'Client asked to retry contacting the customer');
