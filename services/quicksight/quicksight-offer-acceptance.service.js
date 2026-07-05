/*
 * QuickSight — Offer Acceptance service.
 *
 * Measures how the job-offer pool performs: per technician, how many offers
 * they were extended and how many they accepted / rejected / let expire, plus
 * acceptance rate and average response time. Sourced entirely from
 * tbl_job_offer (offer_status / offer_source / offered_at / responded_at),
 * scoped by the standard QuickSight job filters + an optional offered_at window
 * and offer_source. Returns { rows (per tech), bySource, totals } so the CRM
 * page can render KPI tiles + a table + a by-source chart from one call.
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
  if (filters.source) { where += ' AND jo.offer_source = ?'; params.push(filters.source); }
  if (filters.dateFrom) { where += ' AND jo.offered_at >= ?'; params.push(filters.dateFrom + ' 00:00:00'); }
  // Inclusive upper bound — cover the whole dateTo day (legacy DATE_ADD idiom).
  if (filters.dateTo) { where += ' AND jo.offered_at < DATE_ADD(?, INTERVAL 1 DAY)'; params.push(filters.dateTo); }
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
    offered: n(r.offered), accepted: n(r.accepted), rejected: n(r.rejected),
    expired: n(r.expired), open: n(r.open_count),
    acceptanceRate: rate(n(r.accepted), n(r.rejected), n(r.expired)),
    avgResponseSecs: r.avg_response_secs == null ? null : Number(r.avg_response_secs),
  }));
  const bySource = sourceRows.map((r) => ({
    source: r.source,
    offered: n(r.offered), accepted: n(r.accepted), rejected: n(r.rejected),
    expired: n(r.expired), open: n(r.open_count),
    acceptanceRate: rate(n(r.accepted), n(r.rejected), n(r.expired)),
  }));
  const totals = {
    offered: n(tot && tot.offered), accepted: n(tot && tot.accepted), rejected: n(tot && tot.rejected),
    expired: n(tot && tot.expired), open: n(tot && tot.open_count),
    acceptanceRate: rate(n(tot && tot.accepted), n(tot && tot.rejected), n(tot && tot.expired)),
    avgResponseSecs: tot && tot.avg_response_secs != null ? Number(tot.avg_response_secs) : null,
  };

  logger.info('Returning ' + rows.length + ' technician rows · ' + bySource.length + ' sources · ' + byDay.length + ' trend days');
  return { rows, bySource, byDay, totals };
}

// Flat per-technician rows for the XLSX download.
function toXlsx(data) {
  const columns = [
    { key: 'efrName', header: 'Technician', width: 26 },
    { key: 'efrId', header: 'Efr Id', width: 10 },
    { key: 'offered', header: 'Offered', width: 12 },
    { key: 'accepted', header: 'Accepted', width: 12 },
    { key: 'rejected', header: 'Rejected', width: 12 },
    { key: 'expired', header: 'Expired', width: 12 },
    { key: 'open', header: 'Open', width: 10 },
    { key: 'acceptanceRate', header: 'Acceptance %', width: 14 },
    { key: 'avgResponseMins', header: 'Avg Response (Min)', width: 18 },
  ];
  // XLSX keeps a numeric (decimal minutes) so Excel can sort/aggregate — the
  // on-screen KPI/table render mm:ss from the same seconds value.
  const rows = data.rows.map((r) => ({
    ...r,
    avgResponseMins: r.avgResponseSecs == null ? 0 : Math.round((r.avgResponseSecs / 60) * 10) / 10,
  }));
  return { columns, rows };
}

module.exports = { getOfferAcceptance, toXlsx };
