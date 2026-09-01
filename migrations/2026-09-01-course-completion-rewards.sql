-- ============================================================================
-- 2026-09-01 — Courses: optional completion reward points + e-certificate
--
-- WHAT THIS DOES
--   Adds TWO columns to `courses`:
--
--     reward_points        INT NULL              -- NULL/0 = pays nothing
--     certificate_enabled  TINYINT NOT NULL DEFAULT 0
--
--   Both are per-course opt-ins. Neither changes any existing course.
--
-- WHY reward_points CARRIES BOTH THE OPT-IN AND THE AMOUNT
--   A separate `reward_enabled` boolean alongside an amount gives you four
--   states for a two-state fact, and two of them are nonsense (enabled with no
--   amount; disabled with an amount sitting there looking authoritative). One
--   nullable INT says everything: NULL or 0 pays nothing, a positive value
--   both opts the course in and states what it is worth. Per-course by design
--   — an induction course and a six-module technical course are not worth the
--   same, and a single platform-wide constant would force them to be.
--
-- WHY certificate_enabled GATES THE BADGE TOO
--   "Earned a trophy on this course" and "can download a certificate for this
--   course" are the same fact stated twice. A course that is worth a
--   certificate is worth a badge; splitting them into two flags creates a
--   combination ops would have to reason about for no benefit.
--
-- ─── NOTHING IS ADDED TO reward_points_ledger, AND THAT IS THE POINT ────────
--   Completion awards are exactly-once ALREADY, with no new index, no new
--   table and no application-level guard, because reward_points_ledger carries
--
--       uq_reward_award UNIQUE (reason_code, ref_type, ref_id)
--
--   and award() swallows ER_DUP_ENTRY as "the mechanism working". The award is
--   keyed (COURSE, 'course', easyfixer_courses.id).
--
--   NOTE THE ref_id CAREFULLY: it is the ENROLMENT row id, not course_id. The
--   unique key is NOT scoped by easyfixer_id, so keying on course_id would let
--   exactly ONE technician on the platform ever be paid for a given course and
--   silently swallow every subsequent award as a duplicate. easyfixer_courses
--   carries UNIQUE (easyfixer_id, course_id), so its PK is precisely one row
--   per technician per course — and re-assignment preserves that id via
--   ON DUPLICATE KEY UPDATE, so a re-assigned course cannot pay twice either.
--
-- ─── WHY THE BADGE IS STAMPED AND NOT DERIVED ──────────────────────────────
--   The first cut computed the badge live from
--       courses.certificate_enabled = 1 AND completion_date IS NOT NULL
--   which tracks WHO and WHEN durably but leaves the eligibility half on a
--   MUTABLE flag. Turning the toggle off — or retiring the course — would then
--   retroactively erase every badge already earned, and revoke the certificates
--   with them. That is wrong for a badge: a badge is something a technician
--   holds, not something an admin switch can un-give.
--
--   easyfixer_courses.badge_earned_at fixes it by recording the moment. After
--   that the flag governs only whether NEW completions earn one, earned badges
--   survive any later edit, and "who earned what, and when" is a plain query
--   rather than a re-derivation against today's settings.
--
--   NULL means "no badge" — either the course did not offer one when this
--   technician finished, or they have not finished.
--
-- WHY THERE IS NO CERTIFICATE TABLE
--   The certificate is rendered on demand from facts that already exist
--   (badge_earned_at, courses.name, tbl_easyfixer.efr_name), so there is no
--   issuance event to duplicate and generating it twice yields the same
--   document. Persisting the FILE — or minting a serial — would create an
--   idempotency problem that does not otherwise exist. If a serial is ever
--   demanded, use easyfixer_courses.id, the same value the award keys on.
--
--   Note the split: the ENTITLEMENT is stamped (badge_earned_at, above) because
--   it must survive an admin's later edit; the DOCUMENT is not, because it is a
--   pure function of that stamp.
--
-- DEFAULT 0, NOT NULL, for certificate_enabled
--   Unlike reward_points there is no meaningful third state: a course either
--   offers a certificate or it does not. NOT NULL DEFAULT 0 means every
--   existing course is explicitly opted out rather than ambiguously unset, and
--   no read path needs a COALESCE.
--
-- SAFE FOR THE LEGACY CONSUMER — checked, not assumed
--   grep for `courses` and `easyfixer_courses` across EasyFix_CRM/src and
--   EasyFix_API/src returns ZERO files. These tables are owned solely by
--   EasyFix_Backend. There is no legacy INSERT that would trip over a new
--   NOT NULL column (and it has a DEFAULT regardless).
--
-- ─── HOW TO APPLY ───────────────────────────────────────────────────────────
--   Run STATEMENT BY STATEMENT, in order, against easyfix.
--   Section 1 is a read-only preflight naming which ALTERs still need to run.
--   Sections 2 and 3 are plain ALTERs — deliberately NOT wrapped in
--   `SET @sql := … PREPARE … EXECUTE` (banned 2026-05-30), and deliberately
--   not `ADD COLUMN IF NOT EXISTS` (MariaDB-only).
--
--   ON A RE-RUN, expect and ignore:
--     ERROR 1060 (42S21): Duplicate column name 'reward_points'
--     ERROR 1060 (42S21): Duplicate column name 'certificate_enabled'
--     ERROR 1060 (42S21): Duplicate column name 'badge_earned_at'
--
-- IDEMPOTENCY
--   1. Preflight    read-only, always safe.
--   2/3/4. ALTERs   guarded by the preflight; re-running errors 1060, changes
--                   nothing.
--   5. Verify       read-only.
--
-- POST-APPLY
--   Restart the backend. No backfill, no cache flush, no re-login. Every
--   existing course pays 0 points and offers no certificate until an operator
--   opts it in from Manage Courses.
-- ============================================================================

