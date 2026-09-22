const { pool } = require('../db');

/*
 * What a job's services are worth — ONE definition, for every surface that
 * quotes it.
 *
 * WHY THIS EXISTS (2026-09-09)
 *
 * The formula `total_charge × quantity + material_charge` was written out by
 * hand in seven places across two repos, in three variants, and the surfaces
 * that used them disagreed about the same job:
 *
 *   routes/admin/jobs.js   estimate preview        charge × qty + material
 *   routes/admin/jobs.js   estimate email total    charge × qty + material
 *   routes/admin/jobs.js   estimate email per-line charge × qty + material
 *   routes/client/index.js client approval lines   charge × qty + material
 *   routes/client/index.js services_subtotal       charge × qty          (no material)
 *                          — renamed service_charge_subtotal; see totalsFor
 *   routes/admin/finance.js invoice lines          charge × qty + material
 *   routes/admin/finance.js invoice header (SQL)   charge × qty          (no material)
 *   CRM JobTransactionView "Job Total"             charge                (no qty, no material)
 *
 * The invoice header one was live under-billing: the printed lines added up to
 * more than the amount charged, and payment reconciliation settled on the short
 * number. It was fixed on its own first; this module is why it cannot recur.
 *
 * THIS IS A DE-DUPLICATION, NOT A RE-PRICING. Every caller keeps quoting the
 * same number it quotes today — the stored per-unit `total_charge`, not the
 * rate-card cascade in job-service-breakdown.service.js. That distinction is
 * deliberate:
 *
 *   - this module answers "what was this job quoted at", from the columns the
 *     estimate email the client is holding was built from;
 *   - the breakdown service answers "what does the rate card say this is worth
 *     today", which moves when a rate card is edited.
 *
 * Re-pricing the estimate/invoice surfaces off the cascade would make the
 * portal disagree with the email a client already received. If that is wanted
 * it is a product decision, not a refactor.
 *
 * SQL AND JS BOTH, because some callers aggregate across many jobs in one
 * statement (an invoice covers a date range) where a per-job round trip would
 * be N+1. Two expressions of one rule is a compromise, but they are four lines
 * apart in one file and tests/job-line-total.test.js models MySQL's NULL
 * semantics to prove they agree — which is materially different from the seven
 * copies scattered across two repos that this replaces.
 */

/*
 * Soft-deleted services are NOT part of a job's value (policy, 2026-09-09).
 *
 * Every other reader in this backend already excluded them; the invoice
 * queries did not, so clients were billed for services ops had removed. The
 * `IS NULL OR` arm is not decoration: `NULL <> 0` evaluates to NULL, i.e.
 * false, so a bare `<> 0` would silently drop any row whose status was never
 * set. (The sibling spelling `= 1` used by the estimate routes has the same
 * effect for the same reason — it is kept there because those routes are older
 * than this module and changing a working predicate buys nothing.)
 */
const ACTIVE_SERVICES_SQL = (a = 'js') =>
  `(${a}.job_service_status IS NULL OR ${a}.job_service_status <> 0)`;

/*
 * COALESCE per COLUMN, never around the SUM.
 *
 * In MySQL a NULL operand makes the whole expression NULL and SUM() then skips
 * the row entirely — so `COALESCE(SUM(a * b + c), 0)` does not default the
 * missing term, it discards the whole line. material_charge is NULL on most
 * rows, so that spelling under-counts by more than the bug it is meant to fix
 * (measured: 225 vs 75 on the fixture in tests/invoice-header-total.test.js).
 */
const LINE_TOTAL_SQL = (a = 'js') =>
  `(COALESCE(${a}.total_charge, 0) * COALESCE(${a}.quantity, 1) + COALESCE(${a}.material_charge, 0))`;

/** The JS twin of LINE_TOTAL_SQL, for callers that already hold the rows. */
function lineTotal(row) {
  return Number(row.total_charge || 0) * Number(row.quantity || 1)
    + Number(row.material_charge || 0);
}

/** Service charge alone (quantity applied, material excluded) — a breakdown row. */
function serviceCharge(row) {
  return Number(row.total_charge || 0) * Number(row.quantity || 1);
}

/*
 * The projection every estimate/invoice surface needs. Named columns rather
 * than js.* so a schema change surfaces here instead of in six response shapes.
 */
const LINE_COLUMNS = `js.job_service_id, js.job_id, js.quantity,
            js.total_charge, js.material_charge,
            COALESCE(CR.crc_ratecard_name, st.service_type_name, js.service_charge_description) AS service_name`;

const LINE_JOINS = `LEFT JOIN tbl_client_service   CS ON CS.client_service_id = js.service_id
       LEFT JOIN tbl_client_rate_card CR ON CR.crc_id            = CS.rate_card_id
       LEFT JOIN tbl_service_type     st ON st.service_type_id   = js.service_type_id`;

/*
 * NAMES THAT SAY WHAT THEY HOLD (2026-09-09).
 *
 * This used to expose `services_subtotal`, which excluded material — and
 * material_charge is a column ON tbl_job_services, i.e. it belongs to the very
 * service rows the field is named after. So "the subtotal for services"
 * understated those services by their own parts, and the only defence was a
 * comment calling it a breakdown row. Nothing rendered it: the client portal
 * declared it in two type definitions and displayed only grand_total.
 *
 * A field nobody reads and everybody would misread is worse than no field, so
 * the split is kept (labour and parts are genuinely different lines on a
 * quotation) and the labour one is renamed to stop claiming to be the total.
 *
 *   service_charge_subtotal   charge x quantity      — labour
 *   material_subtotal         material_charge        — parts
 *   grand_total               both                   — what is owed
 */
