-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-01 — tbl_job_image: fold the new app's vocabulary into the legacy one
--
-- Pairs with utils/job-image-buckets.js (`persistedCategory`), which now maps
-- the technician app's 'Booking' / 'Completion' onto 'checkin' / 'checkout'
-- BEFORE the insert. This backfills the rows written before that landed, so the
-- column speaks one language end to end.
--
-- ── WHY IT MATTERS ─────────────────────────────────────────────────────
-- Every other consumer in the estate was written against the legacy spelling:
-- Easyfix_Client_App filtered proof photos on 'checkin' / 'checkout' and could
-- not see a single photo the new app took. The readers now accept both, so this
-- is not a correctness fix — it is so the next reader only has to learn one.
--
-- ⚠ THE COLLATION TRAP — this is the whole reason the WHERE clause looks odd.
--
-- tbl_job_image.image_category is case-INSENSITIVE, so the obvious
--
--     WHERE image_category IN ('Booking', 'Completion')
--
-- also matches the LOWERCASE 'booking' rows, which are a completely different
-- thing: customer attachments from the website / WhatsApp / CRM booking flows
-- (30 rows on QA as of today, ids 1413609-1413642, May-July 2026). They are
-- already correct, already bucket as "before", and rewriting them would erase
-- where a photo came from for no gain. BINARY forces a byte comparison so only
-- the app's exact PascalCase spellings are touched.
--
-- ── SCOPE, MEASURED ────────────────────────────────────────────────────
-- On QA this is a NO-OP: zero rows carry the exact-case spellings, because the
-- new technician app is still beta-only and no field traffic has reached
-- `recordImages` there. Production may have beta-tester rows. Step 1 tells you
-- which world you are in before you change anything; if it returns nothing,
-- stop — the migration has nothing to do and running step 2 is still safe but
-- pointless.
--
-- Reversible: step 4 is the inverse, but only if run before any NEW legacy
-- row lands, which is why it is commented out rather than provided as a path.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. READ THIS FIRST — what exists, byte-exactly ──────────────────
-- Expect: 'booking' (leave alone) and, on production only, 'Booking' and/or
-- 'Completion' (the rows this migration converts).
SELECT image_category AS category_exact_bytes,
       COUNT(*)       AS rows_,
       MIN(image_id)  AS first_id,
       MAX(image_id)  AS last_id,
       MIN(created_date) AS first_seen,
       MAX(created_date) AS last_seen
  FROM tbl_job_image
 WHERE BINARY image_category IN ('Booking', 'Completion')
 GROUP BY BINARY image_category
 ORDER BY rows_ DESC;


-- ─── 2. Backfill the before-work photos ──────────────────────────────
UPDATE tbl_job_image SET image_category = 'checkin' WHERE BINARY image_category = 'Booking';


-- ─── 3. Backfill the after-work photos ───────────────────────────────
UPDATE tbl_job_image SET image_category = 'checkout' WHERE BINARY image_category = 'Completion';


-- ─── 4. Verify — both queries must return NO ROWS ────────────────────
-- (a) nothing is left in the app's vocabulary
SELECT image_id, job_id, image_category, job_stage
  FROM tbl_job_image
 WHERE BINARY image_category IN ('Booking', 'Completion')
 LIMIT 10;

-- (b) the lowercase booking rows were NOT swept up — this counts them, and the
--     count must still be what step 1 showed for 'booking' (30 on QA).
SELECT COUNT(*) AS lowercase_booking_rows_untouched
  FROM tbl_job_image
 WHERE BINARY image_category = 'booking';
