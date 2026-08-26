-- DIAGNOSTIC ONLY — nothing here writes. For the 2,946 jobs created since
-- 2026-08-15 with job_primary_spoc IS NULL.
--
-- ── WHAT IS ALREADY RULED OUT ─────────────────────────────────────────────
--
-- NOT a missed code path. There is exactly ONE `INSERT INTO tbl_job` in the
-- whole backend (services/job.service.js), and stampJobPrimarySpoc runs
-- immediately after it inside the same transaction. Bulk Upload, New Dashboard
-- and the partner APIs all route through it — "New Dashboard" is a source_type
-- string on that shared insert, not a second creator.
--
-- NOT a regression from 3442fc5. That commit changed the SELECTED COLUMN
-- (u.mobile_no -> u.user_id) and nothing else: the FROM, the WHERE and the
-- ORDER BY are byte-identical. Any client that stamps NULL today would have
-- stamped NULL before it too.
--
-- So the stamp is running and finding no head. It writes NULL in exactly three
-- situations, and the queries below tell you which — per client and per source.
--
-- Measured on QA for scale: 194 of 398 clients (49%) have NO user_type = 1 row
-- at all, while every client that HAS one resolves to a live user (204/204).
-- If prod looks like that, this is an ops data gap — clients onboarded without a
-- Primary SPOC ever being assigned — and not a code defect.
--
-- ⚠ ONE THING THAT WOULD CHANGE THAT READING. Client 213 appears in BOTH
-- reports: stamped on 2026-08-14 (as 2147483647, i.e. a head WAS found) and
-- NULL on 2026-08-15. A client cannot be in verdict (a) and have been stamped
-- the day before, so for that client something MOVED in between. Query 3
-- isolates exactly those clients, and they are the ones worth looking at first.

-- 1. Why each affected job has no SPOC, by client. verdict is the answer.
SELECT j.fk_client_id, c.client_name, COUNT(*) AS null_jobs, MIN(j.ticket_created_date_time) AS first_seen, MAX(j.ticket_created_date_time) AS last_seen, GROUP_CONCAT(DISTINCT j.source_type ORDER BY j.source_type SEPARATOR ', ') AS sources, m.user_id AS mapped_user_id, u.user_name AS mapped_user_name, CASE WHEN m.client_id IS NULL THEN 'a. no user_type=1 mapping — assign a Primary SPOC' WHEN u.user_id IS NULL THEN 'b. mapping points at a user that no longer exists' ELSE 'c. RESOLVABLE — the stamp should have worked; investigate' END AS verdict FROM tbl_job j LEFT JOIN tbl_client c ON c.client_id = j.fk_client_id LEFT JOIN (SELECT vm.client_id, vm.user_id FROM tbl_vertical_mapping vm WHERE vm.user_type = 1 AND (vm.status IS NULL OR vm.status = 1) GROUP BY vm.client_id, vm.user_id) m ON m.client_id = j.fk_client_id LEFT JOIN tbl_user u ON u.user_id = m.user_id WHERE j.job_status NOT IN (7, 9) AND j.job_primary_spoc IS NULL AND j.ticket_created_date_time > '2026-08-14 23:59:59' GROUP BY j.fk_client_id, c.client_name, m.client_id, m.user_id, u.user_id, u.user_name ORDER BY null_jobs DESC;

-- 2. The same thing as three numbers. If (a) dominates, this is a data gap.
SELECT CASE WHEN m.client_id IS NULL THEN 'a. no user_type=1 mapping' WHEN u.user_id IS NULL THEN 'b. mapped user does not exist' ELSE 'c. RESOLVABLE — real bug' END AS verdict, COUNT(DISTINCT j.fk_client_id) AS clients, COUNT(*) AS null_jobs FROM tbl_job j LEFT JOIN (SELECT vm.client_id, vm.user_id FROM tbl_vertical_mapping vm WHERE vm.user_type = 1 AND (vm.status IS NULL OR vm.status = 1) GROUP BY vm.client_id, vm.user_id) m ON m.client_id = j.fk_client_id LEFT JOIN tbl_user u ON u.user_id = m.user_id WHERE j.job_status NOT IN (7, 9) AND j.job_primary_spoc IS NULL AND j.ticket_created_date_time > '2026-08-14 23:59:59' GROUP BY 1 ORDER BY null_jobs DESC;

-- 3. Clients that USED to stamp and now do not — the ones a data gap cannot
-- explain, because a head was demonstrably found for them before.
SELECT j.fk_client_id, c.client_name, SUM(CASE WHEN j.job_primary_spoc IS NOT NULL THEN 1 ELSE 0 END) AS stamped_before, SUM(CASE WHEN j.job_primary_spoc IS NULL THEN 1 ELSE 0 END) AS null_after, MAX(CASE WHEN j.job_primary_spoc IS NOT NULL THEN j.ticket_created_date_time END) AS last_stamped_at, MIN(CASE WHEN j.job_primary_spoc IS NULL AND j.ticket_created_date_time > '2026-08-14 23:59:59' THEN j.ticket_created_date_time END) AS first_null_at FROM tbl_job j LEFT JOIN tbl_client c ON c.client_id = j.fk_client_id WHERE j.job_status NOT IN (7, 9) AND j.ticket_created_date_time > '2026-07-01' GROUP BY j.fk_client_id, c.client_name HAVING stamped_before > 0 AND null_after > 0 ORDER BY null_after DESC;

-- 4. Is ANY job being stamped since the fix? If this is zero, stop reading and
-- look at the code — it would mean the stamp never succeeds any more, which is
-- a different and much worse finding than a data gap.
SELECT COUNT(*) AS stamped_since_fix, MIN(ticket_created_date_time) AS first, MAX(ticket_created_date_time) AS last FROM tbl_job WHERE job_primary_spoc IS NOT NULL AND job_primary_spoc <> 2147483647 AND ticket_created_date_time > '2026-08-14 23:59:59';
