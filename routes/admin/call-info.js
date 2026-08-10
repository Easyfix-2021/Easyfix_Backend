const router = require('express').Router();
const { pool } = require('../../db');
const logger = require('../../logger');
const { modernOk, modernError } = require('../../utils/response');
const { jobStatusLabel } = require('../../utils/job-status-label');

/*
 * Call Info — date-ranged easyfixer-call-record feed for the
 * Dashboard / Manage Jobs header button.
 *
 * Source table: `tbl_easyfixer_call_record` (verified to have data
 * by ops 2026-05-14 via SELECT * … ORDER BY insert_date_time DESC).
 * Previously this endpoint queried tbl_exotel_call_log which sits
 * empty in production behind the EXOTEL_ENABLED feature flag — so
 * the UI rendered "no calls" even when the easyfixer-call-record
 * table had rows.
 *
 * Columns we read from tbl_easyfixer_call_record (verified via
 * legacy stored proc `sp_ef_jobs_easyfixer_call_record_by_jobId`
 * which exposes these fields):
 *   efr_id            — FK → tbl_easyfixer (technician called)
 *   job_id            — FK → tbl_job (which job the call was for)
 *   insert_date_time  — when the call record was stamped
 *
 * Joined-in display fields:
 *   tbl_easyfixer  → efr_name, efr_no (mobile)
 *   tbl_job        → job_status, job_type, job_customer_name
 *   tbl_customer   → customer_mob_no
 *
 * customer_name (2026-08-03): this feed is JOB-scoped — every row is a
 * call ABOUT a job — so the displayed name is the name typed on the
 * booking page (tbl_job.job_customer_name), falling back to the
 * customer-master name only when the job carries none. The alias stays
 * `customer_name` so the FE (CallInfoModal) needs no change.
 *
 *   COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name)
 *
 * The NULLIF(TRIM(…), '') wrapper is NOT optional. COALESCE only treats
 * NULL as absent, so a plain COALESCE(j.job_customer_name, …) renders a
 * BLANK name for any job whose job_customer_name is '' or whitespace —
 * and '' is reachable: validators/job.validator.js allows '' for that
 * field and services/job.service.js writes it through `??` (null-guard
 * only). NULLIF+TRIM makes blank behave like missing.
 *
 * Legacy contract preserved: fromDate / toDate / optional callTo
 * filter. callTo now matches against efr_no (technician mobile) OR
 * tbl_customer.customer_mob_no.
 *
 * ── CONFERENCE CALLS: THIS FEED IS UNAFFECTED (verified 2026-08-04) ────────
 *
 * The 2026-08-04 ops conference feature made tbl_job_caller_info 1:N against
 * tbl_plivo_call_log, which fanned out every surface built on that join. This
 * one is not: it reads tbl_easyfixer_call_record and touches NEITHER of those
 * tables. It is the legacy TECHNICIAN-side call record, not the CRM outbound
 * audit — a CRM click-to-call has never appeared here, and a conference does
 * not either. The XLSX below is the same query and behaves identically.
 *
 * ⚠ AMBIGUITY WORTH KNOWING: the CRM's "Call Info" button opens a modal with
 * TWO tabs. This endpoint feeds one of them; the other (ClickToCallTab) reads
 * GET /api/admin/calls, which DID need the fix — see the CONFERENCE LEGS block
 * in routes/admin/calls.js. "The Call Info modal is broken/fine" is therefore
 * only ever half a statement; say which tab.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/', async (req, res, next) => {
  try {
    const fromDate = String(req.query.fromDate || '').trim();
    const toDate   = String(req.query.toDate || '').trim();
    logger.info('List call info · from=' + fromDate + ' · to=' + toDate + ' · filtered=' + !!req.query.callTo);
    if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) {
      logger.warn('Call info rejected · invalid date range');
      return modernError(res, 400, 'fromDate and toDate are required (YYYY-MM-DD)');
    }
    if (fromDate > toDate) {
      logger.warn('Call info rejected · fromDate after toDate');
      return modernError(res, 400, 'fromDate must be on or before toDate');
    }
    const callTo = req.query.callTo ? String(req.query.callTo).trim() : '';

    const clauses = ['cr.insert_date_time BETWEEN ? AND ?'];
    const params  = [`${fromDate} 00:00:00`, `${toDate} 23:59:59`];
    if (callTo) {
      // Substring match across technician mobile + customer mobile.
      clauses.push('(e.efr_no LIKE ? OR cu.customer_mob_no LIKE ?)');
      params.push(`%${callTo}%`, `%${callTo}%`);
    }

    const [rows] = await pool.query(
      `SELECT cr.*,
              e.efr_name, e.efr_no,
              j.job_status, j.job_type, j.job_customer_name,
              j.fk_easyfixter_id AS job_efr_id,
              COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name) AS customer_name,
              cu.customer_mob_no
         FROM tbl_easyfixer_call_record cr
         LEFT JOIN tbl_easyfixer e  ON e.efr_id     = cr.efr_id
         LEFT JOIN tbl_job j        ON j.job_id     = cr.job_id
         LEFT JOIN tbl_customer cu  ON cu.customer_id = j.fk_customer_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY cr.insert_date_time DESC
        LIMIT 500`,
      params
    );
    logger.info('Returning ' + rows.length + ' call records');
    modernOk(res, { items: rows, total: rows.length, fromDate, toDate, callTo: callTo || null });
  } catch (e) {
    // Be friendly if the table isn't provisioned on a dev DB — UI
    // shouldn't 500 just because a local schema is incomplete.
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      logger.warn('Call info · call-record table not provisioned');
      return modernOk(res, { items: [], total: 0, note: 'call-record table not provisioned' });
    }
    next(e);
  }
});

/*
 * GET /admin/call-info/export.xlsx?fromDate=&toDate=&callTo=
 *
 * Streams a styled XLSX of the same dataset the list endpoint returns
 * for the given range. Styling + worksheet construction is delegated
 * to `utils/xlsx-styled-export.js` so other report-style endpoints
 * (Completed-Jobs, Easyfixer payout, etc.) can share the same visual
 * recipe with a single import.
 */
