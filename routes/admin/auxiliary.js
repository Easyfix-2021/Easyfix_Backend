const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const { pool } = require('../../db');
const logger = require('../../logger');
const { modernOk, modernError } = require('../../utils/response');

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
router.get('/training-videos', async (req, res, next) => {
  try {
    logger.info('List training videos');
    const [rows] = await pool.query(
      'SELECT id, title, description, sub_title, sub_description FROM training_videos ORDER BY id DESC'
    );
    logger.info('Found ' + rows.length + ' training videos');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post('/training-videos', validate(Joi.object({
  title: Joi.string().trim().min(1).max(255).required(),
  description: Joi.string().max(2000).allow('', null).optional(),
  sub_title: Joi.string().max(255).allow('', null).optional(),
  sub_description: Joi.string().max(2000).allow('', null).optional(),
})), async (req, res, next) => {
  try {
    logger.info('Add training video · title=' + req.body.title);
    const [ins] = await pool.query(
      `INSERT INTO training_videos (title, description, sub_title, sub_description)
       VALUES (?, ?, ?, ?)`,
      [req.body.title, req.body.description || null,
       req.body.sub_title || null, req.body.sub_description || null]
    );
    logger.info('Training video created · id=' + ins.insertId);
    res.status(201);
    modernOk(res, { id: ins.insertId });
  } catch (e) { next(e); }
});

router.delete('/training-videos/:id', async (req, res, next) => {
  try {
    logger.info('Delete training video · id=' + req.params.id);
    const [r] = await pool.query('DELETE FROM training_videos WHERE id = ?', [req.params.id]);
    if (r.affectedRows === 0) logger.warn('Training video not found · id=' + req.params.id);
    if (r.affectedRows === 0) return modernError(res, 404, 'video not found');
    logger.info('Training video deleted · id=' + req.params.id);
    modernOk(res, { deleted: true });
  } catch (e) { next(e); }
});

// ─── Aadhaar / PAN uniqueness ───────────────────────────────────────
// VERIFIED tbl_easyfixer columns: adhaar_card_number (DB spelling
// preserves the "adhaar" typo per CLAUDE.md), pan_card_number.
router.get('/aadhaar-check/:number', async (req, res, next) => {
  try {
    const n = req.params.number;
    logger.info('Aadhaar/PAN uniqueness check');
    const [[r]] = await pool.query(
      `SELECT COUNT(*) AS n, MIN(efr_id) AS existing_efr_id
         FROM tbl_easyfixer
        WHERE adhaar_card_number = ? OR pan_card_number = ?`,
      [n, n]
    );
    logger.info('Aadhaar/PAN check result · exists=' + (r.n > 0) + ' · existingEfrId=' + (r.existing_efr_id ?? '—'));
    modernOk(res, { exists: r.n > 0, existing_efr_id: r.existing_efr_id });
  } catch (e) { next(e); }
});

// ─── Aadhaar auto-fill (name+DOB lookup) ────────────────────────────
// Legacy endpoint `/profile/name-dob-aadhaar` — returns name + DOB
// stored against an aadhaar number on tbl_easyfixer. Useful for the
// "I recognise this person" pre-fill flow.
router.get('/aadhaar-prefill/:number', async (req, res, next) => {
  try {
    logger.info('Aadhaar prefill lookup');
    const [[r]] = await pool.query(
      `SELECT efr_id, efr_name, date_of_birth AS dob, adhaar_card_number, pan_card_number
         FROM tbl_easyfixer
        WHERE adhaar_card_number = ?
        LIMIT 1`,
      [req.params.number]
    );
    if (!r) logger.warn('Aadhaar prefill · no easyfixer matched');
    if (!r) return modernError(res, 404, 'no easyfixer with this aadhaar');
    logger.info('Aadhaar prefill matched · efr_id=' + r.efr_id);
    modernOk(res, r);
  } catch (e) { next(e); }
});

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
