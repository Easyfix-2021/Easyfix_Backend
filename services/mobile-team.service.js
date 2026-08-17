const { pool } = require('../db');
const logger = require('../logger');
const profileDetails = require('./mobile-profile-details.service');
const { currentIstMonth, monthBounds } = require('../utils/ist-calendar');

/*
 * Mobile "My Team" — a master technician's downline: the technicians whose
 * tbl_easyfixer.efr_manager_id points at the caller. Legacy parity with the
 * Dropwizard `GET easyfixers/my_team/{id}?membershipType=`, except the {id} is
 * NEVER trusted from the client — the master is derived from req.tech.efr_id by
 * the route (requireTechAuth), so a tech can only ever see their OWN downline.
 *
 * membership_type has no DB column; it's derived ('Member' for a downline row).
 * efr_profile_img is returned as the stored value (an S3 key or legacy path) —
 * the app's Avatar falls back to initials when it isn't directly renderable.
 */
async function getMyTeam(masterEfrId) {
  logger.info('Fetch my-team downline · masterEfrId=' + masterEfrId);
  const [rows] = await pool.query(
    `SELECT e.efr_id          AS efr_id,
            e.efr_name        AS efr_name,
            e.efr_no          AS efr_mobile,
            e.efr_profile_img AS efr_profile_img,
            c.city_name       AS city_name
       FROM tbl_easyfixer e
       LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
      WHERE e.efr_manager_id = ?
        AND e.efr_status = 1
      ORDER BY e.efr_name ASC`,
    [masterEfrId],
  );
  logger.info('Found ' + rows.length + ' team members');
  return rows.map((r) => ({
    efr_id:          r.efr_id,
    efr_name:        r.efr_name,
    efr_mobile:      r.efr_mobile,
    efr_profile_img: r.efr_profile_img,
    city_name:       r.city_name,
    membership_type: 'Member',
  }));
}

function num(value) {
  return Number(value ?? 0);
}

function money(value) {
  return Number(num(value).toFixed(2));
}

function maskMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length <= 4) return digits;
  return `${digits.slice(0, 2)}${'•'.repeat(Math.max(digits.length - 5, 3))}${digits.slice(-3)}`;
}

function pageValues({ page = 1, limit = 20 } = {}) {
  const p = Math.max(Number(page) || 1, 1);
  const l = Math.min(Math.max(Number(limit) || 20, 1), 50);
  return { page: p, limit: l, offset: (p - 1) * l };
}

/*
 * Team Profile landing payload. The earning figure is named
 * `memberEarnings`: it is the sum of job-linked credits for direct reports'
 * jobs completed in the selected month. It is NOT represented as money earned
 * by the master — no commission/share rule exists in the authoritative schema.
 */
async function getTeamProfile(masterEfrId, { month } = {}, db = pool) {
  const selectedMonth = month || currentIstMonth();
  const { start, end } = monthBounds(selectedMonth);
  logger.info(`Team profile · master=${masterEfrId} month=${selectedMonth}`);

  const [profile, summaryResult] = await Promise.all([
    profileDetails.getProfileDetails(masterEfrId),
    db.query(
      `SELECT COUNT(*) AS member_count,
              COALESCE(SUM(p.earnings), 0) AS member_earnings
         FROM tbl_easyfixer e
         LEFT JOIN (
           SELECT et.easyfixer_id, SUM(ABS(et.amount)) AS earnings
             FROM tbl_easyfixer_transaction et
             JOIN tbl_job paid_job
               ON paid_job.job_id = et.job_id
              AND paid_job.fk_easyfixter_id = et.easyfixer_id
              AND paid_job.job_status IN (3, 5)
             JOIN tbl_easyfixer member
               ON member.efr_id = et.easyfixer_id
              AND member.efr_manager_id = ?
              AND member.efr_status = 1
            WHERE et.transaction_type = 2
              AND et.job_id IS NOT NULL
              AND paid_job.checkout_date_time >= ?
              AND paid_job.checkout_date_time < ?
            GROUP BY et.easyfixer_id
         ) p ON p.easyfixer_id = e.efr_id
        WHERE e.efr_manager_id = ?
          AND e.efr_status = 1`,
      [masterEfrId, start, end, masterEfrId],
    ),
  ]);
  const summary = summaryResult[0]?.[0] || {};
  return {
    efrId: Number(profile.efrId ?? masterEfrId),
    name: profile.name || null,
    mobileMasked: maskMobile(profile.mobile),
    photoUrl: profile.photoUrl || null,
    grade: profile.grade || null,
    rating: profile.rating == null ? null : Number(profile.rating),
    jobsDone: num(profile.completedJobs),
    // Deep-skill mappings are the authoritative active skill selection. The
    // legacy efr_service_category string can be stale or differently delimited.
    categoriesCount: num(profile.skillCount),
    city: profile.city || null,
    easyFixSince: profile.memberSince || null,
    team: {
      members: num(summary.member_count),
      memberEarnings: money(summary.member_earnings),
      month: selectedMonth,
    },
  };
}

