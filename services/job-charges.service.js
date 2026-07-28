const { pool } = require('../db');
const logger = require('../logger');

/*
 * Billing & Charges — job-workspace service backing the CRM "Billing & Charges"
 * tab. Reads/writes the FOUR existing tables (no new tables, no DDL):
 *
 *   Penalty / Travel / Incentive → typed rows in `job_material` discriminated
 *     by the `type` column ('Penalty' | 'Travel' | 'Incentive'). Legacy CRM
 *     reads these same rows for margin / invoice math, so the column layout +
 *     casing MUST match the legacy insert (EasyFix_CRM MaterialDaoImpl
 *     createTravel/createIncentive/createPenalty). Verified against live
 *     INFORMATION_SCHEMA 2026-07-28:
 *       id(PK), job_id, type(varchar), tx_charge(FLOAT), client_charge(FLOAT),
 *       reason, from_city_name, to_city_name, total_distance(INT), tx_unit(INT),
 *       cx_unit(INT), document_name, is_client_approval_needed(BIT(1)),
 *       is_pre_approved(INT), inserted_by(varchar), inserted_date_time(datetime),
 *       updated_by(varchar), updated_date_time(datetime).
 *
 *   Service billing approval → `tbl_job_services.approval_by_client` (1-col
 *     UPDATE; legacy JobDaoImpl.updateJobServiceApprovalByClient).
 *
 *   Job Sheet / Purchase Order documents → `tbl_job_image` rows discriminated
 *     by `image_category`. The shared job-image.service lowercases the category
 *     on write, so reads/deletes match case-insensitively.
 *
 * LEGACY SEMANTICS matched here:
 *   - EXACT type casing 'Penalty' / 'Travel' / 'Incentive'.
 *   - is_pre_approved is stamped 1 on every insert (legacy ps.setBoolean(true)).
 *   - client_charge >= tx_charge is enforced (reject otherwise) — client_charge
 *     is what EasyFix bills the client, tx_charge is what it pays the technician;
 *     a negative margin is always an operator error.
 *   - inserted_by / updated_by carry the acting tbl_user id (varchar column;
 *     stored as string).
 *   - inserted_date_time / updated_date_time are stamped with `new Date()` and
 *     the pool timezone (+05:30) writes IST wall-clock verbatim into the
 *     DATETIME column — NEVER SQL NOW() (see DATETIME IST convention).
 */

const CHARGE_TYPES = ['Penalty', 'Travel', 'Incentive'];
// image_category values (canonical labels). Stored lowercased by the shared
// job-image.service; compared case-insensitively on read/delete.
const DOC_CATEGORIES = ['JobSheet', 'PurchaseOrder'];

// The authenticated serve endpoint the CRM already uses for job images
// (302 → presigned S3 / local stream). Same URL shape the Images tab reads;
// the FE fetches it with its bearer token (plain <img> would 401).
function imageUrl(imageId) {
  return '/api/admin/jobs/images/' + imageId + '/file';
}

// BIT(1) column — normalise a truthy/0/1/'1' input to a 0/1 integer for storage.
function approvalBit(v) {
  return v === true || v === 1 || v === '1' ? 1 : 0;
}

// Reject a charge whose client_charge is below its tx_charge. Both are already
// coerced to numbers by Joi at the route boundary.
function assertChargeOrder(txCharge, clientCharge) {
  if (Number(clientCharge) < Number(txCharge)) {
    const e = new Error('client_charge must be greater than or equal to tx_charge');
    e.status = 400;
    throw e;
  }
}

// ─── READ ────────────────────────────────────────────────────────────
async function getCharges(jobId) {
  const id = Number(jobId);
  logger.info('Load job charges · jobId=' + id);

  const [materials] = await pool.query(
    `SELECT id, type, tx_charge, client_charge, reason,
            from_city_name, to_city_name, total_distance,
            tx_unit, cx_unit, document_name, is_client_approval_needed
       FROM job_material
      WHERE job_id = ? AND type IN (?, ?, ?)
      ORDER BY id DESC`,
    [id, ...CHARGE_TYPES]
  );

  // service_name: prefer the client rate-card label (what estimate/preview
  // shows), fall back to the service-type name, then the stored description.
  const [services] = await pool.query(
    `SELECT js.job_service_id,
            COALESCE(CR.crc_ratecard_name, st.service_type_name, js.service_charge_description) AS service_name,
            js.total_charge, js.quantity, js.approval_by_client, js.is_approved_by_pm
       FROM tbl_job_services js
       LEFT JOIN tbl_client_service   CS ON CS.client_service_id = js.service_id
       LEFT JOIN tbl_client_rate_card CR ON CR.crc_id            = CS.rate_card_id
       LEFT JOIN tbl_service_type     st ON st.service_type_id   = js.service_type_id
      WHERE js.job_id = ?
        AND (js.job_service_status IS NULL OR js.job_service_status <> 0)
      ORDER BY js.job_service_id ASC`,
    [id]
  );

  const [docRows] = await pool.query(
    `SELECT image_id, image_category
       FROM tbl_job_image
      WHERE job_id = ? AND LOWER(image_category) IN ('jobsheet', 'purchaseorder')
      ORDER BY image_id ASC`,
    [id]
  );
  const documents = { jobSheet: [], purchaseOrder: [] };
  for (const r of docRows) {
    const bucket = String(r.image_category || '').toLowerCase() === 'jobsheet'
      ? 'jobSheet' : 'purchaseOrder';
    documents[bucket].push({ image_id: r.image_id, url: imageUrl(r.image_id) });
  }

  logger.info('Job charges loaded · jobId=' + id + ' materials=' + materials.length
    + ' services=' + services.length + ' jobSheet=' + documents.jobSheet.length
    + ' purchaseOrder=' + documents.purchaseOrder.length);
  return { materials, services, documents };
}