-- ─── 1. Preflight — which columns already exist? ────────────────────────────
-- Expect 0 rows on a fresh apply (run all three ALTERs), 3 rows if applied.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND ((TABLE_NAME = 'courses' AND COLUMN_NAME IN ('reward_points', 'certificate_enabled'))
     OR (TABLE_NAME = 'easyfixer_courses' AND COLUMN_NAME = 'badge_earned_at'));

-- ─── 2. Completion reward ───────────────────────────────────────────────────
-- NULL or 0 = this course pays nothing. A positive value opts the course in
-- and states the award.
ALTER TABLE courses ADD COLUMN reward_points INT NULL;

-- ─── 3. Certificate / badge opt-in ──────────────────────────────────────────
-- 1 = finishing this course earns a trophy on the technician's course list and
-- makes an e-certificate downloadable.
ALTER TABLE courses ADD COLUMN certificate_enabled TINYINT NOT NULL DEFAULT 0;

-- ─── 4. Badge / certificate entitlement stamp ───────────────────────────────
-- Set at the moment a technician completes a course that offers a certificate.
-- NULL = no badge. Never cleared, so a later flag change cannot revoke one.
ALTER TABLE easyfixer_courses ADD COLUMN badge_earned_at DATETIME NULL;

-- ─── 5. Verification ────────────────────────────────────────────────────────
-- Expect exactly two rows: reward_points int/YES/NULL, certificate_enabled
-- tinyint/NO/0.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'courses'
   AND COLUMN_NAME IN ('reward_points', 'certificate_enabled')
 ORDER BY COLUMN_NAME;

-- Nothing is backfilled: paying_courses and certificate_courses must both be 0
-- immediately after apply, for every existing course.
SELECT COUNT(*)                                      AS total_courses,
       SUM(reward_points IS NOT NULL
           AND reward_points > 0)                    AS paying_courses,
       SUM(certificate_enabled = 1)                  AS certificate_courses
  FROM courses;

-- No completion award can exist yet. Expect 0.
SELECT COUNT(*) AS course_awards
  FROM reward_points_ledger
 WHERE reason_code = 'COURSE';

-- No badge can exist yet — nothing has been stamped. Expect 0.
SELECT COUNT(*) AS badges_earned
  FROM easyfixer_courses
 WHERE badge_earned_at IS NOT NULL;
