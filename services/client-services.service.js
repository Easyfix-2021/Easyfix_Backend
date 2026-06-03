/*
 * Client Services — which service categories + types each client buys.
 *
 * Backed by `tbl_client_service`:
 *   client_service_id, client_id, service_category_id,
 *   service_type_ids (CSV), service_ids (CSV, legacy unused here),
 *   charge_type, total_charge, service_status
 *
 * Performance profile:
 *
 *   listForClient(clientId) → **exactly 2 queries**, regardless of how
 *     many rows the client has. Naive impl would N+1 by re-resolving
 *     each row's `service_type_ids` CSV one at a time; we instead:
 *       1. LEFT JOIN tbl_service_catg in the main SELECT → grabs the
 *          category name in the same query (no second round-trip).
 *       2. Collect every unique service_type id across all CSVs into a
 *          Set, run ONE `WHERE service_type_id IN (?)` lookup, build
 *          a Map<id, name>, merge in JS.
 *     A client with 10 service categories × 5 service types each = 50
 *     unique ids → 1 lookup query of 50 rows, not 50 queries.
 *
 *   create / update / softDelete → single-statement SQL each.
 *
 * Why CSV columns: legacy. Splitting `service_type_ids` into a junction
 * table would be cleaner but violates the "never alter legacy schema"
 * rule. The CSV stays; we just handle it carefully.
 *
 * Concurrency safety: there's no lock on (client_id, service_category_id)
 * — the legacy data model allows multiple rows per (client, category)
 * with different charge_types, so a UNIQUE index would break it. The
 * route layer doesn't try to dedupe; callers manage it.
 */

const { pool } = require('../db');

/**
 * Probe whether tbl_client_service has a service_type_ids column.
 *
 * Why a runtime probe (vs assume): tbl_client_service schema has drifted
 * across environments — most deploys carry the CSV `service_type_ids`
 * column, but older snapshots lack it (verified after a 500 with
 * "Unknown column 'cs.service_type_ids' in 'field list'"). We can't
 * alter the shared schema (5-service rule), so we adapt at read/write
 * time. Same pattern as cityHasIsActive in job-magic-link.service.js.
 * Memoised after first call.
 */
let _stIdsProbed = false;
let _hasServiceTypeIds = false;
async function clientServiceHasTypeIds(pool) {
  if (_stIdsProbed) return _hasServiceTypeIds;
  try {
    await pool.query('SELECT service_type_ids FROM tbl_client_service LIMIT 1');
    _hasServiceTypeIds = true;
  } catch (_e) {
    _hasServiceTypeIds = false;
  }
  _stIdsProbed = true;
  return _hasServiceTypeIds;
}

/* ─── CSV helpers ─────────────────────────────────────────────────── */

