const { pool } = require('../db');
const logger = require('../logger');
const { nameKey } = require('../utils/name-key');
const materialSvc = require('./material.service');

/*
 * Material Add Requests (Material Management phase 2, sub-project A). See
 * docs/superpowers/specs/2026-09-18-material-add-requests-design.md.
 *
 * tbl_material_add_request is a request LOG, not a second master — approving
 * a row calls services/material.service.js createMaterial() so there is
 * exactly one place a material can be born.
 *
 * request_status: 1 pending, 2 approved, 3 rejected.
 *
 * ponytail: approve() cannot literally share ONE DB transaction with
 * createMaterial(), because that function owns and commits its own
 * connection (services/material.service.js is out of scope for this
 * change — see the task's touch-only-these-files rule). Instead: create the
 * master material first (atomic on its own), then stamp the request in a
 * second transaction; if the stamp fails (lost race, DB error), the just-
 * created material is deleted to avoid an orphan. This preserves the two
 * guarantees the design actually needs — a failing material create leaves
 * no half-approved request, and a failing stamp leaves no orphaned master
 * row — without editing a file outside this task's scope. Upgrade path: give
 * createMaterial an optional `conn` parameter if a real nested transaction
 * is ever required.
 */

const STATUS = Object.freeze({ PENDING: 1, APPROVED: 2, REJECTED: 3 });
const STATUS_NAME_TO_CODE = Object.freeze({ pending: STATUS.PENDING, approved: STATUS.APPROVED, rejected: STATUS.REJECTED });

