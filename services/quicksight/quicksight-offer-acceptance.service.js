/*
 * QuickSight — Offer Acceptance service.
 *
 * Measures how the job-offer pool performs: per technician, how many offers
 * they were extended and how many they accepted / rejected / let expire, plus
 * acceptance rate and average response time. Sourced entirely from
 * tbl_job_offer (offer_status / offer_source / offered_at / responded_at),
 * scoped by the standard QuickSight job filters + an optional offered_at window,
 * a responded_at (acceptance-date) window, an "Offered By" (job owner) filter,
 * and offer_source. Returns { rows (per tech), bySource, byOwner, byDay, totals }
 * so the CRM page can render KPI tiles + a table + by-source / by-owner charts
 * from one call.
 *
 * "Offered By": the CRM user who PUT the offer out, captured per-offer on
 * tbl_job_offer.offered_by_user_id (→ tbl_user, aliased ob.user_name). This is
 * the real offerer — job.service stamps it at the offer site — NOT the job owner
 * (many people touch one job, so job_owner over-credited owners). NULL offered_by
 * buckets 'Unassigned': that means a system/auto offer with no actor, OR a
 * PRE-MIGRATION offer made before the column existed (intentionally not
 * backfilled — historical rows read as "unknown offerer").
 *
 * Uses the named OFFER_STATUS constants (services/offer-status.js) so the SQL
 * reads OFFERED/ACCEPTED/REJECTED/EXPIRED, never bare 0/1/2/3.
 */

const { pool } = require('../../db');
const logger = require('../../logger');
const { buildInFilter, _dateHelpers } = require('./_shared');
const { istToday, fmt, addDays } = _dateHelpers;
const { OFFER_STATUS } = require('../offer-status');

const ROW_CAP = 5000;
// Cap the daily trend so a wide offered_at filter can't explode the chart into
// hundreds of bars — show at most the most recent N days of the window.
const TREND_MAX_DAYS = 31;

// 'YYYY-MM-DD' -> UTC-midnight Date (pairs with _dateHelpers.addDays/fmt, which
// are all UTC-based, so no local-timezone drift).
function parseDay(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }

// The inclusive day axis for the outcome trend: the filter's offered_at window,
// or the last 7 days (IST) when none is set. Clamped to TREND_MAX_DAYS.
function trendDays(filters) {
  const to = filters.dateTo || fmt(istToday());
  const rawFrom = filters.dateFrom || fmt(addDays(parseDay(to), -6));
  const end = parseDay(to);
  let start = parseDay(rawFrom);
  if (end < start) start = end;
  const span = Math.round((end - start) / 86400000) + 1;
  if (span > TREND_MAX_DAYS) start = addDays(end, -(TREND_MAX_DAYS - 1));
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(fmt(d));
  return days;
}

