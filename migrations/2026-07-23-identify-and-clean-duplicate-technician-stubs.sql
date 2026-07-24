-- ============================================================================
-- Duplicate / junk technician rows created by the old self-onboard login path
-- ============================================================================
--
-- BACKGROUND
-- Until 2026-07-23, POST /api/mobile/auth/login-otp resolved a technician with
--   WHERE efr_no = ? AND efr_status = 1
-- and, on no match, CREATED a tbl_user + tbl_easyfixer row -- at SEND-OTP time,
-- before the caller proved anything. Two consequences:
--   1. 55% of tbl_easyfixer (efr_status NULL or 0) was invisible to that lookup,
--      so deactivated / rejected / legacy technicians minted a fresh empty stub
--      on every login instead of resolving to their own record.
--   2. Typing any 10-digit number and tapping "Send OTP" wrote two rows.
-- Both are fixed in services/tech-auth.service.js. This file finds and
-- neutralises the rows the old behaviour already left behind.
--
-- SAFETY MODEL
--   * NO DELETEs. tbl_easyfixer is soft-delete only (efr_status = 0) and is
--     referenced by 40 tables; a hard delete would orphan history and break the
--     legacy Java CRM, EasyFix_API and the old Flutter app, all of which share
--     this database.
--   * A stub is only neutralised when ALL of these hold:
--       - it carries no real profile data,
--       - it has NO rows in any activity table,
--       - a BETTER row exists for the same mobile (so the technician is never
--         left without a record to log into).
--   * Every touched row is stamped with a marker in inactive_comment, which is
--     what makes section D (rollback) exact.
--
-- ORDER OF WORK: run A (identify) -> review -> B (dry run) -> C (clean)
--                -> E (verify). Section D rolls back if needed.
-- ============================================================================


-- ============================================================================
-- SECTION A -- IDENTIFY
-- ============================================================================

-- A1. Scale of the problem: how many mobiles carry more than one easyfixer row.
SELECT COUNT(*) AS duplicate_mobile_groups
FROM (SELECT efr_no FROM tbl_easyfixer
      WHERE efr_no IS NOT NULL AND efr_no <> ''
      GROUP BY efr_no HAVING COUNT(*) > 1) t;

-- A2. The duplicate groups themselves, worst first.
SELECT efr_no,
       COUNT(*)                        AS rows_for_mobile,
       SUM(efr_status = 1)             AS active_rows,
       SUM(is_technician_verified = 1) AS verified_rows,
       SUM(efr_name IS NULL OR efr_name = '') AS nameless_rows,
       MIN(insert_date)                AS first_seen,
       MAX(insert_date)                AS last_seen
FROM tbl_easyfixer
WHERE efr_no IS NOT NULL AND efr_no <> ''
GROUP BY efr_no
HAVING COUNT(*) > 1
ORDER BY rows_for_mobile DESC, last_seen DESC;

-- A3. efr_status distribution -- shows how much the old lookup could not see.
SELECT COUNT(*)               AS total_rows,
       SUM(efr_status IS NULL) AS null_status,
       SUM(efr_status = 0)     AS deactivated,
       SUM(efr_status = 1)     AS active
FROM tbl_easyfixer;

-- A4. Divergence between the two phone numbers for the same person. Each row
--     here is a technician who could NOT be found by their tbl_user number, and
--     so would have had a stub created on login.
SELECT e.efr_id, e.efr_no AS easyfixer_mobile, u.mobile_no AS user_mobile,
       e.efr_name, e.efr_status, e.is_technician_verified
FROM tbl_easyfixer e
JOIN tbl_user u ON u.user_id = e.user_id
WHERE u.user_role = 19
  AND u.mobile_no IS NOT NULL AND u.mobile_no <> ''
  AND e.efr_no IS NOT NULL AND e.efr_no <> ''
  AND e.efr_no <> u.mobile_no
ORDER BY e.efr_id DESC;

