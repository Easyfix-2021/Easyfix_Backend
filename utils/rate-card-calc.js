/*
 * Rate-card charge cascade — single source of truth for splitting a
 * service line's `total_amount` into per-party shares.
 *
 * Used by:
 *   - services/job.service.js          → tbl_job_services INSERT/UPDATE
 *   - services/job-magic-link.service.js → customer-submitted services
 *   - routes/admin/jobs.js             → per-job service-breakdown UPDATE
 *   - services/client-services.service.js → Manage Clients rate-card preview
 *
 * Formula (confirmed by ops 2026-06-05 against legacy CRM screenshot):
 *
 *   Each layer takes "variable% THEN fixed" from whatever REMAINS after
 *   the previous layer's deduction. Layers run in this exact order:
 *
 *     1. Easyfix Direct → 2. Overhead → 3. Client Share → 4. Easyfixer (residual)
 *
 *   Variable rates are stored as PERCENTAGES on tbl_client_service
 *   (e.g. `easyfix_direct_variable = 10` = 10%, NOT 0.10). We divide
 *   by 100 to convert before applying. 25 rows in QA have values in
 *   0.01-1.0 range (legacy decimal-style data anomaly, 0.066% of rows)
 *   — they'll compute slightly low but won't crash; flagged as data-
 *   cleanup follow-up, not a code problem.
 *
 *   `easyfix_charge` BUNDLES Easyfix Direct + Overhead since
 *   tbl_job_services has no dedicated overhead_charge column and the
 *   sum-to-total invariant matters for reporting. Matches the legacy
 *   Java `RateCardCalculations.getEasyfixShare()` semantics (see
 *   `EasyFix_CRM/src/main/java/com/easyfix/util/RateCardCalculations.java`).
 *
 * Worked example (Chair installation, qty 3, from the rate-card screenshot):
 *   Rate-card row:  total_amount=400,
 *                   easyfix_direct: fixed=200, variable=10  → 10%
 *                   overhead:       fixed=10,  variable=20  → 20%
 *                   client_share:   fixed=0,   variable=0
 *
 *   Per-unit cascade:
 *     remaining = 400
 *     L1 Easyfix Direct:  10% of 400 = 40    → 360
 *                         + fixed 200        → 160
 *                         efDirect share = 240
 *     L2 Overhead:        20% of 160 = 32    → 128
 *                         + fixed 10         → 118
 *                         overhead share = 42
 *     L3 Client Share:    0% of 118 = 0      → 118
 *                         + fixed 0          → 118
 *                         client share = 0
 *     L4 Easyfixer (residual) = 118
 *
 *   easyfix_share_per_unit  = efDirect + Overhead = 240 + 42 = 282
 *   easyfixer_share_per_unit = 118
 *   client_share_per_unit   = 0
 *
 *   Multiply by qty=3:
 *     total_charge     = 400                  (per-unit, int column)
 *     total_cost       = 400 × 3 = 1200       (cumulative bill)
 *     easyfix_charge   = 282 × 3 = 846
 *     client_charge    = 0
 *     easyfixer_charge = 118 × 3 = 354
 *
 *   Sum check: 846 + 0 + 354 = 1200 ✓ (matches total_cost)
 */

/**
 * Compute the 5 charge columns for a tbl_job_services row from a
 * tbl_client_service rate-card row + the operator-picked quantity.
 *
 * Pure function — no DB access. Callers fetch the rate-card row and
 * pass it in. Returns an object whose keys match the destination
 * column names so callers can spread it directly into the INSERT/UPDATE.
 *
 * @param {object} rateCardRow Row from tbl_client_service. Required
 *   fields: total_amount, easyfix_direct_fixed, easyfix_direct_variable,
 *   overhead_fixed, overhead_variable, client_fixed, client_variable.
 *   Missing fields default to 0.
 * @param {number} quantity Operator-picked quantity, min 1. Falsy → 1.
 * @returns {{
 *   total_charge: number,
 *   total_cost: number,
 *   client_charge: number,
 *   easyfix_charge: number,
 *   easyfixer_charge: number,
 *   _breakdown: {
 *     ef_direct_share_per_unit: number,
 *     overhead_share_per_unit: number,
 *     client_share_per_unit: number,
 *     easyfixer_share_per_unit: number,
 *   }
 * }}
 *   The `_breakdown` field exposes the per-unit per-layer shares so
 *   consumers that want to render the cascade (Manage Clients rate-
 *   card preview, finance reports) don't have to re-run the math.
 */
