/*
 * tbl_job_offer.offer_status codes — the ONE named source shared across the offer
 * engine (job.service.js), acceptance stats (mobile-performance), candidate
 * ranking, and the mobile routes, so no query hard-codes a bare 0/1/2/3. A
 * read-only `offer_status_label` generated column mirrors these in the DB for
 * browsing (migration 2026-07-02-job-offer-status-label.sql) — keep both in sync.
 */
const OFFER_STATUS = Object.freeze({
  OFFERED: 0,   // extended to the tech, awaiting response
  ACCEPTED: 1,  // tech accepted → job SCHEDULED to them
  REJECTED: 2,  // tech declined (with a reason)
  EXPIRED: 3,   // window elapsed, or superseded (sibling accepted / re-offer)
});

module.exports = { OFFER_STATUS };
