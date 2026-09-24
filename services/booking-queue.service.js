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
 * ── ONE KIND OF NUMBER PER TILE ───────────────────────────────────────────
 *
 * Every tile counts the same thing: OPEN orders (job_status = 9) in that
 * bucket. The five sum to the total the page prints, which is the check that
 * catches a bucket quietly claiming nobody, and the grid below lists exactly
 * the tile you clicked.
 *
 * Inside each tile the Day 0/1/2/3+ pills split that number by how long the
 * ticket has waited, and those four sum to the tile. Response received also
 * splits by WHAT the customer asked for, because that is what decides who
 * picks the order up.
 *
 * An earlier cut had the tiles counting "links sent today" alongside the work,
 * and the two were confused for each other more than once. One number, one
 * meaning, and the pills for everything else.
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

/*
 * WHAT the customer answered, when they answered.
 *
 * tbl_job_customer_request carries the two asks a link can produce — 'cancel'
 * and 'reschedule' — and a request_status of 'pending' until ops actions it.
 * The LATEST PENDING row is the live ask: an actioned one has already been
 * dealt with, and counting it would keep an order in "wants to cancel" after
 * somebody cancelled it.
 *
 * Read exactly as job.service.js's pending_request_type projection reads it
 * (latest pending, created_at DESC) so the tile and the row's own "Customer
 * Request" column can never disagree about what the customer asked for.
 */
function pendingRequestSql(alias = 'j', type) {
  return `(SELECT cr_k.request_type FROM tbl_job_customer_request cr_k
            WHERE cr_k.job_id = ${alias}.job_id AND cr_k.request_status = 'pending'
            ORDER BY cr_k.created_at DESC LIMIT 1) = '${type}'`;
}

/*
 * The three kinds of answer, as ops reads them off the tile:
 *
 *   cancel      the customer asked to cancel        — a decision, not a booking
 *   reschedule  the customer asked for another slot — re-book it
 *   ready       everything else that answered       — attach an SKU and book
 *
 * A PENDING ask wins over a completed form: if a customer filled the link and
 * then asked to move the date, the ask is the newer fact and the one ops must
 * act on. `ready` is therefore the remainder, which also means a job can never
 * fall outside the three — the split always sums to the tile.
 */
const RESPONSE_KINDS = ['ready', 'reschedule', 'cancel'];

function responseKindSql(kind, { hasRequestTable = true } = {}) {
  if (!hasRequestTable) {
    // No request table on this deploy: nobody can have asked for anything, so
    // every answer is a completed form. Conservative, and never wrong-headed.
    return kind === 'ready' ? '1=1' : '1=0';
  }
  const cancel = pendingRequestSql('j', 'cancel');
  const reschedule = pendingRequestSql('j', 'reschedule');
  switch (kind) {
    case 'cancel': return `(${cancel})`;
    case 'reschedule': return `(NOT (${cancel}) OR (${cancel}) IS NULL) AND (${reschedule})`;
    case 'ready': return `COALESCE(${cancel}, FALSE) = FALSE AND COALESCE(${reschedule}, FALSE) = FALSE`;
    default: return null;
  }
}

/* ── How old the ticket is, in days ──────────────────────────────────────── */

/*
 * The Day 0 / 1 / 2 / 3+ pills inside each tile (ops, 2026-09-23).
 *
 * Day N = N IST calendar days since the TICKET came in — not since the link
 * went out. Ops named the ticket date, and it is also the only date every
 * bucket has: an order in "New" has no link yet, so a link-based age could not
 * pill two of the five tiles at all. (In practice they differ by under an hour
 * for most orders, because the cron sends within the hour.)
 *
 * ⚠ THE LAST PILL IS 3-OR-MORE, not 3. A plain "Day 3" is what the design
 * sketch showed, and on the real book it would be a trap: the oldest open
 * unconfirmed order on QA was raised in APRIL. Everything past day 3 would
 * belong to no pill, the pills would stop summing to the tile above them, and
 * the orders that have waited longest — the ones the pills exist to surface —
 * would be the invisible ones.
 *
 * Calendar days, not 24-hour blocks: a ticket raised at 23:00 last night is
 * "Day 1" this morning, which is how ops reads it off the row.
 */
const DAY_BUCKETS = ['0', '1', '2', '3plus'];