// ─── CREATE (job_material typed inserts) ─────────────────────────────
async function createPenalty(jobId, b, userId) {
  assertChargeOrder(b.txCharge, b.clientCharge);
  const [ins] = await pool.query(
    `INSERT INTO job_material
       (job_id, type, tx_charge, client_charge, reason, document_name,
        is_client_approval_needed, is_pre_approved, inserted_by, inserted_date_time)
     VALUES (?, 'Penalty', ?, ?, ?, ?, ?, 1, ?, ?)`,
    [Number(jobId), b.txCharge, b.clientCharge, b.reason ?? null,
     b.documentName ?? null, approvalBit(b.isClientApprovalNeeded),
     String(userId), new Date()]
  );
  logger.info('Penalty created · id=' + ins.insertId + ' · jobId=' + jobId);
  return { id: ins.insertId, type: 'Penalty' };
}

async function createTravel(jobId, b, userId) {
  assertChargeOrder(b.txCharge, b.clientCharge);
  const [ins] = await pool.query(
    `INSERT INTO job_material
       (job_id, type, from_city_name, to_city_name, total_distance,
        tx_unit, cx_unit, tx_charge, client_charge, document_name,
        is_client_approval_needed, is_pre_approved, inserted_by, inserted_date_time)
     VALUES (?, 'Travel', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [Number(jobId), b.fromCityName ?? null, b.toCityName ?? null, b.totalDistance,
     b.txUnit, b.clientUnit, b.txCharge, b.clientCharge, b.documentName ?? null,
     approvalBit(b.isClientApprovalNeeded), String(userId), new Date()]
  );
  logger.info('Travel created · id=' + ins.insertId + ' · jobId=' + jobId);
  return { id: ins.insertId, type: 'Travel' };
}

async function createIncentive(jobId, b, userId) {
  assertChargeOrder(b.txCharge, b.clientCharge);
  const [ins] = await pool.query(
    `INSERT INTO job_material
       (job_id, type, reason, tx_charge, client_charge, document_name,
        is_client_approval_needed, is_pre_approved, inserted_by, inserted_date_time)
     VALUES (?, 'Incentive', ?, ?, ?, ?, ?, 1, ?, ?)`,
    [Number(jobId), b.reason ?? null, b.txCharge, b.clientCharge,
     b.documentName ?? null, approvalBit(b.isClientApprovalNeeded),
     String(userId), new Date()]
  );
  logger.info('Incentive created · id=' + ins.insertId + ' · jobId=' + jobId);
  return { id: ins.insertId, type: 'Incentive' };
}

// ─── EDIT (type resolved from the row) ───────────────────────────────
// The edit endpoint is type-agnostic at the route; here we load the row (which
// also enforces job ownership + that it's one of the 3 charge types) and update
// only the columns that belong to that type. Missing required fields → 400.
async function editCharge(jobId, chargeId, b, userId) {
  const [[row]] = await pool.query(
    `SELECT id, type, is_client_approval_needed FROM job_material
      WHERE id = ? AND job_id = ? AND type IN (?, ?, ?) LIMIT 1`,
    [Number(chargeId), Number(jobId), ...CHARGE_TYPES]
  );
  if (!row) { const e = new Error('charge not found'); e.status = 404; throw e; }

  // Preserve the existing approval flag when the edit body omits it — the
  // dedicated /approval endpoint owns that toggle, so a general field edit must
  // not silently reset it. `is_client_approval_needed` reads back as a boolean
  // (BIT(1) typeCast); approvalBit maps true/false → 1/0.
  const approvalFlag = b.isClientApprovalNeeded === undefined
    ? approvalBit(row.is_client_approval_needed)
    : approvalBit(b.isClientApprovalNeeded);

  const missing = [];
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const txCharge = num(b.txCharge);
  const clientCharge = num(b.clientCharge);
  if (txCharge == null || !Number.isFinite(txCharge)) missing.push('txCharge');
  if (clientCharge == null || !Number.isFinite(clientCharge)) missing.push('clientCharge');

  const now = new Date();
  if (row.type === 'Travel') {
    if (b.totalDistance == null) missing.push('totalDistance');
    if (b.txUnit == null) missing.push('txUnit');
    if (b.clientUnit == null) missing.push('clientUnit');
    if (missing.length) { const e = new Error('Missing required fields: ' + missing.join(', ')); e.status = 400; e.missing = missing; throw e; }
    assertChargeOrder(txCharge, clientCharge);
    await pool.query(
      `UPDATE job_material
          SET from_city_name = ?, to_city_name = ?, total_distance = ?,
              tx_unit = ?, cx_unit = ?, tx_charge = ?, client_charge = ?,
              document_name = ?, is_client_approval_needed = ?,
              updated_by = ?, updated_date_time = ?
        WHERE id = ? AND job_id = ?`,
      [b.fromCityName ?? null, b.toCityName ?? null, b.totalDistance,
       b.txUnit, b.clientUnit, txCharge, clientCharge, b.documentName ?? null,
       approvalFlag, String(userId), now,
       Number(chargeId), Number(jobId)]
    );
  } else if (row.type === 'Penalty') {
    if (missing.length) { const e = new Error('Missing required fields: ' + missing.join(', ')); e.status = 400; e.missing = missing; throw e; }
    assertChargeOrder(txCharge, clientCharge);
    await pool.query(
      `UPDATE job_material
          SET tx_charge = ?, client_charge = ?, reason = ?, document_name = ?,
              is_client_approval_needed = ?, updated_by = ?, updated_date_time = ?
        WHERE id = ? AND job_id = ?`,
      [txCharge, clientCharge, b.reason ?? null, b.documentName ?? null,
       approvalFlag, String(userId), now,
       Number(chargeId), Number(jobId)]
    );
  } else { // Incentive
    if (missing.length) { const e = new Error('Missing required fields: ' + missing.join(', ')); e.status = 400; e.missing = missing; throw e; }
    assertChargeOrder(txCharge, clientCharge);
    await pool.query(
      `UPDATE job_material
          SET reason = ?, tx_charge = ?, client_charge = ?, document_name = ?,
              is_client_approval_needed = ?, updated_by = ?, updated_date_time = ?
        WHERE id = ? AND job_id = ?`,
      [b.reason ?? null, txCharge, clientCharge, b.documentName ?? null,
       approvalFlag, String(userId), now,
       Number(chargeId), Number(jobId)]
    );
  }
  logger.info('Charge edited · id=' + chargeId + ' · type=' + row.type + ' · jobId=' + jobId);
  return { id: Number(chargeId), type: row.type };
}

// ─── EDIT APPROVAL FLAG ONLY ─────────────────────────────────────────
async function setChargeApproval(jobId, chargeId, isClientApprovalNeeded, userId) {
  const bit = approvalBit(isClientApprovalNeeded);
  const [r] = await pool.query(
    `UPDATE job_material
        SET is_client_approval_needed = ?, updated_by = ?, updated_date_time = ?
      WHERE id = ? AND job_id = ? AND type IN (?, ?, ?)`,
    [bit, String(userId), new Date(), Number(chargeId), Number(jobId), ...CHARGE_TYPES]
  );
  if (r.affectedRows === 0) { const e = new Error('charge not found'); e.status = 404; throw e; }
  logger.info('Charge approval flag updated · id=' + chargeId + ' · needed=' + bit + ' · jobId=' + jobId);
  return { id: Number(chargeId), is_client_approval_needed: bit === 1 };
}

// ─── DELETE (only Penalty/Travel/Incentive rows) ─────────────────────
async function deleteCharge(jobId, chargeId) {
  const [r] = await pool.query(
    `DELETE FROM job_material
      WHERE id = ? AND job_id = ? AND type IN (?, ?, ?)`,
    [Number(chargeId), Number(jobId), ...CHARGE_TYPES]
  );
  if (r.affectedRows === 0) { const e = new Error('charge not found'); e.status = 404; throw e; }
  logger.info('Charge deleted · id=' + chargeId + ' · jobId=' + jobId);
  return { id: Number(chargeId), deleted: true };
}

// ─── SERVICE BILLING APPROVAL (tbl_job_services) ─────────────────────
async function setServiceApproval(jobId, jobServiceId, approvalByClient) {
  const [r] = await pool.query(
    'UPDATE tbl_job_services SET approval_by_client = ? WHERE job_id = ? AND job_service_id = ?',
    [Number(approvalByClient), Number(jobId), Number(jobServiceId)]
  );
  if (r.affectedRows === 0) { const e = new Error('job service not found'); e.status = 404; throw e; }
  logger.info('Service billing approval updated · jobServiceId=' + jobServiceId
    + ' · approvalByClient=' + approvalByClient + ' · jobId=' + jobId);
  return { job_service_id: Number(jobServiceId), approval_by_client: Number(approvalByClient) };
}

module.exports = {
  CHARGE_TYPES,
  DOC_CATEGORIES,
  imageUrl,
  getCharges,
  createPenalty,
  createTravel,
  createIncentive,
  editCharge,
  setChargeApproval,
  deleteCharge,
  setServiceApproval,
};
