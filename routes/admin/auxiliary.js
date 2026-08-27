const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const { pool } = require('../../db');
const logger = require('../../logger');
const { modernOk, modernError } = require('../../utils/response');
const { assertActiveAadhaarAvailable } = require('../../utils/aadhaar-uniqueness');
// Training videos are the LMS content catalogue; the reference counts and the
// list projection live with the rest of the LMS logic rather than being
// restated here. The ROUTES stay in this file because the technician app and
// the CRM have always read this table through /aux/training-videos.
const lms = require('../../services/lms.service');

/*
 * Auxiliary admin endpoints — attendance, training videos, materials,
 * Aadhaar uniqueness, geocoding proxy, bulk job reassignment.
 *
 * VERIFIED 2026-05-12 against legacy entity classes:
 *   tbl_easyfixer_attendance (ACD_APIs/Attendance.java):
 *     id (PK), easyfixer_id, morning_slot, evening_slot,
 *     is_leave_marked, created_on, insert_date, updated_on
 *     — NOT `efr_id`/`date`/`status`/`remarks` (those were assumed).
 *
 *   training_videos (TrainingVideo.java):
 *     id (PK), title, description, sub_title, sub_description
 *
 *   tbl_easyfixer aadhaar/PAN: adhaar_card_number (NOT `aadhaar` — DB
 *   spelling has "adhaar" — preserve), pan_card_number.
 */

// ─── Attendance ─────────────────────────────────────────────────────
router.get('/attendance', async (req, res, next) => {
  try {
    const { easyfixerId, from, to } = req.query;
    logger.info('List attendance · easyfixerId=' + (easyfixerId ?? 'all') + ' · from=' + (from || '—') + ' · to=' + (to || '—'));
    const clauses = [], params = [];
    if (easyfixerId != null) { clauses.push('easyfixer_id = ?'); params.push(easyfixerId); }
    if (from && to) {
      clauses.push('DATE(created_on) BETWEEN ? AND ?');
      params.push(from, to);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT id, easyfixer_id, morning_slot, evening_slot, is_leave_marked,
              created_on, insert_date, updated_on
         FROM tbl_easyfixer_attendance
        ${where}
        ORDER BY id DESC
        LIMIT 500`,
      params
    );
    logger.info('Found ' + rows.length + ' attendance rows');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post('/attendance', validate(Joi.object({
  easyfixerId: Joi.number().integer().positive().required(),
  morningSlot: Joi.string().max(50).allow('', null).optional(),
  eveningSlot: Joi.string().max(50).allow('', null).optional(),
  isLeaveMarked: Joi.number().integer().valid(0, 1).default(0),
})), async (req, res, next) => {
  try {
    logger.info('Mark attendance · easyfixerId=' + req.body.easyfixerId + ' · isLeaveMarked=' + req.body.isLeaveMarked);
    const [ins] = await pool.query(
      `INSERT INTO tbl_easyfixer_attendance
         (easyfixer_id, morning_slot, evening_slot, is_leave_marked, created_on, insert_date)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [req.body.easyfixerId, req.body.morningSlot || null,
       req.body.eveningSlot || null, req.body.isLeaveMarked]
    );
    logger.info('Attendance created · id=' + ins.insertId);
    res.status(201);
    modernOk(res, { id: ins.insertId });
  } catch (e) { next(e); }
});

