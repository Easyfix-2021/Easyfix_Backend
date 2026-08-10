/*
 * QuickSight report — Premature Confirmations.
 *
 * THE PROBLEM: a job sits in Unconfirmed until the customer either submits the
 * job-completion magic-link form or is reached by phone. When neither happens,
 * the correct action is to HOLD it in Unconfirmed via the Unreachable flow.
 * Some confirmation-team members instead push it straight to Pending for
 * Scheduling — so a technician gets scheduled against an appointment the
 * customer never agreed to, which shows up later as a failed visit.
 *
 * This report surfaces exactly those moves, with enough evidence attached to
 * check each one rather than take the flag on trust.
 *
 * ─── WHAT COUNTS AS SUSPICIOUS ───────────────────────────────────────
 * A job now in Pending for Scheduling where BOTH hold:
 *   1. the customer never submitted the form (customer_submitted_at IS NULL),
 *      OR the job carries an Unreachable outcome; AND
 *   2. the call evidence is weak — no calls at all, or every call under
 *      SHORT_CALL_SECS (a 6-second call is a ring-out, not a confirmation).
 * Both arms are required: a job with no form submission but a genuine 4-minute
 * conversation was confirmed properly and must not be flagged.
 *
 * ─── ATTRIBUTION: read this before trusting the "Moved By" column ────
 * There is NO status-transition audit table. setStatus() records who cancelled
 * (cancel_by) but writes nothing for the BOOKED transition, so "who confirmed
 * this job" is not directly stored.
 *
 * What IS reliable for THIS population: setStatus() stamps `fk_created_by` on
 * the BOOKED transition *when the row has none yet*, and Unconfirmed jobs come
 * from bulk upload / client integrations, which create rows with no user. So for
 * the jobs this report is about, fk_created_by IS the confirming operator.
 *
 * The gap is honest and bounded: a job that already had a creator (booked by an
 * operator via Book New Call, then later confirmed by someone else) keeps the
 * ORIGINAL creator's name. Those are rare in the Unconfirmed bucket, and the row
 * still reports the suspicious pattern — only the name may be the wrong person.
 * `moved_by_confidence` flags which is which so the report never quietly
 * misattributes: 'confirmed' when the job began with no creator, 'creator' when
 * the name is the original creator and may not be who confirmed it.
 */

const { pool } = require('../../db');
const logger = require('../../logger');

// A call shorter than this cannot have been a confirmation conversation.
// Env-tunable because the right threshold is an ops judgement, not a constant.
const SHORT_CALL_SECS = Number(process.env.QS_PREMATURE_SHORT_CALL_SECS) || 10;

// comment_on = 16 is the Unreachable / call_later outcome written by the
// Confirm & Schedule popup (services/job-comment.service.js STAGES).
const UNREACHABLE_COMMENT_ON = 16;

/*
 * Rows for the report.
 *
 * Filters mirror the other QuickSight services (client / vertical / city /
 * date range) so the shared filter UI works unchanged.
 */
