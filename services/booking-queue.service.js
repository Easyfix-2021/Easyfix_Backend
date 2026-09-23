'use strict';

/*
 * booking-queue.service — My Orders → Unconfirmed, the "Booking queue" tab.
 *
 * ONE definition of each bucket, used by BOTH the tile counts and the grid
 * beneath them. The page's whole credibility rests on the tiles and the rows
 * agreeing, and the only way to guarantee that is for the list's WHERE clause
 * and the count query to be the same SQL string. Hence `bucketPredicate()`,
 * applied by job.list() exactly the way sectionPredicate() already is.
 *
 * ── WHAT THE PAGE SHOWS (ops, 2026-09-22/23) ──────────────────────────────
 *
 * A ticket lands in tbl_job. The CLIENT'S setting decides its path, there and
 * then:
 *
 *   auto process unconfirmed order = true   → NEW, waiting for the hourly link
 *   anything else (false, or no row at all) → NO LINK NEEDED, the team calls
 *
 * The hourly cron (job-magic-link-cron.js) sends the link. After that the job
 * is described by WHAT HAPPENED TO THE LINK:
 *
 *   the customer answered it          → RESPONSE RECEIVED
 *   WhatsApp could not deliver it     → DELIVERY FAILED   (call, never re-send)
 *   sent, no answer yet               → NO RESPONSE
 *
 * ── THE TWO KINDS OF NUMBER, AND WHY BOTH EXIST ───────────────────────────
 *
 * The tiles read "70 / 100 · 58 still to call". Those are different questions
 * and they must behave differently:
 *
 *   70 / 100  WHAT HAPPENED TO THE LINK. A fact about the day, counted over
 *             the links SENT in the period whatever became of the job after.
 *             It never goes down. If the team rings a customer who ignored the
 *             link and books the order, the link was still ignored — the job
 *             leaves the page, but it does not leave this number, because
 *             otherwise 25 + 70 + 5 would stop adding up to the 100 links we
 *             actually sent, and the day's funnel would silently lose orders.
 *
 *   58        WORK LEFT. Counted over jobs still sitting at job_status = 9.
 *             It goes down every time somebody books or cancels one. This is
 *             the number the grid lists, so the row count and the small number
 *             always match.
 *
 * NEW and NO LINK NEEDED have no link outcome to report, so they are plain
 * work counts, split Today / Old by the ticket's creation date. "Old" is not
 * decoration: it is where a job goes when its link never went out (every send
 * failed on our side, say). Without that split those jobs would be invisible.
 *
 * ── PRECEDENCE, NOT FIVE INDEPENDENT FILTERS ──────────────────────────────
 *
 * Every open unconfirmed job lands in EXACTLY ONE bucket. A job listed twice
 * reads as two jobs and the tiles stop summing. The chain is:
 *
 *   1. not opted in            → no_link_needed   (no link will ever be sent)
 *   2. customer has answered   → response_received
 *   3. delivery failed         → delivery_failed
 *   4. link sent, no answer    → no_response
 *   5. nothing sent yet        → new
 *
 * "Answered" beats "failed" deliberately: if a customer somehow replied after
 * a failure report, the reply is the newer and more useful fact.
 */

const { pool } = require('../db');

/*
 * The client opt-in test, character for character as job.service.js projects
 * it for `client_opted_in`. Copied expressions are how this codebase has
 * drifted before (see maxSendCountSql's history), so this one is exported and
 * the two callers share it.
 *
 * NOTE the missing-row case: a client with NO property row is NOT opted in, so
 * the job goes to "No link needed". That matches the cron, which only sends
 * when the value is exactly 'true' — a client without the row never receives a
 * link, and a bucket that claimed otherwise would be describing a message that
 * is never sent.
 */
function optedInSql(alias = 'j') {
  return `EXISTS (
     SELECT 1 FROM tbl_client_custom_properties ccp_bq
      WHERE ccp_bq.client_id = ${alias}.fk_client_id
        AND LOWER(TRIM(REPLACE(ccp_bq.c_prop_name, '_', ' '))) = LOWER('Auto Process Unconfirmed Order')
        AND LOWER(TRIM(ccp_bq.c_prop_values)) = 'true'
        AND ccp_bq.status = 1
   )`;
}

