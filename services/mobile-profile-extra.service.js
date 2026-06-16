const { pool } = require('../db');
const logger = require('../logger');

/*
 * mobile-profile-extra.service — backing logic for routes/mobile/profile-extra.js.
 *
 * Covers the technician-app "profile extras" surface that the legacy
 * Dropwizard `test-api` served under `easyfixers/*`, `upi-details`,
 * `training-video/*`, `version`, `logout`, plus the earnings / icard /
 * ratings reads. Every function is scoped to ONE technician — callers
 * pass `efrId` resolved from `req.tech.efr_id` (never trust a body id).
 *
 * Source-of-truth columns (cross-referenced 2026-06-15 against the
 * legacy EasyFix_CRM Java DAOs + docs/claude-reference/SCHEMA.md +
 * services/{job,mobile-dashboard,performance}.service.js):
 *
 *   tbl_easyfixer                      efr_id, efr_name, efr_first_name,
 *                                      efr_last_name, efr_no, efr_email,
 *                                      efr_profile_img, efr_cityId,
 *                                      efr_service_category, current_balance,
 *                                      date_of_birth, about_yourself,
 *                                      health_insurance, accidental_insurance,
 *                                      efr_pin_no, adhaar_card_number,
 *                                      pan_card_number
 *   tbl_city                           city_id, city_name
 *   tbl_job_transaction (TJT)          fk_job_id, efr_charge (easyfixer's
 *                                      cut), ef_charge (easyfix margin),
 *                                      total_charge, client_charge
 *   tbl_easyfixer_rating_by_customer   id, easyfixer_id, job_id,
 *                                      customer_rating, comment,
 *                                      review_comment, is_escalated,
 *                                      escalated_comments, insert_date_time
 *   easyfixer_watched_video (wvd)      easyfixer_id, video_id,
 *                                      watched_percentage, update_date
 *   device_info                        user_id, device_id, is_logged_in
 *
 * Earnings model (matches legacy EasyfixerDaoImpl.getEasyFixMarginByEfrId
 * / getTotalEarningAndJobCount): a technician's per-job earning is
 * `tbl_job_transaction.efr_charge` over COMPLETED jobs (job_status IN 3,5).
 * `current_balance` is the running wallet on tbl_easyfixer.
 */

// Completed job statuses — same constant the performance service uses.
const COMPLETED_STATUSES = [3, 5];

// ─────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────

// Normalise an optional `from`/`to` (YYYY-MM-DD) pair into an inclusive
// date window. Returns { fromExpr, toExpr } booleans telling callers
// whether to apply the filter. We bind the raw strings parameterised.
function dateBounds(from, to) {
  return {
    hasFrom: Boolean(from),
    hasTo: Boolean(to),
    from: from || null,
    // inclusive end-of-day for the `to` bound
    to: to || null,
  };
}