function computeJobServiceCharges(rateCardRow, quantity) {
  const round4 = (n) => Math.round(Number(n) * 10000) / 10000;
  const num    = (v) => Number(v) || 0;
  const qty    = num(quantity) || 1;

  // Per-unit pricing
  const unitPrice = num(rateCardRow && rateCardRow.total_amount);

  // Pull layer params with defaults; variable rates are percentages
  // (e.g. 10 → 10%), so divide by 100.
  const efFixed = num(rateCardRow && rateCardRow.easyfix_direct_fixed);
  const efVar   = num(rateCardRow && rateCardRow.easyfix_direct_variable) / 100;
  const ohFixed = num(rateCardRow && rateCardRow.overhead_fixed);
  const ohVar   = num(rateCardRow && rateCardRow.overhead_variable) / 100;
  const clFixed = num(rateCardRow && rateCardRow.client_fixed);
  const clVar   = num(rateCardRow && rateCardRow.client_variable) / 100;

  // Sequential cascade — variable% THEN fixed, per layer.
  let remaining = unitPrice;

  // L1: Easyfix Direct
  const efVarCut = remaining * efVar;
  remaining -= efVarCut;
  remaining -= efFixed;
  const efDirectShare = efVarCut + efFixed;

  // L2: Overhead
  const ohVarCut = remaining * ohVar;
  remaining -= ohVarCut;
  remaining -= ohFixed;
  const overheadShare = ohVarCut + ohFixed;

  // L3: Client Share
  const clVarCut = remaining * clVar;
  remaining -= clVarCut;
  remaining -= clFixed;
  const clientShare = clVarCut + clFixed;

  // L4: Easyfixer = residual
  const eferShare = remaining;

  // Easyfix's full cut = direct + overhead (per ops 2026-06-05 decision P:
  // tbl_job_services has no overhead_charge column, so overhead bundles
  // into easyfix_charge to keep the sum-to-total invariant).
  const easyfixShare = efDirectShare + overheadShare;

  return {
    total_charge:     Math.round(unitPrice),         // int column — per-unit price
    total_cost:       round4(unitPrice * qty),       // float — cumulative bill
    client_charge:    round4(clientShare * qty),     // float
    easyfix_charge:   round4(easyfixShare * qty),    // float — bundles overhead
    easyfixer_charge: round4(eferShare * qty),       // float — technician's residual
    _breakdown: {
      ef_direct_share_per_unit: round4(efDirectShare),
      overhead_share_per_unit:  round4(overheadShare),
      client_share_per_unit:    round4(clientShare),
      easyfixer_share_per_unit: round4(eferShare),
    },
  };
}

/**
 * Load the rate-card columns needed for the cascade in a single
 * SELECT. Returns the row or null when no active row exists.
 *
 * @param {object} conn  An open mysql2/promise connection (use the
 *   transaction's conn in write paths so rate-card reads see any
 *   in-flight rate-card edits inside the same transaction).
 * @param {number} clientServiceId  PK from tbl_client_service.
 * @returns {Promise<object|null>}  The row, or null.
 */
async function loadRateCardRow(conn, clientServiceId) {
  if (!clientServiceId) return null;
  const [rows] = await conn.query(
    `SELECT client_service_id, total_amount,
            easyfix_direct_fixed, easyfix_direct_variable,
            overhead_fixed, overhead_variable,
            client_fixed, client_variable
       FROM tbl_client_service
      WHERE client_service_id = ?
      LIMIT 1`,
    [clientServiceId],
  );
  return rows[0] || null;
}

/**
 * Batch variant — fetch many rate-card rows in one query, return a
 * Map keyed by client_service_id. Used by the multi-row INSERT in
 * services/job.service.js::create() so N services don't fan out
 * into N+1 SELECTs.
 *
 * @param {object} conn  Open mysql2/promise connection.
 * @param {number[]} clientServiceIds  Array of PKs.
 * @returns {Promise<Map<number, object>>}
 */
async function loadRateCardRows(conn, clientServiceIds) {
  const ids = (clientServiceIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length === 0) return new Map();
  const [rows] = await conn.query(
    `SELECT client_service_id, total_amount,
            easyfix_direct_fixed, easyfix_direct_variable,
            overhead_fixed, overhead_variable,
            client_fixed, client_variable
       FROM tbl_client_service
      WHERE client_service_id IN (?)`,
    [ids],
  );
  return new Map(rows.map((r) => [Number(r.client_service_id), r]));
}

module.exports = {
  computeJobServiceCharges,
  loadRateCardRow,
  loadRateCardRows,
};