// Shared FROM + WHERE + params for the offer set matching the filters. Joins
// tbl_job_offer → tech (name) + job/client/city so the standard job filters
// (client, vertical, zonal manager = tbl_city.state_user, service category) and
// the optional offered_at window + source can all apply.
function buildScope(filters) {
  const params = [];
  let where = ' WHERE 1=1';
  where += buildInFilter('j.fk_client_id', filters.clientId, params);
  where += buildInFilter('c.vertical_id', filters.verticalId, params);
  where += buildInFilter('cy.state_user', filters.zonalManagerId, params);
  where += buildInFilter('j.fk_service_catg_id', filters.serviceCategoryId, params);
  // "Offered By" = who made the offer (tbl_job_offer.offered_by_user_id). Array of
  // tbl_user ids; empty = all. Reads the base table directly (no job join needed).
  // NULL offered_by (auto / pre-migration offers) never matches an id filter, so
  // those rows only surface when no "Offered By" filter is applied.
  where += buildInFilter('jo.offered_by_user_id', filters.offeredById, params);
  if (filters.source) { where += ' AND jo.offer_source = ?'; params.push(filters.source); }
  if (filters.dateFrom) { where += ' AND jo.offered_at >= ?'; params.push(filters.dateFrom + ' 00:00:00'); }
  // Inclusive upper bound — cover the whole dateTo day (legacy DATE_ADD idiom).
  if (filters.dateTo) { where += ' AND jo.offered_at < DATE_ADD(?, INTERVAL 1 DAY)'; params.push(filters.dateTo); }
  // Acceptance-date window on responded_at (when the tech actually accepted /
  // rejected — the response event), distinct from the offered_at cohort window
  // above. Still-open offers (responded_at IS NULL) naturally fall out. IST edges:
  // the pool session TZ is +05:30, so a bare 'YYYY-MM-DD' compares at IST
  // wall-clock — lower bound at 00:00:00 IST, upper via DATE_ADD(+1 day), matching
  // the offered_at idiom so day boundaries land on IST edges.
  if (filters.respondedFrom) { where += ' AND jo.responded_at >= ?'; params.push(filters.respondedFrom + ' 00:00:00'); }
  if (filters.respondedTo) { where += ' AND jo.responded_at < DATE_ADD(?, INTERVAL 1 DAY)'; params.push(filters.respondedTo); }
  const from = `
      FROM tbl_job_offer jo
      JOIN tbl_easyfixer ef  ON ef.efr_id = jo.fk_easyfixter_id
      LEFT JOIN tbl_job j     ON j.job_id = jo.job_id
      LEFT JOIN tbl_client c  ON c.client_id = j.fk_client_id
      LEFT JOIN tbl_address a ON a.address_id = j.fk_address_id
      LEFT JOIN tbl_city cy   ON cy.city_id = a.city_id`;
  return { from, where, params };
}

// The status-count + avg-response aggregate reused by all three groupings.
const STATUS_AGG = `
      COUNT(*) AS offered,
      -- Total offer ACTIONS. tbl_job_offer holds ONE ROW PER (job, technician):
      -- a re-offer does not insert, it UPDATEs that row and does
      -- offer_count = offer_count + 1 (job.service offerToTechnicians). So
      -- COUNT(*) = "how many were offered" and SUM(offer_count) = "how many
      -- offer actions happened"; the DIFFERENCE between them is the number of
      -- RE-offers, which is what the UI surfaces (as "Re-offers"). Note this is
      -- NOT the same as "rounds"/waves — see the per-job waves column, which
      -- is what an operator means by "how many times did we offer this job".
      -- (No backticks in this comment: the whole block is a JS template
      -- literal, so a backtick would terminate the string.)
      -- COALESCE(...,1) because a row IS at least one offer even if the counter
      -- was never written (pre-column rows).
      SUM(COALESCE(jo.offer_count, 1)) AS rounds,
      COUNT(CASE WHEN jo.offer_status = ${OFFER_STATUS.ACCEPTED} THEN 1 END) AS accepted,
      COUNT(CASE WHEN jo.offer_status = ${OFFER_STATUS.REJECTED} THEN 1 END) AS rejected,
      COUNT(CASE WHEN jo.offer_status = ${OFFER_STATUS.EXPIRED}  THEN 1 END) AS expired,
      COUNT(CASE WHEN jo.offer_status = ${OFFER_STATUS.OFFERED}  THEN 1 END) AS open_count,
      -- Avg response time = only GENUINE responses (ACCEPTED / REJECTED). EXPIRED
      -- offers ALSO stamp responded_at — the offer-expiry cron sets it = NOW() when
      -- it marks a stale offer expired — so including them measures "offer age at
      -- expiry" (~the 30-min TTL, or hours if the cron lagged), never how fast a
      -- tech actually responded. Measured in SECONDS so the CRM renders mm:ss.
      ROUND(AVG(CASE WHEN jo.offer_status IN (${OFFER_STATUS.ACCEPTED}, ${OFFER_STATUS.REJECTED})
                          AND jo.responded_at IS NOT NULL
                     THEN TIMESTAMPDIFF(SECOND, jo.offered_at, jo.responded_at) END)) AS avg_response_secs`;

