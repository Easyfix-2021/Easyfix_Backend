-- Backfill job_primary_spoc rows stamped 2147483647.
--
-- REVISED 2026-08-26 after step 1 returned 41 rows on Production, not zero.
-- The first draft of this file assumed today's vertical mapping was also the
-- mapping at booking time. It is not, and this version does not rely on it.
--
-- ── WHAT HAPPENED ─────────────────────────────────────────────────────────
-- job_primary_spoc is an INT holding tbl_user.user_id. Between ed32e39
-- (2026-07-05) and 3442fc5 (2026-08-14 20:57 IST) the create path stamped the
-- SPOC's MOBILE NUMBER there. An Indian mobile starts 6-9, so it is at least
-- 6,000,000,000 — past the signed INT ceiling — and MySQL clamped every one to
-- exactly 2,147,483,647. These rows are a phone number with its top bits
-- sheared off; the original number is NOT recoverable from what was stored.
--
-- IT IS NOT STILL HAPPENING. One writer in the repo (stampJobPrimarySpoc), and
-- it binds u.user_id. The newest affected job predates the fix by 4h49m. Step 0
-- confirms that against live data.
--
-- ── WHY THE OBVIOUS FIX IS WRONG ──────────────────────────────────────────
-- tbl_vertical_mapping KEEPS NO HISTORY, in either write path:
--   * replaceAssignments  DELETEs every row for the client, then INSERTs.
--   * upsertSpoc          UPDATEs user_id IN PLACE for user_type = 1.
-- inserted_on is a plain datetime with no default and no ON UPDATE, so the
-- in-place path does not even move the timestamp. There is no SPOC audit table,
-- and the only trace of a change is a log line that records "primary=updated"
-- without either user id. So the head as of 2026-08-14 CANNOT be read back out
-- of this database — and step 1 proves at least 41 mappings moved since.
--
-- ── WHAT THIS USES INSTEAD ────────────────────────────────────────────────
-- Jobs created AFTER the fix carry a correctly stamped snapshot. For each
-- affected client, the earliest such job is the closest-in-time evidence of who
-- that client's head was — a stamp, not a re-derivation, and anchored hours
-- rather than weeks away from the affected rows.
--
-- ── SCOPE: ONLY WHERE BOTH SOURCES AGREE (owner's call, 2026-08-26) ───────
-- The write below touches ONLY clients whose post-fix stamp and today's mapping
-- name the SAME person. Where two independent sources agree the value stops
-- being much of an inference — the one way both could be wrong together is a
-- head that moved and then moved back, which does not happen by accident.
--
-- Everything else is LEFT AS 2147483647 ON PURPOSE, for a manual pass:
--   * DISAGREE    — the head moved, so either source would be a guess. A wrong
--                   owner is worse than an obviously-broken one: 2147483647 at
--                   least announces itself, and a real user id does not.
--   * today only  — one source is not agreement.
--   * no evidence — nothing to write.
--
-- Step 3 prints how many jobs that leaves. It is NOT the 41 from the earlier
-- mapping-movement check: that counted MAPPING ROWS rather than jobs, and it is
-- a lower bound anyway (the in-place update path moves no timestamp, so a head
-- changed that way is invisible to it). Step 3's non-AGREE total is the number.

-- Step 0 — is the write path really fixed? Expect ZERO rows.
SELECT job_id, ticket_created_date_time FROM tbl_job WHERE job_primary_spoc = 2147483647 AND ticket_created_date_time > '2026-08-14 20:57:51' ORDER BY ticket_created_date_time DESC LIMIT 20;

-- Step 1 — per-client evidence. One row per affected client: how many jobs are
-- affected, what the post-fix stamp says, and what today's mapping says.
CREATE TEMPORARY TABLE tmp_spoc_evidence AS SELECT j.fk_client_id AS client_id, COUNT(*) AS affected_jobs, MIN(j.ticket_created_date_time) AS first_affected, MAX(j.ticket_created_date_time) AS last_affected, (SELECT n.job_primary_spoc FROM tbl_job n WHERE n.fk_client_id = j.fk_client_id AND n.ticket_created_date_time > '2026-08-14 20:57:51' AND n.job_primary_spoc IS NOT NULL AND n.job_primary_spoc BETWEEN 1 AND 2147483646 ORDER BY n.ticket_created_date_time ASC LIMIT 1) AS head_after_fix, (SELECT u.user_id FROM tbl_vertical_mapping vm LEFT JOIN tbl_user u ON u.user_id = vm.user_id WHERE vm.client_id = j.fk_client_id AND vm.user_type = 1 AND (vm.status IS NULL OR vm.status = 1) ORDER BY vm.id DESC LIMIT 1) AS head_today FROM tbl_job j WHERE j.job_primary_spoc = 2147483647 GROUP BY j.fk_client_id;

-- Step 2 — READ THIS BEFORE WRITING ANYTHING.
-- verdict tells you how much to trust each client's backfill.
SELECT e.client_id, c.client_name, e.affected_jobs, e.first_affected, e.last_affected, e.head_after_fix, e.head_today, ua.user_name AS head_after_fix_name, ut.user_name AS head_today_name, CASE WHEN e.head_after_fix IS NULL AND e.head_today IS NULL THEN 'NO EVIDENCE — will write NULL' WHEN e.head_after_fix IS NULL THEN 'today''s mapping only — weaker' WHEN e.head_after_fix = e.head_today THEN 'AGREE — safe' ELSE 'DISAGREE — head moved; post-fix stamp is the closer one' END AS verdict FROM tmp_spoc_evidence e LEFT JOIN tbl_client c ON c.client_id = e.client_id LEFT JOIN tbl_user ua ON ua.user_id = e.head_after_fix LEFT JOIN tbl_user ut ON ut.user_id = e.head_today ORDER BY e.affected_jobs DESC;

-- Step 3 — the same thing as one line, so the shape of the risk is on screen.
SELECT CASE WHEN head_after_fix IS NULL AND head_today IS NULL THEN 'no evidence' WHEN head_after_fix IS NULL THEN 'today only' WHEN head_after_fix = head_today THEN 'agree' ELSE 'disagree' END AS verdict, COUNT(*) AS clients, SUM(affected_jobs) AS jobs FROM tmp_spoc_evidence GROUP BY 1 ORDER BY jobs DESC;

-- Step 4 — THE WRITE. Only clients where both sources name the same person.
-- Both IS NOT NULL guards are load-bearing. NULL = NULL is not true in SQL, so
-- the equality alone would already exclude the no-evidence clients — but by
-- accident of three-valued logic rather than by saying what is meant, and the
-- next person to edit this line should not have to know that to keep it correct.
UPDATE tbl_job j JOIN tmp_spoc_evidence e ON e.client_id = j.fk_client_id SET j.job_primary_spoc = e.head_after_fix WHERE j.job_primary_spoc = 2147483647 AND e.head_after_fix IS NOT NULL AND e.head_today IS NOT NULL AND e.head_after_fix = e.head_today;

-- Step 5 — what is deliberately left behind, per client, for the manual pass.
SELECT e.client_id, c.client_name, e.affected_jobs, e.head_after_fix, e.head_today, ua.user_name AS head_after_fix_name, ut.user_name AS head_today_name, CASE WHEN e.head_after_fix IS NULL AND e.head_today IS NULL THEN 'no evidence' WHEN e.head_after_fix IS NULL THEN 'today only' ELSE 'disagree' END AS why_left FROM tmp_spoc_evidence e LEFT JOIN tbl_client c ON c.client_id = e.client_id LEFT JOIN tbl_user ua ON ua.user_id = e.head_after_fix LEFT JOIN tbl_user ut ON ut.user_id = e.head_today WHERE NOT (e.head_after_fix IS NOT NULL AND e.head_today IS NOT NULL AND e.head_after_fix = e.head_today) ORDER BY e.affected_jobs DESC;

-- Step 6 — the remaining count. NOT expected to be zero. It must EQUAL step 3's
-- non-AGREE job total, and that equality is the check that step 4 wrote exactly
-- what it was scoped to write and nothing more.
SELECT COUNT(*) AS still_intmax FROM tbl_job WHERE job_primary_spoc = 2147483647;

-- Step 7 — housekeeping.
DROP TEMPORARY TABLE tmp_spoc_evidence;
