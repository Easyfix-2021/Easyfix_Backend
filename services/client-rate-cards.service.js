/*
 * Client Rate Cards — catalog-level rate cards linked to clients via
 * the services they buy.
 *
 * IMPORTANT data-model correction (2026-05-25 audit):
 *   `tbl_client_rate_card` is NOT a per-client table — it has NO
 *   `client_id` column. It's a **catalog of rate cards keyed by service
 *   type**. Clients pick up rate cards via
 *   `tbl_client_service.rate_card_id` which FK-references
 *   `tbl_client_rate_card.crc_id`.
 *
 *   Schema (legacy `ClientRateCardDaoImpl.java` + `ClientDaoImpl.java#906`):
 *     crc_id              PK
 *     crc_servicetype_id  FK → tbl_service_type.service_type_id
 *     crc_ratecard_name   display label
 *     status              active flag
 *     easyfix_direct_fixed, easyfix_direct_variable
 *     overhead_fixed,       overhead_variable
 *     client_fixed,         client_variable
 *
 *   Per-client view → JOIN through tbl_client_service:
 *     SELECT cs.client_service_id, cs.service_type_id,
 *            cs.rate_card_id AS crc_id, rc.crc_ratecard_name,
 *            rc.easyfix_direct_fixed, ..., st.service_type_name
 *       FROM tbl_client_service cs
 *       LEFT JOIN tbl_client_rate_card rc ON rc.crc_id = cs.rate_card_id
 *       LEFT JOIN tbl_service_type    st ON st.service_type_id = cs.service_type_id
 *      WHERE cs.client_id = ? AND (cs.service_status IS NULL OR cs.service_status <> 0)
 *
 * Three cost dimensions × two parts each (fixed + variable) = 6 cost cols.
 *
 * Performance profile:
 *
 *   listForClient(clientId) → **1 query**. Single LEFT JOIN to
 *     tbl_service_type so the FE gets type names alongside the rates
 *     with no second fetch.
 *
 *   bulkUpsert(clientId, rows) → **1 query** (regardless of row
 *     count). Uses `INSERT ... ON DUPLICATE KEY UPDATE` against a
 *     batch VALUES clause. Saving 50 rate cards = 1 round-trip, not 50.
 *     Requires a unique key on (client_id, service_type_id) — see the
 *     migration; if it's absent the upsert degrades to plain INSERT
 *     (duplicates possible) and a warning logs once.
 *
 *   softDelete(rateCardId) → 1 query.
 *
 * Excel import: parsed in-memory by the route layer, fed through
 * bulkUpsert. No per-row queries.
 */

const { pool } = require('../db');
const logger = require('../logger');

const COST_COLS = [
  'easyfix_direct_fixed', 'easyfix_direct_variable',
  'overhead_fixed',       'overhead_variable',
  'client_fixed',         'client_variable',
];

/* ─── Probe: composite unique key presence ────────────────────────── */