// Acceptance rate over RESPONDED offers (accepted / accepted+rejected+expired),
// as a whole-number percent. Open offers are excluded (not yet decided).
function rate(accepted, rejected, expired) {
  const responded = accepted + rejected + expired;
  return responded > 0 ? Math.round((accepted / responded) * 100) : 0;
}

const n = (v) => Number(v) || 0;

async function getOfferAcceptance(filters = {}) {
  logger.info('Building Offer Acceptance report');

  const s1 = buildScope(filters);
  const [techRows] = await pool.query(
    `SELECT jo.fk_easyfixter_id AS efrId, ef.efr_name AS efrName, ${STATUS_AGG}
       ${s1.from} ${s1.where}
      GROUP BY jo.fk_easyfixter_id, ef.efr_name
      ORDER BY offered DESC, accepted DESC
      LIMIT ${ROW_CAP}`,
    s1.params,
  );
  if (techRows.length >= ROW_CAP) logger.warn(`Offer Acceptance hit the ${ROW_CAP}-row cap`);

  const s2 = buildScope(filters);
  const [sourceRows] = await pool.query(
    `SELECT COALESCE(jo.offer_source, 'unknown') AS source, ${STATUS_AGG}
       ${s2.from} ${s2.where}
      GROUP BY COALESCE(jo.offer_source, 'unknown')
      ORDER BY offered DESC`,
    s2.params,
  );

  // Offers grouped by "Offered By" = the user who made the offer
  // (tbl_job_offer.offered_by_user_id → tbl_user.user_name). NULL offered_by
  // (system/auto or pre-migration offers) buckets to 'Unassigned'. The tbl_user
  // join lives only here — the other groupings don't need the offerer NAME, and
  // the "Offered By" FILTER above reads jo.offered_by_user_id off the base table,
  // so there's no extra cost elsewhere. (ownerId/ownerName keys are kept so the
  // FE response contract is unchanged; they now carry the offerer, not the owner.)
  const s4 = buildScope(filters);
  const [ownerRows] = await pool.query(
    `SELECT COALESCE(jo.offered_by_user_id, 0) AS ownerId,
            COALESCE(ob.user_name, 'Unassigned') AS ownerName, ${STATUS_AGG}
       ${s4.from}
       LEFT JOIN tbl_user ob ON ob.user_id = jo.offered_by_user_id
       ${s4.where}
      GROUP BY COALESCE(jo.offered_by_user_id, 0), COALESCE(ob.user_name, 'Unassigned')
      ORDER BY offered DESC`,
    s4.params,
  );

  /*
   * ── Per-JOB grouping ──────────────────────────────────────────────────
   * "How hard was each job worked?" — how many technicians it was offered to,
   * how many offer ROUNDS that took, who did the offering, and whether it ever
   * landed. No new joins: buildScope's FROM already carries tbl_job + tbl_client.
   *
   * TWO queries, deliberately. A single query at (job × offerer) grain would be
   * truncated by ROW_CAP mid-job, so the boundary job would silently show
   * PARTIAL totals. Capping at JOB grain keeps every returned row complete; the
   * offerer breakdown is then fetched for exactly those job ids.
   *
   * MAX() on the job/client columns rather than widening GROUP BY: we group by
   * jo.job_id, and ONLY_FULL_GROUP_BY does not infer functional dependency
   * through the join (it would only do so when grouping by j's own PK). One job
   * per group, so MAX is exact, not a "pick any".
   */
  const s5 = buildScope(filters);
  const [jobRows] = await pool.query(
    `SELECT jo.job_id AS jobId,
            MAX(c.client_name) AS clientName,
            MAX(j.job_status)  AS jobStatus,
            /*
             * The JOB's assigned technician (tbl_job.fk_easyfixter_id, NOT the
             * offer's fk_easyfixter_id) — drives the BOOKED sub-label split
             * ("Pending App Ack" when a tech is assigned vs "Pending for
             * Scheduling" when not), so the report's Job Status reads the same as
             * the job modal / jobs list. One job per group, so MAX is exact.
             */
            MAX(j.fk_easyfixter_id) AS jobEfrId,
            COUNT(DISTINCT jo.fk_easyfixter_id) AS techsOffered,
            /*
             * ROUNDS = offer WAVES, i.e. how many times ops pressed "Offer" for
             * this job ("5 techs in round 1, 3 more in round 2" = 2).
             *
             * Derived as COUNT(DISTINCT offered_at) because one Offer action
             * writes every tech in the batch inside a single transaction, so a
             * wave shares one offered_at second; a re-offer sets
             * offered_at = NOW() again (job.service offerToTechnicians), which
             * is what makes later waves distinguishable at all.
             *
             * ⚠ Two honest limits of a schema that keeps ONE row per (job,tech)
             * and overwrites it:
             *   - if a wave re-offers EVERY tech from the previous wave, the
             *     earlier timestamps are gone and both waves read as one;
             *   - a very large batch straddling a second boundary can read as
             *     two.
             * Exact wave history is not recoverable without an append-only
             * offer log — this is the closest faithful measure.
             */
            COUNT(DISTINCT jo.offered_at) AS waves,
            ${STATUS_AGG},
            MIN(jo.offered_at) AS firstOfferedAt,
            MAX(jo.offered_at) AS lastOfferedAt,
            MAX(CASE WHEN jo.offer_status = ${OFFER_STATUS.ACCEPTED} THEN ef.efr_name END) AS acceptedBy,
            MIN(CASE WHEN jo.offer_status = ${OFFER_STATUS.ACCEPTED} THEN jo.responded_at END) AS acceptedAt,
            TIMESTAMPDIFF(SECOND, MIN(jo.offered_at),
              MIN(CASE WHEN jo.offer_status = ${OFFER_STATUS.ACCEPTED} THEN jo.responded_at END)
            ) AS time_to_accept_secs
       ${s5.from} ${s5.where}
      GROUP BY jo.job_id
      ORDER BY rounds DESC, offered DESC
      LIMIT ${ROW_CAP}`,
    s5.params,
  );
  if (jobRows.length >= ROW_CAP) logger.warn(`Offer Acceptance (by job) hit the ${ROW_CAP}-row cap`);

  // Offerer breakdown for exactly the jobs above → each job row carries
  // "who offered it, and how many rounds each". Skipped entirely when there
  // are no jobs (an IN () with no ids is a syntax error, not an empty set).
  let offerersByJob = new Map();
  if (jobRows.length > 0) {
    const jobIds = jobRows.map((r) => r.jobId);
    const s6 = buildScope(filters);
    const [offRows] = await pool.query(
      `SELECT jo.job_id AS jobId,
              COALESCE(jo.offered_by_user_id, 0) AS ownerId,
              COALESCE(ob.user_name, 'Unassigned') AS ownerName,
              COUNT(*) AS offers,
              SUM(COALESCE(jo.offer_count, 1)) AS rounds
         ${s6.from}
         LEFT JOIN tbl_user ob ON ob.user_id = jo.offered_by_user_id
         ${s6.where} AND jo.job_id IN (${jobIds.map(() => '?').join(',')})
        GROUP BY jo.job_id, COALESCE(jo.offered_by_user_id, 0), COALESCE(ob.user_name, 'Unassigned')
        ORDER BY rounds DESC`,
      [...s6.params, ...jobIds],
    );
    offerersByJob = offRows.reduce((m, r) => {
      const list = m.get(r.jobId) || [];
      list.push({ ownerId: n(r.ownerId), ownerName: r.ownerName || 'Unassigned', offers: n(r.offers), rounds: n(r.rounds) });
      m.set(r.jobId, list);
      return m;
    }, new Map());
  }

  const s3 = buildScope(filters);
  const [[tot]] = await pool.query(`SELECT ${STATUS_AGG} ${s3.from} ${s3.where}`, s3.params);

  // Daily outcome trend — gap-filled so EVERY day in the window has a bar (a
  // GROUP BY only returns days that had offers). Window = the filter's range or
  // the last 7 days (IST) by default.
  const days = trendDays(filters);
  const sD = buildScope({ ...filters, dateFrom: days[0], dateTo: days[days.length - 1] });
  const [dayRows] = await pool.query(
    `SELECT DATE_FORMAT(jo.offered_at, '%Y-%m-%d') AS day, ${STATUS_AGG}
       ${sD.from} ${sD.where}
      GROUP BY DATE_FORMAT(jo.offered_at, '%Y-%m-%d')`,
    sD.params,
  );
  const dayMap = new Map(dayRows.map((r) => [r.day, r]));
  const byDay = days.map((day) => {
    const r = dayMap.get(day);
    return {
      day,
      offered: n(r && r.offered), accepted: n(r && r.accepted), rejected: n(r && r.rejected),
      expired: n(r && r.expired), open: n(r && r.open_count),
    };
  });

  const rows = techRows.map((r) => ({
    efrId: r.efrId,
    efrName: r.efrName || `Efr #${r.efrId}`,
    offered: n(r.offered), rounds: n(r.rounds),
    reoffers: Math.max(0, n(r.rounds) - n(r.offered)),
    accepted: n(r.accepted), rejected: n(r.rejected),
    expired: n(r.expired), open: n(r.open_count),
    acceptanceRate: rate(n(r.accepted), n(r.rejected), n(r.expired)),
    avgResponseSecs: r.avg_response_secs == null ? null : Number(r.avg_response_secs),
  }));
  const bySource = sourceRows.map((r) => ({
    source: r.source,
    offered: n(r.offered), rounds: n(r.rounds),
    reoffers: Math.max(0, n(r.rounds) - n(r.offered)),
    accepted: n(r.accepted), rejected: n(r.rejected),
    expired: n(r.expired), open: n(r.open_count),
    acceptanceRate: rate(n(r.accepted), n(r.rejected), n(r.expired)),
  }));
  const byOwner = ownerRows.map((r) => ({
    ownerId: n(r.ownerId),
    ownerName: r.ownerName || 'Unassigned',
    offered: n(r.offered), rounds: n(r.rounds),
    reoffers: Math.max(0, n(r.rounds) - n(r.offered)),
    accepted: n(r.accepted), rejected: n(r.rejected),
    expired: n(r.expired), open: n(r.open_count),
    acceptanceRate: rate(n(r.accepted), n(r.rejected), n(r.expired)),
  }));
  const byJob = jobRows.map((r) => ({
    jobId: n(r.jobId),
    clientName: r.clientName || null,
    jobStatus: r.jobStatus == null ? null : n(r.jobStatus),
    // Whether the JOB has a technician assigned — the FE labels status 0 by this
    // (Pending App Ack vs Pending for Scheduling), matching the job modal.
    assigned: r.jobEfrId != null,
    techsOffered: n(r.techsOffered),
    // waves = "Rounds" on screen. `rounds` (SUM offer_count) is kept as the
    // raw offer-action total; `reoffers` is the part of it that was a REPEAT
    // offer to a tech who already had one — the two are different questions
    // and are labelled differently in the UI.
    waves: n(r.waves),
    reoffers: Math.max(0, n(r.rounds) - n(r.offered)),
    offered: n(r.offered), rounds: n(r.rounds), accepted: n(r.accepted), rejected: n(r.rejected),
    expired: n(r.expired), open: n(r.open_count),
    acceptanceRate: rate(n(r.accepted), n(r.rejected), n(r.expired)),
    acceptedBy: r.acceptedBy || null,
    firstOfferedAt: r.firstOfferedAt || null,
    lastOfferedAt: r.lastOfferedAt || null,
    acceptedAt: r.acceptedAt || null,
    timeToAcceptSecs: r.time_to_accept_secs == null ? null : Number(r.time_to_accept_secs),
    offerers: offerersByJob.get(r.jobId) || [],
  }));
  const totals = {
    offered: n(tot && tot.offered), rounds: n(tot && tot.rounds),
    reoffers: Math.max(0, n(tot && tot.rounds) - n(tot && tot.offered)),
    accepted: n(tot && tot.accepted), rejected: n(tot && tot.rejected),
    expired: n(tot && tot.expired), open: n(tot && tot.open_count),
    acceptanceRate: rate(n(tot && tot.accepted), n(tot && tot.rejected), n(tot && tot.expired)),
    avgResponseSecs: tot && tot.avg_response_secs != null ? Number(tot.avg_response_secs) : null,
  };

  logger.info('Returning ' + rows.length + ' technician rows · ' + bySource.length + ' sources · ' + byOwner.length + ' offerers · ' + byJob.length + ' jobs · ' + byDay.length + ' trend days');
  return { rows, bySource, byOwner, byJob, byDay, totals };
}

