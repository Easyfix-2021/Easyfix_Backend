/*
 * QuickSight — Profile Update Requests service.
 *
 * Tracks the easyfixer profile-update magic-link flow: per technician who was
 * sent a link, whether they SUBMITTED it, plus send-count / last-action /
 * days-to-submit. Source = tbl_easyfixer send-audit columns
 * (profile_update_sent_at / _send_count / _last_action).
 *
 * ⚠️ There is NO explicit "submitted" timestamp in the schema — a submission
 * commits directly with no status. But submitting deep skills AND serviceable
 * pincodes is MANDATORY in the link, and replaceServiceablePincodes stamps the
 * writer's id (a technician self-submit via the public link passes actor=null →
 * created_by/updated_by = efr_id; a CRM operator edit stamps their user_id). So
 * we INFER "submitted" from tbl_efr_serviceable_pincodes.
 *
 * ⚠️ The INSERT is `ON DUPLICATE KEY UPDATE … updated_by = VALUES(updated_by)`
 * with PK = easyfixer_id, so there's ONE row per tech and only `updated_by`
 * changes on a later write — `created_by` is the FIRST writer (often a CRM
 * operator who set it up), `updated_by` is the LAST. So the reliable signal is
 * **updated_by = efr_id AND updated_date >= profile_update_sent_at** (the tech
 * was the last to write it, after the link was sent). submittedAt = updated_date.
 *   Limitation: a CRM edit AFTER a tech submission overwrites updated_by and
 *   hides it — acceptable (submission is normally the last action).
 *
 * Returns { rows, byStatus, byDay, totals } for KPI tiles + table + trend.
 */

const { pool } = require('../../db');
const logger = require('../../logger');
const { buildInFilter } = require('./_shared');

const ROW_CAP = 5000;
const EXPIRY_DAYS = 30; // link TTL — an un-submitted request past this is "Expired".
const DAY_MS = 86400000;

// The technician's own last write to serviceable_pincodes at/after the send —
// our inferred "submitted at". PK is easyfixer_id (one row/tech) so no MIN.
const SUBMITTED_AT_SQL = `(
  SELECT sp.updated_date FROM tbl_efr_serviceable_pincodes sp
   WHERE sp.easyfixer_id = e.efr_id
     AND sp.updated_by = e.efr_id
     AND sp.updated_date >= e.profile_update_sent_at
   LIMIT 1)`;

// Shared FROM + WHERE + params. The report is technician-centric so the only
// job-style filter that maps is zonalManager (a city's owner via efr_cityId →
// tbl_city.state_user). Base set = techs who were actually SENT a link.
function buildScope(filters) {
  const params = [];
  let where = ' WHERE NOT (e.efr_status <=> 3) AND e.profile_update_sent_at IS NOT NULL';
  where += buildInFilter('cy.state_user', filters.zonalManagerId, params);
  if (filters.lastAction) { where += ' AND e.profile_update_last_action = ?'; params.push(filters.lastAction); }
  if (filters.dateFrom) { where += ' AND e.profile_update_sent_at >= ?'; params.push(filters.dateFrom + ' 00:00:00'); }
  if (filters.dateTo)   { where += ' AND e.profile_update_sent_at < DATE_ADD(?, INTERVAL 1 DAY)'; params.push(filters.dateTo); }
  const from = `
      FROM tbl_easyfixer e
      LEFT JOIN tbl_city cy ON cy.city_id = e.efr_cityId`;
  return { from, where, params };
}

