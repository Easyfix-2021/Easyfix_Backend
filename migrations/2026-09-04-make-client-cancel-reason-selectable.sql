-- Make "Cancellation requested by client" selectable by an operator.
--
-- Follows 2026-09-04-seed-client-request-reasons.sql, which inserted it with
-- is_new = 0. That kept it out of the Cancel dropdown, and on reflection that is
-- wrong for THIS row: when ops cancels a job precisely because the client asked
-- them to, that is the reason. Forcing them to pick something else throws away
-- the attribution on the one job where the cause is known.
--
-- WHY AN UPDATE AND NOT AN EDIT TO THE SEED. The seed is idempotent via
-- `WHERE NOT EXISTS`, so re-running it after changing the literal does NOTHING
-- to a row that already exists — the value would silently stay 0 on every
-- environment that has already run it, and match the file only on a fresh one.
-- A file that behaves differently depending on whether it has been run before
-- is worse than a second file.
--
-- SAFE IN THIS BUCKET, and the reasoning is specific rather than general.
-- GET /api/admin/jobs/cancel-reasons shows only rows at MAX(is_new) per
-- (action_type, user_type). Measured on QA after seeding, action_type 1 +
-- user_type 3 holds 6 live rows of which 4 are already curated (is_new = 1), so
-- MAX is ALREADY 1: flipping this row to 1 adds it to the visible set and
-- changes nothing else. Were the bucket entirely legacy, the same flip would
-- take MAX from 0 to 1 and hide every other reason in it — so do not copy this
-- statement to another bucket without re-measuring that bucket.
--
-- THE RETRY ROW IS DELIBERATELY LEFT AT 0. "Client asked to retry contacting
-- the customer" is not an Un Reachable OUTCOME; it is a request about one. In
-- the action_type 25 dropdown, where an operator records what happened on a
-- call, it would be a choice that describes nothing they did.
--
-- Resolution is unaffected either way: client-request.service.js looks these up
-- by (action_type, user_type, action_desc) and does not filter is_new.
--
-- Idempotent by construction: setting is_new = 1 on a row already at 1 is a
-- no-op, and the WHERE pins the exact row rather than the bucket.

UPDATE action_taken_reason
   SET is_new = 1
 WHERE action_type = 1
   AND user_type = 3
   AND action_desc = 'Cancellation requested by client';