const { streamStyledXlsx } = require('../../utils/xlsx-styled-export');

// Job-status → label uses the shared CRM helper (utils/job-status-label.js,
// imported at the top). It mirrors the on-screen statusLabel exactly — which
// also corrected this export's old local map, where 10/20/21 read
// Revisit/Pending to Close/Followup instead of Closed from App/In Progress/On
// Hold — and does the BOOKED sub-split from `assigned` (j.fk_easyfixter_id).

router.get('/export.xlsx', async (req, res, next) => {
  try {
    const fromDate = String(req.query.fromDate || '').trim();
    const toDate   = String(req.query.toDate || '').trim();
    logger.info('Export call info xlsx · from=' + fromDate + ' · to=' + toDate + ' · filtered=' + !!req.query.callTo);
    if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) {
      logger.warn('Call info export rejected · invalid date range');
      return modernError(res, 400, 'fromDate and toDate are required (YYYY-MM-DD)');
    }
    if (fromDate > toDate) {
      logger.warn('Call info export rejected · fromDate after toDate');
      return modernError(res, 400, 'fromDate must be on or before toDate');
    }
    const callTo = req.query.callTo ? String(req.query.callTo).trim() : '';

    const clauses = ['cr.insert_date_time BETWEEN ? AND ?'];
    const params  = [`${fromDate} 00:00:00`, `${toDate} 23:59:59`];
    if (callTo) {
      clauses.push('(e.efr_no LIKE ? OR cu.customer_mob_no LIKE ?)');
      params.push(`%${callTo}%`, `%${callTo}%`);
    }

    let rawRows = [];
    try {
      const [r] = await pool.query(
        `SELECT cr.insert_date_time,
                e.efr_name, e.efr_no,
                cr.job_id,
                j.job_status, j.job_type, j.job_customer_name,
                j.fk_easyfixter_id AS job_efr_id,
                COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name) AS customer_name,
                cu.customer_mob_no
           FROM tbl_easyfixer_call_record cr
           LEFT JOIN tbl_easyfixer e  ON e.efr_id     = cr.efr_id
           LEFT JOIN tbl_job j        ON j.job_id     = cr.job_id
           LEFT JOIN tbl_customer cu  ON cu.customer_id = j.fk_customer_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY cr.insert_date_time DESC
          LIMIT 5000`,
        params
      );
      rawRows = r;
      logger.info('Found ' + rawRows.length + ' call records for export');
    } catch (e) {
      // Missing table on a dev DB → still produce a (empty) workbook
      // so the download UX doesn't dead-end.
      if (e?.code !== 'ER_NO_SUCH_TABLE') throw e;
      logger.warn('Call info export · call-record table not provisioned');
      rawRows = [];
    }

    // Shape rows for the styled exporter — column keys must match
    // those declared in `columns` below.
    const xlsxRows = rawRows.map((r) => ({
      call_time: r.insert_date_time
        ? new Date(r.insert_date_time).toLocaleString('en-IN', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
          })
        : '',
      efr_name:     r.efr_name || '',
      efr_no:       r.efr_no || '',
      job_id:       r.job_id ?? '',
      // `customer_name` is already the job-first resolution done in SQL
      // (job_customer_name → customer-master). The old JS chain here was
      // `r.customer_name || r.job_customer_name`, which preferred the MASTER
      // name and so contradicted the on-screen table — the export and the
      // modal now agree because both read this one resolved column.
      customer:     r.customer_name || '',
      customer_mob: r.customer_mob_no || '',
      job_type:     r.job_type || '',
      // Split BOOKED by tech presence so the export matches the on-screen chip.
      job_status:   jobStatusLabel(r.job_status, r.job_efr_id != null),
    }));

    const meta = [
      `Range: ${fromDate}  →  ${toDate}`,
      callTo ? `Filter: ${callTo}` : null,
      `Generated: ${new Date().toLocaleString('en-IN')}`,
      `Total: ${xlsxRows.length} call${xlsxRows.length === 1 ? '' : 's'}`,
    ].filter(Boolean).join('    ·    ');

    logger.info('Streaming call-history xlsx · rows=' + xlsxRows.length);
    await streamStyledXlsx(res, `call-history_${fromDate}_to_${toDate}.xlsx`, {
      title: 'EasyFix  ·  Call History',
      meta,
      sheetName: 'Call History',
      columns: [
        { header: 'Call Time',        key: 'call_time',    width: 22, align: 'left' },
        { header: 'Easyfixer',        key: 'efr_name',     width: 28, align: 'left' },
        { header: 'Easyfixer Mobile', key: 'efr_no',       width: 16, align: 'center' },
        { header: 'Job ID',           key: 'job_id',       width: 12, align: 'center' },
        { header: 'Customer',         key: 'customer',     width: 28, align: 'left' },
        { header: 'Customer Mobile',  key: 'customer_mob', width: 16, align: 'center' },
        { header: 'Job Type',         key: 'job_type',     width: 16, align: 'center' },
        { header: 'Job Status',       key: 'job_status',   width: 14, align: 'center' },
      ],
      rows: xlsxRows,
      emptyMessage: 'No calls found for the selected range.',
    });
  } catch (e) { next(e); }
});

module.exports = router;