/*
 * getOfferDetails(filters, selection) — the individual offers behind ONE number
 * in the report, for the count drill-downs on every tab.
 *
 * ⚠ It reuses buildScope, so the detail list carries the EXACT SAME filters as
 * the summary that produced the number. That is the whole point: a drill-down
 * that ignored the report's date/client/source window could show 3 rows under a
 * count of 1, and the operator would rightly stop trusting the report. (This is
 * also why the job-tab drill-down does NOT use /admin/jobs/:id/offers — that
 * endpoint answers "every offer on this job, ever", a different question.)
 *
 * `selection` narrows to the clicked cell:
 *   jobId        — Job tab row
 *   efrId        — Technician tab row
 *   offeredById  — Offerer tab row (0 = the "Unassigned" bucket = NULL offerer)
 *   status       — which count was clicked ('accepted' | 'rejected' | 'expired'
 *                  | 'open'); omitted = the row's whole offer set.
 */
const DETAIL_CAP = 500;
const DETAIL_STATUS = {
  open: OFFER_STATUS.OFFERED,
  accepted: OFFER_STATUS.ACCEPTED,
  rejected: OFFER_STATUS.REJECTED,
  expired: OFFER_STATUS.EXPIRED,
};

async function getOfferDetails(filters = {}, selection = {}) {
  const s = buildScope(filters);
  let where = s.where;
  const params = [...s.params];

  if (selection.jobId != null) { where += ' AND jo.job_id = ?'; params.push(Number(selection.jobId)); }
  if (selection.efrId != null) { where += ' AND jo.fk_easyfixter_id = ?'; params.push(Number(selection.efrId)); }
  if (selection.offeredById != null) {
    // ownerId 0 is the synthetic "Unassigned" bucket the byOwner grouping uses
    // for NULL offered_by (system/auto or pre-migration offers) — it must map
    // back to IS NULL, not to user_id = 0.
    if (Number(selection.offeredById) === 0) where += ' AND jo.offered_by_user_id IS NULL';
    else { where += ' AND jo.offered_by_user_id = ?'; params.push(Number(selection.offeredById)); }
  }
  const st = DETAIL_STATUS[selection.status];
  if (st !== undefined) { where += ' AND jo.offer_status = ?'; params.push(st); }

  const [rows] = await pool.query(
    `SELECT jo.job_id AS jobId, c.client_name AS clientName,
            j.job_status AS jobStatus,
            j.fk_easyfixter_id AS jobEfrId,
            jo.fk_easyfixter_id AS efrId, ef.efr_name AS efrName,
            COALESCE(ob.user_name, 'Unassigned') AS offererName,
            jo.offer_status AS offerStatus,
            jo.offered_at AS offeredAt, jo.responded_at AS respondedAt,
            COALESCE(jo.offer_count, 1) AS offerCount,
            /*
             * Per-offer response time. Restricted to ACCEPTED / REJECTED for the
             * same reason STATUS_AGG's avg is: an EXPIRED offer also stamps
             * responded_at — the expiry sweep sets it to NOW() — so including
             * those would report "offer age at expiry" (~the 30-min TTL, or
             * hours if the cron lagged) as if the technician had answered. NULL
             * on expired/open rows renders as '—', which is the honest value.
             * offered_at is the LAST offer, so on a re-offered row this is the
             * response to that latest offer — which is the one that mattered.
             */
            CASE WHEN jo.offer_status IN (${OFFER_STATUS.ACCEPTED}, ${OFFER_STATUS.REJECTED})
                      AND jo.responded_at IS NOT NULL
                 THEN TIMESTAMPDIFF(SECOND, jo.offered_at, jo.responded_at) END AS responseSecs,
            jo.offer_source AS source, jo.reject_reason AS rejectReason
       ${s.from}
       LEFT JOIN tbl_user ob ON ob.user_id = jo.offered_by_user_id
       ${where}
      ORDER BY jo.offered_at DESC, jo.job_id DESC
      LIMIT ${DETAIL_CAP}`,
    params,
  );
  const capped = rows.length >= DETAIL_CAP;
  if (capped) logger.warn(`Offer Acceptance drill-down hit the ${DETAIL_CAP}-row cap`);
  logger.info('Returning ' + rows.length + ' offer detail rows' + (capped ? ' (capped)' : ''));
  return {
    items: rows.map((r) => ({
      jobId: n(r.jobId),
      clientName: r.clientName || null,
      // Where the JOB is now — lets a drill-down row be triaged in place
      // instead of bouncing back to the report or the CRM to look it up.
      jobStatus: r.jobStatus == null ? null : n(r.jobStatus),
      // Job-level tech presence — same BOOKED sub-label split as the modal.
      assigned: r.jobEfrId != null,
      efrId: n(r.efrId),
      efrName: r.efrName || null,
      offererName: r.offererName || 'Unassigned',
      offerStatus: n(r.offerStatus),
      offeredAt: r.offeredAt || null,
      respondedAt: r.respondedAt || null,
      offerCount: n(r.offerCount),
      responseSecs: r.responseSecs == null ? null : Number(r.responseSecs),
      source: r.source || null,
      rejectReason: (r.rejectReason && String(r.rejectReason).trim()) || null,
    })),
    capped,
  };
}

