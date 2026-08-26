-- Backfill job_primary_spoc rows stamped 2147483647.
--
-- WHAT HAPPENED. job_primary_spoc is an INT holding tbl_user.user_id. Until
-- 3442fc5 (2026-08-14 20:57 IST) the create path stamped the SPOC's MOBILE
-- NUMBER there instead. An Indian mobile starts 6-9, so it is at least
-- 6,000,000,000 — past the signed INT ceiling of 2,147,483,647 — and MySQL
-- clamped every one of them to exactly that ceiling. So these rows are not a
-- weird user id; they are a phone number with its top bits sheared off, and the
-- original number is NOT recoverable from the stored value.
--
-- IT IS NOT STILL HAPPENING. There is exactly one writer of this column in the
-- repo (services/job.service.js stampJobPrimarySpoc) and it binds u.user_id.
-- The newest affected job was created 2026-08-14 16:08:09, four hours and
-- forty-nine minutes BEFORE that fix was committed. Run step 0 to confirm
-- against live data before running anything else.
--
-- ⚠ THIS RE-DERIVES A SNAPSHOT FROM TODAY'S MAPPING. The column exists to
-- record who the client's head was AT CREATION, and is deliberately never
-- re-stamped, because re-stamping hands one owner's history to another. That
-- objection does not apply to a value of 2,147,483,647 — it resolves to nobody
-- and owns nothing — but it DOES mean these jobs get the head as of today. Run
-- step 1: if it returns no rows, no head mapping changed inside the affected
-- window and today's answer is also the answer at creation time.

-- Step 0 — is the write path really fixed? Expect ZERO rows.
SELECT job_id, ticket_created_date_time FROM tbl_job WHERE job_primary_spoc = 2147483647 AND ticket_created_date_time > '2026-08-14 20:57:51' ORDER BY ticket_created_date_time DESC LIMIT 20;

-- Step 1 — did any head mapping move during the affected window? Expect ZERO rows.
SELECT vm.client_id, vm.user_id, vm.inserted_on FROM tbl_vertical_mapping vm WHERE vm.user_type = 1 AND vm.inserted_on > (SELECT MIN(ticket_created_date_time) FROM tbl_job WHERE job_primary_spoc = 2147483647);

-- Step 2 — preview what the backfill would write. Read this before step 3.
SELECT j.job_id, j.fk_client_id, j.job_primary_spoc AS current_value, (SELECT u.user_id FROM tbl_vertical_mapping vm LEFT JOIN tbl_user u ON u.user_id = vm.user_id WHERE vm.client_id = j.fk_client_id AND vm.user_type = 1 AND (vm.status IS NULL OR vm.status = 1) ORDER BY vm.id DESC LIMIT 1) AS would_become FROM tbl_job j WHERE j.job_primary_spoc = 2147483647 ORDER BY j.ticket_created_date_time DESC;

-- Step 3 — the backfill. A client with no live head mapping stamps NULL, which
-- is the same thing the create path does today: no owner beats a dangling one.
UPDATE tbl_job j SET j.job_primary_spoc = (SELECT u.user_id FROM tbl_vertical_mapping vm LEFT JOIN tbl_user u ON u.user_id = vm.user_id WHERE vm.client_id = j.fk_client_id AND vm.user_type = 1 AND (vm.status IS NULL OR vm.status = 1) ORDER BY vm.id DESC LIMIT 1) WHERE j.job_primary_spoc = 2147483647;

-- Step 4 — verify. Expect ZERO rows.
SELECT COUNT(*) AS still_intmax FROM tbl_job WHERE job_primary_spoc = 2147483647;