// ─── Materials ──────────────────────────────────────────────────────
// `job_material` column layout (verified against legacy
// `Easyfix_CRM/.../MaterialDaoImpl.java::saveMaterial`):
//   id, name, description, sku, unit (INT), unit_price (FLOAT),
//   total_price (FLOAT), tx_charge (FLOAT), job_id
// The frontend modal speaks `materialName`/`unitPrice`/`quantity`, so we
// translate at the route boundary and keep the legacy column names intact.
// `total_price` is server-side computed = unit_price × quantity so the
// stored value can never drift from the math, regardless of what the
// client sends.
router.get('/materials/job/:jobId', async (req, res, next) => {
  try {
    logger.info('List materials for job · jobId=' + req.params.jobId);
    const [rows] = await pool.query(
      `SELECT id, job_id, name AS material_name, description, sku,
              unit, unit_price, total_price
         FROM job_material
        WHERE job_id = ?
        ORDER BY id DESC`,
      [req.params.jobId]
    );
    logger.info('Found ' + rows.length + ' materials');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post('/materials', async (req, res, next) => {
  try {
    const b = req.body || {};
    logger.info('Add material · jobId=' + (b.jobId ?? '—') + ' · sku=' + (b.sku ?? '—'));
    // Explicit per-field validation — return the missing-field list so the
    // frontend can highlight the corresponding inputs rather than showing
    // a generic "Internal Server Error". Matches the legacy CRM's
    // `addAndUpdateMaterial` server-side checks.
    const missing = [];
    if (!b.jobId)                                  missing.push('jobId');
    if (!b.materialName || !String(b.materialName).trim()) missing.push('materialName');
    if (b.sku == null || String(b.sku).trim() === '')      missing.push('sku');
    if (b.unit == null || String(b.unit).trim() === '')    missing.push('unit');
    const unitPrice = Number(b.unitPrice);
    const quantity  = Number(b.quantity);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) missing.push('unitPrice');
    if (!Number.isFinite(quantity)  || quantity  <= 0) missing.push('quantity');
    if (missing.length) {
      logger.warn('Add material rejected · missing=' + missing.join(','));
      return modernError(res, 400, `Missing required fields: ${missing.join(', ')}`, { missing });
    }
    // Legacy `job_material.unit` is INT (Material.unit Java field). The new
    // UI lets operators type free-text labels like "m" / "pcs" because no
    // unit-master table exists to back a dropdown. Coerce: if the supplied
    // unit parses as a positive integer, store it; otherwise store 0
    // (matches legacy default for missing/unknown units). The free-text
    // value still travels through — see comment row below: we don't lose
    // it because the form-side description / SKU usually carry brand info.
    const unitInt = Number.isInteger(Number(b.unit)) && Number(b.unit) > 0 ? Number(b.unit) : 0;
    const totalPrice = unitPrice * quantity;
    const [ins] = await pool.query(
      `INSERT INTO job_material (job_id, name, description, sku, unit, unit_price, total_price)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(b.jobId), String(b.materialName).trim(), b.description || null,
        String(b.sku).trim(), unitInt, unitPrice, totalPrice,
      ]
    );
    logger.info('Material created · id=' + ins.insertId + ' · totalPrice=' + totalPrice);
    res.status(201);
    modernOk(res, { id: ins.insertId, total_price: totalPrice });
  } catch (e) { next(e); }
});

router.delete('/materials/:id', async (req, res, next) => {
  try {
    logger.info('Delete material · id=' + req.params.id);
    await pool.query('DELETE FROM job_material WHERE id = ?', [req.params.id]);
    logger.info('Material deleted · id=' + req.params.id);
    modernOk(res, { deleted: true });
  } catch (e) { next(e); }
});

// ─── Training videos ────────────────────────────────────────────────
/*
 * The LMS content catalogue. Beyond the plain columns, each row carries:
 *
 *   progress_count — technicians holding watched progress against this video
 *   course_count   — courses that include it
 *
 * Both exist so the CRM can show an operator WHY a delete will be refused
 * before they click it, rather than surfacing a 409 as a surprise.
 *
 * Response shape is {rows, total, limit, offset}, not a bare array. Nothing
 * consumed the previous array form (verified 2026-08-13 across the CRM and
 * this repo) — the technician app reads the separate /api/mobile route.
 */
router.get('/training-videos', validate(Joi.object({
  q: Joi.string().allow('', null).optional(),
  limit: Joi.number().integer().min(1).max(1000).default(200),
  offset: Joi.number().integer().min(0).default(0),
}), 'query'), async (req, res, next) => {
  try {
    logger.info('List training videos · q=' + (req.query.q || ''));
    modernOk(res, await lms.listVideos(req.query));
  } catch (e) { next(e); }
});

router.patch('/training-videos/:id', validate(Joi.object({
  id: Joi.number().integer().positive().required(),
}), 'params'), validate(Joi.object({
  title: Joi.string().trim().min(1).max(255).optional(),
  description: Joi.string().max(2000).allow('', null).optional(),
  sub_title: Joi.string().max(255).allow('', null).optional(),
  sub_description: Joi.string().max(2000).allow('', null).optional(),
  video_url: Joi.string().max(500).allow('', null).optional(),
}).min(1)), async (req, res, next) => {
  try {
    /*
     * video_url lives on the joined document row, so it is applied separately
     * from the training_videos column writes. An edit that ONLY changes the
     * link is legitimate, which is why the column UPDATE below is skipped
     * rather than run with an empty SET (that would be a syntax error).
     */
    if (req.body.video_url !== undefined) {
      await lms.setVideoLink(req.params.id, req.body.video_url, req.user?.user_id ?? null);
    }
    const sets = [];
    const params = [];
    /*
     * Each field is written with a plain placeholder rather than
     * COALESCE(?, col). COALESCE only falls back on NULL — an empty string
     * passes through it and blanks the column while looking like a guard.
     * Clearing a sub-title is a legitimate edit, so '' is stored as NULL
     * explicitly and only the fields actually sent are touched.
     */
    for (const field of ['title', 'description', 'sub_title', 'sub_description']) {
      if (req.body[field] === undefined) continue;
      sets.push(`${field} = ?`);
      params.push(req.body[field] === '' ? null : req.body[field]);
    }
    logger.info('Update training video · id=' + req.params.id + ' · fields=' + sets.length);
    // A link-only edit leaves `sets` empty; setVideoLink already 404s on an
    // unknown id, so there is nothing left to do and an empty SET would throw.
    if (!sets.length) return modernOk(res, { updated: true });
    const [r] = await pool.query(
      `UPDATE training_videos SET ${sets.join(', ')} WHERE id = ?`,
      [...params, req.params.id],
    );
    if (r.affectedRows === 0) return modernError(res, 404, 'video not found');
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

router.post('/training-videos', validate(Joi.object({
  title: Joi.string().trim().min(1).max(255).required(),
  description: Joi.string().max(2000).allow('', null).optional(),
  sub_title: Joi.string().max(255).allow('', null).optional(),
  sub_description: Joi.string().max(2000).allow('', null).optional(),
  // Stored via the legacy document row, not as a column here — see setVideoLink.
  video_url: Joi.string().max(500).allow('', null).optional(),
})), async (req, res, next) => {
  try {
    logger.info('Add training video · title=' + req.body.title);
    /*
     * Validate the link BEFORE inserting the row. setVideoLink would reject a
     * non-YouTube URL with a 400 anyway, but by then the catalogue row exists
     * and the operator gets an error on a video that was silently created —
     * they retry, and end up with duplicates.
     */
    if (String(req.body.video_url || '').trim() && !lms.parseYouTubeUrl(req.body.video_url)) {
      return modernError(res, 400, 'video link must be a YouTube URL');
    }
    const { videoGlobal } = await lms.lmsFlagColumns();
    const [ins] = await pool.query(
      /*
       * is_global = 0. A catalogue row created here is CONTENT; it becomes
       * something every technician must watch by being put into a course
       * flagged mandatory, never by existing. The column defaults to 1 so the
       * three pre-LMS rows kept their meaning through the migration — new rows
       * must opt IN, or adding a video silently re-creates the 2026-08-26
       * platform-wide earning lockout.
       */
      //
      // Named only once the column is PROBED PRESENT. Omitting it is safe
      // pre-migration (there is no column to default) and unsafe after — the
      // DEFAULT is 1, so a dropped column here would make every new video
      // globally mandatory. lms.lmsFlagColumns() is what tells the two apart.
      `INSERT INTO training_videos (title, description, sub_title, sub_description${videoGlobal ? ', is_global' : ''})
       VALUES (?, ?, ?, ?${videoGlobal ? ', 0' : ''})`,
      [req.body.title, req.body.description || null,
       req.body.sub_title || null, req.body.sub_description || null]
    );
    if (String(req.body.video_url || '').trim()) {
      await lms.setVideoLink(ins.insertId, req.body.video_url, req.user?.user_id ?? null);
    }
    lms.invalidateVideoIdCache();
    logger.info('Training video created · id=' + ins.insertId);
    res.status(201);
    modernOk(res, { id: ins.insertId });
  } catch (e) { next(e); }
});

/*
 * Deleting a training video is REFUSED while anything references it.
 *
 * This table and easyfixer_watched_video are both MyISAM. MySQL accepts
 * foreign keys on MyISAM and then silently ignores them, so the constraints
 * that appear on easyfixer_watched_video are decorative — they read as a
 * guarantee and enforce nothing. This route was the only thing standing
 * between an operator and orphaned progress, and it did not stand:
 * 5 progress rows across 3 deleted video ids were already stranded before
 * this guard existed (measured 2026-08-13).
 *
 * Refusal rather than soft-delete is deliberate. training_videos is a legacy
 * Java table that the technician app reads directly through
 * /api/mobile/training-videos; adding a status column would mean teaching
 * every existing reader to filter on it, and a reader that forgot would keep
 * serving withdrawn content. A 409 that names the blocking count costs the
 * operator one extra step and cannot fail silently. The counts are also on
 * the list response, so the CRM can disable the button before it is clicked.
 *
 * Escape hatch: unassign the video from its courses and the course side
 * clears; progress rows are historical fact and are never bulk-deleted here.
 */
router.delete('/training-videos/:id', async (req, res, next) => {
  try {
    logger.info('Delete training video · id=' + req.params.id);
    const [exists] = await pool.query('SELECT id FROM training_videos WHERE id = ?', [req.params.id]);
    if (!exists.length) {
      logger.warn('Training video not found · id=' + req.params.id);
      return modernError(res, 404, 'video not found');
    }

    const [progressCount, courseCount] = await Promise.all([
      lms.videoProgressCount(req.params.id),
      lms.videoCourseCount(req.params.id),
    ]);
    if (progressCount > 0 || courseCount > 0) {
      const blockers = [];
      if (progressCount > 0) blockers.push(`${progressCount} technician progress record(s)`);
      if (courseCount > 0) blockers.push(`${courseCount} course(s)`);
      logger.warn('Training video delete refused · id=' + req.params.id
        + ' · progress=' + progressCount + ' · courses=' + courseCount);
      return modernError(
        res, 409,
        `cannot delete this video — it is referenced by ${blockers.join(' and ')}`,
        { progress_count: progressCount, course_count: courseCount },
      );
    }

    const [r] = await pool.query('DELETE FROM training_videos WHERE id = ?', [req.params.id]);
    if (r.affectedRows === 0) return modernError(res, 404, 'video not found');
    // Drop the id cache so the mobile validator cannot keep accepting progress
    // for this video for the rest of its TTL.
    lms.invalidateVideoIdCache();
    logger.info('Training video deleted · id=' + req.params.id);
    modernOk(res, { deleted: true });
  } catch (e) { next(e); }
});

/*
 * ─── Aadhaar / PAN uniqueness ───────────────────────────────────────
 * VERIFIED tbl_easyfixer columns: adhaar_card_number (DB spelling preserves the
 * "adhaar" typo per CLAUDE.md), pan_card_number.
 *
 * Hardened 2026-08-12. Three defects, all fixed here:
 *
 *  1. GET with a path param put the Aadhaar into req.originalUrl, which
 *     middleware/http-log.js prints on EVERY request — the value was in the
 *     access log on every call. Now a POST body, which is not logged.
 *  2. The response returned `existing_efr_id`, turning a yes/no check into an
 *     Aadhaar-to-technician resolver. It now returns a bare boolean: an operator
 *     needs to know the number is taken, not by whom.
 *  3. The predicate ignored efr_status, so a soft-deleted (efr_status = 3)
 *     technician still reported the number as taken — contradicting the
 *     generated column, which frees a deleted row's number. Delegated to the
 *     shared guard's semantics so this can no longer drift from the write path.
 */
router.post('/aadhaar-check', validate(Joi.object({
  number: Joi.string().trim().pattern(/^([0-9]{12}|[A-Za-z]{5}[0-9]{4}[A-Za-z])$/).required()
    .messages({ 'string.pattern.base': 'number must be a 12-digit Aadhaar or a valid PAN' }),
})), async (req, res, next) => {
  try {
    logger.info('Aadhaar/PAN uniqueness check');
    let exists = false;
    try {
      // excludeEfrId 0 — this is a pre-create check with no row of its own.
      await assertActiveAadhaarAvailable(pool, req.body.number, 0);
    } catch (error) {
      if (error?.details?.code !== 'AADHAAR_ALREADY_REGISTERED') throw error;
      exists = true;
    }
    logger.info('Aadhaar/PAN check result · exists=' + exists);
    modernOk(res, { exists });
  } catch (e) { next(e); }
});

/*
 * ─── Aadhaar auto-fill (name+DOB lookup) — REMOVED 2026-08-12 ────────
 * `GET /aadhaar-prefill/:number` returned efr_id, name, date of birth,
 * adhaar_card_number AND pan_card_number for whoever held a GUESSED Aadhaar,
 * with no efr_status filter. Any CRM user could walk the 12-digit space and
 * harvest full identity records — the number is the lookup key, so knowing it is
 * the only "authorisation" the endpoint ever required. It had no caller in any
 * repo (CRM UI, client UI, mobile app), so the "I recognise this person" prefill
 * flow it was ported for was never built.
 *
 * Do not reintroduce a lookup keyed on an identity number. If a prefill flow is
 * ever needed, key it on something the operator already legitimately holds (an
 * efr_id from a list they can see) and return the minimum needed.
 */

// ─── Geocoding proxy (MapMyIndia) with simple in-memory token cache ─
// The legacy geocoding flow has two endpoints: (1) get an OAuth token,
// (2) call CITY_DETAILS_URL. Token is reused across requests until it
// expires (~24h). In-memory cache is fine for a single Node instance;
// when we scale horizontally, lift this to Redis (Phase 14).
let _mmiToken = { value: null, expiresAt: 0 };
async function getMmiToken() {
  if (_mmiToken.value && Date.now() < _mmiToken.expiresAt) return _mmiToken.value;
  const url = process.env.MMI_TOKEN_URL;
  const clientId = process.env.MMI_CLIENT_ID;
  const clientSecret = process.env.MMI_CLIENT_SECRET;
  if (!url || !clientId || !clientSecret) return null;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  const ttlMs = (Number(j.expires_in) || 3600) * 1000;
  _mmiToken = { value: j.access_token, expiresAt: Date.now() + ttlMs - 30_000 };
  return _mmiToken.value;
}

router.get('/geocode/:pincode', async (req, res, next) => {
  try {
    logger.info('Geocode pincode · pincode=' + req.params.pincode);
    const token = await getMmiToken();
    if (!token) {
      logger.warn('Geocode skipped · MMI credentials not configured');
      return modernOk(res, {
        pincode: req.params.pincode,
        note: 'MMI credentials not configured (MMI_TOKEN_URL/MMI_CLIENT_ID/MMI_CLIENT_SECRET)',
      });
    }
    const url = `${process.env.MMI_CITY_DETAILS_URL}?pincode=${encodeURIComponent(req.params.pincode)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) logger.warn('Geocode upstream failed · status=' + r.status);
    if (!r.ok) return modernError(res, r.status, await r.text());
    const data = await r.json();
    logger.info('Geocode resolved · pincode=' + req.params.pincode);
    modernOk(res, data);
  } catch (e) { next(e); }
});

// ─── Experience catalog ─────────────────────────────────────────────
router.get('/experience', async (req, res, next) => {
  try {
    logger.info('List experience catalog');
    const [rows] = await pool.query('SELECT * FROM experience ORDER BY id').catch(() => [[]]);
    logger.info('Found ' + rows.length + ' experience entries');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.get('/marital-status', async (req, res) => {
  modernOk(res, [
    { id: 1, name: 'Single' }, { id: 2, name: 'Married' },
    { id: 3, name: 'Divorced' }, { id: 4, name: 'Widowed' },
  ]);
});

// ─── Bulk job reassign ──────────────────────────────────────────────
// Mirrors legacy `activeUserJobAssignment` (activeUserJobListAction.java).
// Round-robins active jobs (status 0,1,2,3,4) across a given set of
// admin user_ids. Used by ops to reshuffle ownership when staff joins
// or leaves; not for technician (efr) assignment — that's auto-assign.
router.post('/bulk-reassign', validate(Joi.object({
  userIds: Joi.array().items(Joi.number().integer().positive()).min(1).required(),
  statuses: Joi.array().items(Joi.number().integer()).default([0, 1, 2, 3, 4]),
  limit: Joi.number().integer().min(1).max(5000).default(500),
})), async (req, res, next) => {
  try {
    logger.info('Bulk reassign jobs · userCount=' + req.body.userIds.length + ' · statuses=[' + req.body.statuses.join(',') + '] · limit=' + req.body.limit);
    const placeholders = req.body.statuses.map(() => '?').join(',');
    const [jobs] = await pool.query(
      `SELECT job_id FROM tbl_job
        WHERE job_status IN (${placeholders})
        ORDER BY job_id
        LIMIT ?`,
      [...req.body.statuses, req.body.limit]
    );
    logger.info('Found ' + jobs.length + ' jobs to reassign');
    const conn = await pool.getConnection();
    let reassigned = 0;
    try {
      await conn.beginTransaction();
      for (let i = 0; i < jobs.length; i++) {
        const ownerId = req.body.userIds[i % req.body.userIds.length];
        await conn.query(
          'UPDATE tbl_job SET job_owner = ?, last_update_time = NOW() WHERE job_id = ?',
          [ownerId, jobs[i].job_id]
        );
        reassigned++;
      }
      await conn.commit();
    } catch (err) { await conn.rollback(); throw err; } finally { conn.release(); }
    logger.info('Bulk reassign done · reassigned=' + reassigned);
    modernOk(res, { reassigned, userCount: req.body.userIds.length });
  } catch (e) { next(e); }
});

module.exports = router;
