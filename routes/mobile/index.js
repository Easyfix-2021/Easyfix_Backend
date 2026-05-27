const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const requireTechAuth = require('../../middleware/tech-auth');
const { pool } = require('../../db');
const techAuth = require('../../services/tech-auth.service');
const jobService = require('../../services/job.service');
const { modernOk, modernError } = require('../../utils/response');

const mobile = Joi.string().pattern(/^[0-9]{10}$/);

// ─── Auth (public) ─────────────────────────────────────────────────
router.post('/auth/login-otp', validate(Joi.object({ mobile: mobile.required() })), async (req, res, next) => {
  try {
    const r = await techAuth.createLoginOtp(req.body.mobile);
    modernOk(res, { delivered: r.found, expiresAt: r.expiresAt || null });
  } catch (e) { next(e); }
});

// Verify OTP — mirrors legacy `POST /test-api/api/verify-otp` (UserDto) so the
// app can upgrade in-place. Accepts the same field names the legacy controller
// did (deviceId, fireBaseToken) plus our modern camelCase (fcmToken). If any
// device fields are supplied, we upsert `device_info` in the SAME request so
// the technician is push-reachable immediately after login — no second
// /mobile/device round-trip needed (the standalone /mobile/device endpoint
// stays for token-rotation cases).
//
// Legacy reference: https://qa.easyfix.in/test-api/swagger-ui/index.html#/login-controller/verifyOtpUsingPOST
//   request: { userId, otp, deviceId, fireBaseToken, userName }
//   response: { status, message, data: <session-with-device> }
// Our modern envelope wraps the same fields under { success, data }.
router.post('/auth/verify-otp', validate(Joi.object({
  mobile:        mobile.required(),
  otp:           Joi.number().integer().min(1000).max(9999).required(),
  // Optional device fields — when present, the device is registered for push
  // notifications inside this same call. fireBaseToken is the legacy name;
  // fcmToken is the new one. Accept either, prefer the explicit fcmToken.
  deviceId:      Joi.string().trim().max(255).optional(),
  fcmToken:      Joi.string().trim().max(4096).optional(),
  fireBaseToken: Joi.string().trim().max(4096).optional(),
  appVersion:    Joi.string().trim().max(50).optional(),
  language:      Joi.string().trim().max(10).optional(),
})), async (req, res, next) => {
  try {
    const r = await techAuth.verifyLoginOtp(req.body.mobile, req.body.otp);
    if (!r.ok) return modernError(res, 401, r.reason);

    // Device-info upsert. device_info schema reality (verified 2026-05-27
    // against QA `SHOW CREATE TABLE`):
    //   - NO unique constraint exists on (user_id, device_id) — only PK on
    //     `id` + a non-unique secondary key on user_id. This means
    //     `INSERT ... ON DUPLICATE KEY UPDATE` SILENTLY FAILS to upsert
    //     (no constraint to violate → always INSERT → row count grows
    //     unbounded per login). Therefore we manually UPDATE-then-INSERT.
    //   - `is_logged_in` is VARCHAR(255), not TINYINT — values are string
    //     '1' / '0' to match legacy data shape.
    //   - Engine is MyISAM — no transactions. The three statements below
    //     run sequentially; a partial failure mid-sequence (rare) leaves
    //     a benign half-state that the next login self-heals.
    //
    // Single-active-session policy: on every verify-otp with a deviceId,
    // mark all OTHER device rows for this user as `is_logged_in = '0'`.
    // The next push fan-out reads only is_logged_in='1' rows so the old
    // phone stops receiving notifications immediately.
    const fcm = req.body.fcmToken || req.body.fireBaseToken || null;
    let deviceRegistered = false;
    if (req.body.deviceId) {
      try {
        // 1) Kick out every OTHER device for this technician
        await pool.query(
          "UPDATE device_info SET is_logged_in = '0' WHERE user_id = ? AND device_id <> ?",
          [r.tech.efr_id, req.body.deviceId],
        );

        // 2) Try to UPDATE the row for THIS (user_id, device_id) — refreshes
        //    FCM token, app version, language, marks logged-in, bumps time
        const [upd] = await pool.query(
          `UPDATE device_info SET
             fire_base_token   = ?,
             app_version_name  = COALESCE(?, app_version_name),
             language          = COALESCE(?, language),
             is_logged_in      = '1',
             last_login_time   = NOW()
           WHERE user_id = ? AND device_id = ?`,
          [fcm, req.body.appVersion || null, req.body.language || null,
           r.tech.efr_id, req.body.deviceId],
        );

        // 3) No matching row → INSERT fresh. Matches the column set + types
        //    used by the standalone /mobile/device endpoint.
        if (upd.affectedRows === 0) {
          await pool.query(
            `INSERT INTO device_info
               (user_id, device_id, fire_base_token, app_version_name, language, is_logged_in, last_login_time)
             VALUES (?, ?, ?, ?, ?, '1', NOW())`,
            [r.tech.efr_id, req.body.deviceId, fcm, req.body.appVersion || null, req.body.language || null],
          );
        }
        deviceRegistered = true;
      } catch (devErr) {
        // Soft-fail — login still succeeds, push just won't reach this
        // device until /mobile/device is hit explicitly.
        require('../../logger').warn(
          { err: devErr.message, efrId: r.tech.efr_id, deviceId: req.body.deviceId },
          'device_info upsert failed during verify-otp',
        );
      }
    }

    res.cookie('techToken', r.token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400 * 1000 });
    modernOk(res, {
      token: r.token,
      tech: {
        efr_id: r.tech.efr_id,
        name:   r.tech.efr_name,
        mobile: r.tech.efr_no,
        email:  r.tech.efr_email,
      },
      device: req.body.deviceId
        ? { registered: deviceRegistered, deviceId: req.body.deviceId, fcmStored: Boolean(fcm) }
        : { registered: false },
    });
  } catch (e) { next(e); }
});