/*
 * Set-based monthly metrics for every direct report on the requested page.
 * Each aggregate joins the manager-filtered member set before touching its
 * large fact table, avoiding the legacy Java endpoint's per-member/per-job
 * query fan-out. Sorting is deterministic and describes observable quality:
 * rating, then on-time %, completed jobs, and finally stable efr id.
 */
async function listMembers(masterEfrId, { month, page, limit } = {}, db = pool) {
  const selectedMonth = month || currentIstMonth();
  const { start, end } = monthBounds(selectedMonth);
  const pagination = pageValues({ page, limit });
  logger.info(`Team members · master=${masterEfrId} month=${selectedMonth} page=${pagination.page}`);

  const [rowsResult, countResult] = await Promise.all([
    db.query(
      `SELECT e.efr_id, e.efr_name, e.efr_no, e.efr_profile_img,
              COALESCE(j.jobs_done, 0) AS jobs_done,
              COALESCE(j.on_time_jobs, 0) AS on_time_jobs,
              j.on_time_pct,
              r.rating,
              COALESCE(p.earnings, 0) AS earnings
         FROM tbl_easyfixer e
         LEFT JOIN (
           SELECT j.fk_easyfixter_id AS efr_id,
                  COUNT(*) AS jobs_done,
                  SUM(j.checkin_date_time IS NOT NULL
                    AND j.checkin_date_time <= DATE_ADD(j.requested_date_time, INTERVAL 60 MINUTE)) AS on_time_jobs,
                  ROUND(100 * SUM(j.checkin_date_time IS NOT NULL
                    AND j.checkin_date_time <= DATE_ADD(j.requested_date_time, INTERVAL 60 MINUTE)) / COUNT(*)) AS on_time_pct
             FROM tbl_job j
             JOIN tbl_easyfixer member
               ON member.efr_id = j.fk_easyfixter_id
              AND member.efr_manager_id = ?
              AND member.efr_status = 1
            WHERE j.job_status IN (3, 5)
              AND j.checkout_date_time >= ?
              AND j.checkout_date_time < ?
            GROUP BY j.fk_easyfixter_id
         ) j ON j.efr_id = e.efr_id
         LEFT JOIN (
           SELECT rc.easyfixer_id AS efr_id, AVG(rc.customer_rating) AS rating
             FROM tbl_easyfixer_rating_by_customer rc
             JOIN tbl_job rated_job
               ON rated_job.job_id = rc.job_id
              AND rated_job.fk_easyfixter_id = rc.easyfixer_id
              AND rated_job.job_status IN (3, 5)
             JOIN tbl_easyfixer member
               ON member.efr_id = rc.easyfixer_id
              AND member.efr_manager_id = ?
              AND member.efr_status = 1
            WHERE rc.customer_rating IS NOT NULL
              AND rated_job.checkout_date_time >= ?
              AND rated_job.checkout_date_time < ?
            GROUP BY rc.easyfixer_id
         ) r ON r.efr_id = e.efr_id
         LEFT JOIN (
           SELECT et.easyfixer_id AS efr_id, SUM(ABS(et.amount)) AS earnings
             FROM tbl_easyfixer_transaction et
             JOIN tbl_job paid_job
               ON paid_job.job_id = et.job_id
              AND paid_job.fk_easyfixter_id = et.easyfixer_id
              AND paid_job.job_status IN (3, 5)
             JOIN tbl_easyfixer member
               ON member.efr_id = et.easyfixer_id
              AND member.efr_manager_id = ?
              AND member.efr_status = 1
            WHERE et.transaction_type = 2
              AND et.job_id IS NOT NULL
              AND paid_job.checkout_date_time >= ?
              AND paid_job.checkout_date_time < ?
            GROUP BY et.easyfixer_id
         ) p ON p.efr_id = e.efr_id
        WHERE e.efr_manager_id = ?
          AND e.efr_status = 1
        ORDER BY COALESCE(r.rating, 0) DESC,
                 COALESCE(j.on_time_pct, 0) DESC,
                 COALESCE(j.jobs_done, 0) DESC,
                 e.efr_id ASC
        LIMIT ? OFFSET ?`,
      [
        masterEfrId, start, end,
        masterEfrId, start, end,
        masterEfrId, start, end,
        masterEfrId, pagination.limit, pagination.offset,
      ],
    ),
    db.query(
      `SELECT COUNT(*) AS total
         FROM tbl_easyfixer
        WHERE efr_manager_id = ? AND efr_status = 1`,
      [masterEfrId],
    ),
  ]);

  return {
    month: selectedMonth,
    items: (rowsResult[0] || []).map((row) => ({
      efrId: Number(row.efr_id),
      name: row.efr_name || null,
      mobileMasked: maskMobile(row.efr_no),
      photoUrl: row.efr_profile_img || null,
      jobsDone: num(row.jobs_done),
      rating: row.rating == null ? null : Number(num(row.rating).toFixed(1)),
      onTime: num(row.on_time_jobs),
      earnings: money(row.earnings),
    })),
    total: num(countResult[0]?.[0]?.total),
    page: pagination.page,
    limit: pagination.limit,
  };
}