function dayKey(dt) {
  if (!dt) return null;
  const d = new Date(dt);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function getProfileUpdateRequests(filters = {}) {
  logger.info('Building Profile Update Requests report');
  const s = buildScope(filters);
  const [raw] = await pool.query(
    `SELECT e.efr_id AS efrId, e.efr_name AS efrName, e.efr_no AS efrMobile,
            cy.city_name AS cityName,
            e.profile_update_sent_at AS sentAt,
            COALESCE(e.profile_update_send_count, 0) AS sendCount,
            e.profile_update_last_action AS lastAction,
            ${SUBMITTED_AT_SQL} AS submittedAt
       ${s.from} ${s.where}
      ORDER BY e.profile_update_sent_at DESC
      LIMIT ${ROW_CAP}`,
    s.params,
  );
  if (raw.length >= ROW_CAP) logger.warn(`Profile Update Requests hit the ${ROW_CAP}-row cap`);

  const now = Date.now();
  let rows = raw.map((r) => {
    const submitted = r.submittedAt != null;
    const sentMs = r.sentAt ? new Date(r.sentAt).getTime() : null;
    const daysToSubmit = submitted && sentMs != null
      ? Math.max(0, Math.floor((new Date(r.submittedAt).getTime() - sentMs) / DAY_MS))
      : null;
    const status = submitted
      ? 'Submitted'
      : (sentMs != null && (now - sentMs) > EXPIRY_DAYS * DAY_MS ? 'Expired' : 'Pending');
    return {
      efrId: r.efrId,
      efrName: r.efrName || `Efr #${r.efrId}`,
      efrMobile: r.efrMobile || null,
      cityName: r.cityName || null,
      sentAt: r.sentAt || null,
      sendCount: Number(r.sendCount) || 0,
      lastAction: r.lastAction || null,
      submitted,
      submittedAt: r.submittedAt || null,
      daysToSubmit,
      status,
    };
  });

  // Optional status filter, applied post-derivation.
  if (filters.submittedStatus && filters.submittedStatus !== 'all') {
    const want = String(filters.submittedStatus).toLowerCase();
    rows = rows.filter((r) => r.status.toLowerCase() === want);
  }

  const byStatus = { submitted: 0, pending: 0, expired: 0 };
  const dayMap = new Map();
  let totalDays = 0; let submittedWithDays = 0; let totalSends = 0;
  for (const r of rows) {
    byStatus[r.status.toLowerCase()] = (byStatus[r.status.toLowerCase()] || 0) + 1;
    totalSends += r.sendCount;
    if (r.submitted && r.daysToSubmit != null) { totalDays += r.daysToSubmit; submittedWithDays += 1; }
    const k = dayKey(r.sentAt);
    if (k) {
      const d = dayMap.get(k) || { day: k, sent: 0, submitted: 0 };
      d.sent += 1;
      if (r.submitted) d.submitted += 1;
      dayMap.set(k, d);
    }
  }
  const byDay = Array.from(dayMap.values()).sort((a, b) => a.day.localeCompare(b.day));

  const total = rows.length;
  const totals = {
    requests: total,                        // techs with a sent link (in scope)
    submitted: byStatus.submitted,
    pending: byStatus.pending,
    expired: byStatus.expired,
    totalSends,
    submissionRate: total > 0 ? Math.round((byStatus.submitted / total) * 100) : 0,
    avgDaysToSubmit: submittedWithDays > 0 ? Math.round((totalDays / submittedWithDays) * 10) / 10 : null,
  };

  logger.info('Returning ' + rows.length + ' profile-update rows · submitted=' + byStatus.submitted);
  return { rows, byStatus, byDay, totals };
}

function toXlsx(data) {
  const columns = [
    { key: 'efrName', header: 'Technician', width: 26 },
    { key: 'efrId', header: 'Efr Id', width: 10 },
    { key: 'efrMobile', header: 'Mobile', width: 16 },
    { key: 'cityName', header: 'City', width: 18 },
    { key: 'sentAtStr', header: 'Link Sent At', width: 20 },
    { key: 'sendCount', header: 'Send Count', width: 12 },
    { key: 'lastAction', header: 'Last Action', width: 14 },
    { key: 'statusStr', header: 'Status', width: 12 },
    { key: 'submittedAtStr', header: 'Submitted At', width: 20 },
    { key: 'daysToSubmit', header: 'Days To Submit', width: 14 },
  ];
  const fmtDt = (dt) => (dt ? String(dt).replace('T', ' ').replace('Z', '').slice(0, 16) : '');
  const rows = data.rows.map((r) => ({
    ...r,
    sentAtStr: fmtDt(r.sentAt),
    submittedAtStr: fmtDt(r.submittedAt),
    statusStr: r.status,
    daysToSubmit: r.daysToSubmit == null ? '' : r.daysToSubmit,
  }));
  return { columns, rows };
}

module.exports = { getProfileUpdateRequests, toXlsx };