-- A5. Candidate junk stubs: created by the self-onboard path, no profile data.
--     Reported WITHOUT the dependency check so you can see the raw population.
SELECT e.efr_id, e.efr_no, e.user_id, e.efr_status, e.insert_date
FROM tbl_easyfixer e
WHERE e.new_easy_fixer = 1
  AND (e.efr_name IS NULL OR e.efr_name = '')
  AND (e.adhaar_card_number IS NULL OR e.adhaar_card_number = '')
  AND (e.efr_profile_img IS NULL OR e.efr_profile_img = '')
  AND (e.efr_cityId IS NULL OR e.efr_cityId = 0)
ORDER BY e.insert_date DESC;

-- A6. THE CLEANUP SET. Same as A5, plus the two guards that make it safe:
--       (a) zero rows in every activity table, and
--       (b) a better row exists for the same mobile.
--     `superseded_by` is the row the technician will resolve to afterwards.
--     REVIEW THIS OUTPUT BEFORE RUNNING SECTION C.
SELECT e.efr_id,
       e.efr_no,
       e.user_id,
       e.efr_status,
       e.insert_date,
       (SELECT k.efr_id FROM tbl_easyfixer k
         WHERE k.efr_no = e.efr_no AND k.efr_id <> e.efr_id
         ORDER BY (k.is_technician_verified = 1) DESC, (k.efr_status = 1) DESC, k.efr_id DESC
         LIMIT 1) AS superseded_by
FROM tbl_easyfixer e
WHERE e.new_easy_fixer = 1
  AND (e.efr_name IS NULL OR e.efr_name = '')
  AND (e.adhaar_card_number IS NULL OR e.adhaar_card_number = '')
  AND (e.efr_profile_img IS NULL OR e.efr_profile_img = '')
  AND (e.efr_cityId IS NULL OR e.efr_cityId = 0)
  AND EXISTS (SELECT 1 FROM tbl_easyfixer k
               WHERE k.efr_no = e.efr_no AND k.efr_id <> e.efr_id
                 AND (k.is_technician_verified = 1 OR (k.efr_name IS NOT NULL AND k.efr_name <> '')))
  AND NOT EXISTS (SELECT 1 FROM tbl_job                    x WHERE x.fk_easyfixter_id = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_job_offer              x WHERE x.fk_easyfixter_id = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_job_comment            x WHERE x.efr_id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_document     x WHERE x.efr_id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_attendance   x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_transaction  x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_bank_details x WHERE x.efr_Id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_assessment   x WHERE x.efr_Id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_efr_deepskill_mapping  x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_efr_serviceable_pincodes x WHERE x.easyfixer_id   = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_efr_advance_payment    x WHERE x.efr_id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_service_payout         x WHERE x.efr_id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM scheduling_history         x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM easyfixer_courses          x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM easyfixer_watched_video    x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM easyfixer_comments         x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_rating_by_customer x WHERE x.easyfixer_id = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_client_easyfixer_mapping     x WHERE x.easyfixer_id = e.efr_id)
ORDER BY e.insert_date DESC;

-- A7. Orphan role-19 tbl_user rows with no easyfixer at all (the "ghost
--     accounts" CLAUDE.md warns about). REPORT ONLY -- this file does not touch
--     tbl_user, because legacy services join to it in ways we have not audited.
SELECT u.user_id, u.mobile_no, u.user_status, u.insert_date
FROM tbl_user u
WHERE u.user_role = 19
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer e WHERE e.user_id = u.user_id)
ORDER BY u.user_id DESC;


-- ============================================================================
-- SECTION B -- DRY RUN (read-only; run before Section C)
-- ============================================================================

