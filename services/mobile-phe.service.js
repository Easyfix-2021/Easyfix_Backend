const { pool } = require('../db');
const logger = require('../logger');
const s3Storage = require('../utils/s3-storage');
const { OFFER_STATUS } = require('./offer-status');
const {
  currentIstMonth,
  monthBounds,
  monthLabel,
  monthParts,
  shiftMonth,
  shiftYmd,
  todayIst,
} = require('../utils/ist-calendar');

/*
 * Performance + History + Earnings (PHE) read model for the technician app.
 *
 * This module deliberately composes existing source-of-truth tables rather
 * than creating another wallet/performance ledger:
 *   - paid money       tbl_easyfixer_transaction (type 2 = credit)
 *   - wallet balance   tbl_easyfixer.current_balance
 *   - withdrawals      tbl_easyfixer_withdrawal_request
 *   - job performance  tbl_job + tbl_job_offer + customer ratings
 *   - proof of work    tbl_job_image
 *
 * Every public function receives the authenticated efr id. There is no subject
 * id in query/body data. Reads are bounded and page-based where the result can
 * grow. QC is intentionally absent: the current schema has no authoritative
 * "client checking quality / money pending" state, and status 10 is overloaded
 * by legacy audit/revisit flows, so deriving QC would present guesses as money.
 */

function num(value) {
  return Number(value ?? 0);
}

function money(value) {
  return Number(num(value).toFixed(2));
}

function maskedLast4(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? digits.slice(-4) : null;
}