async function getMemberDetail(masterEfrId, memberEfrId, { month } = {}, db = pool) {
  const selectedMonth = month || currentIstMonth();
  const { start, end } = monthBounds(selectedMonth);
  logger.info(`Team member detail · master=${masterEfrId} member=${memberEfrId} month=${selectedMonth}`);

  const [[member]] = await db.query(
    `SELECT e.efr_id, e.efr_name, e.efr_no, e.efr_profile_img, e.insert_date
       FROM tbl_easyfixer e
      WHERE e.efr_id = ?
        AND e.efr_manager_id = ?
        AND e.efr_status = 1
      LIMIT 1`,
    [memberEfrId, masterEfrId],
  );
  if (!member) {
    // Uniform 404: do not reveal whether the id exists under another master.
    const error = new Error('team member not found');
    error.status = 404;
    throw error;
  }

  const [metricResult, jobsResult] = await Promise.all([
    db.query(
      `SELECT
         (SELECT COUNT(*)
            FROM tbl_job j
           WHERE j.fk_easyfixter_id = ? AND j.job_status IN (3, 5)
             AND j.checkout_date_time >= ? AND j.checkout_date_time < ?) AS jobs_done,
         (SELECT SUM(j.checkin_date_time IS NOT NULL
                    AND j.checkin_date_time <= DATE_ADD(j.requested_date_time, INTERVAL 60 MINUTE))
            FROM tbl_job j
           WHERE j.fk_easyfixter_id = ? AND j.job_status IN (3, 5)
             AND j.checkout_date_time >= ? AND j.checkout_date_time < ?) AS on_time_jobs,
         (SELECT AVG(rc.customer_rating)
            FROM tbl_easyfixer_rating_by_customer rc
            JOIN tbl_job rated_job
              ON rated_job.job_id = rc.job_id
             AND rated_job.fk_easyfixter_id = rc.easyfixer_id
             AND rated_job.job_status IN (3, 5)
           WHERE rc.easyfixer_id = ? AND rc.customer_rating IS NOT NULL
             AND rated_job.checkout_date_time >= ? AND rated_job.checkout_date_time < ?) AS rating,
         (SELECT COALESCE(SUM(ABS(et.amount)), 0)
            FROM tbl_easyfixer_transaction et
            JOIN tbl_job paid_job
              ON paid_job.job_id = et.job_id
             AND paid_job.fk_easyfixter_id = et.easyfixer_id
             AND paid_job.job_status IN (3, 5)
           WHERE et.easyfixer_id = ? AND et.transaction_type = 2
             AND et.job_id IS NOT NULL
             AND paid_job.checkout_date_time >= ? AND paid_job.checkout_date_time < ?) AS earnings`,
      [
        memberEfrId, start, end,
        memberEfrId, start, end,
        memberEfrId, start, end,
        memberEfrId, start, end,
      ],
    ),
    db.query(
      `SELECT j.job_id,
              COALESCE(sc.service_catg_name, st.service_type_name, CONCAT('Job #', j.job_id)) AS title,
              j.checkout_date_time,
              p.paid_amount,
              r.job_rating,
              (j.checkin_date_time IS NOT NULL
                AND j.checkin_date_time <= DATE_ADD(j.requested_date_time, INTERVAL 60 MINUTE)) AS on_time
         FROM (
           SELECT et.job_id, SUM(ABS(et.amount)) AS paid_amount,
                  MAX(et.transaction_date) AS paid_at
             FROM tbl_easyfixer_transaction et
             JOIN tbl_job paid_job
               ON paid_job.job_id = et.job_id
            WHERE et.easyfixer_id = ? AND et.transaction_type = 2
              AND et.job_id IS NOT NULL
              AND paid_job.fk_easyfixter_id = ?
              AND paid_job.job_status IN (3, 5)
              AND paid_job.checkout_date_time >= ?
              AND paid_job.checkout_date_time < ?
            GROUP BY et.job_id
         ) p
         JOIN tbl_job j ON j.job_id = p.job_id
         LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id
         LEFT JOIN tbl_service_type st ON st.service_type_id = j.fk_service_type_id
         LEFT JOIN (
           SELECT rc.job_id, AVG(rc.customer_rating) AS job_rating
             FROM tbl_easyfixer_rating_by_customer rc
            WHERE rc.easyfixer_id = ?
            GROUP BY rc.job_id
         ) r ON r.job_id = j.job_id
        WHERE j.fk_easyfixter_id = ? AND j.job_status IN (3, 5)
        ORDER BY j.checkout_date_time DESC, j.job_id DESC
        LIMIT 5`,
      [memberEfrId, memberEfrId, start, end, memberEfrId, memberEfrId],
    ),
  ]);
  const metrics = metricResult[0]?.[0] || {};
  return {
    efrId: Number(member.efr_id),
    name: member.efr_name || null,
    mobileMasked: maskMobile(member.efr_no),
    photoUrl: member.efr_profile_img || null,
    easyFixSince: member.insert_date || null,
    month: selectedMonth,
    metrics: {
      jobsDone: num(metrics.jobs_done),
      rating: metrics.rating == null ? null : Number(num(metrics.rating).toFixed(1)),
      onTime: num(metrics.on_time_jobs),
      earnings: money(metrics.earnings),
    },
    lastJobs: (jobsResult[0] || []).map((row) => ({
      jobId: Number(row.job_id),
      title: row.title,
      completedAt: row.checkout_date_time || null,
      amount: money(row.paid_amount),
      rating: row.job_rating == null ? null : Number(num(row.job_rating).toFixed(1)),
      onTime: Boolean(row.on_time),
    })),
  };
}

module.exports = {
  getMyTeam,
  getTeamProfile,
  listMembers,
  getMemberDetail,
  _internals: { maskMobile, pageValues },
};