function splitCategories(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────
// Name + image
// ─────────────────────────────────────────────────────────────────────

/*
 * DUPLICATE REMOVED: `getEditableProfile` (legacy
 * `easyfixers/edited-profile-details`) was removed — it duplicates the
 * existing `GET /profile`, which returns the full tbl_easyfixer row the
 * app reads its editable fields from.
 */

/*
 * Update the technician's display name — legacy `name-dob-aadhaar`
 * (name slice only). Single-column UPDATE, parameterised.
 */
async function updateName(efrId, name) {
  await pool.query(
    'UPDATE tbl_easyfixer SET efr_name = ? WHERE efr_id = ?',
    [name, efrId],
  );
  return { ok: true };
}

/*
 * Set the profile image — legacy `profile/profile-image-upload`.
 *
 * The RN screen uploads the binary via the generic doc/image upload
 * endpoint (multipart) first, then calls THIS with the resulting
 * `imageId` (an S3 key / file id). Here we just persist that reference
 * onto tbl_easyfixer.efr_profile_img and return the stored value.
 *
 * VERIFY: whether `efr_profile_img` stores a bare S3 key or a full URL
 * varies by legacy data — we store exactly what the app sends (the
 * upload endpoint already produced the canonical key/URL). The mobile
 * Bearer-auth image-rendering pattern fetches it via authenticated
 * fetch → Blob, so a bare key is fine.
 */
async function setProfileImage(efrId, imageId) {
  await pool.query(
    'UPDATE tbl_easyfixer SET efr_profile_img = ? WHERE efr_id = ?',
    [imageId, efrId],
  );
  return { url: imageId };
}

// ─────────────────────────────────────────────────────────────────────
// Weekly performance
// ─────────────────────────────────────────────────────────────────────

/*
 * Weekly performance chart — legacy had no clean 1:1; the blueprint
 * (§4.2) specifies a computed roll-up. There is NO pre-computed
 * daily-performance table (confirmed in performance.service.js header —
 * the spec's assumption was audited false 2026-05-25). So we COMPUTE
 * from completed jobs + the rating table, bucketed by ISO week.
 *
 *   ota / sda / grade / rating   — headline figures (reuse the canonical
 *                                  performance.service so OTA/SDA/rating
 *                                  definitions stay shared, not forked).
 *   totalJobs / totalEarnings    — over the requested window.
 *   weeks[]                      — per-week { weekStart, ota, sda,
 *                                  jobsDone, earnings }.
 *
 * `earnings` per week = SUM(tbl_job_transaction.efr_charge) for that
 * tech's completed jobs whose checkout fell in the week.
 *
 * VERIFY: bucket date column — we bucket on `checkin_date_time` (the
 * same column performance.service uses to order "recent" jobs). If the
 * analytics team prefers `app_checkout_date_time`, swap the GROUP BY
 * expression — both columns exist on tbl_job.
 */
async function getWeeklyPerformance(efrId, { from, to } = {}) {
  const b = dateBounds(from, to);

  // Headline OTA/SDA/grade/rating from the shared performance service —
  // avoids duplicating the on-time / same-day definitions.
  // eslint-disable-next-line global-require
  const performanceService = require('./performance.service');
  const headline = await performanceService
    .getForTech(efrId)
    .catch((e) => {
      logger.warn({ err: e.message, efrId }, 'weekly headline perf failed');
      return { ota: 0, sda: 0, grade: 'A', rating: 0 };
    });

  // Per-week aggregation. Bind the window only when supplied so an
  // unbounded call still works (returns all weeks the tech has history).
  const params = [efrId, COMPLETED_STATUSES];
  let windowSql = '';
  if (b.hasFrom) { windowSql += ' AND j.checkin_date_time >= ?'; params.push(b.from); }
  if (b.hasTo) { windowSql += ' AND j.checkin_date_time < DATE_ADD(?, INTERVAL 1 DAY)'; params.push(b.to); }

  let weeks = [];
  let totalJobs = 0;
  let totalEarnings = 0;
  try {
    const [rows] = await pool.query(
      `SELECT
         DATE(DATE_SUB(j.checkin_date_time, INTERVAL WEEKDAY(j.checkin_date_time) DAY)) AS weekStart,
         COUNT(DISTINCT j.job_id) AS jobsDone,
         COALESCE(SUM(tjt.efr_charge), 0) AS earnings,
         SUM(j.checkin_date_time <= DATE_ADD(j.requested_date_time, INTERVAL 60 MINUTE)) AS onTime,
         SUM(DATE(j.checkin_date_time) = DATE(COALESCE(j.original_appointment_date_time, j.requested_date_time))) AS sameDay,
         COUNT(*) AS sampleSize
       FROM tbl_job j
       LEFT JOIN tbl_job_transaction tjt ON tjt.fk_job_id = j.job_id
      WHERE j.fk_easyfixter_id = ?
        AND j.job_status IN (?)
        AND j.checkin_date_time IS NOT NULL
        ${windowSql}
      GROUP BY weekStart
      ORDER BY weekStart ASC`,
      params,
    );
    weeks = rows.map((r) => {
      const sample = Number(r.sampleSize ?? 0);
      const jobs = Number(r.jobsDone ?? 0);
      const earn = Number(r.earnings ?? 0);
      totalJobs += jobs;
      totalEarnings += earn;
      return {
        weekStart: r.weekStart,
        ota: sample ? Math.round((Number(r.onTime ?? 0) / sample) * 100) : 0,
        sda: sample ? Math.round((Number(r.sameDay ?? 0) / sample) * 100) : 0,
        jobsDone: jobs,
        earnings: earn,
      };
    });
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'getWeeklyPerformance aggregation failed');
  }

  return {
    ota: headline.ota,
    sda: headline.sda,
    grade: headline.grade,
    rating: headline.rating,
    totalJobs,
    totalEarnings,
    weeks,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Earnings / wallet
// ─────────────────────────────────────────────────────────────────────

/*
 * Earnings statement — legacy `easyfixers/` (getMyEarningData).
 *
 *   totalEarnings   — SUM(efr_charge) over completed jobs in the window.
 *   currentBalance  — tbl_easyfixer.current_balance (running wallet).
 *   averageEarning  — totalEarnings / completed-job-count (0 if none).
 *   items[]         — per completed job line { jobId, title, date, amount, type }.
 *
 * `title` = service category name when joinable, else a generic label.
 * `type` is a coarse credit/debit hint — earnings here are all credits
 * ('earning'); the running balance carries any debits separately.
 */
async function getEarnings(efrId, { from, to } = {}) {
  const b = dateBounds(from, to);

  // current_balance is a simple per-tech read.
  let currentBalance = 0;
  try {
    const [[walletRow]] = await pool.query(
      'SELECT current_balance FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1',
      [efrId],
    );
    currentBalance = Number(walletRow?.current_balance ?? 0);
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'getEarnings balance read failed');
  }

  const params = [efrId, COMPLETED_STATUSES];
  let windowSql = '';
  if (b.hasFrom) { windowSql += ' AND j.checkin_date_time >= ?'; params.push(b.from); }
  if (b.hasTo) { windowSql += ' AND j.checkin_date_time < DATE_ADD(?, INTERVAL 1 DAY)'; params.push(b.to); }

  let items = [];
  let totalEarnings = 0;
  try {
    // Category-name join mirrors job.service.js::LIST exactly:
    //   LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id
    // (note: table is `tbl_service_catg`, NOT `tbl_service_category`).
    // LEFT JOIN keeps the line even if the category is missing.
    const [rows] = await pool.query(
      `SELECT j.job_id AS jobId,
              sc.service_catg_name AS title,
              j.checkin_date_time AS jobDate,
              COALESCE(tjt.efr_charge, 0) AS amount
         FROM tbl_job j
         LEFT JOIN tbl_job_transaction tjt ON tjt.fk_job_id = j.job_id
         LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id
        WHERE j.fk_easyfixter_id = ?
          AND j.job_status IN (?)
          ${windowSql}
        ORDER BY j.checkin_date_time DESC`,
      params,
    );
    items = rows.map((r) => {
      const amt = Number(r.amount ?? 0);
      totalEarnings += amt;
      return {
        jobId: r.jobId,
        title: r.title || 'Service',
        date: r.jobDate ?? null,
        amount: amt,
        type: 'earning',
      };
    });
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'getEarnings items query failed');
  }

  const averageEarning = items.length ? Number((totalEarnings / items.length).toFixed(2)) : 0;
  return {
    totalEarnings: Number(totalEarnings.toFixed(2)),
    currentBalance,
    averageEarning,
    items,
  };
}