/*
 * CRM-facing job-status label for the XLSX Job sheet.
 *
 * ⚠ Do NOT swap this for services/integration.service.js's statusLabel(). That
 * map is FROZEN to the legacy Dropwizard contract external clients depend on,
 * where 0 = 'Unconfirmed' and 9 = 'Call Later'. In the CRM's own vocabulary
 * 0 = 'Booked' and 9 = 'Unconfirmed' — reusing it would label the export
 * differently from the chip the operator just looked at, on the very statuses
 * they care about most.
 *
 * Mirrors the FE's statusLabel (src/lib/utils.ts) EXACTLY, including the BOOKED
 * sub-split by tech presence: status 0 + a tech assigned → "Pending App Ack",
 * status 0 + no tech → "Pending for Scheduling", and plain "Booked" only when
 * assignment is unknown. Reproducing the split is what keeps the export cell
 * equal to the on-screen chip and the job modal header (the mismatch this fixes:
 * the report said "Booked" while the modal said "Pending App Ack" for the same
 * assigned-but-unacknowledged job). `assigned` now flows in from the query
 * (MAX(j.fk_easyfixter_id)); before, this report had no fk_easyfixter_id in scope.
 */
const JOB_STATUS_MAP = {
  0: 'Booked', 1: 'Scheduled', 2: 'In Progress', 3: 'Completed', 5: 'Completed',
  6: 'Cancelled', 7: 'Enquiry', 9: 'Unconfirmed', 10: 'Closed from App',
  15: 'Estimate Pending', 20: 'In Progress', 21: 'On Hold',
};
function jobStatusLabel(code, assigned) {
  if (code == null) return '';
  if (code === 0 && (assigned === true || assigned === false)) {
    return assigned ? 'Pending App Ack' : 'Pending for Scheduling';
  }
  return JOB_STATUS_MAP[code] || `Status ${code}`;
}

