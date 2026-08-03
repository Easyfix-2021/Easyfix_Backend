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
 *   tbl_customer   → customer_name, customer_mob_no
 *
 * Legacy contract preserved: fromDate / toDate / optional callTo
 * filter. callTo now matches against efr_no (technician mobile) OR
 * tbl_customer.customer_mob_no.
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
              cu.customer_name, cu.customer_mob_no
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
                cu.customer_name, cu.customer_mob_no
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
      customer:     r.customer_name || r.job_customer_name || '',
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