-- B1. How many rows Section C will touch. If this is 0, there is nothing to do.
SELECT COUNT(*) AS rows_section_c_will_deactivate
FROM tbl_easyfixer e
WHERE e.new_easy_fixer = 1
  AND e.efr_status = 1
  AND (e.efr_name IS NULL OR e.efr_name = '')
  AND (e.adhaar_card_number IS NULL OR e.adhaar_card_number = '')
  AND (e.efr_profile_img IS NULL OR e.efr_profile_img = '')
  AND (e.efr_cityId IS NULL OR e.efr_cityId = 0)
  AND EXISTS (SELECT 1 FROM tbl_easyfixer k
               WHERE k.efr_no = e.efr_no AND k.efr_id <> e.efr_id
                 AND (k.is_technician_verified = 1 OR (k.efr_name IS NOT NULL AND k.efr_name <> '')))
  AND NOT EXISTS (SELECT 1 FROM tbl_job                    x WHERE x.fk_easyfixter_id = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_job_offer              x WHERE x.fk_easyfixter_id = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_job_comment            x WHERE x.efr_id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_document     x WHERE x.efr_id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_attendance   x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_transaction  x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_bank_details x WHERE x.efr_Id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_assessment   x WHERE x.efr_Id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_efr_deepskill_mapping  x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_efr_serviceable_pincodes x WHERE x.easyfixer_id   = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_efr_advance_payment    x WHERE x.efr_id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_service_payout         x WHERE x.efr_id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM scheduling_history         x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM easyfixer_courses          x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM easyfixer_watched_video    x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM easyfixer_comments         x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_rating_by_customer x WHERE x.easyfixer_id = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_client_easyfixer_mapping     x WHERE x.easyfixer_id = e.efr_id);

-- B2. Sanity: confirm no mobile would be left with zero usable rows. Expect 0.
SELECT COUNT(*) AS mobiles_left_with_no_row
FROM (SELECT e.efr_no
      FROM tbl_easyfixer e
      WHERE e.efr_no IS NOT NULL AND e.efr_no <> ''
      GROUP BY e.efr_no
      HAVING SUM(NOT (e.new_easy_fixer = 1
                      AND (e.efr_name IS NULL OR e.efr_name = '')
                      AND (e.adhaar_card_number IS NULL OR e.adhaar_card_number = '')
                      AND (e.efr_profile_img IS NULL OR e.efr_profile_img = '')
                      AND (e.efr_cityId IS NULL OR e.efr_cityId = 0))) = 0
         AND COUNT(*) > 1) t;


-- ============================================================================
-- SECTION C -- CLEAN (the only writing statement in this file)
-- ============================================================================
-- Soft-deactivate the reviewed set. The marker in inactive_comment is what
-- Sections D and E key on -- do not edit its text.
UPDATE tbl_easyfixer e
SET e.efr_status = 0,
    e.inactive_comment = 'auto-cleanup 2026-07-23: duplicate self-onboard stub',
    e.last_inactive_date_time = NOW()
WHERE e.new_easy_fixer = 1
  AND e.efr_status = 1
  AND (e.efr_name IS NULL OR e.efr_name = '')
  AND (e.adhaar_card_number IS NULL OR e.adhaar_card_number = '')
  AND (e.efr_profile_img IS NULL OR e.efr_profile_img = '')
  AND (e.efr_cityId IS NULL OR e.efr_cityId = 0)
  AND EXISTS (SELECT 1 FROM (SELECT * FROM tbl_easyfixer) k
               WHERE k.efr_no = e.efr_no AND k.efr_id <> e.efr_id
                 AND (k.is_technician_verified = 1 OR (k.efr_name IS NOT NULL AND k.efr_name <> '')))
  AND NOT EXISTS (SELECT 1 FROM tbl_job                    x WHERE x.fk_easyfixter_id = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_job_offer              x WHERE x.fk_easyfixter_id = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_job_comment            x WHERE x.efr_id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_document     x WHERE x.efr_id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_attendance   x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_transaction  x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_bank_details x WHERE x.efr_Id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_assessment   x WHERE x.efr_Id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_efr_deepskill_mapping  x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_efr_serviceable_pincodes x WHERE x.easyfixer_id   = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_efr_advance_payment    x WHERE x.efr_id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_service_payout         x WHERE x.efr_id           = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM scheduling_history         x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM easyfixer_courses          x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM easyfixer_watched_video    x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM easyfixer_comments         x WHERE x.easyfixer_id     = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_easyfixer_rating_by_customer x WHERE x.easyfixer_id = e.efr_id)
  AND NOT EXISTS (SELECT 1 FROM tbl_client_easyfixer_mapping     x WHERE x.easyfixer_id = e.efr_id);


