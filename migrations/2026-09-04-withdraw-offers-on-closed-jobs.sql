-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-04 — Close the OPEN offers still advertising jobs that ended.
--
-- ── WHAT WENT WRONG ──────────────────────────────────────────────────
-- Reported as "job is completed but the technician app still shows Accept /
-- Reject". It was not a rendering bug. Nothing ever closed an offer when its
-- JOB ended:
--
--   * expireStaleOffers() closes offers on AGE (a 30-minute TTL), and
--   * job.offer_expiry.enabled is "false" in production — switched off
--     deliberately — so that sweep returns early and closes nothing.
--
-- Measured on the production replica before this ran:
--
--     offer_status=0 (OFFERED) on job_status 5   1124
--     offer_status=0 (OFFERED) on job_status 6    466   (cancelled)
--     offer_status=0 (OFFERED) on job_status 10     9
--     offer_status=0 (OFFERED) on job_status 3      7
--                                        TOTAL   1606
--
-- The youngest was ~40 hours old and the oldest ~38 days, so none of them were
-- a live offer caught mid-flight — every one was advertising work that had
-- already finished or been cancelled.
--
-- ── THE CODE FIX SHIPS WITH THIS ─────────────────────────────────────
-- services/job.service.js now calls withdrawOffersForClosedJob() from
-- setStatus, so a job reaching 3 / 5 / 6 / 10 closes its own open offers from
-- here on. This file only clears the backlog that accumulated before that.
-- Running it WITHOUT the code deployed fixes today and nothing after it.
--
-- ── WHY offer_status = 3 (EXPIRED) AND NOT A NEW CODE ────────────────
-- services/offer-status.js already defines EXPIRED as "window elapsed, OR
-- SUPERSEDED", which is precisely this. It also matters for fairness:
-- candidate-ranking scores acceptance from OFFERED and REJECTED rows, so a
-- withdrawn offer must never read as a technician's decline. An EXPIRED row
-- correctly does not count against them.
--
-- responded_at is stamped for the same reason acceptOffer and expireStaleOffers
-- stamp it — a closed offer with a NULL responded_at is exactly the shape this
-- migration is cleaning up, and leaving it NULL would make the backlog
-- invisible to the very query that found it.
--
-- ── SAFE TO RE-RUN ───────────────────────────────────────────────────
-- The WHERE clause matches only offer_status = 0, and step 2 sets it to 3, so a
-- second run matches nothing. No DELIMITER, no PREPARE — this opens in DBeaver.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. READ THIS FIRST — the backlog, before you change it ──────────
-- Expect roughly the table above. If it comes back 0, the fix has already run.
SELECT j.job_status, COUNT(*) AS open_offers,
       MIN(o.offered_at) AS oldest, MAX(o.offered_at) AS newest
  FROM tbl_job j
  JOIN tbl_job_offer o ON o.job_id = j.job_id
 WHERE o.offer_status = 0
   AND j.job_status IN (3, 5, 6, 10)
 GROUP BY j.job_status
 ORDER BY open_offers DESC;


-- ─── 2. Close them ───────────────────────────────────────────────────
-- 3 = EXPIRED (services/offer-status.js). Statuses 3/5/6/10 mirror
-- OFFER_WITHDRAWAL_STATES in services/job.service.js — change both together.
UPDATE tbl_job_offer o
  JOIN tbl_job j ON j.job_id = o.job_id
   SET o.offer_status = 3,
       o.responded_at = NOW()
 WHERE o.offer_status = 0
   AND j.job_status IN (3, 5, 6, 10);


-- ─── 3. Verify — expect ZERO rows ────────────────────────────────────
SELECT COUNT(*) AS should_be_zero
  FROM tbl_job j
  JOIN tbl_job_offer o ON o.job_id = j.job_id
 WHERE o.offer_status = 0
   AND j.job_status IN (3, 5, 6, 10);


-- ─── 4. Control — open offers on LIVE jobs must be UNTOUCHED ─────────
-- These are real, actionable offers. If this returns 0, step 2 was too wide
-- and every technician's live offer has just been cancelled.
SELECT COUNT(*) AS live_offers_left_alone
  FROM tbl_job j
  JOIN tbl_job_offer o ON o.job_id = j.job_id
 WHERE o.offer_status = 0
   AND j.job_status NOT IN (3, 5, 6, 10);
