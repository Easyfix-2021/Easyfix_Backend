const router = require('express').Router();
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const { sendXlsx } = require('../../utils/xlsx-export');
const logger = require('../../logger');

const wantsXlsx = (req) => String(req.query.format || '').toLowerCase() === 'xlsx';
const stamp = () => new Date().toISOString().slice(0, 10);

router.get('/completed-jobs', async (req, res, next) => {
  try {
    const { from, to, clientId } = req.query;
    logger.info('Completed-jobs report · from=' + from + ' to=' + to + ' clientId=' + (clientId ?? '-') + ' format=' + (req.query.format || 'json'));
    if (!from || !to) { logger.warn('Completed-jobs report rejected · from and to required'); return modernError(res, 400, 'from and to required'); }
    const clauses = ['j.job_status IN (3,5)', 'j.checkout_date_time BETWEEN ? AND ?'];
    const params = [from, to];
    if (clientId != null) { clauses.push('j.fk_client_id = ?'); params.push(clientId); }
    const [rows] = await pool.query(
      /*
       * total_amount is NOT a column on tbl_job — it never was, so this report
       * threw ER_BAD_FIELD_ERROR on every request, JSON and XLSX alike. Job
       * money lives in tbl_job_transaction, which is where the Transactions
       * modal reads it from too.
       *
       * A CORRELATED SUBQUERY, not a join. Only 1 job in 338,740 carries more
       * than one transaction row, but a LEFT JOIN would silently duplicate
       * that one job in a report people reconcile against — and the subquery
       * needs no GROUP BY, so nothing else in the statement has to change.
       * The alias is kept because the XLSX column is keyed on `total_amount`.
       */
      `SELECT j.job_id, j.fk_client_id, cl.client_name, j.job_type, j.checkout_date_time,
              ef.efr_name AS easyfixer, ci.city_name,
              (SELECT TJT.total_charge_and_tax
                 FROM tbl_job_transaction TJT
                WHERE TJT.fk_job_id = j.job_id
                ORDER BY TJT.job_transaction_id DESC
                LIMIT 1)                    AS total_amount
         FROM tbl_job j
         LEFT JOIN tbl_client    cl ON cl.client_id = j.fk_client_id
         LEFT JOIN tbl_easyfixer ef ON ef.efr_id    = j.fk_easyfixter_id
         LEFT JOIN tbl_address   ad ON ad.address_id = j.fk_address_id
         LEFT JOIN tbl_city      ci ON ci.city_id = ad.city_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY j.checkout_date_time DESC LIMIT 1000`, params);
    logger.info('Found ' + rows.length + ' completed jobs');

    if (wantsXlsx(req)) {
      logger.info('Exporting ' + rows.length + ' completed jobs as xlsx');
      return sendXlsx(res, {
        filename: `completed-jobs-${stamp()}.xlsx`,
        sheetName: 'Completed Jobs',
        columns: [
          { key: 'job_id',              header: 'Job ID',         width: 10 },
          { key: 'fk_client_id',        header: 'Client ID',      width: 10 },
          { key: 'client_name',         header: 'Client',         width: 28 },
          { key: 'job_type',            header: 'Job Type',       width: 14 },
          { key: 'checkout_date_time',  header: 'Checkout',       width: 20 },
          { key: 'easyfixer',           header: 'Easyfixer',      width: 24 },
          { key: 'city_name',           header: 'City',           width: 18 },
          { key: 'total_amount',        header: 'Total Amount',   width: 14 },
        ],
        rows,
      });
    }
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/easyfixer', async (req, res, next) => {
  try {
    const { from, to, efrId } = req.query;
    logger.info('Easyfixer report · from=' + (from ?? '-') + ' to=' + (to ?? '-') + ' efrId=' + (efrId ?? '-') + ' format=' + (req.query.format || 'json'));
    const clauses = [], params = [];
    if (efrId != null) { clauses.push('j.fk_easyfixter_id = ?'); params.push(efrId); }
    if (from && to)    { clauses.push('j.checkout_date_time BETWEEN ? AND ?'); params.push(from, to); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT ef.efr_id, ef.efr_name,
              SUM(CASE WHEN j.job_status IN (3,5) THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN j.job_status = 6 THEN 1 ELSE 0 END) AS cancelled,
              COUNT(j.job_id) AS total_jobs
         FROM tbl_easyfixer ef LEFT JOIN tbl_job j ON j.fk_easyfixter_id = ef.efr_id
         ${where} GROUP BY ef.efr_id, ef.efr_name ORDER BY completed DESC LIMIT 500`, params);
    logger.info('Found ' + rows.length + ' easyfixers');

    if (wantsXlsx(req)) {
      return sendXlsx(res, {
        filename: `easyfixer-report-${stamp()}.xlsx`,
        sheetName: 'Easyfixers',
        columns: [
          { key: 'efr_id',     header: 'Easyfixer ID', width: 12 },
          { key: 'efr_name',   header: 'Name',         width: 26 },
          { key: 'completed',  header: 'Completed',    width: 12 },
          { key: 'cancelled',  header: 'Cancelled',    width: 12 },
          { key: 'total_jobs', header: 'Total Jobs',   width: 12 },
        ],
        rows,
      });
    }
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/payout-sheet', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    logger.info('Payout-sheet report · from=' + from + ' to=' + to + ' format=' + (req.query.format || 'json'));
    if (!from || !to) { logger.warn('Payout-sheet report rejected · from and to required'); return modernError(res, 400, 'from and to required'); }
    const [rows] = await pool.query(
      `SELECT ef.efr_id, ef.efr_name, ef.efr_no, ef.current_balance,
              COUNT(j.job_id) AS jobs_completed
         FROM tbl_easyfixer ef
         LEFT JOIN tbl_job j ON j.fk_easyfixter_id = ef.efr_id
           AND j.job_status IN (3,5) AND j.checkout_date_time BETWEEN ? AND ?
        WHERE ef.efr_status = 1
        GROUP BY ef.efr_id ORDER BY jobs_completed DESC LIMIT 1000`, [from, to]);
    logger.info('Found ' + rows.length + ' payout rows');

    if (wantsXlsx(req)) {
      return sendXlsx(res, {
        filename: `payout-sheet-${stamp()}.xlsx`,
        sheetName: 'Payout Sheet',
        columns: [
          { key: 'efr_id',          header: 'Easyfixer ID',    width: 12 },
          { key: 'efr_name',        header: 'Name',            width: 26 },
          { key: 'efr_no',          header: 'Mobile',          width: 14 },
          { key: 'current_balance', header: 'Current Balance', width: 16 },
          { key: 'jobs_completed',  header: 'Jobs Completed',  width: 14 },
        ],
        rows,
      });
    }
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/city-analysis', async (req, res, next) => {
  try {
    logger.info('City-analysis report · format=' + (req.query.format || 'json'));
    const [rows] = await pool.query(
      `SELECT ci.city_id, ci.city_name,
              COUNT(j.job_id) AS total_jobs,
              SUM(CASE WHEN j.job_status IN (3,5) THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN j.job_status = 6 THEN 1 ELSE 0 END) AS cancelled
         FROM tbl_city ci
         LEFT JOIN tbl_address ad ON ad.city_id = ci.city_id
         LEFT JOIN tbl_job j ON j.fk_address_id = ad.address_id
        WHERE ci.city_status = 1
        GROUP BY ci.city_id ORDER BY total_jobs DESC LIMIT 100`);
    logger.info('Found ' + rows.length + ' cities');

    if (wantsXlsx(req)) {
      return sendXlsx(res, {
        filename: `city-analysis-${stamp()}.xlsx`,
        sheetName: 'City Analysis',
        columns: [
          { key: 'city_id',    header: 'City ID',    width: 10 },
          { key: 'city_name',  header: 'City',       width: 22 },
          { key: 'total_jobs', header: 'Total Jobs', width: 12 },
          { key: 'completed',  header: 'Completed',  width: 12 },
          { key: 'cancelled',  header: 'Cancelled',  width: 12 },
        ],
        rows,
      });
    }
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/job-tracking', async (req, res, next) => {
  try {
    const { jobId } = req.query;
    logger.info('Job-tracking report · jobId=' + (jobId ?? '-'));
    if (!jobId) { logger.warn('Job-tracking report rejected · jobId required'); return modernError(res, 400, 'jobId required'); }
    const [history] = await pool.query(
      `SELECT sh.id, sh.easyfixer_id, ef.efr_name, sh.schedule_time, sh.reason_id, sh.reschedule_reason
         FROM scheduling_history sh LEFT JOIN tbl_easyfixer ef ON ef.efr_id = sh.easyfixer_id
        WHERE sh.job_id = ? ORDER BY sh.id ASC`, [jobId]);
    logger.info('Found ' + history.length + ' scheduling-history entries');
    modernOk(res, history);
  } catch (e) { next(e); }
});

// Legacy parity: userProductivity (UserAction.getUserCRMActiveTime).
// Pairs each user's login_date_time with logout_date_time (or NOW() if open)
// in tbl_user_login_logout_logs and sums active seconds per user across the
// requested window. Returns one row per user with sessions count and active
// hours; supports ?format=xlsx for download.
router.get('/user-productivity', async (req, res, next) => {
  try {
    const { from, to, userId, roleId } = req.query;
    logger.info('User-productivity report · from=' + from + ' to=' + to + ' userId=' + (userId ?? '-') + ' roleId=' + (roleId ?? '-') + ' format=' + (req.query.format || 'json'));
    if (!from || !to) { logger.warn('User-productivity report rejected · from and to required'); return modernError(res, 400, 'from and to required'); }
    const clauses = ['l.login_date_time BETWEEN ? AND ?'];
    const params = [from, to];
    if (userId != null) { clauses.push('l.user_id = ?'); params.push(userId); }
    if (roleId != null) { clauses.push('u.user_role = ?'); params.push(roleId); }
    const [rows] = await pool.query(
      `SELECT u.user_id, u.user_name, u.user_code, u.official_email,
              r.role_name,
              COUNT(l.id) AS sessions,
              SUM(TIMESTAMPDIFF(SECOND, l.login_date_time, COALESCE(l.logout_date_time, NOW()))) AS active_seconds
         FROM tbl_user u
         JOIN tbl_user_login_logout_logs l ON l.user_id = u.user_id
         LEFT JOIN tbl_role r ON r.role_id = u.user_role
        WHERE ${clauses.join(' AND ')}
        GROUP BY u.user_id, u.user_name, u.user_code, u.official_email, r.role_name
        ORDER BY active_seconds DESC
        LIMIT 1000`, params);
    logger.info('Found ' + rows.length + ' user-productivity rows');

    const enriched = rows.map(r => {
      const secs = Number(r.active_seconds) || 0;
      const hours = secs / 3600;
      return {
        ...r,
        active_seconds: secs,
        active_hours: Math.round(hours * 100) / 100,
        active_time: `${Math.floor(hours)}h ${Math.floor((secs % 3600) / 60)}m`,
      };
    });

    if (wantsXlsx(req)) {
      return sendXlsx(res, {
        filename: `user-productivity-${stamp()}.xlsx`,
        sheetName: 'User Productivity',
        columns: [
          { key: 'user_id',        header: 'User ID',     width: 10 },
          { key: 'user_code',      header: 'Code',        width: 12 },
          { key: 'user_name',      header: 'Name',        width: 26 },
          { key: 'official_email', header: 'Email',       width: 28 },
          { key: 'role_name',      header: 'Role',        width: 22 },
          { key: 'sessions',       header: 'Sessions',    width: 10 },
          { key: 'active_hours',   header: 'Active Hours',width: 14 },
          { key: 'active_time',    header: 'Active Time', width: 14 },
        ],
        rows: enriched,
      });
    }
    modernOk(res, enriched);
  } catch (e) { next(e); }
});

router.get('/user-hours', async (req, res, next) => {
  try {
    const { from, to, userId } = req.query;
    logger.info('User-hours report · from=' + (from ?? '-') + ' to=' + (to ?? '-') + ' userId=' + (userId ?? '-'));
    const [rows] = await pool.query(
      `SELECT user_id, DATE(created_date_time) AS date, COUNT(*) AS actions
         FROM tbl_user_login_logout_logs
         WHERE created_date_time BETWEEN ? AND ?
           ${userId != null ? 'AND user_id = ?' : ''}
         GROUP BY user_id, DATE(created_date_time) ORDER BY date DESC LIMIT 500`,
      userId != null ? [from || '2020-01-01', to || new Date(), userId] : [from || '2020-01-01', to || new Date()]).catch(() => [[]]);
    logger.info('Found ' + rows.length + ' user-hours rows');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

module.exports = router;