function mkErr(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

// ─── Mobile: ownership guard (mirrors services/mobile-job-estimate.service.js
// jobForTech — duplicated rather than imported so this file stays independent
// of that service, which is out of this task's scope) ──────────────────────
async function jobForTech(jobId, efrId) {
  const [[row]] = await pool.query(
    `SELECT job_id, fk_easyfixter_id, fk_service_catg_id FROM tbl_job WHERE job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!row) return null;
  if (Number(row.fk_easyfixter_id) !== Number(efrId)) return null;
  return row;
}

async function getRequestById(id) {
  const [[row]] = await pool.query(
    `SELECT request_id, material_name, brand_name, service_catg_id, job_id, efr_id,
            expected_price, qty, note, CAST(request_status AS SIGNED) AS request_status,
            reject_reason, material_id, reviewed_by, reviewed_at, created_at
       FROM tbl_material_add_request WHERE request_id = ? LIMIT 1`,
    [id],
  );
  return row || null;
}

// ─── Mobile: raise + list ───────────────────────────────────────────────

/*
 * Raise a material-add request from a job. service_catg_id is READ FROM THE
 * JOB row (fk_service_catg_id) — any service_catg_id in `payload` is ignored
 * on purpose, so a technician can never mint a duplicate in a category they
 * don't belong to (see the design's "Data model" section).
 */
async function createFromJob(jobId, efrId, payload = {}) {
  const job = await jobForTech(jobId, efrId);
  if (!job) { logger.warn('Material add request failed · job not found or not owned · jobId=' + jobId); throw mkErr(404, 'job not found'); }

  const name = String(payload.material_name || '').trim();
  if (!name) throw mkErr(400, 'material_name is required');

  const [ins] = await pool.query(
    `INSERT INTO tbl_material_add_request
       (material_name, brand_name, service_catg_id, job_id, efr_id, expected_price, qty, note, request_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      payload.brand_name || null,
      job.fk_service_catg_id,
      jobId,
      efrId,
      payload.expected_price ?? null,
      payload.qty ?? null,
      payload.note || null,
      STATUS.PENDING,
      new Date(),
    ],
  );
  logger.info('Material add request created · id=' + ins.insertId + ' · jobId=' + jobId);
  return getRequestById(ins.insertId);
}

async function listForJob(jobId, efrId) {
  const job = await jobForTech(jobId, efrId);
  if (!job) throw mkErr(404, 'job not found');
  const [rows] = await pool.query(
    `SELECT request_id, material_name, brand_name, service_catg_id, job_id, efr_id,
            expected_price, qty, note, CAST(request_status AS SIGNED) AS request_status,
            reject_reason, material_id, reviewed_by, reviewed_at, created_at
       FROM tbl_material_add_request WHERE job_id = ? ORDER BY created_at DESC`,
    [jobId],
  );
  return { items: rows };
}

// ─── Admin: list / count ────────────────────────────────────────────────

async function listRequests({ status, search, page = 0, limit = 20 } = {}) {
  limit = Math.min(Math.max(Number(limit) || 20, 1), 1000);
  page = Math.max(Number(page) || 0, 0);
  const offset = page * limit;

  const where = [];
  const params = [];
  if (status && STATUS_NAME_TO_CODE[status]) { where.push('r.request_status = ?'); params.push(STATUS_NAME_TO_CODE[status]); }
  if (search) { where.push('r.material_name LIKE ?'); params.push(`%${search}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await pool.query(
    `SELECT r.request_id, r.material_name, r.brand_name, r.service_catg_id, sc.service_catg_name,
            r.job_id, r.efr_id, r.expected_price, r.qty, r.note,
            CAST(r.request_status AS SIGNED) AS request_status,
            r.reject_reason, r.material_id, r.reviewed_by, r.reviewed_at, r.created_at
       FROM tbl_material_add_request r
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = r.service_catg_id
       ${whereSql}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const [[totalRow]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_material_add_request r ${whereSql}`,
    params,
  );
  return { items: rows, total: totalRow ? totalRow.total : 0 };
}

async function countRequests({ status = 'pending' } = {}) {
  const code = STATUS_NAME_TO_CODE[status] || STATUS.PENDING;
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS count FROM tbl_material_add_request WHERE request_status = ?`,
    [code],
  );
  return { count: row ? row.count : 0 };
}

// ─── Admin: approve / reject ────────────────────────────────────────────

async function approveRequest(id, body = {}, actor = {}) {
  const reqRow = await getRequestById(id);
  if (!reqRow) throw mkErr(404, 'Request not found');
  if (reqRow.request_status !== STATUS.PENDING) throw mkErr(409, 'Request has already been reviewed');

  let materialId;
  let createdHere = false;

  if (body.link_material_id) {
    const [[mat]] = await pool.query(
      `SELECT material_id, material_name FROM tbl_material_master WHERE material_id = ? AND status = 1 LIMIT 1`,
      [body.link_material_id],
    );
    if (!mat) throw mkErr(422, 'link_material_id does not exist or is inactive');
    materialId = mat.material_id;
  } else {
    const name = String(body.material_name || reqRow.material_name || '').trim();
    const serviceCatgId = body.service_catg_id || reqRow.service_catg_id;
    const key = nameKey(name);
    const [[dup]] = await pool.query(
      `SELECT material_id, material_name FROM tbl_material_master WHERE material_key = ? AND service_catg_id = ? AND status = 1 LIMIT 1`,
      [key, serviceCatgId],
    );
    if (dup) {
      throw mkErr(409, `A material named "${dup.material_name}" already exists in this category — link this request to it instead (link_material_id), or choose a different name.`, { existing_material_id: dup.material_id, existing_material_name: dup.material_name });
    }

    const created = await materialSvc.createMaterial({
      material_name: name,
      description: body.description,
      service_catg_id: serviceCatgId,
      uom_id: body.uom_id,
      pricing_type: body.pricing_type,
      groups: body.groups,
    }, actor);
    materialId = created.material_id;
    createdHere = true;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      `UPDATE tbl_material_add_request
          SET request_status = ?, material_id = ?, reviewed_by = ?, reviewed_at = ?
        WHERE request_id = ? AND request_status = ?`,
      [STATUS.APPROVED, materialId, actor.userId || null, new Date(), id, STATUS.PENDING],
    );
    if (r.affectedRows === 0) throw mkErr(409, 'Request has already been reviewed');
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    if (createdHere) {
      // Compensate: don't leave an orphaned master material behind a request
      // that failed to stamp — this is the "no half-approved request" guarantee
      // from the other direction (create succeeded, stamp failed).
      await materialSvc.deleteMaterial(materialId).catch((ce) => {
        logger.error('Failed to roll back orphaned material after approve failure · material_id=' + materialId + ' · ' + ce.message);
      });
    }
    logger.error('Approve material request failed, rolled back · request_id=' + id + ' · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }

  logger.info('Material request approved · id=' + id + ' · material_id=' + materialId);
  return getRequestById(id);
}

async function rejectRequest(id, body = {}, actor = {}) {
  const reason = String(body.reject_reason || '').trim();
  if (!reason) throw mkErr(422, 'reject_reason is required');

  const reqRow = await getRequestById(id);
  if (!reqRow) throw mkErr(404, 'Request not found');
  if (reqRow.request_status !== STATUS.PENDING) throw mkErr(409, 'Request has already been reviewed');

  const [r] = await pool.query(
    `UPDATE tbl_material_add_request
        SET request_status = ?, reject_reason = ?, reviewed_by = ?, reviewed_at = ?
      WHERE request_id = ? AND request_status = ?`,
    [STATUS.REJECTED, reason, actor.userId || null, new Date(), id, STATUS.PENDING],
  );
  if (r.affectedRows === 0) throw mkErr(409, 'Request has already been reviewed');

  logger.info('Material request rejected · id=' + id);
  return getRequestById(id);
}

module.exports = {
  mkErr,
  createFromJob,
  listForJob,
  listRequests,
  countRequests,
  getRequestById,
  approveRequest,
  rejectRequest,
  STATUS,
};