/*
 * `materials` are Ops-APPROVED quotation_details rows (Ops Material Approval,
 * sub-project E, 2026-09-18 — see
 * docs/superpowers/specs/2026-09-18-ops-material-approval-design.md). They
 * join the same material_subtotal / grand_total that tbl_job_services.
 * material_charge already fed — a second source of "material", not a
 * competing one. Defaulted so every existing caller (none of which pass a
 * second argument) keeps its exact prior totals.
 */
function totalsFor(lines, materials = []) {
  const approvedMaterialSum = materials.reduce((s, m) => s + Number(m.approved_charge || 0), 0);
  return {
    service_charge_subtotal: lines.reduce((s, l) => s + serviceCharge(l), 0),
    material_subtotal: lines.reduce((s, l) => s + Number(l.material_charge || 0), 0) + approvedMaterialSum,
    grand_total: lines.reduce((s, l) => s + l.line_total, 0) + approvedMaterialSum,
  };
}

/*
 * Ops-approved material lines — the client-facing half of Ops Material
 * Approval (sub-project E, 2026-09-18 — see
 * docs/superpowers/specs/2026-09-18-ops-material-approval-design.md).
 *
 * `status = 1 AND action_on IS NOT NULL` is the gate, NOT `status = 1`
 * alone. quotation_details has no 3-value pending/approved/rejected scheme
 * anywhere in this codebase (grepped: routes/admin/quotations.js,
 * services/job.service.js's dashboard filters, services/job-export.
 * service.js, and mobile-job-estimate.service.js's own
 * `quotation_actioned_on` all agree) — a technician's material line is
 * INSERTED at status = 1 with action_on NULL (mobile-job-estimate.service.js
 * addQuotationLine), so status = 1 alone would return an UNREVIEWED line
 * exactly as readily as an approved one. `action_on IS NOT NULL` is what
 * "Ops has acted on this row" actually means (quotations.js PATCH
 * /:id/approve stamps it; reject sets status = 0 instead of touching this
 * gate at all). `status` is TINYINT(1) — db.js's typeCast hands back a JS
 * boolean unless CAST, so it is CAST here even though we filter on the
 * literal (a raw `= 1` would silently become `= true`, which mysql2 still
 * binds correctly, but CASTing keeps this query legible next to every other
 * status read in the codebase that needs it for a returned column, not just
 * a WHERE literal).
 *
 * The technician's `unit_price` is NEVER selected — only what Ops approved.
 */
const MATERIAL_LINE_COLUMNS = `qd.id AS line_id, qd.job_id, qd.name, qd.unit, qd.approved_charge`;

/** Ops-approved material lines for MANY jobs in ONE query. */
async function approvedMaterialLinesForJobs(jobIds) {
  const ids = [...new Set((jobIds || []).map(Number).filter(Number.isFinite))];
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT ${MATERIAL_LINE_COLUMNS}
       FROM quotation_details qd
      WHERE qd.job_id IN (${placeholders})
        AND qd.type = 'material'
        AND CAST(qd.status AS SIGNED) = 1
        AND qd.action_on IS NOT NULL
      ORDER BY qd.job_id, qd.id`,
    ids,
  );
  const byJob = new Map();
  for (const r of rows) {
    if (!byJob.has(r.job_id)) byJob.set(r.job_id, []);
    byJob.get(r.job_id).push({
      line_id: r.line_id,
      name: r.name,
      unit: r.unit,
      approved_charge: Number(r.approved_charge || 0),
    });
  }
  return byJob;
}

/**
 * Priced service lines + Ops-approved material lines for MANY jobs in ONE
 * round trip apiece.
 *
 * @param {number[]} jobIds
 * @returns {Promise<Map<number, { lines: object[], materials: object[], totals: object }>>}
 *   Jobs with neither active services nor approved material lines are absent
 *   from the map — callers that must render a row for every job should treat
 *   a miss as an empty line set rather than as an error.
 */
async function estimateLinesForJobs(jobIds) {
  const ids = [...new Set((jobIds || []).map(Number).filter(Number.isFinite))];
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT ${LINE_COLUMNS}
       FROM tbl_job_services js
       ${LINE_JOINS}
      WHERE js.job_id IN (${placeholders})
        AND ${ACTIVE_SERVICES_SQL('js')}
      ORDER BY js.job_id, js.job_service_id`,
    ids,
  );
  const byJob = new Map();
  for (const r of rows) {
    const line = { ...r, line_total: lineTotal(r) };
    if (!byJob.has(r.job_id)) byJob.set(r.job_id, []);
    byJob.get(r.job_id).push(line);
  }
  const materialsByJob = await approvedMaterialLinesForJobs(ids);
  const out = new Map();
  for (const jobId of new Set([...byJob.keys(), ...materialsByJob.keys()])) {
    const lines = byJob.get(jobId) || [];
    const materials = materialsByJob.get(jobId) || [];
    out.set(jobId, { lines, materials, totals: totalsFor(lines, materials) });
  }
  return out;
}

/** Priced service + material lines for ONE job. Empty lines + zero totals when it has none. */
async function estimateLinesForJob(jobId) {
  const byJob = await estimateLinesForJobs([jobId]);
  return byJob.get(Number(jobId)) || { lines: [], materials: [], totals: totalsFor([]) };
}

module.exports = {
  ACTIVE_SERVICES_SQL,
  LINE_TOTAL_SQL,
  lineTotal,
  serviceCharge,
  estimateLinesForJob,
  estimateLinesForJobs,
  approvedMaterialLinesForJobs,
};
