-- Backfill tbl_job.job_client_owner for jobs booked since 2026-01-01.
--
-- WHAT IS MISSING AND WHY
-- -----------------------
-- job_client_owner records the client's Primary SPOC at booking time. Every
-- LIVE writer sets it: EasyFix_Backend on its single INSERT, ACD_APIs at both
-- create sites, EasyFix_API since ed45cb4. Measured on QA, every source is at
-- zero missing since the Node resolver shipped on 2026-06-03 -- manual 0/4,
-- CRM - New 0/9, Client_App 0/21, partner API 0/2, integration_v2 0/2,
-- New Dashboard 1/12.
--
-- So this is history, not a leak: rows booked before that resolver existed, or
-- written by a legacy stack that never set the column.
--
-- WHY 2026-01-01 AND NOT ALL OF IT
-- --------------------------------
-- 464,606 rows are missing across all time and 405,720 of them have a client
-- with a live SPOC -- so "fixable" is not the same question as "should be
-- fixed". This column is a SNAPSHOT of who owned the job when it was booked.
-- Stamping today's SPOC onto a 2019 job does not recover that fact; it invents
-- one, and it does so in a column reports read as history. The further back the
-- row, the more likely the client has since been reassigned.
--
-- Scoped to this year (19,453 rows) because within one year a client's SPOC is
-- very likely still the same person -- and on this database no client has more
-- than ONE active user_type = 1 mapping at all, so there is nothing to have
-- drifted from. Widening the window is a business decision, not a technical
-- one: change the date in steps 1, 3 and 4 together if ops want more.
--
-- HOW THE SPOC IS PICKED
-- ----------------------
-- Identical to services/job.service.js resolveClientPrimarySpoc():
--   * user_type = 1, status NULL or 1;
--   * newest mapping first (inserted_on DESC, id DESC);
--   * u.user_id THROUGH a LEFT JOIN, so a mapping whose user was deleted
--     resolves to nothing and the row is left alone. A dangling owner id is
--     worse than a NULL, because it reads as data.
-- ROW_NUMBER makes the pick deterministic even though no client currently has
-- a second mapping -- an UPDATE ... JOIN that matches two rows applies an
-- arbitrary one, and "arbitrary" is not a property to leave in a backfill.
--
-- job_primary_spoc is NOT touched here. It is missing on far more rows and is
-- covered by its own migration.
--
-- Run steps 1 and 2 first and read them. Step 3 is the only write.


-- Step 1. How many rows would change, and how many are left behind.
SELECT COUNT(*) AS missing_in_window, SUM(sp.user_id IS NOT NULL) AS would_be_filled, SUM(sp.user_id IS NULL) AS no_spoc_left_alone FROM tbl_job j LEFT JOIN (SELECT vm.client_id, u.user_id FROM tbl_vertical_mapping vm LEFT JOIN tbl_user u ON u.user_id = vm.user_id WHERE vm.user_type = 1 AND (vm.status IS NULL OR vm.status = 1) GROUP BY vm.client_id, u.user_id) sp ON sp.client_id = j.fk_client_id WHERE (j.job_client_owner IS NULL OR j.job_client_owner = 0) AND j.ticket_created_date_time >= '2026-01-01';


-- Step 2. A sample of what step 3 will write, so the values can be eyeballed
-- against Manage Clients before anything is changed.
SELECT j.job_id, j.fk_client_id, j.source_type, j.job_client_owner AS current_value, sp.user_id AS would_become, u2.user_name AS spoc_name FROM tbl_job j JOIN (SELECT client_id, user_id FROM (SELECT vm.client_id, u.user_id, ROW_NUMBER() OVER (PARTITION BY vm.client_id ORDER BY vm.inserted_on DESC, vm.id DESC) AS rn FROM tbl_vertical_mapping vm LEFT JOIN tbl_user u ON u.user_id = vm.user_id WHERE vm.user_type = 1 AND (vm.status IS NULL OR vm.status = 1)) ranked WHERE rn = 1 AND user_id IS NOT NULL) sp ON sp.client_id = j.fk_client_id LEFT JOIN tbl_user u2 ON u2.user_id = sp.user_id WHERE (j.job_client_owner IS NULL OR j.job_client_owner = 0) AND j.ticket_created_date_time >= '2026-01-01' ORDER BY j.job_id DESC LIMIT 25;


-- Step 3. THE WRITE. Only rows that are currently empty are touched, so an
-- owner already recorded is never overwritten and re-running changes nothing.
UPDATE tbl_job j JOIN (SELECT client_id, user_id FROM (SELECT vm.client_id, u.user_id, ROW_NUMBER() OVER (PARTITION BY vm.client_id ORDER BY vm.inserted_on DESC, vm.id DESC) AS rn FROM tbl_vertical_mapping vm LEFT JOIN tbl_user u ON u.user_id = vm.user_id WHERE vm.user_type = 1 AND (vm.status IS NULL OR vm.status = 1)) ranked WHERE rn = 1 AND user_id IS NOT NULL) sp ON sp.client_id = j.fk_client_id SET j.job_client_owner = sp.user_id WHERE (j.job_client_owner IS NULL OR j.job_client_owner = 0) AND j.ticket_created_date_time >= '2026-01-01';


-- Step 4. Verify. missing_in_window should now be only the rows whose client
-- has no live SPOC -- the same number step 1 reported as no_spoc_left_alone.
SELECT COUNT(*) AS still_missing_in_window FROM tbl_job WHERE (job_client_owner IS NULL OR job_client_owner = 0) AND ticket_created_date_time >= '2026-01-01';


-- Step 5. What is left, and why. Every row here is a client with no active
-- user_type = 1 mapping, or one whose mapped user has been deleted. That is an
-- ops data gap in Manage Clients, not something a backfill can invent.
SELECT j.fk_client_id, c.client_name, COUNT(*) AS jobs_left_without_owner FROM tbl_job j LEFT JOIN tbl_client c ON c.client_id = j.fk_client_id WHERE (j.job_client_owner IS NULL OR j.job_client_owner = 0) AND j.ticket_created_date_time >= '2026-01-01' GROUP BY j.fk_client_id, c.client_name ORDER BY jobs_left_without_owner DESC;