// Parse `"1,2,3"` (or null/empty) into a deduped sorted numeric array.
// Tolerates whitespace + non-numeric junk by filtering at parse time.
function parseCsvIds(raw) {
  if (raw == null) return [];
  const s = String(raw).trim();
  if (!s) return [];
  const seen = new Set();
  for (const tok of s.split(',')) {
    const n = Number(String(tok).trim());
    if (Number.isInteger(n) && n > 0) seen.add(n);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

// Numeric-array → CSV string for storage. Returns null when empty so
// the column stores NULL not "".
function idsToCsv(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const cleaned = Array.from(new Set(
    ids.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0),
  )).sort((a, b) => a - b);
  return cleaned.length ? cleaned.join(',') : null;
}

/* ─── Reads ───────────────────────────────────────────────────────── */

/*
 * List a client's subscribed services. Exactly 2 queries regardless of
 * row count. Returns rows with:
 *   {
 *     client_service_id, client_id, service_category_id,
 *     service_category_name, service_type_ids: number[],
 *     service_types: [{ service_type_id, service_type_name }, …],
 *     charge_type, total_charge, service_status
 *   }
 *
 * Inactive rows (service_status = 0) are filtered by default.
 */
async function listForClient(clientId) {
  // Query 1: main list with category name joined.
  // LEGACY COLUMNS (verified against ClientDaoImpl.java#670):
  //   cs.service_catg_id   (NOT `service_category_id`)
  //   cs.total_amount      (NOT `total_charge`)
  //   cs.charge_type       (int FK to charge type)
  //   cs.service_status    (0 = soft-deleted)
  //   cs.service_type_ids  (CSV) — may be absent on older deploys; probed.
  // The 6 cost columns (`easyfix_direct_fixed`, `easyfix_direct_variable`,
  // `overhead_fixed`, `overhead_variable`, `client_fixed`, `client_variable`)
  // are now projected too (2026-06-05) so the cascade helper can compute
  // a per-unit charge breakdown right here — Manage Clients rate-card
  // preview + Confirm modal service breakdown both consume this shape.
  // Result aliases preserved (`service_category_id`, `total_charge`) so
  // FE contract stays stable while the DB stays legacy-shaped.
  const hasTypeIds = await clientServiceHasTypeIds(pool);
  const typeIdsProjection = hasTypeIds
    ? 'cs.service_type_ids'
    : 'NULL AS service_type_ids';
  const [rows] = await pool.query(
    `SELECT cs.client_service_id, cs.client_id,
            cs.service_catg_id    AS service_category_id,
            ${typeIdsProjection},
            cs.charge_type,
            cs.total_amount       AS total_charge,
            cs.easyfix_direct_fixed,
            cs.easyfix_direct_variable,
            cs.overhead_fixed,
            cs.overhead_variable,
            cs.client_fixed,
            cs.client_variable,
            cs.service_status,
            sc.service_catg_name  AS service_category_name
       FROM tbl_client_service cs
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = cs.service_catg_id
      WHERE cs.client_id = ?
        AND (cs.service_status IS NULL OR cs.service_status <> 0)
      ORDER BY cs.client_service_id DESC`,
    [clientId],
  );
  if (rows.length === 0) return [];

  // Collect every unique service_type id across all CSVs — single Set.
  const allTypeIds = new Set();
  const parsed = rows.map((r) => {
    const ids = parseCsvIds(r.service_type_ids);
    ids.forEach((id) => allTypeIds.add(id));
    return { row: r, ids };
  });

  // Query 2 (only if any ids to look up): bulk resolve.
  let nameById = new Map();
  if (allTypeIds.size > 0) {
    const idArr = Array.from(allTypeIds);
    const [typeRows] = await pool.query(
      `SELECT service_type_id, service_type_name
         FROM tbl_service_type
        WHERE service_type_id IN (?)`,
      [idArr],
    );
    nameById = new Map(typeRows.map((t) => [t.service_type_id, t.service_type_name]));
  }

  // Compute per-unit charge cascade for each row via the shared helper
  // (utils/rate-card-calc.js). `charges` carries:
  //   - total_charge (per-unit price)
  //   - total_cost (= unit price × qty; here qty=1)
  //   - easyfix_charge, client_charge, easyfixer_charge (the splits)
  //   - _breakdown.{ef_direct_share_per_unit, overhead_share_per_unit, …}
  // for consumers that want to render the layered breakdown directly.
  // Skipping this projection-time work is safe (FE re-runs the same helper
  // if it needs a different qty), but doing it here keeps the contract
  // self-describing for the Swagger consumers.
  const { computeJobServiceCharges } = require('../utils/rate-card-calc');
  return parsed.map(({ row, ids }) => ({
    client_service_id: row.client_service_id,
    client_id: row.client_id,
    service_category_id: row.service_category_id,
    service_category_name: row.service_category_name,
    service_type_ids: ids,
    service_types: ids.map((id) => ({
      service_type_id: id,
      service_type_name: nameById.get(id) || null,
    })),
    charge_type: row.charge_type,
    total_charge: row.total_charge,
    // Rate-card cost columns — surfaced so Manage Clients / Rate Cards
    // tab consumers don't have to re-fetch them through a separate query.
    easyfix_direct_fixed:    row.easyfix_direct_fixed,
    easyfix_direct_variable: row.easyfix_direct_variable,
    overhead_fixed:          row.overhead_fixed,
    overhead_variable:       row.overhead_variable,
    client_fixed:            row.client_fixed,
    client_variable:         row.client_variable,
    // Computed cascade (per-unit; multiply by job quantity at write time).
    charges: computeJobServiceCharges(row, 1),
    service_status: row.service_status,
  }));
}

/* ─── Writes ──────────────────────────────────────────────────────── */

async function create(clientId, body) {
  const csv = idsToCsv(body.serviceTypeIds);
  const hasTypeIds = await clientServiceHasTypeIds(pool);
  // Real columns on tbl_client_service: service_catg_id + total_amount
  // (NOT service_category_id + total_charge). service_type_ids may be
  // absent on older deploys — omit it from the INSERT when missing so
  // writes still succeed; multi-select just doesn't persist there.
  const cols = ['client_id', 'service_catg_id'];
  const vals = [clientId, body.serviceCategoryId];
  if (hasTypeIds) {
    cols.push('service_type_ids');
    vals.push(csv);
  }
  cols.push('charge_type', 'total_amount', 'service_status');
  vals.push(body.chargeType || null, body.totalCharge ?? null, 1);
  const placeholders = cols.map(() => '?').join(', ');
  const [ins] = await pool.query(
    `INSERT INTO tbl_client_service (${cols.join(', ')}) VALUES (${placeholders})`,
    vals,
  );
  return ins.insertId;
}

// Partial update. service_type_ids accepted as array → CSV.
async function update(clientServiceId, body) {
  const sets = [];
  const vals = [];
  const hasTypeIds = await clientServiceHasTypeIds(pool);
  if (body.serviceCategoryId !== undefined) {
    // Real column is `service_catg_id`.
    sets.push('service_catg_id = ?');
    vals.push(body.serviceCategoryId);
  }
  if (body.serviceTypeIds !== undefined && hasTypeIds) {
    // Silently skip persisting service_type_ids on deploys missing the
    // column; the row still updates other fields successfully.
    sets.push('service_type_ids = ?');
    vals.push(idsToCsv(body.serviceTypeIds));
  }
  if (body.chargeType !== undefined) {
    sets.push('charge_type = ?');
    vals.push(body.chargeType);
  }
  if (body.totalCharge !== undefined) {
    // Real column is `total_amount`.
    sets.push('total_amount = ?');
    vals.push(body.totalCharge);
  }
  if (body.serviceStatus !== undefined) {
    sets.push('service_status = ?');
    vals.push(body.serviceStatus);
  }
  if (sets.length === 0) {
    throw Object.assign(new Error('nothing to update'), { status: 400 });
  }
  vals.push(clientServiceId);
  const [r] = await pool.query(
    `UPDATE tbl_client_service SET ${sets.join(', ')} WHERE client_service_id = ?`,
    vals,
  );
  return r.affectedRows;
}

// Soft-delete — flip status to 0. Job history that references this
// row by id stays intact; the FE filters status=0 out.
async function softDelete(clientServiceId) {
  const [r] = await pool.query(
    'UPDATE tbl_client_service SET service_status = 0 WHERE client_service_id = ?',
    [clientServiceId],
  );
  return r.affectedRows;
}

module.exports = {
  listForClient,
  create,
  update,
  softDelete,
  // exported for tests + the rate-cards service which needs the parser
  parseCsvIds,
  idsToCsv,
};