async function getPrematureConfirmations(filters = {}) {
  const {
    clientId, verticalId, serviceCategoryId, cityId,
    dateFrom, dateTo, movedById, limit = 500,
  } = filters;

  const where = [
    // Pending for Scheduling = BOOKED (0) with nobody assigned yet.
    'j.job_status = 0',
    'j.fk_easyfixter_id IS NULL',
  ];
  const params = [];

  if (dateFrom) { where.push('DATE(j.last_update_time) >= ?'); params.push(dateFrom); }
  if (dateTo)   { where.push('DATE(j.last_update_time) <= ?'); params.push(dateTo); }
  if (Array.isArray(clientId) && clientId.length) {
    where.push(`j.fk_client_id IN (${clientId.map(() => '?').join(',')})`); params.push(...clientId);
  }
  if (Array.isArray(verticalId) && verticalId.length) {
    where.push(`cl.vertical_id IN (${verticalId.map(() => '?').join(',')})`); params.push(...verticalId);
  }
  if (Array.isArray(serviceCategoryId) && serviceCategoryId.length) {
    where.push(`j.fk_service_catg_id IN (${serviceCategoryId.map(() => '?').join(',')})`); params.push(...serviceCategoryId);
  }
  if (Array.isArray(cityId) && cityId.length) {
    where.push(`ad.city_id IN (${cityId.map(() => '?').join(',')})`); params.push(...cityId);
  }
  if (Array.isArray(movedById) && movedById.length) {
    where.push(`j.fk_created_by IN (${movedById.map(() => '?').join(',')})`); params.push(...movedById);
  }

  /*
   * Call evidence is aggregated in a derived table rather than joined row-wise:
   * a job with 12 call rows would otherwise multiply the job row 12 times and
   * every count in the report would be wrong.
   *
   * `short_calls` counts calls that CONNECTED but were too brief (duration > 0
   * AND < threshold) — those are the ones worth listening to. A duration of 0 is
   * an unanswered ring, which is evidence of NOT reaching the customer, not of a
   * suspiciously short conversation.
   */
  const sql = `
    SELECT
      j.job_id,
      j.job_reference_id,
      j.client_ref_id,
      j.created_date_time,
      j.requested_date_time,
      j.last_update_time                       AS moved_at,
      j.customer_submitted_at,
      j.time_slot,
      cl.client_name,
      ci.city_name,
      /*
       * Every row of this report IS a job, and the "Customer" column identifies
       * the customer ON THAT JOB — so it reads the booked name
       * (tbl_job.job_customer_name) with the customer-master name as fallback,
       * exactly like the jobs list and the job modal. Reviewers cross-check
       * these rows against the job screen; two different names for one job id
       * would make the report untrustworthy.
       *
       * NULLIF(TRIM(...), '') is required, not cosmetic: MySQL's COALESCE skips
       * NULL only, so a plain COALESCE(j.job_customer_name, cu.customer_name)
       * renders BLANK for any job whose booked name is an empty string — and ''
       * is an accepted value on both the create and update validators. Shared
       * definition: services/job.service.js JOB_CUSTOMER_NAME_EXPR (not imported
       * here — the QuickSight services deliberately keep their SQL literal and
       * self-contained).
       *
       * Alias stays customer_name: the FE table, the customer_name XLSX column
       * below, and the owner-filter shaping all read that key.
       */
      COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name) AS customer_name,
      cu.customer_mob_no,
      j.fk_created_by                          AS moved_by_id,
      cr.user_name                             AS moved_by,
      -- 'confirmed' = the row began with no creator, so the BOOKED stamp IS the
      -- confirming operator. 'creator' = the name predates the confirmation and
      -- may not be who moved it. See the attribution note in the header.
      CASE WHEN j.job_owner IS NULL OR j.job_owner = j.fk_created_by
           THEN 'confirmed' ELSE 'creator' END AS moved_by_confidence,
      COALESCE(c.call_count, 0)                AS call_count,
      COALESCE(c.max_duration, 0)              AS max_duration,
      COALESCE(c.short_calls, 0)               AS short_calls,
      c.short_call_ids,
      u.unreachable_at
    FROM tbl_job j
    LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
    LEFT JOIN tbl_address  ad ON ad.address_id  = j.fk_address_id
    LEFT JOIN tbl_city     ci ON ci.city_id     = ad.city_id
    LEFT JOIN tbl_client   cl ON cl.client_id   = j.fk_client_id
    LEFT JOIN tbl_user     cr ON cr.user_id     = j.fk_created_by
    LEFT JOIN (
      SELECT job_id,
             COUNT(*)                                                  AS call_count,
             MAX(COALESCE(duration, 0))                                AS max_duration,
             SUM(COALESCE(duration, 0) > 0 AND COALESCE(duration, 0) < ?) AS short_calls,
             -- Ids of the brief-but-connected calls, so the report can offer
             -- playback for exactly the rows worth checking.
             GROUP_CONCAT(CASE WHEN COALESCE(duration, 0) > 0
                                AND COALESCE(duration, 0) < ?
                               THEN job_caller_info END
                          ORDER BY inserted_time DESC)                 AS short_call_ids
        FROM tbl_job_caller_info
       GROUP BY job_id
    ) c ON c.job_id = j.job_id
    LEFT JOIN (
      SELECT job_id, MAX(created_on) AS unreachable_at
        FROM tbl_job_comment
       WHERE comment_on = ?
       GROUP BY job_id
    ) u ON u.job_id = j.job_id
    WHERE ${where.join(' AND ')}
      -- Arm 1: the customer never confirmed for themselves.
      AND (j.customer_submitted_at IS NULL OR u.unreachable_at IS NOT NULL)
      -- Arm 2: and the phone evidence is weak.
      AND (COALESCE(c.call_count, 0) = 0 OR COALESCE(c.max_duration, 0) < ?)
    ORDER BY j.last_update_time DESC
    LIMIT ?`;

  const [rows] = await pool.query(sql, [
    SHORT_CALL_SECS, SHORT_CALL_SECS, UNREACHABLE_COMMENT_ON,
    ...params, SHORT_CALL_SECS, Number(limit),
  ]);

  const shaped = rows.map((r) => ({
    ...r,
    short_call_ids: r.short_call_ids
      ? String(r.short_call_ids).split(',').map(Number).filter(Boolean)
      : [],
    // Why this row was flagged — spelled out so the reviewer isn't guessing.
    flags: [
      r.customer_submitted_at ? null : 'Form not submitted',
      r.unreachable_at ? 'Marked Unreachable' : null,
      Number(r.call_count) === 0 ? 'No calls' : null,
      Number(r.call_count) > 0 && Number(r.max_duration) < SHORT_CALL_SECS
        ? `All calls under ${SHORT_CALL_SECS}s` : null,
    ].filter(Boolean),
  }));

  const byUser = new Map();
  for (const r of shaped) {
    const key = r.moved_by_id || 0;
    if (!byUser.has(key)) {
      byUser.set(key, { moved_by_id: r.moved_by_id, moved_by: r.moved_by || 'Unknown', jobs: 0 });
    }
    byUser.get(key).jobs += 1;
  }

  const totals = {
    jobs: shaped.length,
    noCalls: shaped.filter((r) => Number(r.call_count) === 0).length,
    shortCallsOnly: shaped.filter((r) => Number(r.call_count) > 0).length,
    notSubmitted: shaped.filter((r) => !r.customer_submitted_at).length,
    unreachable: shaped.filter((r) => r.unreachable_at).length,
    shortCallThresholdSecs: SHORT_CALL_SECS,
  };

  logger.info(
    'Premature-confirmations report · rows=' + shaped.length
    + ' · noCalls=' + totals.noCalls + ' · operators=' + byUser.size,
  );

  return {
    rows: shaped,
    byUser: [...byUser.values()].sort((a, b) => b.jobs - a.jobs),
    totals,
  };
}

/* XLSX projection — flags flattened, ids dropped (not meaningful in a sheet). */
function toXlsx(data) {
  const columns = [
    { key: 'job_id', header: 'Job ID' },
    { key: 'job_reference_id', header: 'Reference' },
    { key: 'client_name', header: 'Client' },
    { key: 'city_name', header: 'City' },
    { key: 'customer_name', header: 'Customer' },
    { key: 'moved_by', header: 'Moved By' },
    { key: 'moved_by_confidence', header: 'Attribution' },
    { key: 'moved_at', header: 'Moved On' },
    { key: 'customer_submitted_at', header: 'Form Submitted' },
    { key: 'unreachable_at', header: 'Marked Unreachable' },
    { key: 'call_count', header: 'Calls' },
    { key: 'max_duration', header: 'Longest Call (s)' },
    { key: 'flagText', header: 'Why Flagged' },
  ];
  const rows = data.rows.map((r) => ({
    ...r,
    customer_submitted_at: r.customer_submitted_at || 'Not submitted',
    unreachable_at: r.unreachable_at || '—',
    flagText: r.flags.join(' · '),
  }));
  return { columns, rows };
}

module.exports = { getPrematureConfirmations, toXlsx, SHORT_CALL_SECS };