// ─── Protected ─────────────────────────────────────────────────────
router.use(requireTechAuth);

// Notice Board — mounted via shared factory (zero duplication with
// /api/admin/notices). See routes/mobile/notices.js — it's a 10-line
// wrapper around utils/notice-reader-router.js.
router.use('/notices', require('./notices'));

router.get('/me', (req, res) => modernOk(res, { tech: req.tech }));

// Dashboard — aggregated payload (2026-05-25, repointed at the new
// orchestrator). Replaces the older 4-counts query. The orchestrator
// composes shared services so CRM + Mobile see the same counts logic.
//
// Query params:
//   noticesLimit (int 1-10, default 3) — how many notices to inline
//     in `notices.items` for the dashboard strip / carousel.
//
// See services/mobile-dashboard.service.js for the full payload shape.
const mobileDashboardService = require('../../services/mobile-dashboard.service');
router.get(
  '/dashboard',
  validate(Joi.object({
    noticesLimit: Joi.number().integer().min(1).max(10).optional(),
  }), 'query'),
  async (req, res, next) => {
    try {
      modernOk(res, await mobileDashboardService.getDashboard(
        req.tech.efr_id,
        { noticesLimit: req.query.noticesLimit },
      ));
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

// Jobs assigned to me
router.get('/jobs', async (req, res, next) => {
  try {
    const { rows, total } = await jobService.list({
      easyfixerId: req.tech.efr_id,
      status: req.query.status != null ? Number(req.query.status) : undefined,
      limit: Math.min(Number(req.query.limit) || 50, 200),
    });
    modernOk(res, { items: rows, total });
  } catch (e) { next(e); }
});

router.get('/jobs/:id', async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    modernOk(res, job);
  } catch (e) { next(e); }
});

// Status: 0 (BOOKED) → 1 (SCHEDULED). Now flows through shared
// jobService.setStatus(), which owns: audit-stamp logic, webhook
// fan-out (TechStart not fired here — accept doesn't trigger a
// client-facing webhook in the existing wiring), and any future
// transition rules (e.g. send_back_to_tx reset on completion).
// The "must be in status 0" guard previously enforced via WHERE
// clause is now enforced upstream: we verify in the handler before
// calling setStatus.
router.post('/jobs/:id/accept', async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    if (Number(job.job_status) !== 0) return modernError(res, 409, `cannot accept job in status ${job.job_status}`);
    await jobService.setStatus(
      job.job_id,
      { status: 1 /* SCHEDULED */ },
      { user_id: req.tech.efr_id },          // semantic note: efr_id stored as actor stamp
    );
    modernOk(res, { accepted: true });
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

// Reject: clears fk_easyfixter_id + drops to BOOKED + writes
// scheduling_history with the reason. Flows through shared
// jobService.unassign() — same code path CRM will use when an admin
// "force-unassigns" a job (e.g. tech is sick). Single transaction +
// single webhook fan-out (RescheduleTech) live in the shared service.
router.post('/jobs/:id/reject', validate(Joi.object({ reason: Joi.string().min(3).max(500).required() })), async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    await jobService.unassign(job.job_id, { reason: req.body.reason }, { user_id: req.tech.efr_id });
    modernOk(res, { rejected: true });
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

// ETA: tech-side "on the way" signal. NOT a status transition — just
// stamps `eta_status` + `eta_requested_time`. Routed through the
// shared setStatus() extras path (no-op transition pattern) so the
// stamps + last_update_time + any future side-effects live in one
// canonical function. eta_status / eta_requested_time are already on
// STATUS_EXTRAS_ALLOWLIST.
router.post('/jobs/:id/eta', validate(Joi.object({
  etaStatus: Joi.string().max(20).optional(),
  etaTime:   Joi.date().iso().optional(),
})), async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    await jobService.setStatus(
      job.job_id,
      {
        status: Number(job.job_status),        // no-op transition
        extras: {
          eta_status:         req.body.etaStatus || 'OTW',
          eta_requested_time: new Date(req.body.etaTime || Date.now()),
        },
      },
      { user_id: req.tech.efr_id },
    );
    modernOk(res, { sent: true });
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

// Status: → 2 (IN_PROGRESS). `setStatus` fires the TechStart webhook
// automatically based on the transition (BOOKED|SCHEDULED → IN_PROGRESS).
// Mobile-specific stamps (GPS, address, pincode, fk_checkin_by) ride
// through the `extras` whitelist so the transition rules + stamps land
// in a single shared UPDATE — no duplication of status-transition logic.
router.post('/jobs/:id/checkin', validate(Joi.object({
  gps: Joi.string().pattern(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).required(),
  address: Joi.string().max(500).optional(),
  pincode: Joi.string().pattern(/^[0-9]{6}$/).optional(),
  otp: Joi.string().optional(),
})), async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    await jobService.setStatus(
      job.job_id,
      {
        status: 2 /* IN_PROGRESS */,
        extras: {
          checkin_gps_location: req.body.gps,
          checkin_address:      req.body.address || null,
          checkin_pincode:      req.body.pincode || null,
          fk_checkin_by:        req.tech.efr_id,
        },
      },
      { user_id: req.tech.efr_id },
    );
    modernOk(res, { checkedIn: true });
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

// Status: 2 → 3 (COMPLETED). `setStatus` fires TechVisitComplete +
// stamps checkout_date_time + fk_checkout_by + (when the column exists)
// resets send_back_to_tx = 0. The mobile-specific `app_checkout_date_time`
// stamp rides through extras so all the transition side-effects land
// in a single UPDATE. See services/job.service.js::setStatus().
router.post('/jobs/:id/checkout', async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    await jobService.setStatus(
      job.job_id,
      {
        status: 3 /* COMPLETED */,
        extras: { app_checkout_date_time: new Date() },
      },
      { user_id: req.tech.efr_id },
    );
    modernOk(res, { checkedOut: true });
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

// Reschedule (tech-initiated). Doesn't change job_status; just shifts
// the appointment + stamps the reschedule audit columns. We call
// setStatus with the EXISTING status (no transition) just to ride
// through the extras-whitelist write path + emit the RescheduleTech
// webhook via the same code path /admin/jobs/:id/reschedule uses.
//
// `resch_job_count` is incremented via a follow-up query because the
// extras whitelist binds parameterised values — incrementing requires
// `COALESCE(resch_job_count, 0) + 1` which is an expression, not a
// bind. Done in a separate UPDATE; safe because both writes are on
// the same row and idempotent if a retry lands.
router.post('/jobs/:id/reschedule', validate(Joi.object({
  newDate: Joi.date().iso().required(),
  reasonId: Joi.number().integer().positive().required(),
  remarks: Joi.string().max(500).optional(),
})), async (req, res, next) => {
  try {
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    await jobService.setStatus(
      job.job_id,
      {
        status: Number(job.job_status),       // no-op transition; just rides the extras path
        extras: {
          requested_date_time:   new Date(req.body.newDate),
          reschedule_reason_id:  req.body.reasonId,
          reschedule_remarks:    req.body.remarks || null,
          reschedule_at_app:     new Date(),
          is_rescheduled_by_app: 1,
        },
      },
      { user_id: req.tech.efr_id },
    );
    await pool.query(
      `UPDATE tbl_job SET resch_job_count = COALESCE(resch_job_count, 0) + 1 WHERE job_id = ?`,
      [job.job_id],
    );
    // RescheduleTech webhook isn't auto-fired by setStatus on a no-op
    // transition — fire it explicitly here. (statusToEventName only
    // maps actual transitions; rescheduling isn't a status change.)
    jobService.fireWebhook('RescheduleTech', job.job_id);
    modernOk(res, { rescheduled: true });
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

// Profile sub-tree — covers the legacy /profile/* endpoints
router.get('/profile', async (req, res, next) => {
  try {
    const [[tech]] = await pool.query('SELECT * FROM tbl_easyfixer WHERE efr_id = ?', [req.tech.efr_id]);
    modernOk(res, tech);
  } catch (e) { next(e); }
});

router.get('/profile/percentage', async (req, res, next) => {
  try {
    const [[p]] = await pool.query(
      `SELECT efr_profile_perc, efr_personal_details_perc, efr_professional_details_perc,
              efr_bank_details_perc, efr_identity_details_perc
         FROM tbl_easyfixer WHERE efr_id = ?`, [req.tech.efr_id]);
    modernOk(res, p);
  } catch (e) { next(e); }
});

router.post('/profile/personal-details', async (req, res, next) => {
  try {
    const b = req.body || {};
    await pool.query(
      `UPDATE tbl_easyfixer SET
        efr_marital_status = COALESCE(?, efr_marital_status),
        efr_children = COALESCE(?, efr_children),
        date_of_birth = COALESCE(?, date_of_birth),
        about_yourself = COALESCE(?, about_yourself),
        efr_personal_details_perc = 100
       WHERE efr_id = ?`,
      [b.maritalStatus, b.children, b.dateOfBirth, b.about, req.tech.efr_id]);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

router.post('/profile/professional-details', async (req, res, next) => {
  try {
    const b = req.body || {};
    await pool.query(
      `UPDATE tbl_easyfixer SET experience_id = COALESCE(?, experience_id), efr_tools = COALESCE(?, efr_tools),
          efr_professional_details_perc = 100 WHERE efr_id = ?`,
      [b.experienceId, b.tools, req.tech.efr_id]);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

router.post('/profile/identity-details', validate(Joi.object({
  aadhaar: Joi.string().pattern(/^[0-9]{12}$/).optional(),
  pan: Joi.string().pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/i).optional(),
}).min(1)), async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE tbl_easyfixer SET adhaar_card_number = COALESCE(?, adhaar_card_number),
          pan_card_number = COALESCE(?, pan_card_number),
          efr_identity_details_perc = 100 WHERE efr_id = ?`,
      [req.body.aadhaar, req.body.pan, req.tech.efr_id]);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

router.get('/bank-details', async (req, res, next) => {
  try {
    const [[b]] = await pool.query('SELECT * FROM tbl_easyfixer_bank_details WHERE efr_id = ? LIMIT 1', [req.tech.efr_id]);
    modernOk(res, b || null);
  } catch (e) { next(e); }
});

router.post('/bank-details', async (req, res, next) => {
  try {
    const b = req.body || {};
    const [[existing]] = await pool.query('SELECT efr_bank_id FROM tbl_easyfixer_bank_details WHERE efr_id = ?', [req.tech.efr_id]);
    if (existing) {
      await pool.query(
        `UPDATE tbl_easyfixer_bank_details SET efr_bank_acc_num = ?, efr_bank_ifsc = ?, bank = ?, is_bank_details_filled = 1 WHERE efr_id = ?`,
        [b.accountNumber, b.ifsc, b.bankId || null, req.tech.efr_id]);
    } else {
      await pool.query(
        `INSERT INTO tbl_easyfixer_bank_details (efr_bank_acc_num, efr_bank_ifsc, bank, efr_id, is_bank_details_filled)
         VALUES (?, ?, ?, ?, 1)`,
        [b.accountNumber, b.ifsc, b.bankId || null, req.tech.efr_id]);
    }
    await pool.query('UPDATE tbl_easyfixer SET efr_bank_details_perc = 100 WHERE efr_id = ?', [req.tech.efr_id]);
    modernOk(res, { saved: true });
  } catch (e) { next(e); }
});

router.post('/device', validate(Joi.object({
  deviceId: Joi.string().required(),
  fcmToken: Joi.string().required(),
  appVersion: Joi.string().optional(),
  language: Joi.string().max(10).optional(),
})), async (req, res, next) => {
  try {
    await pool.query(
      `INSERT INTO device_info (user_id, device_id, fire_base_token, app_version_name, language, is_logged_in, last_login_time)
       VALUES (?, ?, ?, ?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE fire_base_token = VALUES(fire_base_token), is_logged_in = 1, last_login_time = NOW()`,
      [req.tech.efr_id, req.body.deviceId, req.body.fcmToken, req.body.appVersion || null, req.body.language || 'en']);
    modernOk(res, { registered: true });
  } catch (e) { next(e); }
});

// VERIFIED 2026-05-12 against ACD_APIs TrainingVideo.java:
//   training_videos columns: id, title, description, sub_title, sub_description
router.get('/training-videos', async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, title, description, sub_title, sub_description FROM training_videos ORDER BY id DESC'
    );
    modernOk(res, rows);
  } catch (e) { next(e); }
});

// Customer lookup by mobile (from tech app for OTP flows)
router.get('/customers/mobile/:mobile', async (req, res, next) => {
  try {
    const [[cust]] = await pool.query(
      'SELECT customer_id, customer_name, customer_mob_no, customer_email FROM tbl_customer WHERE customer_mob_no = ? LIMIT 1',
      [req.params.mobile]);
    modernOk(res, cust || null);
  } catch (e) { next(e); }
});

module.exports = router;