/*
 * "The customer answered the link."
 *
 * TWO sources, because there are two ways to answer and only counting one
 * would under-report the tile that ops measures the day by:
 *   customer_submitted_at        the form / conversation was completed
 *   tbl_job_customer_request     the customer asked to cancel or reschedule
 *                                — an answer, just not a confirmation
 *
 * The request table is probed rather than assumed (job.service.js does the
 * same): on a deploy without it the EXISTS is dropped, so the count is a
 * little conservative instead of the whole query 500ing.
 */
function respondedSql(alias = 'j', hasRequestTable = true) {
  const submitted = `${alias}.customer_submitted_at IS NOT NULL`;
  if (!hasRequestTable) return `(${submitted})`;
  return `(${submitted} OR EXISTS (
     SELECT 1 FROM tbl_job_customer_request cr_bq WHERE cr_bq.job_id = ${alias}.job_id
   ))`;
}

/*
 * WhatsApp told us the message did not reach the customer.
 *
 * ⚠ THE `IS NOT NULL` GUARD IS LOAD-BEARING, not defensive noise. SQL is
 * three-valued: on a job that never had a delivery report, the column is NULL,
 * `NULL IN ('failed','undelivered')` is NULL — not FALSE — and `NOT NULL` is
 * NULL, which is not TRUE, so the row matches NO bucket at all. Measured on the
 * QA book before this guard existed: 146 of 149 open unconfirmed orders
 * silently belonged to nothing, every tile read 0, and the page looked calm
 * and empty rather than broken. The unit truth-table could not catch it — it
 * substitutes JS booleans, where there is no third value.
 *
 * `IS NOT NULL` can never itself be NULL, and AND short-circuits it to FALSE,
 * so the whole expression is strictly TRUE or FALSE for every row.
 */
function failedSql(alias = 'j') {
  return `(${alias}.magic_link_delivery_status IS NOT NULL
        AND ${alias}.magic_link_delivery_status IN ('failed', 'undelivered'))`;
}

/** A link has gone out (or been attempted — a failed attempt stamps sent_at). */
function sentSql(alias = 'j') {
  return `${alias}.magic_link_sent_at IS NOT NULL`;
}

const BUCKETS = ['new', 'no_link_needed', 'response_received', 'no_response', 'delivery_failed'];

/** Tile order and labels. The CRM may relabel; these are the defaults. */
const BUCKET_META = [
  { key: 'new', label: 'New — waiting for link', kind: 'waiting' },
  { key: 'response_received', label: 'Response received', kind: 'link' },
  { key: 'no_response', label: 'No response', kind: 'link' },
  { key: 'delivery_failed', label: 'Delivery failed — call, no resend', kind: 'link' },
  { key: 'no_link_needed', label: 'No link needed — calling', kind: 'waiting' },
];

/**
 * The WHERE fragment for one bucket, over OPEN jobs (the caller pins
 * job_status = 9 through the tab filter it already applies).
 *
 * Precedence is encoded as mutual exclusion — SQL has no if-chain, so each
 * bucket must explicitly exclude the ones above it. Miss one and a job appears
 * in two tiles.
 *
 * No bound parameters: every test is a column comparison or a correlated
 * EXISTS, so the fragment composes with any other filter the list applies.
 */
function bucketPredicate(bucket, { hasRequestTable = true } = {}) {
  const optedIn = optedInSql();
  const responded = respondedSql('j', hasRequestTable);
  const failed = failedSql();
  const sent = sentSql();

  switch (bucket) {
    case 'no_link_needed':
      return `NOT ${optedIn}`;
    case 'response_received':
      return `${optedIn} AND ${responded}`;
    case 'delivery_failed':
      return `${optedIn} AND NOT ${responded} AND ${failed}`;
    case 'no_response':
      return `${optedIn} AND NOT ${responded} AND NOT ${failed} AND ${sent}`;
    case 'new':
      return `${optedIn} AND NOT ${responded} AND NOT ${failed} AND NOT ${sent}`;
    default:
      return null;
  }
}