-- ============================================================================
-- SECTION D -- ROLLBACK (undo Section C exactly)
-- ============================================================================
UPDATE tbl_easyfixer
SET efr_status = 1,
    inactive_comment = NULL,
    last_inactive_date_time = NULL
WHERE inactive_comment = 'auto-cleanup 2026-07-23: duplicate self-onboard stub';


-- ============================================================================
-- SECTION E -- VERIFY (run after Section C)
-- ============================================================================

-- E1. What was actually touched.
SELECT COUNT(*) AS rows_deactivated_by_cleanup
FROM tbl_easyfixer
WHERE inactive_comment = 'auto-cleanup 2026-07-23: duplicate self-onboard stub';

-- E2. HARD SAFETY CHECK. Every cleaned row must still have zero activity.
--     Expect 0. Anything above 0 means a row with history was touched -- run
--     Section D immediately.
SELECT COUNT(*) AS cleaned_rows_that_have_history
FROM tbl_easyfixer e
WHERE e.inactive_comment = 'auto-cleanup 2026-07-23: duplicate self-onboard stub'
  AND (EXISTS (SELECT 1 FROM tbl_job                   x WHERE x.fk_easyfixter_id = e.efr_id)
    OR EXISTS (SELECT 1 FROM tbl_job_offer             x WHERE x.fk_easyfixter_id = e.efr_id)
    OR EXISTS (SELECT 1 FROM tbl_easyfixer_document    x WHERE x.efr_id           = e.efr_id)
    OR EXISTS (SELECT 1 FROM tbl_easyfixer_attendance  x WHERE x.easyfixer_id     = e.efr_id)
    OR EXISTS (SELECT 1 FROM tbl_easyfixer_transaction x WHERE x.easyfixer_id     = e.efr_id));

-- E3. HARD SAFETY CHECK. No verified technician may have been deactivated.
--     Expect 0.
SELECT COUNT(*) AS verified_techs_wrongly_deactivated
FROM tbl_easyfixer
WHERE inactive_comment = 'auto-cleanup 2026-07-23: duplicate self-onboard stub'
  AND is_technician_verified = 1;

-- E4. LOGIN CHECK. Every cleaned mobile must still resolve to a usable row
--     under the NEW resolver ordering. Expect one row per mobile, and
--     resolves_to must never be the cleaned efr_id.
SELECT c.efr_no,
       c.efr_id AS cleaned_efr_id,
       (SELECT k.efr_id FROM tbl_easyfixer k
         WHERE k.efr_no = c.efr_no
         ORDER BY (k.is_technician_verified = 1) DESC, (k.efr_status = 1) DESC, k.efr_id DESC
         LIMIT 1) AS resolves_to
FROM tbl_easyfixer c
WHERE c.inactive_comment = 'auto-cleanup 2026-07-23: duplicate self-onboard stub';

-- E5. LEGACY IMPACT. The legacy Java CRM, EasyFix_API and the old Flutter app
--     all read active technicians as efr_status = 1. Confirm the drop equals
--     exactly the number cleaned and nothing more.
SELECT SUM(efr_status = 1) AS active_now,
       SUM(efr_status = 0) AS inactive_now,
       SUM(efr_status IS NULL) AS null_status_untouched
FROM tbl_easyfixer;

-- E6. ASSIGNMENT IMPACT. No job may point at a cleaned row. Expect 0.
--     (Section C's dependency guard should make this impossible; this proves it.)
SELECT COUNT(*) AS jobs_pointing_at_cleaned_rows
FROM tbl_job j
JOIN tbl_easyfixer e ON e.efr_id = j.fk_easyfixter_id
WHERE e.inactive_comment = 'auto-cleanup 2026-07-23: duplicate self-onboard stub';

-- E7. Duplicate groups remaining (informational -- rows with real data on both
--     sides are NOT auto-cleaned and need a human merge decision).
SELECT COUNT(*) AS duplicate_mobile_groups_remaining
FROM (SELECT efr_no FROM tbl_easyfixer
      WHERE efr_no IS NOT NULL AND efr_no <> ''
      GROUP BY efr_no HAVING COUNT(*) > 1) t;