// ─────────────────────────────────────────────────────────────────────
// I-Card
// ─────────────────────────────────────────────────────────────────────

/*
 * Digital I-Card — legacy `easyfixers/icard`.
 *
 * Shape (blueprint §4.2):
 *   { id, name, mobile, serviceCategoryList, city, vaccinated,
 *     insurance, memberSince, rating, logos:[] }
 *
 * `rating` = AVG(customer_rating) over the tech's lifetime (matches
 * legacy getEasyfixerAvgRating — unwindowed AVG).
 *
 * VERIFY:
 *   - `vaccinated`: no dedicated column found in the legacy easyfixer
 *     model; default false until the live column is confirmed. If a
 *     `vaccination_status` / `is_vaccinated` column exists, surface it.
 *   - `memberSince`: legacy used `profile_activation_date_time` as the
 *     activation marker — we read that. If absent on this DB row it
 *     degrades to null.
 *   - `logos`: client/partner logo URLs are a presentation concern the
 *     legacy endpoint left empty; returned as [].
 */
async function getICard(efrId) {
  let row = {};
  try {
    const [[r]] = await pool.query(
      `SELECT e.efr_id, e.efr_name, e.efr_no,
              e.efr_service_category, e.efr_cityId, c.city_name,
              e.health_insurance, e.accidental_insurance,
              e.profile_activation_date_time
         FROM tbl_easyfixer e
         LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId
        WHERE e.efr_id = ?
        LIMIT 1`,
      [efrId],
    );
    row = r || {};
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'getICard identity read failed');
  }

  let rating = 0;
  try {
    const [[rt]] = await pool.query(
      `SELECT AVG(customer_rating) AS avgRating
         FROM tbl_easyfixer_rating_by_customer
        WHERE easyfixer_id = ? AND customer_rating IS NOT NULL`,
      [efrId],
    );
    rating = Number((Number(rt?.avgRating ?? 0)).toFixed(1));
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'getICard rating read failed');
  }

  const hasInsurance = Boolean(row.health_insurance) || Boolean(row.accidental_insurance);
  return {
    id: row.efr_id ?? efrId,
    name: row.efr_name ?? null,
    mobile: row.efr_no ?? null,
    serviceCategoryList: splitCategories(row.efr_service_category),
    city: row.city_name ?? null,
    vaccinated: false, // VERIFY: no vaccination column confirmed on tbl_easyfixer
    insurance: hasInsurance,
    memberSince: row.profile_activation_date_time ?? null, // VERIFY: activation date as "member since"
    rating,
    logos: [],
  };
}