/* ── The period the link tiles are counted over ──────────────────────────── */

const PERIODS = ['today', 'yesterday', 'last7'];

/**
 * The period as IST calendar days, resolved to a [start, end) pair of JS
 * Dates the pool binds directly.
 *
 * IST, not UTC, and not SQL CURDATE(): magic_link_sent_at is written as a JS
 * Date against a pool running at +05:30 (the clock rule the send paths and the
 * cron already follow), so the day boundary has to be computed the same way or
 * a link sent at 02:00 IST would be counted on the previous day.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function istDayStart(now, daysBack = 0) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const ymd = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - daysBack);
  return new Date(ymd - IST_OFFSET_MS);
}

function periodRange(period, now = new Date()) {
  const todayStart = istDayStart(now, 0);
  const tomorrowStart = new Date(istDayStart(now, -1).getTime());
  switch (period) {
    case 'yesterday':
      return { start: istDayStart(now, 1), end: todayStart };
    case 'last7':
      // Seven calendar days ENDING today, today included — "the last 7 days"
      // as ops reads it off a calendar, not a rolling 168 hours.
      return { start: istDayStart(now, 6), end: tomorrowStart };
    case 'today':
    default:
      return { start: todayStart, end: tomorrowStart };
  }
}

/** The IST calendar date (YYYY-MM-DD) it is right now — the Today/Old split. */
function istToday(now = new Date()) {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/* ── The counts behind the tiles ─────────────────────────────────────────── */

/**
 * Every number the tile strip shows, in TWO queries.
 *
 * Two, not ten: one pass over the links sent in the period, one over the open
 * unconfirmed jobs. Counting each tile separately would mean a query per tile
 * per day filter, and the page would be slower than the list it sits above.
 *
 * `scopeSql` / `scopeParams` let the caller push its RBAC and owner filters in
 * unchanged, so the tiles describe the same population as the grid. Passed as
 * a fragment rather than re-derived here — two implementations of "which jobs
 * may this user see" is exactly the drift this file exists to avoid.
 */
async function counts({
  period = 'today', now = new Date(), scopeSql = '', scopeParams = [], scopeJoins = '',
  ownerId, hasRequestTable = true, db = pool,
} = {}) {
  const { start, end } = periodRange(period, now);
  const responded = respondedSql('j', hasRequestTable);
  const failed = failedSql();
  /*
   * The caller's row filter, verbatim. `ownerId` rides alongside it because My
   * Orders is owner-scoped for everyone outside the admin group — the tiles
   * have to count the same jobs the grid lists, and the grid sends ownerId.
   */
  const where = [];
  const whereParams = [];
  if (scopeSql) { where.push(`(${scopeSql})`); whereParams.push(...scopeParams); }
  if (Number.isFinite(Number(ownerId))) { where.push('j.job_owner = ?'); whereParams.push(Number(ownerId)); }
  const scope = where.length ? ` AND ${where.join(' AND ')}` : '';
  const joins = scopeJoins ? ` ${scopeJoins}` : '';

  /*
   * PASS 1 — what happened to the links sent in this period.
   *
   * Deliberately NOT filtered by job_status: a link sent this morning counts
   * whatever the order did afterwards. `*_open` re-counts the same rows that
   * are still unconfirmed, which is the small "still to call" number, so the
   * two halves of every tile come from one row and cannot disagree.
   */
  const [[sentRow]] = await db.query(
    `SELECT COUNT(*) AS sent,
            SUM(${responded})                              AS responded,
            SUM(NOT ${responded} AND ${failed})            AS failed,
            SUM(NOT ${responded} AND NOT ${failed})        AS no_response,
            SUM(${responded} AND j.job_status = 9)                       AS responded_open,
            SUM(NOT ${responded} AND ${failed} AND j.job_status = 9)     AS failed_open,
            SUM(NOT ${responded} AND NOT ${failed} AND j.job_status = 9) AS no_response_open
       FROM tbl_job j${joins}
      WHERE j.magic_link_sent_at >= ? AND j.magic_link_sent_at < ?${scope}`,
    [start, end, ...whereParams],
  );

  /*
   * PASS 2 — THE WORK STILL ON THE BOARD, over open jobs (job_status = 9),
   * every bucket, WITHOUT a date window.
   *
   * ⚠ WHY NO PERIOD HERE, and it is the bug this pass was rewritten to fix.
   * The first cut counted the open work as a SUBSET OF THE PERIOD COHORT —
   * "of the links sent today, how many are still waiting". On QA that read 0
   * across every tile while 133 open orders sat in No response from links sent
   * weeks earlier: the page accounted for 13 of 149 orders and looked finished.
   * An order does not stop needing a phone call because its link is old, and
   * the grid below lists every open order in the bucket, so a count that
   * excluded them described a different population than the rows underneath it.
   *
   * So: the headline x/N stays the PERIOD funnel (what happened to the links we
   * sent today), and this is the QUEUE — all five buckets, all open orders,
   * summing to the tab total. One pass, one CASE, so they cannot double-count.
   *
   * `period_open` keeps the period-cohort subset alongside it, which is what
   * "closed by team" is derived from: of today's links, the ones that have
   * already been dealt with.
   */
  const optedIn = optedInSql();
  const sentP = sentSql();
  const today = istToday(now);
  const isNew = `${optedIn} AND NOT ${sentP} AND NOT ${responded} AND NOT ${failed}`;
  const ticketYmd = 'DATE(COALESCE(j.ticket_created_date_time, j.created_date_time))';
  const [[waitRow]] = await db.query(
    `SELECT
        SUM(${isNew} AND ${ticketYmd} = ?)  AS new_today,
        SUM(${isNew} AND ${ticketYmd} <> ?) AS new_old,
        SUM(NOT ${optedIn} AND ${ticketYmd} = ?)  AS no_link_today,
        SUM(NOT ${optedIn} AND ${ticketYmd} <> ?) AS no_link_old,
        SUM(${optedIn} AND ${responded})                                  AS open_responded,
        SUM(${optedIn} AND NOT ${responded} AND ${failed})                AS open_failed,
        SUM(${optedIn} AND NOT ${responded} AND NOT ${failed} AND ${sentP}) AS open_no_response
       FROM tbl_job j${joins}
      WHERE j.job_status = 9${scope}`,
    [today, today, today, today, ...whereParams],
  );

  const n = (v) => Number(v || 0);
  return {
    period,
    period_start: start,
    period_end: end,
    // What happened to the links sent in the period. sent = the other three.
    links: {
      sent: n(sentRow && sentRow.sent),
      response_received: n(sentRow && sentRow.responded),
      no_response: n(sentRow && sentRow.no_response),
      delivery_failed: n(sentRow && sentRow.failed),
    },
    /*
     * THE QUEUE: every open order in the bucket, whatever day its link went
     * out. This is what the grid lists and what the tile's work pill shows, and
     * open.* + waiting.* sums to the tab total — the check that catches a
     * bucket quietly claiming nobody.
     */
    open: {
      response_received: n(waitRow && waitRow.open_responded),
      no_response: n(waitRow && waitRow.open_no_response),
      delivery_failed: n(waitRow && waitRow.open_failed),
    },
    /*
     * The same three, narrowed to the period's links. Only "closed by team"
     * reads this: links.x - period_open.x = how many of TODAY'S links have
     * already been dealt with. Kept separate from `open` above because mixing
     * the two is exactly what made the tiles describe 13 of 149 orders.
     */
    period_open: {
      response_received: n(sentRow && sentRow.responded_open),
      no_response: n(sentRow && sentRow.no_response_open),
      delivery_failed: n(sentRow && sentRow.failed_open),
    },
    // No link outcome to report — plain work counts, split by ticket date.
    waiting: {
      new: { today: n(waitRow && waitRow.new_today), old: n(waitRow && waitRow.new_old) },
      no_link_needed: { today: n(waitRow && waitRow.no_link_today), old: n(waitRow && waitRow.no_link_old) },
    },
    meta: BUCKET_META,
  };
}

module.exports = {
  BUCKETS, BUCKET_META, PERIODS,
  optedInSql, respondedSql, failedSql, sentSql,
  bucketPredicate, periodRange, istToday, counts,
};