/*
 * XLSX payload — THREE sheets mirroring the on-screen tabs (Technician /
 * Offerer / Job) rather than the single technician sheet this used to emit.
 * One download now carries every grain, so nothing the operator can see in the
 * report is missing from the file. The route walks `sheets` and hands each to
 * buildStyledWorkbook with a shared workbook.
 */
function toXlsx(data) {
  // XLSX keeps a numeric (decimal minutes) so Excel can sort/aggregate — the
  // on-screen KPI/table render mm:ss from the same seconds value.
  const mins = (secs) => (secs == null ? 0 : Math.round((secs / 60) * 10) / 10);
  const OUTCOME_COLS = [
    { key: 'offered', header: 'Offered', width: 12 },
    { key: 'reoffers', header: 'Re-Offers', width: 12 },
    { key: 'accepted', header: 'Accepted', width: 12 },
    { key: 'rejected', header: 'Rejected', width: 12 },
    { key: 'expired', header: 'Expired', width: 12 },
    { key: 'open', header: 'Open', width: 10 },
    { key: 'acceptanceRate', header: 'Acceptance %', width: 14 },
  ];

  return {
    sheets: [
      {
        name: 'Technician',
        columns: [
          { key: 'efrName', header: 'Technician', width: 26 },
          { key: 'efrId', header: 'Efr Id', width: 10 },
          ...OUTCOME_COLS,
          { key: 'avgResponseMins', header: 'Avg Response (Min)', width: 18 },
        ],
        rows: data.rows.map((r) => ({ ...r, avgResponseMins: mins(r.avgResponseSecs) })),
      },
      {
        name: 'Offerer',
        columns: [
          { key: 'ownerName', header: 'Offerer', width: 26 },
          ...OUTCOME_COLS,
        ],
        rows: data.byOwner,
      },
      {
        name: 'Job',
        columns: [
          { key: 'jobId', header: 'Job #', width: 12 },
          { key: 'clientName', header: 'Client', width: 26 },
          { key: 'jobStatusLabel', header: 'Job Status', width: 18 },
          { key: 'techsOffered', header: 'Techs Offered', width: 14 },
          { key: 'waves', header: 'Rounds', width: 10 },
          { key: 'reoffers', header: 'Re-Offers', width: 12 },
          { key: 'accepted', header: 'Accepted', width: 12 },
          { key: 'rejected', header: 'Rejected', width: 12 },
          { key: 'expired', header: 'Expired', width: 12 },
          { key: 'open', header: 'Open', width: 10 },
          { key: 'offerersLabel', header: 'Offerers', width: 34 },
          { key: 'acceptedBy', header: 'Accepted By (Tech)', width: 24 },
          { key: 'firstOfferedAt', header: 'First Offered', width: 20 },
          { key: 'timeToAcceptMins', header: 'Time To Fill (Min)', width: 20 },
        ],
        rows: data.byJob.map((j) => ({
          ...j,
          // Same label the on-screen chip shows — an exported row has to be
          // triageable without going back to the CRM to look up a code. Passes
          // `assigned` so the BOOKED sub-split matches the chip and modal.
          jobStatusLabel: jobStatusLabel(j.jobStatus, j.assigned),
          // Flatten the offerer array for a spreadsheet cell — same text the
          // Offerers column shows on screen.
          offerersLabel: (j.offerers || []).map((o) => `${o.ownerName} (${o.rounds})`).join(', '),
          timeToAcceptMins: mins(j.timeToAcceptSecs),
        })),
      },
    ],
  };
}

module.exports = { getOfferAcceptance, getOfferDetails, toXlsx };
