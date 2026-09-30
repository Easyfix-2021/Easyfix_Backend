const { pool } = require('../db');
const logger = require('../logger');
const { serviceChargeMap } = require('./job-service-breakdown.service');

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

/*
 * 'Material' (2026-09-30) — legacy's audit screen (appCheckoutJobDetail →
 * MaterialAction.addAndUpdateMaterial → MaterialDaoImpl.saveMaterialWithType)
 * adds and re-prices material lines at checkout: units x Tx / Cx unit price.
 * 84.7k of QA's job_material rows are this type, against 17.7k Travel and
 * single digits of the other two. The completion ledger already pays tx_charge
 * on them (job-ledger.service materialSign), so a row written here posts.
 */
const CHARGE_TYPES = ['Penalty', 'Travel', 'Incentive', 'Material'];
const TYPE_IN = CHARGE_TYPES.map(() => '?').join(', ');
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
    `SELECT id, type, name, description, unit, uom, tx_charge, client_charge, reason,
            from_city_name, to_city_name, total_distance,
            tx_unit, cx_unit, document_name, is_client_approval_needed
       FROM job_material
      WHERE job_id = ? AND type IN (${TYPE_IN})
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

  /*
   * client_charge + tx_charge per service line (2026-09-09).
   *
   * WHAT THIS REPLACES. The CRM's Job Summary matrix rendered the Services row
   * as `{ client: Σ js.total_charge, tx: 0 }` — a hardcoded zero, with a
   * comment saying the contract offered nothing better. It was wrong twice
   * over, and the second one is easy to miss:
   *
   *   tx     — always 0, so every service looked like pure margin.
   *   client — js.total_charge is a PER-UNIT column despite its name (the
   *            writers store Math.round(unitPrice) into it), and the matrix
   *            never multiplied by quantity. A qty-3 line was billed once.
   *            The column is also "usually 0" on older rows, which is why
   *            job.service.js and the breakdown route both refuse to read it
   *            raw. Same figure, three readers, three answers.
   *
   * FROM THE SAME CODE THE SERVICES TAB USES, not a second implementation that
   * happens to agree today: two tabs of one modal quoting different money is
   * the defect this is fixing, so they now share one function. The stored
   * columns on tbl_job_services are deliberately NOT used — see the docblock in
   * job-service-breakdown.service.js for why (a different cascade, a snapshot,
   * and empty on pre-June rows).
   *
   * FAIL-SOFT. The breakdown needs a tbl_client_service row; a service whose
   * rate card has been deleted resolves to no entry, and that line keeps
   * total_charge alone with nulls for the two new fields. A tab that renders
   * without a number is recoverable; one that 500s is not, and this endpoint
   * also carries the documents and penalty/travel/incentive rows.
   *
   * NO NEGATIVE MARGIN IS POSSIBLE on these rows, and that is structural rather
   * than checked: `remainder` is what is LEFT after the cascade subtracts its
   * three layers from `totalCharge`, so tx <= client by construction. The
   * client_charge >= tx_charge guard this file enforces on job_material rows
   * exists because those two are operator-entered and independent; these two
   * are not.
   *
   * COST: one extra query for the whole job, not one per service.
   */
  let chargeMap = new Map();
  try {
    chargeMap = await serviceChargeMap(id);
  } catch (e) {
    // Genuinely soft: the two new fields go null and the tab still renders its
    // materials, documents and approval controls. Logged at warn because a
    // persistent failure here means every Services row silently reads as
    // unpriced, which looks like a data problem rather than a broken query.
    logger.warn({ err: e.message, jobId: id }, 'Service charge breakdown failed — charges omitted');
  }
  for (const row of services) {
    const c = chargeMap.get(Number(row.job_service_id));
    // A missing entry is null, never 0. Zero is a price; null is "not known",
    // and the FE renders them differently on purpose.
    row.client_charge = c ? c.client_charge : null;
    row.tx_charge     = c ? c.tx_charge : null;
  }

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

/*
 * Material — legacy saveMaterialWithType's columns. The two charges are DERIVED,
 * units x unit price, as legacy's screen computes them before posting; taking
 * them from the caller would let a total disagree with its own units.
 */
function materialCharges(b) {
  return { txCharge: b.unit * b.txUnit, clientCharge: b.unit * b.clientUnit };
}

async function createMaterial(jobId, b, userId) {
  const { txCharge, clientCharge } = materialCharges(b);
  assertChargeOrder(txCharge, clientCharge);
  const [ins] = await pool.query(
    `INSERT INTO job_material
       (job_id, type, name, description, unit, uom, tx_unit, cx_unit,
        tx_charge, client_charge, is_pre_approved, inserted_by, inserted_date_time)
     VALUES (?, 'Material', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [Number(jobId), b.name, b.description ?? null, b.unit, b.uom ?? null,
     b.txUnit, b.clientUnit, txCharge, clientCharge, String(userId), new Date()]
  );
  logger.info('Material created · id=' + ins.insertId + ' · jobId=' + jobId);
  return { id: ins.insertId, type: 'Material' };
}