/**
 * The age expression, as IST calendar days.
 *
 * ⚠ NOT CURDATE(). The pool runs at +05:30 but MySQL's own session clock is
 * UTC on these hosts, so CURDATE() is yesterday's date for the first five and a
 * half hours of every IST day — a ticket raised at 01:00 would read as Day 1
 * the moment it arrived, and every pill would be off by one all night. The
 * repo's linter refuses SQL clock functions for exactly this reason.
 *
 * Today's IST date is therefore computed in JS and inlined. Inlined, not bound,
 * because this fragment composes into the list's WHERE and into twenty SUM()
 * columns with no parameter slots of its own — and it is safe to inline
 * BECAUSE IT IS NOT INPUT: it comes from the clock, never from a request, and
 * is re-checked against a strict YYYY-MM-DD shape before it is interpolated.
 */
function ageDaysSql(alias = 'j', today = istToday()) {
  const ymd = String(today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error('booking-queue: bad IST date ' + ymd);
  return `DATEDIFF('${ymd}', DATE(${alias}.ticket_created_date_time))`;
}

/**
 * The WHERE fragment for one day pill. NULL-safe: a ticket with no date (none
 * on QA, but the column is nullable) yields NULL from DATEDIFF, and a NULL
 * predicate excludes the row from EVERY pill — so `3plus` claims it rather than
 * letting it fall out of the tile it is counted in.
 */
function dayPredicate(day, alias = 'j', today = istToday()) {
  const age = ageDaysSql(alias, today);
  switch (String(day)) {
    case '0': return `${age} = 0`;
    case '1': return `${age} = 1`;
    case '2': return `${age} = 2`;
    case '3plus': return `(${age} >= 3 OR ${age} IS NULL)`;
    default: return null;
  }
}

const BUCKETS = ['new', 'no_link_needed', 'response_received', 'no_response', 'delivery_failed'];

/*
 * The three Response-received pills are ALSO grid filters, so clicking one
 * narrows the rows beneath. They are not tiles, so they live outside BUCKETS
 * (which the tile list is checked against) but are accepted by the same
 * `bucket=` parameter — one mechanism, not two.
 */
const RESPONSE_SUB_BUCKETS = RESPONSE_KINDS.map((k) => `response_${k}`);
const ALL_BUCKET_FILTERS = [...BUCKETS, ...RESPONSE_SUB_BUCKETS];

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
function bucketPredicate(bucket, { hasRequestTable = true, day } = {}) {
  /*
   * A day pill narrows its own tile, so the two compose here rather than each
   * becoming its own query parameter to be combined by the caller — the grid
   * sends bucket + ageDay and gets exactly the rows the pill counted.
   */
  const dayClause = day ? dayPredicate(day) : null;
  if (day && !dayClause) return null;          // unknown pill: never unfiltered
  const withDay = (sql) => (dayClause ? `${sql} AND (${dayClause})` : sql);
  const optedIn = optedInSql();
  const responded = respondedSql('j', hasRequestTable);
  const failed = failedSql();
  const sent = sentSql();

  // A Response-received sub-filter: the tile's own predicate, narrowed to what
  // the customer actually asked for.
  if (typeof bucket === 'string' && bucket.startsWith('response_') && bucket !== 'response_received') {
    const kind = bucket.slice('response_'.length);
    if (!RESPONSE_KINDS.includes(kind)) return null;
    const sub = responseKindSql(kind, { hasRequestTable });
    return withDay(`${optedIn} AND ${responded} AND (${sub})`);
  }

  switch (bucket) {
    case 'no_link_needed':
      return withDay(`NOT ${optedIn}`);
    case 'response_received':
      return withDay(`${optedIn} AND ${responded}`);
    case 'delivery_failed':
      return withDay(`${optedIn} AND NOT ${responded} AND ${failed}`);
    case 'no_response':
      return withDay(`${optedIn} AND NOT ${responded} AND NOT ${failed} AND ${sent}`);
    case 'new':
      return withDay(`${optedIn} AND NOT ${responded} AND NOT ${failed} AND NOT ${sent}`);
    default:
      return null;
  }
}

/*
 * ── THERE IS NO PERIOD FILTER ANY MORE, and its removal is deliberate ─────
 *
 * This file used to carry All / Today / Yesterday / Last 7 days, and the route
 * defaulted to `today` when the caller sent nothing. When the day pills
 * replaced the date tabs the page stopped sending a period — and the default
 * quietly filtered every tile to tickets raised TODAY, of which QA had none.
 * The screen read 0 across the board while 149 orders sat open, and it looked
 * calm rather than broken.
 *
 * So the concept is gone rather than re-defaulted. The page counts every open
 * order, and the Day 0/1/2/3+ pills inside each tile do the slicing by age.
 * A filter nothing sends is a filter nobody can see is wrong.
 */

/*
 * India is +05:30 from UTC, and the whole page's idea of "a day" hangs off it:
 * the pool stores datetimes at this offset, so a ticket raised at 01:00 IST
 * belongs to that IST date even though UTC is still on the day before.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** The IST calendar date (YYYY-MM-DD) it is right now — the day pills' anchor. */
function istToday(now = new Date()) {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/* ── The counts behind the tiles ─────────────────────────────────────────── */

/**
 * Every number the tile strip shows, in ONE query.
 *
 * One, not twenty-five: five tiles x four day pills, plus the answer split and
 * the links tally, all come off a single pass over the open book. A query per
 * pill would make the strip slower than the list beneath it, and — worse —
 * numbers read at slightly different moments cannot be relied on to add up.
 *
 * `scopeSql` / `scopeParams` let the caller push its RBAC and owner filters in
 * unchanged, so the tiles describe the same population as the grid. Passed as
 * a fragment rather than re-derived here — two implementations of "which jobs
 * may this user see" is exactly the drift this file exists to avoid.
 */
async function counts({
  now = new Date(), scopeSql = '', scopeParams = [], scopeJoins = '',
  ownerId, hasRequestTable = true, db = pool,
} = {}) {
  const responded = respondedSql('j', hasRequestTable);
  const failed = failedSql();
  const optedIn = optedInSql();
  const sentP = sentSql();

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
   * ONE PASS over the open book. Every tile, the answer split, the Today/Old
   * halves and the links-sent tally come off the same rows, so they cannot
   * disagree with each other and the five buckets always sum to `total`.
   */
  const isNew = `${optedIn} AND NOT ${sentP} AND NOT ${responded} AND NOT ${failed}`;
  const ticketYmd = 'DATE(j.ticket_created_date_time)';
  const today = istToday(now);
  const [[row]] = await db.query(
    `SELECT COUNT(*) AS total,
        SUM(${isNew})                                                       AS b_new,
        SUM(NOT ${optedIn})                                                 AS b_no_link,
        SUM(${optedIn} AND ${responded})                                    AS b_responded,
        SUM(${optedIn} AND NOT ${responded} AND ${failed})                  AS b_failed,
        SUM(${optedIn} AND NOT ${responded} AND NOT ${failed} AND ${sentP}) AS b_no_response,
        SUM(${optedIn} AND ${responded} AND (${responseKindSql('ready', { hasRequestTable })}))      AS r_ready,
        SUM(${optedIn} AND ${responded} AND (${responseKindSql('reschedule', { hasRequestTable })})) AS r_reschedule,
        SUM(${optedIn} AND ${responded} AND (${responseKindSql('cancel', { hasRequestTable })}))     AS r_cancel,
        SUM(${isNew} AND ${ticketYmd} = ?)        AS new_today,
        SUM(${isNew} AND ${ticketYmd} <> ?)       AS new_old,
        SUM(NOT ${optedIn} AND ${ticketYmd} = ?)  AS no_link_today,
        SUM(NOT ${optedIn} AND ${ticketYmd} <> ?) AS no_link_old,
        SUM(${sentP})                             AS links_sent,
        SUM((${isNew}) AND (${dayPredicate('0', 'j', today)})) AS d_new_0,
        SUM((${isNew}) AND (${dayPredicate('1', 'j', today)})) AS d_new_1,
        SUM((${isNew}) AND (${dayPredicate('2', 'j', today)})) AS d_new_2,
        SUM((${isNew}) AND (${dayPredicate('3plus', 'j', today)})) AS d_new_3plus,
        SUM((NOT ${optedIn}) AND (${dayPredicate('0', 'j', today)})) AS d_no_link_0,
        SUM((NOT ${optedIn}) AND (${dayPredicate('1', 'j', today)})) AS d_no_link_1,
        SUM((NOT ${optedIn}) AND (${dayPredicate('2', 'j', today)})) AS d_no_link_2,
        SUM((NOT ${optedIn}) AND (${dayPredicate('3plus', 'j', today)})) AS d_no_link_3plus,
        SUM((${optedIn} AND ${responded}) AND (${dayPredicate('0', 'j', today)})) AS d_responded_0,
        SUM((${optedIn} AND ${responded}) AND (${dayPredicate('1', 'j', today)})) AS d_responded_1,
        SUM((${optedIn} AND ${responded}) AND (${dayPredicate('2', 'j', today)})) AS d_responded_2,
        SUM((${optedIn} AND ${responded}) AND (${dayPredicate('3plus', 'j', today)})) AS d_responded_3plus,
        SUM((${optedIn} AND NOT ${responded} AND ${failed}) AND (${dayPredicate('0', 'j', today)})) AS d_failed_0,
        SUM((${optedIn} AND NOT ${responded} AND ${failed}) AND (${dayPredicate('1', 'j', today)})) AS d_failed_1,
        SUM((${optedIn} AND NOT ${responded} AND ${failed}) AND (${dayPredicate('2', 'j', today)})) AS d_failed_2,
        SUM((${optedIn} AND NOT ${responded} AND ${failed}) AND (${dayPredicate('3plus', 'j', today)})) AS d_failed_3plus,
        SUM((${optedIn} AND NOT ${responded} AND NOT ${failed} AND ${sentP}) AND (${dayPredicate('0', 'j', today)})) AS d_no_response_0,
        SUM((${optedIn} AND NOT ${responded} AND NOT ${failed} AND ${sentP}) AND (${dayPredicate('1', 'j', today)})) AS d_no_response_1,
        SUM((${optedIn} AND NOT ${responded} AND NOT ${failed} AND ${sentP}) AND (${dayPredicate('2', 'j', today)})) AS d_no_response_2,
        SUM((${optedIn} AND NOT ${responded} AND NOT ${failed} AND ${sentP}) AND (${dayPredicate('3plus', 'j', today)})) AS d_no_response_3plus
       FROM tbl_job j${joins}
      WHERE j.job_status = 9${scope}`,
    [today, today, today, today, ...whereParams],
  );

  const n = (v) => Number(v || 0);
  const dayMap = (r, key) => ({
    0: n(r && r[`d_${key}_0`]),
    1: n(r && r[`d_${key}_1`]),
    2: n(r && r[`d_${key}_2`]),
    '3plus': n(r && r[`d_${key}_3plus`]),
  });
  return {
    /* Every open order in the range, one bucket each. These sum to `total`. */
    open: {
      new: n(row && row.b_new),
      no_link_needed: n(row && row.b_no_link),
      response_received: n(row && row.b_responded),
      no_response: n(row && row.b_no_response),
      delivery_failed: n(row && row.b_failed),
    },
    total: n(row && row.total),
    /*
     * WHAT the customers who answered asked for. Sums to open.response_received
     * because `ready` is the remainder rather than a third test — a job cannot
     * answer and match none of the three.
     */
    response_breakdown: {
      ready: n(row && row.r_ready),
      reschedule: n(row && row.r_reschedule),
      cancel: n(row && row.r_cancel),
    },
    /* The two tiles with no link outcome, split by the ticket's own date. */
    waiting: {
      new: { today: n(row && row.new_today), old: n(row && row.new_old) },
      no_link_needed: { today: n(row && row.no_link_today), old: n(row && row.no_link_old) },
    },
    /* How many of these orders have had a link go out. Context, not a bucket. */
    links_sent: n(row && row.links_sent),
    /*
     * How old the waiting orders are, per tile. Each bucket's four pills sum to
     * its own count — that is the check that catches an order past day 3
     * falling out of every pill, which is exactly what a plain "Day 3" would
     * have done to a book whose oldest order is five months old.
     */
    days: {
      new: dayMap(row, 'new'),
      no_link_needed: dayMap(row, 'no_link'),
      response_received: dayMap(row, 'responded'),
      no_response: dayMap(row, 'no_response'),
      delivery_failed: dayMap(row, 'failed'),
    },
    meta: BUCKET_META,
  };
}

module.exports = {
  BUCKETS, BUCKET_META,
  RESPONSE_KINDS, RESPONSE_SUB_BUCKETS, ALL_BUCKET_FILTERS, responseKindSql,
  DAY_BUCKETS, dayPredicate, ageDaysSql,
  optedInSql, respondedSql, failedSql, sentSql,
  bucketPredicate, istToday, counts,
};