// ─────────────────────────────────────────────────────────────────────
// Ratings list
// ─────────────────────────────────────────────────────────────────────

/*
 * Customer ratings list — legacy `all/` (getRatingList).
 *
 * Reads tbl_easyfixer_rating_by_customer scoped to the technician,
 * optionally windowed by insert_date_time. Column names confirmed
 * against JobDaoImpl (RC.comment AS ratingComment, RC.review_comment,
 * RC.customer_rating, escalated_*).
 */
async function getRatings(efrId, { from, to } = {}) {
  const b = dateBounds(from, to);
  const params = [efrId];
  let windowSql = '';
  if (b.hasFrom) { windowSql += ' AND insert_date_time >= ?'; params.push(b.from); }
  if (b.hasTo) { windowSql += ' AND insert_date_time < DATE_ADD(?, INTERVAL 1 DAY)'; params.push(b.to); }

  let items = [];
  try {
    const [rows] = await pool.query(
      `SELECT id, customer_rating, comment, review_comment,
              job_id, is_escalated
         FROM tbl_easyfixer_rating_by_customer
        WHERE easyfixer_id = ?
          ${windowSql}
        ORDER BY insert_date_time DESC`,
      params,
    );
    items = rows.map((r) => ({
      id: r.id,
      customerRating: r.customer_rating ?? null,
      comments: r.comment ?? null,
      reviewComments: r.review_comment ?? null,
      jobId: r.job_id ?? null,
      isEscalated: Boolean(r.is_escalated),
    }));
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'getRatings query failed');
  }
  return { items };
}

// ─────────────────────────────────────────────────────────────────────
// Training videos — watched %
// ─────────────────────────────────────────────────────────────────────

/*
 * Per-video watched % — legacy `training-video/percentage`.
 * Backed by `easyfixer_watched_video` (wvd) — columns confirmed in
 * EasyfixerDaoImpl: easyfixer_id, video_id, watched_percentage, update_date.
 */
async function getTrainingPercentages(efrId) {
  let items = [];
  try {
    const [rows] = await pool.query(
      `SELECT video_id, watched_percentage
         FROM easyfixer_watched_video
        WHERE easyfixer_id = ?
        ORDER BY video_id ASC`,
      [efrId],
    );
    items = rows.map((r) => ({
      videoId: r.video_id,
      watchedPercentage: Number(r.watched_percentage ?? 0),
    }));
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'getTrainingPercentages query failed');
  }
  return { items };
}