// ─── EDIT (type resolved from the row) ───────────────────────────────
// The edit endpoint is type-agnostic at the route; here we load the row (which
// also enforces job ownership + that it's one of the CHARGE_TYPES) and update
// only the columns that belong to that type. Missing required fields → 400.
async function editCharge(jobId, chargeId, b, userId) {
  const [[row]] = await pool.query(
    `SELECT id, type, is_client_approval_needed FROM job_material
      WHERE id = ? AND job_id = ? AND type IN (${TYPE_IN}) LIMIT 1`,
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
  const now = new Date();
  if (row.type === 'Material') {
    for (const k of ['name', 'unit', 'txUnit', 'clientUnit']) if (b[k] == null || b[k] === '') missing.push(k);
    if (missing.length) { const e = new Error('Missing required fields: ' + missing.join(', ')); e.status = 400; e.missing = missing; throw e; }
    const m = materialCharges(b);
    assertChargeOrder(m.txCharge, m.clientCharge);
    await pool.query(
      `UPDATE job_material
          SET name = ?, description = ?, unit = ?, uom = ?, tx_unit = ?, cx_unit = ?,
              tx_charge = ?, client_charge = ?, is_client_approval_needed = ?,
              updated_by = ?, updated_date_time = ?
        WHERE id = ? AND job_id = ?`,
      [b.name, b.description ?? null, b.unit, b.uom ?? null, b.txUnit, b.clientUnit,
       m.txCharge, m.clientCharge, approvalFlag, String(userId), now,
       Number(chargeId), Number(jobId)]
    );
    logger.info('Charge edited · id=' + chargeId + ' · type=Material · jobId=' + jobId);
    return { id: Number(chargeId), type: row.type };
  }
  const txCharge = num(b.txCharge);
  const clientCharge = num(b.clientCharge);
  if (txCharge == null || !Number.isFinite(txCharge)) missing.push('txCharge');
  if (clientCharge == null || !Number.isFinite(clientCharge)) missing.push('clientCharge');

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
      WHERE id = ? AND job_id = ? AND type IN (${TYPE_IN})`,
    [bit, String(userId), new Date(), Number(chargeId), Number(jobId), ...CHARGE_TYPES]
  );
  if (r.affectedRows === 0) { const e = new Error('charge not found'); e.status = 404; throw e; }
  logger.info('Charge approval flag updated · id=' + chargeId + ' · needed=' + bit + ' · jobId=' + jobId);
  return { id: Number(chargeId), is_client_approval_needed: bit === 1 };
}

// ─── DELETE (only the CHARGE_TYPES rows) ─────────────────────
async function deleteCharge(jobId, chargeId) {
  const [r] = await pool.query(
    `DELETE FROM job_material
      WHERE id = ? AND job_id = ? AND type IN (${TYPE_IN})`,
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
  createMaterial,
  createTravel,
  createIncentive,
  editCharge,
  setChargeApproval,
  deleteCharge,
  setServiceApproval,
};