let _hasCompositeKeyPromise = null;
async function hasCompositeUniqueKey() {
  if (!_hasCompositeKeyPromise) {
    _hasCompositeKeyPromise = (async () => {
      try {
        const [rows] = await pool.query(
          `SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX
             FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'tbl_client_rate_card'
              AND NON_UNIQUE = 0
              AND COLUMN_NAME IN ('client_id', 'service_type_id')
            ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        );
        // Group by INDEX_NAME — we want one index that has BOTH cols.
        const byIndex = new Map();
        for (const r of rows) {
          if (!byIndex.has(r.INDEX_NAME)) byIndex.set(r.INDEX_NAME, new Set());
          byIndex.get(r.INDEX_NAME).add(r.COLUMN_NAME);
        }
        const ok = Array.from(byIndex.values()).some((s) => s.has('client_id') && s.has('service_type_id'));
        if (!ok) {
          logger.warn(
            '[client-rate-cards] no (client_id, service_type_id) unique index — bulkUpsert will degrade to plain INSERT (duplicates possible). Add index for proper upsert semantics.',
          );
        }
        return ok;
      } catch (e) {
        logger.warn({ err: e?.message }, '[client-rate-cards] composite-key probe failed');
        return false;
      }
    })();
  }
  return _hasCompositeKeyPromise;
}

/* ─── List ────────────────────────────────────────────────────────── */

async function listForClient(clientId) {
  logger.info('List client rate cards · clientId=' + clientId);
  // **Correction (2026-05-25 audit)**: the 6 cost columns are on
  // `tbl_client_service`, NOT `tbl_client_rate_card`. Verified
  // against legacy ClientDaoImpl.java#672-677. So:
  //
  //   - `tbl_client_service` holds: easyfix_direct_fixed/variable,
  //     overhead_fixed/variable, client_fixed/(client_variable),
  //     plus `rate_card_id` FK pointing to the catalog row.
  //   - `tbl_client_rate_card` holds: crc_id, crc_servicetype_id,
  //     crc_ratecard_name, status. No cost columns here.
  //
  // Per-client view: ONE row per client_service entry. The Rate Card
  // *catalog name* is joined optionally via the FK link.
  //
  // Note: tbl_client_service has `service_type_id` (singular, despite
  // the also-existing `service_type_ids` CSV) — verified in legacy
  // line 666 `cs.service_type_id`.
  const [rows] = await pool.query(
    `SELECT cs.client_service_id,
            cs.service_type_id,
            cs.rate_card_id           AS rate_card_id,
            rc.crc_ratecard_name,
            COALESCE(cs.easyfix_direct_fixed,    0) AS easyfix_direct_fixed,
            COALESCE(cs.easyfix_direct_variable, 0) AS easyfix_direct_variable,
            COALESCE(cs.overhead_fixed,          0) AS overhead_fixed,
            COALESCE(cs.overhead_variable,       0) AS overhead_variable,
            COALESCE(cs.client_fixed,            0) AS client_fixed,
            COALESCE(cs.client_variable,         0) AS client_variable,
            st.service_type_name,
            st.service_catg_id
       FROM tbl_client_service cs
       LEFT JOIN tbl_client_rate_card rc ON rc.crc_id          = cs.rate_card_id
       LEFT JOIN tbl_service_type     st ON st.service_type_id = cs.service_type_id
      WHERE cs.client_id = ?
        AND (cs.service_status IS NULL OR cs.service_status <> 0)
      ORDER BY st.service_type_name ASC`,
    [clientId],
  );
  logger.info('Found ' + rows.length + ' client rate cards · clientId=' + clientId);
  return rows;
}

/* ─── Bulk upsert ─────────────────────────────────────────────────── */

/*
 * `rows` is an array of:
 *   { serviceTypeId, easyfixDirectFixed?, easyfixDirectVariable?,
 *     overheadFixed?, overheadVariable?, clientFixed?, clientVariable? }
 *
 * Each numeric cost is COALESCEd to 0 when missing (matches legacy
 * default — empty cells in the Excel import become zeros).
 *
 * Returns the number of rows actually written (insertId/affectedRows
 * semantics from mysql2 — affectedRows under ON DUPLICATE KEY UPDATE
 * is 1 for INSERT, 2 for UPDATE; we report total touched).
 */
async function bulkUpsert(clientId, rows) {
  logger.info('Bulk upsert client rate cards · clientId=' + clientId + ' rows=' + (Array.isArray(rows) ? rows.length : 0));
  logger.warn('Bulk upsert client rate cards · deferred path — returning 503 (use Upload Rate Card Xlsx)');
  // DEFERRED PATH — see file-header comment. Under the corrected
  // catalog model, the per-client write is "link/unlink a catalog
  // rate_card_id onto a tbl_client_service row", not an upsert into
  // tbl_client_rate_card. The legacy form's "Upload Rate Card" flow
  // is the right place to wire this. Until then, surface a 503 so the
  // FE doesn't get a cryptic SQL error and operators see a clear
  // message.
  throw Object.assign(
    new Error('Per-client rate-card edit is not supported — use Upload Rate Card (Xlsx) from the row actions menu'),
    { status: 503 },
  );
  // eslint-disable-next-line no-unreachable
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  // Defensive: dedupe by serviceTypeId — caller should already, but
  // catching here protects against a FE bug producing the same key twice.
  const seen = new Set();
  const cleaned = [];
  for (const r of rows) {
    const sid = Number(r?.serviceTypeId);
    if (!Number.isInteger(sid) || sid <= 0) {
      throw Object.assign(new Error('serviceTypeId must be a positive integer'), { status: 400 });
    }
    if (seen.has(sid)) continue;
    seen.add(sid);
    cleaned.push({
      sid,
      e_fix:  Number(r.easyfixDirectFixed)    || 0,
      e_var:  Number(r.easyfixDirectVariable) || 0,
      o_fix:  Number(r.overheadFixed)         || 0,
      o_var:  Number(r.overheadVariable)      || 0,
      c_fix:  Number(r.clientFixed)           || 0,
      c_var:  Number(r.clientVariable)        || 0,
    });
  }
  if (cleaned.length === 0) return 0;

  const hasKey = await hasCompositeUniqueKey();
  const values = cleaned.map((c) => [
    clientId, c.sid, c.e_fix, c.e_var, c.o_fix, c.o_var, c.c_fix, c.c_var,
  ]);
  const sql = hasKey
    ? `INSERT INTO tbl_client_rate_card
         (client_id, service_type_id,
          easyfix_direct_fixed, easyfix_direct_variable,
          overhead_fixed, overhead_variable,
          client_fixed, client_variable)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         easyfix_direct_fixed    = VALUES(easyfix_direct_fixed),
         easyfix_direct_variable = VALUES(easyfix_direct_variable),
         overhead_fixed          = VALUES(overhead_fixed),
         overhead_variable       = VALUES(overhead_variable),
         client_fixed            = VALUES(client_fixed),
         client_variable         = VALUES(client_variable)`
    : `INSERT INTO tbl_client_rate_card
         (client_id, service_type_id,
          easyfix_direct_fixed, easyfix_direct_variable,
          overhead_fixed, overhead_variable,
          client_fixed, client_variable)
       VALUES ?`;
  const [r] = await pool.query(sql, [values]);
  return r.affectedRows;
}

async function deleteOne(rateCardId) {
  logger.info('Delete client rate card · crc_id=' + rateCardId);
  const [r] = await pool.query(
    // Column-name landmine — PK is `crc_id` on tbl_client_rate_card.
    'DELETE FROM tbl_client_rate_card WHERE crc_id = ?', [rateCardId],
  );
  logger.info('Client rate card deleted · crc_id=' + rateCardId + ' affected=' + r.affectedRows);
  return r.affectedRows;
}

/*
 * ─── Rate-Card Charge Calculation Formula ─────────────────────────
 *
 * Verified against legacy EasyFix_CRM "Edit Client Services" modal +
 * ops example 2026-05-25:
 *
 *   Total Charge = 400
 *   Easyfix Direct: Fixed=200, Variable=10%
 *   Overhead:       Fixed=10,  Variable=20%
 *   Client Share:   Fixed=0,   Variable=0%
 *
 *   Cascade (Variable first, then Fixed at each layer):
 *     start          400
 *     − 10% (E.Var)  → 360       (deducts  40)
 *     − 200 (E.Fix)  → 160       (deducts 200)
 *     − 20% (O.Var)  → 128       (deducts  32)
 *     − 10  (O.Fix)  → 118       (deducts  10)
 *     − 0%  (C.Var)  → 118       (deducts   0)
 *     − 0   (C.Fix)  → 118       (deducts   0)
 *
 *   "Easyfix Direct cut" = 40 + 200 = 240
 *   "Overhead cut"       = 32 +  10 =  42
 *   "Client Share cut"   = remainder = 118
 *
 * In other words: each layer takes a % of what remains, then a flat
 * Fixed amount. The "Client Share Fixed/Variable" line is the
 * TRUE-UP/leftover; if its Fixed+Variable are zero, the residual IS
 * the client's portion.
 *
 * Per-quantity rule:
 *   total_cost  = single-unit total charge (rate-card row × 1)
 *   total_charge = total_cost × quantity
 *
 * Returns a breakdown object:
 *   {
 *     totalCharge:      <input>,
 *     easyfixDirect:    { variableAmt, fixedAmt, total },
 *     overhead:         { variableAmt, fixedAmt, total },
 *     clientShare:      { variableAmt, fixedAmt, total },
 *     remainder:        <after-all-deductions>,
 *   }
 */
function calculateCharges({
  totalCharge,
  easyfixDirectFixed = 0, easyfixDirectVariable = 0,
  overheadFixed      = 0, overheadVariable      = 0,
  clientFixed        = 0, clientVariable        = 0,
}) {
  logger.info('Calculate rate-card charges · totalCharge=' + totalCharge);
  const toN = (x) => (typeof x === 'number' && Number.isFinite(x)) ? x : Number(x) || 0;
  let running = toN(totalCharge);

  const eVar = Math.max(0, toN(easyfixDirectVariable));
  const eFix = Math.max(0, toN(easyfixDirectFixed));
  const oVar = Math.max(0, toN(overheadVariable));
  const oFix = Math.max(0, toN(overheadFixed));
  const cVar = Math.max(0, toN(clientVariable));
  const cFix = Math.max(0, toN(clientFixed));

  // Easyfix Direct cascade
  const eVarAmt = running * (eVar / 100);
  running -= eVarAmt;
  const eFixAmt = Math.min(running, eFix); // never deduct more than what's left
  running -= eFixAmt;

  // Overhead cascade
  const oVarAmt = running * (oVar / 100);
  running -= oVarAmt;
  const oFixAmt = Math.min(running, oFix);
  running -= oFixAmt;

  // Client Share cascade — applied last; remainder is the operator's
  // true-up bucket (legacy semantics).
  const cVarAmt = running * (cVar / 100);
  running -= cVarAmt;
  const cFixAmt = Math.min(running, cFix);
  running -= cFixAmt;

  return {
    totalCharge: toN(totalCharge),
    easyfixDirect: {
      variableAmt: round2(eVarAmt),
      fixedAmt:    round2(eFixAmt),
      total:       round2(eVarAmt + eFixAmt),
    },
    overhead: {
      variableAmt: round2(oVarAmt),
      fixedAmt:    round2(oFixAmt),
      total:       round2(oVarAmt + oFixAmt),
    },
    clientShare: {
      variableAmt: round2(cVarAmt),
      fixedAmt:    round2(cFixAmt),
      total:       round2(cVarAmt + cFixAmt),
    },
    remainder: round2(running),
  };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

module.exports = {
  listForClient,
  bulkUpsert,
  deleteOne,
  hasCompositeUniqueKey,
  COST_COLS,
  calculateCharges,
};