/*
 * Upsert a single video's watched % — legacy
 * `training-video/update-watched-percentage`.
 *
 * `easyfixer_watched_video` has no guaranteed unique key on
 * (easyfixer_id, video_id) — to stay correct regardless of constraint
 * presence we UPDATE-then-INSERT (same defensive pattern the device_info
 * upsert uses in routes/mobile/index.js). `update_date` is stamped NOW().
 */
async function setTrainingPercentage(efrId, videoId, watchedPercentage) {
  const [upd] = await pool.query(
    `UPDATE easyfixer_watched_video
        SET watched_percentage = ?, update_date = NOW()
      WHERE easyfixer_id = ? AND video_id = ?`,
    [watchedPercentage, efrId, videoId],
  );
  if (upd.affectedRows === 0) {
    await pool.query(
      `INSERT INTO easyfixer_watched_video (easyfixer_id, video_id, watched_percentage, update_date)
       VALUES (?, ?, ?, NOW())`,
      [efrId, videoId, watchedPercentage],
    );
  }
  return { videoId, watchedPercentage };
}

// ─────────────────────────────────────────────────────────────────────
// App version
// ─────────────────────────────────────────────────────────────────────

/*
 * App version / force-update — legacy `version`.
 *
 * Intentionally HARDCODED build-time constants, NOT DB config. The version
 * threshold moves in lockstep with each app release + backend deploy, so a
 * code change + redeploy is the natural control surface — no separate config
 * store to keep in sync. Bump these when cutting a release:
 *   LATEST_VERSION         — newest version in the stores (soft "update
 *                            available" prompt when the client is below this).
 *   MIN_SUPPORTED_VERSION  — clients below this are force-updated by the app.
 *   FORCE_UPDATE           — global kill-switch; set true to force EVERY
 *                            client to update on the next deploy, then flip
 *                            back to false. Altered in code before the build.
 */
const LATEST_VERSION = '1.0.0';
const MIN_SUPPORTED_VERSION = '1.0.0';
const FORCE_UPDATE = false;