function maskPersonName(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function withdrawalShape(row) {
  if (!row || row.request_id == null) return null;
  return {
    requestId: Number(row.request_id),
    amount: money(row.amount),
    status: row.status || null,
    requestedOn: row.requested_on || null,
    processedOn: row.processed_on || null,
    bankName: row.bank_name || null,
    accountLast4: maskedLast4(row.bank_account_number),
    // `remarks` is operator free text, not a canonical bank/UTR reference.
    // Keep the contract explicit until a dedicated payout-reference column is
    // introduced and populated by the finance flow.
    reference: null,
  };
}

function pageValues({ page = 1, limit = 20 } = {}) {
  const p = Math.max(Number(page) || 1, 1);
  const l = Math.min(Math.max(Number(limit) || 20, 1), 50);
  return { page: p, limit: l, offset: (p - 1) * l };
}

function monthsBefore(before, limit) {
  const result = [];
  let cursor = shiftMonth(before, -1);
  for (let i = 0; i < limit; i += 1) {
    result.push(cursor);
    cursor = shiftMonth(cursor, -1);
  }
  return result;
}

function hasMonthActivity(item) {
  return item.earnings !== 0
    || item.given !== 0
    || item.accepted !== 0
    || item.completed !== 0
    || item.sameDay !== 0
    || item.rating != null;
}

async function getOverview(efrId, { before, limit = 6 } = {}, db = pool) {
  const exclusiveBefore = before || shiftMonth(currentIstMonth(), 1);
  monthParts(exclusiveBefore);
  const cappedLimit = Math.min(Math.max(Number(limit) || 6, 1), 12);
  const monthKeys = monthsBefore(exclusiveBefore, cappedLimit);
  const from = `${monthKeys[monthKeys.length - 1]}-01`;
  const to = `${exclusiveBefore}-01`;

  logger.info(`PHE overview · efrId=${efrId} before=${exclusiveBefore} limit=${cappedLimit}`);

  const accountPromise = db.query(
    `SELECT e.current_balance,
            w.request_id, w.amount, w.status, w.requested_on, w.processed_on,
            w.bank_name, w.bank_account_number
       FROM tbl_easyfixer e
       LEFT JOIN tbl_easyfixer_withdrawal_request w
              ON w.request_id = (
                SELECT MAX(w2.request_id)
                  FROM tbl_easyfixer_withdrawal_request w2
                 WHERE w2.fk_easyfixer_id = e.efr_id
              )
      WHERE e.efr_id = ? AND NOT (e.efr_status <=> 3)
      LIMIT 1`,
    [efrId],
  );

  // A Paid-month card is one reconcilable cohort: completed jobs in that
  // month which have job-linked technician credits. This excludes manual
  // wallet credits and keeps the card amount/count/rating aligned with the
  // jobs opened from that card even when finance credits the job later.
  const paidJobsPromise = db.query(
    `SELECT DATE_FORMAT(p.checkout_date_time, '%Y-%m') AS month_key,
            COALESCE(SUM(p.paid_amount), 0) AS earnings,
            COUNT(*) AS completed,
            SUM(DATE(p.checkin_date_time) = DATE(COALESCE(p.original_appointment_date_time, p.requested_date_time))) AS same_day,
            AVG(r.job_rating) AS rating
       FROM (
         SELECT j.job_id, j.checkout_date_time, j.checkin_date_time,
                j.original_appointment_date_time, j.requested_date_time,
                SUM(ABS(et.amount)) AS paid_amount
           FROM tbl_job j
           JOIN tbl_easyfixer_transaction et
             ON et.easyfixer_id = ?
            AND et.job_id = j.job_id
            AND et.transaction_type = 2
          WHERE j.fk_easyfixter_id = ?
            AND j.job_status IN (3, 5)
            AND j.checkout_date_time >= ?
            AND j.checkout_date_time < ?
          GROUP BY j.job_id, j.checkout_date_time, j.checkin_date_time,
                   j.original_appointment_date_time, j.requested_date_time
       ) p
       LEFT JOIN (
         SELECT rc.job_id, AVG(rc.customer_rating) AS job_rating
           FROM tbl_easyfixer_rating_by_customer rc
          WHERE rc.easyfixer_id = ?
          GROUP BY rc.job_id
       ) r ON r.job_id = p.job_id
      GROUP BY month_key`,
    [efrId, efrId, from, to, efrId],
  );

  const offersPromise = db.query(
    `SELECT DATE_FORMAT(jo.offered_at, '%Y-%m') AS month_key,
            COUNT(DISTINCT jo.job_id) AS given_count,
            COUNT(DISTINCT CASE WHEN jo.offer_status = ${OFFER_STATUS.ACCEPTED}
                                THEN jo.job_id END) AS accepted_count
       FROM tbl_job_offer jo
      WHERE jo.fk_easyfixter_id = ?
        AND jo.offered_at >= ?
        AND jo.offered_at < ?
      GROUP BY month_key`,
    [efrId, from, to],
  ).catch((error) => {
    if (error?.code === 'ER_NO_SUCH_TABLE') return [[]];
    throw error;
  });

  const [accountResult, paidJobResult, offerResult] = await Promise.all([
    accountPromise, paidJobsPromise, offersPromise,
  ]);
  const account = accountResult[0]?.[0] || null;
  if (!account) {
    const error = new Error('Technician not found');
    error.status = 404;
    throw error;
  }

  const paidJobs = new Map((paidJobResult[0] || []).map((r) => [r.month_key, r]));
  const offers = new Map((offerResult[0] || []).map((r) => [r.month_key, r]));

  const items = monthKeys.map((month) => {
    const paid = paidJobs.get(month) || {};
    const o = offers.get(month) || {};
    return {
      month,
      label: monthLabel(month),
      earnings: money(paid.earnings),
      given: num(o.given_count),
      accepted: num(o.accepted_count),
      completed: num(paid.completed),
      sameDay: num(paid.same_day),
      rating: paid.rating == null ? null : Number(num(paid.rating).toFixed(1)),
    };
  });

  return {
    wallet: { availableToWithdraw: money(account.current_balance) },
    latestWithdrawal: withdrawalShape(account),
    months: {
      items,
      // Stop after the first all-empty page. This bounds historical paging
      // without needing an unindexed global MIN scan on every overview read.
      nextCursor: items.some(hasMonthActivity) && items.length
        ? items[items.length - 1].month
        : null,
    },
    features: { qc: false },
  };
}

async function getMonthJobs(efrId, month, paging = {}, db = pool) {
  const { start, end } = monthBounds(month);
  const { page, limit, offset } = pageValues(paging);
  const paidJobs = `
    SELECT et.job_id,
           MIN(et.transaction_date) AS paid_at,
           SUM(ABS(et.amount)) AS paid_amount
      FROM tbl_easyfixer_transaction et
      JOIN tbl_job paid_job
        ON paid_job.job_id = et.job_id
     WHERE et.easyfixer_id = ?
       AND et.transaction_type = 2
       AND et.job_id IS NOT NULL
       AND paid_job.fk_easyfixter_id = ?
       AND paid_job.job_status IN (3, 5)
       AND paid_job.checkout_date_time >= ?
       AND paid_job.checkout_date_time < ?
     GROUP BY et.job_id`;

  const [rowsResult, countResult] = await Promise.all([
    db.query(
      `SELECT j.job_id,
              COALESCE(sc.service_catg_name, st.service_type_name, CONCAT('Job #', j.job_id)) AS title,
              cl.client_name, j.checkout_date_time, p.paid_at, p.paid_amount,
              r.job_rating,
              (j.checkin_date_time IS NOT NULL
                AND j.checkin_date_time <= DATE_ADD(j.requested_date_time, INTERVAL 60 MINUTE)) AS on_time,
              (j.checkin_date_time IS NOT NULL
                AND DATE(j.checkin_date_time) = DATE(COALESCE(j.original_appointment_date_time, j.requested_date_time))) AS same_day
         FROM (${paidJobs}) p
         JOIN tbl_job j ON j.job_id = p.job_id
         LEFT JOIN tbl_client cl ON cl.client_id = j.fk_client_id
         LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id
         LEFT JOIN tbl_service_type st ON st.service_type_id = j.fk_service_type_id
         LEFT JOIN (
           SELECT rc.job_id, AVG(rc.customer_rating) AS job_rating
             FROM tbl_easyfixer_rating_by_customer rc
            WHERE rc.easyfixer_id = ?
            GROUP BY rc.job_id
         ) r ON r.job_id = j.job_id
        WHERE j.fk_easyfixter_id = ?
          AND j.job_status IN (3, 5)
        ORDER BY j.checkout_date_time DESC, j.job_id DESC
        LIMIT ? OFFSET ?`,
      [efrId, efrId, start, end, efrId, efrId, limit, offset],
    ),
    db.query(
      `SELECT COUNT(*) AS total
         FROM (${paidJobs}) p
         JOIN tbl_job j ON j.job_id = p.job_id
        WHERE j.fk_easyfixter_id = ?
          AND j.job_status IN (3, 5)`,
      [efrId, efrId, start, end, efrId],
    ),
  ]);

  return {
    month,
    items: (rowsResult[0] || []).map((r) => ({
      jobId: Number(r.job_id),
      title: r.title,
      clientName: r.client_name || null,
      completedAt: r.checkout_date_time || null,
      paidAt: r.paid_at || null,
      amount: money(r.paid_amount),
      rating: r.job_rating == null ? null : Number(num(r.job_rating).toFixed(1)),
      onTime: Boolean(r.on_time),
      sameDay: Boolean(r.same_day),
    })),
    total: num(countResult[0]?.[0]?.total),
    page,
    limit,
  };
}

async function getJobDetail(efrId, jobId, db = pool) {
  const [[row]] = await db.query(
    `SELECT j.job_id,
            COALESCE(sc.service_catg_name, st.service_type_name, CONCAT('Job #', j.job_id)) AS title,
            cl.client_name, j.created_date_time, j.checkout_date_time,
            p.paid_at, p.paid_amount,
            r.customer_rating, COALESCE(NULLIF(r.comment, ''), r.review_comment) AS feedback,
            COALESCE(NULLIF(j.job_customer_name, ''), cu.customer_name) AS reviewer_name,
            NULLIF(CONCAT_WS(', ', ad.address, ad.building, ad.locality, ci.city_name, ad.pin_code), '') AS full_address
       FROM tbl_job j
       LEFT JOIN tbl_client cl ON cl.client_id = j.fk_client_id
       LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
       LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id
       LEFT JOIN tbl_city ci ON ci.city_id = ad.city_id
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id
       LEFT JOIN tbl_service_type st ON st.service_type_id = j.fk_service_type_id
       LEFT JOIN (
         SELECT et.job_id, MIN(et.transaction_date) AS paid_at,
                SUM(ABS(et.amount)) AS paid_amount
           FROM tbl_easyfixer_transaction et
          WHERE et.easyfixer_id = ? AND et.transaction_type = 2 AND et.job_id = ?
          GROUP BY et.job_id
       ) p ON p.job_id = j.job_id
       LEFT JOIN tbl_easyfixer_rating_by_customer r
              ON r.id = (
                SELECT r2.id
                  FROM tbl_easyfixer_rating_by_customer r2
                 WHERE r2.easyfixer_id = ? AND r2.job_id = j.job_id
                 ORDER BY r2.insert_date_time DESC, r2.id DESC
                 LIMIT 1
              )
      WHERE j.job_id = ?
        AND j.fk_easyfixter_id = ?
        AND j.job_status IN (3, 5)
        AND p.job_id IS NOT NULL
      LIMIT 1`,
    [efrId, jobId, efrId, jobId, efrId],
  );
  if (!row) {
    const error = new Error('job not found');
    error.status = 404;
    throw error;
  }

  // Cap both SQL rows and URL-signing work. Reading each proof bucket
  // independently preserves the earliest "before" evidence and the latest
  // completion evidence even on jobs with a noisy historical image trail.
  const [beforeResult, afterResult] = await Promise.all([
    db.query(
      `SELECT image_id, image, image_category, job_stage, created_date
         FROM tbl_job_image
        WHERE job_id = ?
          AND (LOWER(image_category) IN ('booking', 'before', 'checkin') OR job_stage = 0)
        ORDER BY image_id ASC
        LIMIT 10`,
      [jobId],
    ),
    db.query(
      `SELECT image_id, image, image_category, job_stage, created_date
         FROM tbl_job_image
        WHERE job_id = ?
          AND (LOWER(image_category) IN ('completion', 'after') OR job_stage = 5)
        ORDER BY image_id DESC
        LIMIT 10`,
      [jobId],
    ),
  ]);
  const imageRows = [...new Map(
    [...(beforeResult[0] || []), ...(afterResult[0] || [])]
      .map((image) => [image.image_id, image]),
  ).values()];

  const proof = { before: [], after: [] };
  const resolvedImages = await Promise.all((imageRows || []).map(async (image) => {
    let url = null;
    try {
      url = await s3Storage.resolveImageUrl(image.image);
    } catch (error) {
      logger.warn(
        { err: error.message, jobId, imageId: Number(image.image_id) },
        'PHE proof image URL resolution failed',
      );
    }
    return { image, url };
  }));
  // Preserve SQL order even when signed-URL calls resolve out of order.
  // Deterministic evidence ordering prevents a refresh from visually shuffling
  // the same job's proof tiles.
  resolvedImages.forEach(({ image, url }) => {
    if (!url) return;
    const category = String(image.image_category || '').toLowerCase();
    const item = {
      imageId: Number(image.image_id),
      url,
      createdAt: image.created_date || null,
    };
    if (category === 'completion' || category === 'after' || Number(image.job_stage) === 5) {
      proof.after.push(item);
    } else if (category === 'booking' || category === 'before' || category === 'checkin' || Number(image.job_stage) === 0) {
      proof.before.push(item);
    }
  });

  return {
    jobId: Number(row.job_id),
    title: row.title,
    clientName: row.client_name || null,
    completedAt: row.checkout_date_time || null,
    paidAt: row.paid_at || null,
    amount: money(row.paid_amount),
    customerFeedback: row.customer_rating == null && !row.feedback ? null : {
      rating: row.customer_rating == null ? null : Number(row.customer_rating),
      comment: row.feedback || null,
      reviewerDisplayName: maskPersonName(row.reviewer_name),
    },
    proof,
    bookedAt: row.created_date_time || null,
    attendedBy: 'You',
    address: row.full_address || null,
  };
}

async function missedWindow(efrId, from, to, db) {
  const offersQuery = db.query(
    `SELECT
       SUM(x.offer_status = ${OFFER_STATUS.EXPIRED}) AS expired_jobs,
       SUM(x.offer_status = ${OFFER_STATUS.REJECTED}) AS rejected_jobs,
       SUM(CASE WHEN x.offer_status = ${OFFER_STATUS.EXPIRED} THEN x.known_amount ELSE 0 END) AS expired_amount,
       SUM(CASE WHEN x.offer_status = ${OFFER_STATUS.REJECTED} THEN x.known_amount ELSE 0 END) AS rejected_amount,
       SUM(CASE WHEN x.offer_status = ${OFFER_STATUS.EXPIRED} AND x.has_amount = 1 THEN 1 ELSE 0 END) AS expired_known,
       SUM(CASE WHEN x.offer_status = ${OFFER_STATUS.REJECTED} AND x.has_amount = 1 THEN 1 ELSE 0 END) AS rejected_known
     FROM (
       SELECT jo.job_id, jo.offer_status,
              COALESCE(SUM(tjt.efr_charge), 0) AS known_amount,
              (COUNT(tjt.fk_job_id) > 0) AS has_amount
         FROM tbl_job_offer jo
         JOIN (
           SELECT job_id, MAX(job_offer_id) AS latest_offer_id
             FROM tbl_job_offer
            WHERE fk_easyfixter_id = ?
              AND offer_status IN (${OFFER_STATUS.REJECTED}, ${OFFER_STATUS.EXPIRED})
              AND responded_at >= ?
              AND responded_at < ?
            GROUP BY job_id
         ) latest ON latest.latest_offer_id = jo.job_offer_id
         LEFT JOIN tbl_job_transaction tjt ON tjt.fk_job_id = jo.job_id
        GROUP BY jo.job_id, jo.offer_status
     ) x`,
    [efrId, from, to],
  ).catch((error) => {
    if (error?.code === 'ER_NO_SUCH_TABLE') return [[{}]];
    throw error;
  });

  const cancelledQuery = db.query(
    `SELECT COUNT(*) AS cancelled_jobs,
            SUM(x.known_amount) AS cancelled_amount,
            SUM(x.has_amount = 1) AS cancelled_known
       FROM (
         SELECT j.job_id, COALESCE(SUM(tjt.efr_charge), 0) AS known_amount,
                (COUNT(tjt.fk_job_id) > 0) AS has_amount
           FROM tbl_job j
           LEFT JOIN tbl_job_transaction tjt ON tjt.fk_job_id = j.job_id
          WHERE j.fk_easyfixter_id = ?
            AND j.job_status = 6
            AND j.cancel_date_time >= ?
            AND j.cancel_date_time < ?
          GROUP BY j.job_id
       ) x`,
    [efrId, from, to],
  );

  const [offerResult, cancelResult] = await Promise.all([offersQuery, cancelledQuery]);
  const o = offerResult[0]?.[0] || {};
  const c = cancelResult[0]?.[0] || {};
  const expiredJobs = num(o.expired_jobs);
  const rejectedJobs = num(o.rejected_jobs);
  const cancelledJobs = num(c.cancelled_jobs);
  const expiredKnown = num(o.expired_known);
  const rejectedKnown = num(o.rejected_known);
  const cancelledKnown = num(c.cancelled_known);

  const categories = [
    {
      key: 'expired', label: 'Offer expired', jobs: expiredJobs,
      knownAmount: money(o.expired_amount), amountCoverageComplete: expiredKnown === expiredJobs,
    },
    {
      key: 'rejected', label: 'Offer declined', jobs: rejectedJobs,
      knownAmount: money(o.rejected_amount), amountCoverageComplete: rejectedKnown === rejectedJobs,
    },
    {
      key: 'cancelledAfterAssignment', label: 'Cancelled after assignment', jobs: cancelledJobs,
      knownAmount: money(c.cancelled_amount), amountCoverageComplete: cancelledKnown === cancelledJobs,
    },
  ];
  const totalJobs = expiredJobs + rejectedJobs + cancelledJobs;
  const knownJobs = expiredKnown + rejectedKnown + cancelledKnown;
  return {
    expiredOffers: expiredJobs,
    rejectedOffers: rejectedJobs,
    cancelledJobs,
    knownPotentialAmount: money(categories.reduce((sum, item) => sum + item.knownAmount, 0)),
    amountCoverageComplete: knownJobs === totalJobs,
    categories,
  };
}

async function getMissed(efrId, { days = 30 } = {}, db = pool) {
  const windowDays = Number(days) || 30;
  const today = todayIst();
  const currentTo = shiftYmd(today, 1);
  const currentFrom = shiftYmd(currentTo, -windowDays);
  const previousFrom = shiftYmd(currentFrom, -windowDays);
  const [current, previous] = await Promise.all([
    missedWindow(efrId, currentFrom, currentTo, db),
    missedWindow(efrId, previousFrom, currentFrom, db),
  ]);
  return {
    period: { days: windowDays, from: currentFrom, to: today },
    summary: {
      expiredOffers: current.expiredOffers,
      rejectedOffers: current.rejectedOffers,
      cancelledJobs: current.cancelledJobs,
      knownPotentialAmount: current.knownPotentialAmount,
      amountCoverageComplete: current.amountCoverageComplete,
    },
    previousPeriod: {
      expiredOffers: previous.expiredOffers,
      rejectedOffers: previous.rejectedOffers,
      cancelledJobs: previous.cancelledJobs,
      knownPotentialAmount: previous.knownPotentialAmount,
      amountCoverageComplete: previous.amountCoverageComplete,
    },
    categories: current.categories,
  };
}

async function getWithdrawals(efrId, paging = {}, db = pool) {
  const { page, limit, offset } = pageValues(paging);
  const [rowsResult, countResult] = await Promise.all([
    db.query(
      `SELECT request_id, amount, status, requested_on, processed_on,
              bank_name, bank_account_number
         FROM tbl_easyfixer_withdrawal_request
        WHERE fk_easyfixer_id = ?
        ORDER BY request_id DESC
        LIMIT ? OFFSET ?`,
      [efrId, limit, offset],
    ),
    db.query(
      `SELECT COUNT(*) AS total
         FROM tbl_easyfixer_withdrawal_request
        WHERE fk_easyfixer_id = ?`,
      [efrId],
    ),
  ]);
  return {
    items: (rowsResult[0] || []).map(withdrawalShape),
    total: num(countResult[0]?.[0]?.total),
    page,
    limit,
  };
}

module.exports = {
  getOverview,
  getMonthJobs,
  getJobDetail,
  getMissed,
  getWithdrawals,
  _internals: {
    currentIstMonth,
    monthBounds,
    monthsBefore,
    shiftMonth,
    todayIst,
    pageValues,
    hasMonthActivity,
    maskPersonName,
    withdrawalShape,
  },
};