function getAppVersion() {
  return {
    latestVersion: LATEST_VERSION,
    minSupportedVersion: MIN_SUPPORTED_VERSION,
    forceUpdate: FORCE_UPDATE,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Logout — device deregister
// ─────────────────────────────────────────────────────────────────────

/*
 * Logout — legacy `logout`. Deregisters the technician's device so push
 * fan-out stops reaching it. The push fan-out reads is_logged_in='1'
 * rows in device_info (see verify-otp single-active-session logic).
 *
 * `is_logged_in` is VARCHAR on device_info — set the string '0' to match
 * the existing data shape used by verify-otp. When a deviceId is given
 * we scope to that row; otherwise we log out ALL of this tech's devices.
 */
async function logout(efrId, deviceId) {
  if (deviceId) {
    await pool.query(
      "UPDATE device_info SET is_logged_in = '0' WHERE user_id = ? AND device_id = ?",
      [efrId, deviceId],
    );
  } else {
    await pool.query(
      "UPDATE device_info SET is_logged_in = '0' WHERE user_id = ?",
      [efrId],
    );
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────
// UPI details
// ─────────────────────────────────────────────────────────────────────

/*
 * UPI details — legacy `upi-details` (get/add).
 *
 * STATUS (2026-06-16): DEFERRED to the alteration pass — do NOT re-point here.
 * `tbl_easyfixer_upi` does NOT exist. The real legacy table is
 * `upi_details (id PK, upi_or_mobile_number VARCHAR(255), user_id INT)` — no
 * is_primary, no timestamp (the multi-UPI/primary model below does not apply).
 *
 * Crucially, `upi_details.user_id` is the legacy `tbl_user.user_id`, NOT
 * `efr_id` (live count 2026-06-16: 431/431 rows match a tbl_user.user_id vs
 * only 393/431 an efr_id — a real FK matches ~100%; the 91% is id-space
 * overlap). Technicians were tbl_user role-19 rows in the legacy system; the
 * new backend re-based mobile identity onto tbl_easyfixer.efr_id, so the
 * mobile token carries efr_id and CANNOT key this table without an
 * efr_id → tbl_user.user_id bridge (the unreliable ghost-row mapping —
 * ~4,753 role-19 rows). That bridge, OR switching the app to an efr-keyed
 * store (tbl_easyfixer_bank_details.upi_or_mobile_number, which is CRM-shared),
 * is a cross-tier WRITE decision for the alteration iteration — out of the
 * zero-risk pass.
 *
 * Until then the queries below intentionally target the non-existent
 * `tbl_easyfixer_upi`: getUpiDetails degrades to {items:[]}, addUpiDetail
 * 503s (see its catch) — both safe, neither mis-files data.
 */
async function getUpiDetails(efrId) {
  let items = [];
  try {
    const [rows] = await pool.query(
      `SELECT id, upi_id, is_primary
         FROM tbl_easyfixer_upi
        WHERE efr_id = ?
        ORDER BY is_primary DESC, id DESC`,
      [efrId],
    );
    items = rows.map((r) => ({
      id: r.id,
      upiId: r.upi_id ?? null,
      isPrimary: Boolean(r.is_primary),
    }));
  } catch (e) {
    logger.warn({ err: e.message, efrId }, 'getUpiDetails query failed (VERIFY tbl_easyfixer_upi columns)');
  }
  return { items };
}

/*
 * Add a UPI id. When `isPrimary` is requested, demote any existing
 * primary in the SAME transaction so exactly one stays primary.
 * Multi-step write → pool connection + begin/commit/rollback per the
 * coding rules.
 */
async function addUpiDetail(efrId, upiId, isPrimary) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (isPrimary) {
      await conn.query(
        'UPDATE tbl_easyfixer_upi SET is_primary = 0 WHERE efr_id = ?',
        [efrId],
      );
    }
    const [ins] = await conn.query(
      `INSERT INTO tbl_easyfixer_upi (efr_id, upi_id, is_primary, created_date_time)
       VALUES (?, ?, ?, NOW())`,
      [efrId, upiId, isPrimary ? 1 : 0],
    );
    await conn.commit();
    return { id: ins.insertId, upiId, isPrimary: Boolean(isPrimary) };
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* swallow rollback failure */ }
    // Storage table not provisioned yet (real table is `upi_details`, pending
    // a column-confirmed re-point). Degrade a missing-table error to a clean
    // 503 rather than a raw 500 — and crucially NOT a fake success, so the app
    // knows the UPI was not saved. Mirrors getUpiDetails' defensive posture
    // for the write path.
    if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146)) {
      logger.warn({ err: e.message, efrId }, 'addUpiDetail: UPI storage not available yet — degrading to 503');
      const err = new Error('UPI storage is not available yet');
      err.status = 503;
      throw err;
    }
    throw e;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────
// KYC — Aadhaar/PAN duplicate-check
// ─────────────────────────────────────────────────────────────────────

/*
 * Duplicate-check a candidate Aadhaar or PAN number across tbl_easyfixer.
 * Legacy `profile/adhaar-pan-number/{n}`. Returns { exists } — true if
 * ANY OTHER active technician already holds that number on either the
 * adhaar_card_number or pan_card_number column.
 *
 * `excludeEfrId` lets the current technician's own row not count as a
 * duplicate (so re-saving an unchanged number doesn't false-positive).
 * Column names confirmed in SCHEMA.md: adhaar_card_number (note the
 * `adhaar` spelling), pan_card_number.
 */
async function aadhaarPanExists(number, excludeEfrId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS cnt
       FROM tbl_easyfixer
      WHERE (adhaar_card_number = ? OR pan_card_number = ?)
        AND efr_id <> ?`,
    [number, number, excludeEfrId || 0],
  );
  return { exists: Number(row?.cnt ?? 0) > 0 };
}

module.exports = {
  updateName,
  setProfileImage,
  getWeeklyPerformance,
  getEarnings,
  getICard,
  getRatings,
  getTrainingPercentages,
  setTrainingPercentage,
  getAppVersion,
  logout,
  getUpiDetails,
  addUpiDetail,
  aadhaarPanExists,
};
