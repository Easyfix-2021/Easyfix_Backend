/*
 * Mobile Job-Estimate service — the technician-app "Estimate / Quotation"
 * surface (Order Lifecycle §13–16: recce → rate-card → quotation lines →
 * send-for-approval → questionnaire → work-progress timeline).
 *
 * This is the SERVICE half of routes/mobile/jobs-estimate.js. It owns all
 * SQL so the route file stays a thin Joi+envelope wrapper. Every function
 * takes an `efrId` (req.tech.efr_id) and the jobId, and self-scopes the
 * write to "this technician's job" — a tech can only touch a job whose
 * tbl_job.fk_easyfixter_id matches their efr_id (legacy-typo column name
 * preserved; do NOT rename to easyfixer).
 *
 * Tables (all PRE-EXISTING — read/write only, never altered):
 *   quotation_details        — estimate line items. Columns verified against
 *                              ACD_APIs QuotationDetails.java + the canonical
 *                              admin route routes/admin/quotations.js:
 *                                id (PK), type ('product'|'material'),
 *                                name, unit, unit_price,
 *                                tx_charge, client_charge, approved_charge,
 *                                margin, status (bit), easyfxer_id (TYPO),
 *                                action_by, sent_by, sent_on, action_on,
 *                                job_id, client_service_id, material_id,
 *                                job_service_id
 *   tbl_client_service       — per-client purchased services. Holds the
 *                              rate-card price in `total_amount` + FK
 *                              `rate_card_id` → tbl_client_rate_card.crc_id.
 *   tbl_client_rate_card     — rate-card catalog keyed by service type:
 *                                crc_id, crc_servicetype_id,
 *                                crc_ratecard_name, status.
 *   tbl_service_type         — service_type_id, service_type_name.
 *   tbl_questionaire         — client questionnaire header (legacy spelling
 *                              "questionaire", single-n): c_questionaire_id,
 *                              client_id, c_questionaire_name, status.
 *   tbl_questionaire_details — questions: c_qd_id, c_questionaire_id,
 *                              c_qd_category, c_qd_seq, c_qd_type, c_qd_text,
 *                              c_qd_values, c_qd_mandatory, status.
 *   tbl_questionaire_answer  — answers: c_qd_ans_id, c_qd_id, job_id,
 *                              c_questionaire_id, c_qd_ans, c_qd_comments,
 *                              c_qd_proof_doc, inserted_by, insert_date,
 *                              updated_by, update_date.
 *   tbl_job_image            — image refs: image_id, job_id, image,
 *                              image_category, job_stage, created_date.
 *   scheduling_history       — schedule audit: id, job_id, schedule_time,
 *                              easyfixer_id, reason_id, reschedule_reason.
 *   tbl_job                  — order row: job_status, requested_date_time,
 *                              checkin_date_time, checkout_date_time,
 *                              approval_sent_on_date_time, no_of_req_approval.
 */

const { pool } = require('../db');
const logger = require('../logger');
const {
  persistedCategory,
  PROOF_BEFORE_CATEGORIES,
  PROOF_AFTER_CATEGORIES,
} = require('../utils/job-image-buckets');
const { deleteJobImage } = require('./job-image.service');
const { resolveMaterialPrice, defaultTxShare } = require('./material-price-resolver');
// Material Request Flow v2 (2026-09-21) — the single line-state derivation
// and the pre_material_status get/store pair. Neither depends on
// job.service.js, so requiring them here carries none of the circular-import
// risk the STATUS constants below were duplicated to avoid.
const quotationLineState = require('./quotation-line-state');
const { storePreMaterialStatus } = require('./material-review-store');

// Job status codes (mirror services/job.service.js STATUS — duplicated as a
// local const so this service has no circular dependency on job.service.js,
// which the no-edit rule forbids us touching).
const STATUS_SCHEDULED = 1;
const STATUS_ESTIMATE_PENDING_APPROVAL = 15;
// Material Management phase 2, sub-project D (2026-09-18) — see
// docs/superpowers/specs/2026-09-18-pending-for-material-status-16-design.md.
const STATUS_IN_PROGRESS = 2;
const STATUS_IN_PROGRESS_ALT = 20;
const STATUS_PENDING_FOR_MATERIAL = 16;
// material_sub_status: 1 = Quotation Pending (RETIRED — Material Request Flow
// v2, 2026-09-21, no longer writes this value; kept for old rows / old app
// builds that still read it), 2 = Review Pending.
const MATERIAL_SUB_STATUS_QUOTATION_PENDING = 1;
const MATERIAL_SUB_STATUS_REVIEW_PENDING = 2;

/*
 * Job-status LOCK for a technician quotation WRITE (add / bulk-add / delete /
 * bulk-delete). See the design's "Locks", amended 2026-09-22 (owner
 * decision): drafting the NEXT quotation is now allowed at 15 too — only
 * SEND is blocked there (assertTechCanSendForApproval below). Anywhere
 * outside {1 SCHEDULED, 2/20 IN_PROGRESS, 16 PENDING_FOR_MATERIAL, 15
 * ESTIMATE_PENDING_APPROVAL}, there is no defined transition for a
 * technician to write into, so it is refused (closed allowlist, not an open
 * denylist — the safe direction when a status this backend gains later
 * should be refused until someone decides it belongs here).
 */
const TECH_QUOTATION_WRITE_STATUSES = new Set([
  STATUS_SCHEDULED, STATUS_IN_PROGRESS, STATUS_IN_PROGRESS_ALT, STATUS_PENDING_FOR_MATERIAL,
  STATUS_ESTIMATE_PENDING_APPROVAL,
]);

function assertTechCanWriteQuotation(jobStatus) {
  const s = Number(jobStatus);
  if (!TECH_QUOTATION_WRITE_STATUSES.has(s)) {
    const e = new Error('This material is locked'); e.status = 409; throw e;
  }
}

// The one write send-for-approval alone forbids at 15: the client already
// has a quotation out; the technician may keep drafting the next one (Save)
// but may not send it until the client decides on the one they're looking
// at. Exact contract message (owner decision, 2026-09-22).
const SEND_BLOCKED_AT_ESTIMATE_PENDING_MESSAGE =
  'Your previous quotation is with the client — send this one after they decide';

function assertTechCanSendForApproval(jobStatus) {
  const s = Number(jobStatus);
  if (s === STATUS_ESTIMATE_PENDING_APPROVAL) {
    const e = new Error(SEND_BLOCKED_AT_ESTIMATE_PENDING_MESSAGE); e.status = 409; throw e;
  }
  assertTechCanWriteQuotation(s);
}

/*
 * Per-LINE lock — a technician may only touch a `draft` line
 * (quotationLineState.TECH_EDITABLE_STATES); every other state
 * (review_pending, approval_pending, rejected, client_approved,
 * client_rejected) is locked to the technician even when the JOB-level check
 * above passes. OWNER DECISION (2026-09-22): once a line has been sent
 * (review_pending) it is as locked as an already-decided one — "Save" is for
 * drafts; anything more once sent is a NEW quotation, not an edit of this
 * one. This also means the technician can no longer delete the job's last
 * non-draft line, so the old "revert job to pre-status" transition that used
 * to fire on that delete is unreachable and has been removed (CRM Reject
 * Request still reverts to pre-status, unchanged).
 */
function assertTechLineEditable(state) {
  if (!quotationLineState.isTechEditable(state)) {
    const e = new Error('This material is locked'); e.status = 409; throw e;
  }
}

// S3 key convention for job-supporting images:
//   JobSupportings/<Category>_<JobID>_<Seq>   (no file extension on the key)
// Matches utils/s3-storage.js putJobImage() + routes/admin/jobs.js. The
// mobile estimate flow records refs (caller already uploaded the bytes, or
// will once multipart ships — see // VERIFY in the route), so this service
// only stores the canonical key string into tbl_job_image.image.
const IMAGE_CATEGORIES = new Set(['Booking', 'Completion']);

/*
 * Ownership guard — returns the job row's scope fields IFF the job exists
 * AND belongs to this technician. Returns null otherwise so the route can
 * 404 uniformly (never leak another tech's job). Reads only the columns we
 * need (cheap single-row lookup on the indexed PK).
 */
async function jobForTech(jobId, efrId) {
  const [[row]] = await pool.query(
    `SELECT job_id, fk_client_id, fk_easyfixter_id, job_status
       FROM tbl_job
      WHERE job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!row) return null;
  if (Number(row.fk_easyfixter_id) !== Number(efrId)) return null;
  return row;
}

/* ─── Rate card ─────────────────────────────────────────────────────────
 * Product/material rate-card items available for THIS job's client. The
 * per-client view joins tbl_client_service → tbl_client_rate_card (catalog
 * name) → tbl_service_type (type name). Price comes from
 * tbl_client_service.total_amount (verified: cost columns live on
 * tbl_client_service, NOT tbl_client_rate_card — see
 * services/client-rate-cards.service.js header).
 *
 * Returns the shape the RN app expects:
 *   { items: [{ clientRateCardId, name, price, serviceTypeId }] }
 *
 * `clientRateCardId` is the tbl_client_service.client_service_id — that is
 * the id the legacy app sends back as "clientRateCardId" when adding a
 * product line (verified in deepskill add_product_bottom_sheet.dart:699).
 */
async function getRateCard(jobId, efrId) {
  logger.info('Get job rate card · jobId=' + jobId);
  const job = await jobForTech(jobId, efrId);
  if (!job) logger.warn('Get rate card failed · job not found or not owned · jobId=' + jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }

  const [rows] = await pool.query(
    `SELECT cs.client_service_id        AS clientRateCardId,
            cs.service_type_id          AS serviceTypeId,
            COALESCE(rc.crc_ratecard_name, st.service_type_name) AS name,
            COALESCE(cs.total_amount, 0) AS price
       FROM tbl_client_service cs
       LEFT JOIN tbl_client_rate_card rc ON rc.crc_id          = cs.rate_card_id
       LEFT JOIN tbl_service_type     st ON st.service_type_id = cs.service_type_id
      WHERE cs.client_id = ?
        AND (cs.service_status IS NULL OR cs.service_status <> 0)
      ORDER BY name ASC`,
    [job.fk_client_id],
  );
  logger.info('Returning ' + rows.length + ' rate-card items · jobId=' + jobId);

  return {
    items: rows.map((r) => ({
      clientRateCardId: r.clientRateCardId,
      name: r.name || null,
      price: Number(r.price) || 0,
      serviceTypeId: r.serviceTypeId,
    })),
  };
}

/*
 * Job's service category + state, for the material picker and price
 * resolution (sub-project B). Kept as its OWN query rather than folded into
 * jobForTech: jobForTech's SQL text is pinned verbatim by
 * tests/mobile-job-estimate-timestamps.test.js, so it must not change shape.
 *
 * state_id comes from the job's service address (tbl_address.city_id →
 * tbl_city.state_id) — the same path services/job.service.js LIST_JOIN uses
 * for every other state-scoped read in this codebase. No row (job / address /
 * city missing) degrades to nulls rather than throwing — resolveMaterialPrice
 * already treats a missing stateId as "skip the state-price steps".
 */
async function jobEstimateContext(jobId) {
  const [[row]] = await pool.query(
    `SELECT j.fk_service_catg_id, ci.state_id
       FROM tbl_job j
       LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id
       LEFT JOIN tbl_city    ci ON ci.city_id    = ad.city_id
      WHERE j.job_id = ? LIMIT 1`,
    [jobId],
  );
  return row || { fk_service_catg_id: null, state_id: null };
}

/* ─── Estimate material picker (Material Management phase 2, sub-project B) ─
 * Master-list materials for THIS job's service category, each priced via
 * resolveMaterialPrice() (sub-project C) for the job's client + state — the
 * app never computes a price itself. See
 * docs/superpowers/specs/2026-09-18-app-estimate-material-picker-design.md.
 *
 * A material with no brand rows (tbl_material_price_group_brand) is a
 * "No Brand" material — resolved once, top-level `price`/`price_source`.
 * A material WITH brand rows returns one entry per brand under `brands[]`
 * instead (top-level price/price_source are null — the app picks a brand
 * first).
 *
 * Returns { items: [{ material_id, material_name, uom_name, pricing_type,
 *                      brands: [{ brand_id, brand_name, price, price_source }],
 *                      price, price_source }] }
 */
async function getJobMaterials(jobId, efrId, { search } = {}) {
  logger.info('Get job materials · jobId=' + jobId + ' · search=' + (search || ''));
  const job = await jobForTech(jobId, efrId);
  if (!job) logger.warn('Get job materials failed · job not found or not owned · jobId=' + jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }

  const ctx = await jobEstimateContext(jobId);

  const where = ['m.status = 1', 'm.service_catg_id = ?'];
  const params = [ctx.fk_service_catg_id];
  if (search) { where.push('m.material_name LIKE ?'); params.push('%' + search + '%'); }

  const [materials] = await pool.query(
    `SELECT m.material_id, m.material_name, m.pricing_type, u.uom_name
       FROM tbl_material_master m
       LEFT JOIN tbl_uom_master u ON u.uom_id = m.uom_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.material_name ASC`,
    params,
  );
  if (materials.length === 0) return { items: [] };

  const [brandRows] = await pool.query(
    `SELECT gb.material_id, bm.brand_id, bm.brand_name
       FROM tbl_material_price_group_brand gb
       JOIN tbl_brand_master bm ON bm.brand_id = gb.brand_id AND bm.status = 1
      WHERE gb.material_id IN (?)
      ORDER BY bm.brand_name ASC`,
    [materials.map((m) => m.material_id)],
  );
  const brandsByMaterial = new Map();
  for (const b of brandRows) {
    if (!brandsByMaterial.has(b.material_id)) brandsByMaterial.set(b.material_id, []);
    brandsByMaterial.get(b.material_id).push(b);
  }

  const items = [];
  for (const m of materials) {
    const brandRowsForMaterial = brandsByMaterial.get(m.material_id) || [];
    if (brandRowsForMaterial.length === 0) {
      const resolved = await resolveMaterialPrice({
        clientId: job.fk_client_id, materialId: m.material_id, brandId: null, stateId: ctx.state_id,
      });
      items.push({
        material_id: m.material_id, material_name: m.material_name,
        uom_name: m.uom_name || null, pricing_type: m.pricing_type,
        brands: [], price: resolved.price, price_source: resolved.source,
      });
      continue;
    }
    const brands = [];
    for (const b of brandRowsForMaterial) {
      const resolved = await resolveMaterialPrice({
        clientId: job.fk_client_id, materialId: m.material_id, brandId: b.brand_id, stateId: ctx.state_id,
      });
      brands.push({ brand_id: b.brand_id, brand_name: b.brand_name, price: resolved.price, price_source: resolved.source });
    }
    items.push({
      material_id: m.material_id, material_name: m.material_name,
      uom_name: m.uom_name || null, pricing_type: m.pricing_type,
      brands, price: null, price_source: null,
    });
  }
  logger.info('Returning ' + items.length + ' materials · jobId=' + jobId);
  return { items };
}

/* ─── Quotation lines ───────────────────────────────────────────────────
 * Insert one estimate line (product or material) into quotation_details.
 *
 *   type       'product' | 'material'
 *   itemId     product only → client_service_id (rate-card row).
 *   materialId material only → REQUIRED (the free-text material path is
 *              removed — see the design doc's "Backend" section). The
 *              Others/material-add-request flow never reaches this function;
 *              it POSTs material-request instead and creates no quotation line.
 *   brandId    material only, optional — selects which brand price applies.
 *   name       display label. For material lines the master's own
 *              material_name is used regardless of what the client sends —
 *              this is a master-list picker now, not free text.
 *   quantity   → quotation_details.unit  (legacy column name for qty)
 *   amount     → quotation_details.unit_price for PRODUCT lines, unchanged.
 *
 *              OWNER DECISION (2026-09-21): for a MATERIAL line, the
 *              technician's own quoted `amount` is now what gets billed as
 *              unit_price — a material priced ₹500 in the rate card but
 *              actually bought for ₹550 must quote ₹550. The OLD rule (the
 *              server re-resolved the price and ignored `amount`) is
 *              RETIRED. `amount` is required (> 0); when it is absent (or
 *              not a positive number) it defaults to the resolver's price,
 *              and only 422s when NEITHER is available.
 *
 *              `client_charge` now carries the resolveMaterialPrice() result
 *              as a SNAPSHOT of what the rate card said at quote time (NULL
 *              when the resolver has no price at all — source 'none' —
 *              because client_charge is a nullable float column and NULL is
 *              the only value a reader can tell apart from a genuine ₹0
 *              rate-card price). This lets the CRM show Rate Card
 *              (client_charge) vs Amount Quoted (unit_price) vs Approved
 *              (approved_charge) side by side — see routes/admin/jobs.js's
 *              job/transaction view, which already reads client_charge.
 *
 * status defaults to 1 (active, pending approval) — same default the admin
 * route uses. easyfxer_id (legacy typo) stamps the technician who raised
 * the line. sent_on = now marks it raised-from-app.
 *
 * Returns { lineId }.
 */
/*
 * Resolve one line's shape + pricing WITHOUT writing anything — the shared
 * core between the single add, the bulk draft add, and send-for-approval's
 * inline `lines`. `job` is the jobForTech() row (already ownership-checked
 * by the caller); `ctx` is jobEstimateContext(jobId) (also already fetched
 * by the caller — resolving it once per bulk call, not once per line).
 * Throws { status: 422 } exactly as the single-add path always has.
 */
async function resolveLineForInsert(job, ctx, { type, itemId, name, quantity, amount, materialId, brandId }) {
  const isProduct = type === 'product';
  let clientServiceId = null;
  let materialIdOut = null;
  let lineName = name || null;
  let unitPrice = amount;
  let clientCharge = 0; // product lines: unchanged, always 0 (out of scope of this change)
  let txShare = 0; // product lines: no Tx Share concept — stays 0, same as clientCharge above

  if (isProduct) {
    clientServiceId = itemId || null;
  } else {
    // Material line — master-list only. A missing material_id means the
    // client is still on the old free-text path (or Others reached this
    // endpoint by mistake, which it never should — Others posts to
    // material-request instead) — reject rather than silently accepting it.
    if (!materialId) {
      logger.warn('Add quotation line rejected · material_id required · jobId=' + job.job_id);
      const e = new Error('material_id is required for material lines'); e.status = 422; throw e;
    }

    const [[material]] = await pool.query(
      `SELECT material_id, material_name, service_catg_id, CAST(status AS SIGNED) AS status
         FROM tbl_material_master WHERE material_id = ? LIMIT 1`,
      [materialId],
    );
    if (!material || material.status !== 1 || Number(material.service_catg_id) !== Number(ctx.fk_service_catg_id)) {
      logger.warn('Add quotation line rejected · material not available for this job · jobId=' + job.job_id + ' · materialId=' + materialId);
      const e = new Error('material not found for this job'); e.status = 422; throw e;
    }

    const resolved = await resolveMaterialPrice({
      clientId: job.fk_client_id, materialId, brandId: brandId || null, stateId: ctx.state_id,
    });
    // resolvedPrice is the rate-card snapshot: NULL for 'none' (no price
    // anywhere), a real number — possibly 0 — otherwise.
    const resolvedPrice = resolved.source === 'none' ? null : (Number(resolved.price) || 0);

    const quotedAmount = Number(amount);
    const hasQuote = Number.isFinite(quotedAmount) && quotedAmount > 0;
    if (!hasQuote && resolvedPrice === null) {
      logger.warn('Add quotation line rejected · no technician amount and no resolvable rate-card price · jobId=' + job.job_id + ' · materialId=' + materialId);
      const e = new Error('amount is required for material lines with no resolvable rate-card price'); e.status = 422; throw e;
    }
    /*
     * quotation_details.unit_price is a legacy INT column: a fractional quote
     * would be TRUNCATED by MySQL with no error (₹550.50 → ₹550). Refuse it
     * instead — the app only offers whole rupees — so a technician's money is
     * never silently rounded down. client_charge / approved_charge are FLOAT
     * and keep their paise.
     */
    if (hasQuote && !Number.isInteger(quotedAmount)) {
      const e = new Error('amount must be in whole rupees'); e.status = 422; throw e;
    }
    // The technician's own quote wins when given; the rate-card price is only
    // a fallback for a line with no quote at all (owner decision, 2026-09-21).
    // The fallback is rounded for the same INT column, rather than truncated.
    unitPrice = hasQuote ? quotedAmount : Math.round(resolvedPrice);
    clientCharge = resolvedPrice;
    materialIdOut = materialId;
    lineName = material.material_name;
    // Tx Share (2026-09-24) snapshot for this unit — the resolver's own
    // figure (client_state/client_group's stored value, or 20% computed for
    // a master hit / a NULL legacy client row), falling back to 20% of the
    // billed unit_price when the resolver had no price at all ('none').
    txShare = (resolved.tx_share !== null && resolved.tx_share !== undefined)
      ? Number(resolved.tx_share) : defaultTxShare(unitPrice);
  }

  return { type, name: lineName, quantity, unitPrice, clientCharge, txShare, clientServiceId, materialId: materialIdOut };
}

/*
 * Insert ONE resolved line as a DRAFT (sent_on = NULL — Material Request
 * Flow v2, 2026-09-21: a line is never "raised from app" at insert time
 * any more; sendForApproval's bulk sent_on stamp is what raises it). Takes
 * an explicit `conn` so a bulk caller can insert several lines inside its
 * own transaction; defaults to `pool` for the single-add path.
 */
async function insertDraftLine(conn, jobId, efrId, resolved) {
  // tx_charge appended LAST in the column list (rather than in its native
  // table position) so every pre-existing positional param index above stays
  // unchanged — see tests/mobile-job-materials.test.js's `ins.params[N]`
  // assertions, none of which needed to move for the 2026-09-24 Tx Share
  // addition.
  const [ins] = await conn.query(
    `INSERT INTO quotation_details
       (type, name, unit, unit_price,
        client_charge, margin,
        status, easyfxer_id, sent_on,
        job_id, client_service_id, material_id, tx_charge)
     VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?)`,
    [
      resolved.type, resolved.name, resolved.quantity, resolved.unitPrice,
      resolved.clientCharge,
      efrId, null,
      jobId, resolved.clientServiceId, resolved.materialId,
      resolved.txShare || 0,
    ],
  );
  return ins.insertId;
}

/*
 * Add ONE draft line (existing single-add path). Draft — sent_on NULL — per
 * the design's "State model": the estimate's old "Send for Approval" button
 * is now "Save"; sending is a separate, explicit step (sendForApproval).
 */
async function addQuotationLine(jobId, efrId, input) {
  logger.info('Add quotation line · jobId=' + jobId + ' · type=' + input.type + ' · itemId=' + (input.itemId || null) + ' · materialId=' + (input.materialId || null) + ' · qty=' + input.quantity);
  const job = await jobForTech(jobId, efrId);
  if (!job) logger.warn('Add quotation line failed · job not found or not owned · jobId=' + jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }
  assertTechCanWriteQuotation(job.job_status);

  const ctx = await jobEstimateContext(jobId);
  const resolved = await resolveLineForInsert(job, ctx, input);
  const lineId = await insertDraftLine(pool, jobId, efrId, resolved);
  logger.info('Quotation line created (draft) · id=' + lineId + ' · jobId=' + jobId);
  return { lineId };
}

/*
 * NEW — POST /:id/quotation/draft. Bulk add, 1..50 lines (Joi-bounded at the
 * route), one transaction: either every line lands or none does. Returns
 * { lineIds } in the SAME order as the input array.
 */
async function addQuotationLines(jobId, efrId, lines) {
  logger.info('Add quotation lines (bulk draft) · jobId=' + jobId + ' · count=' + ((Array.isArray(lines) ? lines : []).length));
  const job = await jobForTech(jobId, efrId);
  if (!job) logger.warn('Bulk add quotation lines failed · job not found or not owned · jobId=' + jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }
  assertTechCanWriteQuotation(job.job_status);

  const list = Array.isArray(lines) ? lines : [];
  if (list.length === 0) { const e = new Error('lines must contain at least one item'); e.status = 422; throw e; }

  const ctx = await jobEstimateContext(jobId);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const lineIds = [];
    for (const input of list) {
      const resolved = await resolveLineForInsert(job, ctx, input);
      lineIds.push(await insertDraftLine(conn, jobId, efrId, resolved));
    }
    await conn.commit();
    logger.info('Bulk draft lines created · jobId=' + jobId + ' · count=' + lineIds.length);
    return { lineIds };
  } catch (e) {
    logger.warn('Bulk add quotation lines failed, rolled back · jobId=' + jobId + ' · ' + e.message);
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/*
 * Delete one quotation line. Self-scoped: the line must belong to a job
 * owned by this technician (we re-resolve the job from the line's job_id
 * and re-check ownership) so a tech can't delete another tech's estimate
 * line by guessing an id. Returns { deleted: true }; throws 404 if the
 * line doesn't exist or isn't this tech's.
 *
 * Two lock checks: the job-level one (anything outside
 * {1,2,20,16,15} -> "This material is locked") and a per-LINE one — only
 * `draft` is technician-editable (owner decision, 2026-09-22 — see
 * assertTechLineEditable above). Because a technician can therefore never
 * delete a sent (review_pending) line any more, the old "deletes the last
 * review_pending line at 16 -> revert to pre-status" transition is
 * unreachable from here and has been removed; CRM Reject Request still
 * reverts to pre-status exactly as before.
 */
async function deleteQuotationLine(jobId, efrId, lineId) {
  logger.info('Delete quotation line · jobId=' + jobId + ' · lineId=' + lineId);
  const job = await jobForTech(jobId, efrId);
  if (!job) logger.warn('Delete quotation line failed · job not found or not owned · jobId=' + jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }
  assertTechCanWriteQuotation(job.job_status);

  // Ensure the line belongs to THIS job (defends against cross-job ids), and
  // fetch exactly the columns quotationLineState needs to derive its state.
  const [[line]] = await pool.query(
    `SELECT id, job_id, sent_on, action_on,
            CAST(status AS UNSIGNED) AS status, CAST(client_status AS SIGNED) AS client_status
       FROM quotation_details WHERE id = ? LIMIT 1`,
    [lineId],
  );
  if (!line || Number(line.job_id) !== Number(jobId)) {
    logger.warn('Delete quotation line failed · line not found for job · jobId=' + jobId + ' · lineId=' + lineId);
    const e = new Error('quotation line not found'); e.status = 404; throw e;
  }
  assertTechLineEditable(quotationLineState.quotationLineState(line));

  await pool.query('DELETE FROM quotation_details WHERE id = ? AND job_id = ?', [lineId, jobId]);
  logger.info('Quotation line deleted · id=' + lineId + ' · jobId=' + jobId);
  return { deleted: true };
}

/*
 * NEW — DELETE /:id/quotation. Deletes every technician-editable line — now
 * `draft` only (owner decision, 2026-09-22) — in one statement — the app's
 * "Delete All". Sent (review_pending) / locked / client-approved / rejected
 * lines are left untouched (not in the SQL's state predicate at all), same
 * as a single delete would refuse them one by one. Returns { deleted: n }.
 */
async function deleteAllQuotationLines(jobId, efrId) {
  logger.info('Delete all technician-editable quotation lines · jobId=' + jobId);
  const job = await jobForTech(jobId, efrId);
  if (!job) logger.warn('Delete-all quotation lines failed · job not found or not owned · jobId=' + jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }
  assertTechCanWriteQuotation(job.job_status);

  const editableSql = quotationLineState.anyStateSql('quotation_details', quotationLineState.TECH_EDITABLE_STATES);
  const [result] = await pool.query(
    `DELETE FROM quotation_details WHERE job_id = ? AND (${editableSql})`,
    [jobId],
  );
  logger.info('Deleted ' + result.affectedRows + ' technician-editable quotation lines · jobId=' + jobId);
  return { deleted: result.affectedRows };
}

/*
 * NEW — GET /:id/quotation. The spec names this exact path as "the existing
 * list" — no such endpoint existed before this change (grep confirms: no
 * GET quotation route in this router, and no reader of quotation_details
 * anywhere under routes/mobile/). Added new, to the spec's exact contract
 * shape, since the CRM and the technician app are building against it in
 * parallel. See the closing report for this deviation.
 */
async function listQuotationLines(jobId, efrId) {
  logger.info('List quotation lines · jobId=' + jobId);
  const job = await jobForTech(jobId, efrId);
  if (!job) logger.warn('List quotation lines failed · job not found or not owned · jobId=' + jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }

  const [rows] = await pool.query(
    `SELECT id, type, name, unit, unit_price, material_id, client_service_id,
            client_charge, approved_charge, sent_on, action_on,
            ${quotationLineState.quotationLineStateSql('quotation_details')} AS state
       FROM quotation_details
      WHERE job_id = ?
      ORDER BY id DESC`,
    [jobId],
  );
  // quotationNo (owner decision, 2026-09-22): 1..n by ascending distinct
  // sent_on within the job; null for a draft. One shared JS helper — see
  // quotation-line-state.js's quotationNumbers.
  const quotationNos = quotationLineState.quotationNumbers(rows.map((r) => r.sent_on));
  return {
    items: rows.map((r, i) => ({
      lineId: r.id,
      type: r.type,
      name: r.name,
      quantity: r.unit,
      amount: r.unit_price,
      materialId: r.material_id,
      itemId: r.client_service_id,
      clientCharge: r.client_charge,
      approvedCharge: r.approved_charge,
      sentOn: r.sent_on,
      actionOn: r.action_on,
      state: r.state,
      quotationNo: quotationNos[i],
    })),
  };
}

/* ─── Send estimate for SPOC approval (Material Request Flow v2) ────────
 * Marks the estimate "sent for approval": stamps
 * tbl_job.approval_sent_on_date_time = now, bumps no_of_req_approval, and
 * moves the order into PENDING_FOR_MATERIAL (16) with material_sub_status = 2
 * (Review Pending) — NOT 15. A PM reviews it first
 * (POST /api/admin/jobs/:id/material-review) and ONLY an approve there moves
 * the job to 15. This is the single source of "estimate sent" the admin
 * quotations expiry endpoint reads (routes/admin/quotations.js GET
 * /expiry/:jobId) — that reader is unaffected, since it keys off
 * approval_sent_on_date_time, not job_status.
 *
 * 2026-09-21 (Material Request Flow v2) rewrites this around the
 * draft/review_pending line-state model — see the design's "Transitions":
 *   - `lines` (optional, same shape as the single/bulk add) are inserted as
 *     DRAFTS in the SAME transaction FIRST, so a send with an inline line
 *     list is one atomic call.
 *   - every CURRENT draft for the job (pre-existing + just-inserted) is
 *     stamped sent_on = now — this is what "drafts -> sent" means; a line
 *     drafted minutes ago and one drafted in this same call are sent
 *     together.
 *   - no draft at all (before OR after inserting `lines`) -> 422 "Add
 *     materials before sending for approval". Nothing is written.
 *   - allowed from 1/2/20/16 (job-level lock — see assertTechCanWriteQuotation);
 *     16 stays 16; 1/2/20 move to 16 and the job's PRE-status is stored
 *     (services/material-review-store.js) so a later CRM Reject Request can
 *     put it back.
 *
 * AMENDMENT (owner decision, 2026-09-22): send is now ALSO allowed to be
 * ATTEMPTED at 15 job-status-wise (drafting the next quotation is allowed
 * there), but is refused with its own message —
 * assertTechCanSendForApproval, not assertTechCanWriteQuotation — because a
 * quotation is already with the client. The stamp itself is now the
 * strictly-later timestamp quotationLineState.nextSentOn computes against
 * the job's MAX(sent_on): "a QUOTATION = the lines stamped by one send, with
 * one exact sent_on" only holds if two sends can never land in the same
 * second.
 *
 * `checkInImageRefs` (optional) — if the app passes check-in image S3 keys
 * alongside the send, we record them as Booking-stage refs so the estimate
 * carries its site photos.
 *
 * Returns { sent: true }.
 */
async function sendForApproval(jobId, efrId, { checkInImageRefs, lines } = {}) {
  logger.info('Send estimate for approval · jobId=' + jobId + ' · checkInImageRefs=' + ((Array.isArray(checkInImageRefs) ? checkInImageRefs : []).length) + ' · lines=' + ((Array.isArray(lines) ? lines : []).length));
  const job = await jobForTech(jobId, efrId);
  if (!job) logger.warn('Send for approval failed · job not found or not owned · jobId=' + jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }
  assertTechCanSendForApproval(job.job_status);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const now = new Date();

    if (Array.isArray(lines) && lines.length) {
      const ctx = await jobEstimateContext(jobId);
      for (const input of lines) {
        const resolved = await resolveLineForInsert(job, ctx, input);
        await insertDraftLine(conn, jobId, efrId, resolved);
      }
    }

    // Lock the job's current drafts so a concurrent add can't sneak a line
    // past the "at least one draft" check between the count and the UPDATE.
    const [draftRows] = await conn.query(
      `SELECT id FROM quotation_details
        WHERE job_id = ? AND (${quotationLineState.statePredicateSql('quotation_details', quotationLineState.STATE.DRAFT)})
        FOR UPDATE`,
      [jobId],
    );
    if (draftRows.length === 0) {
      const e = new Error('Add materials before sending for approval'); e.status = 422; throw e;
    }

    // One-timestamp-per-send, strictly later than any sent_on already on the
    // job (owner decision, 2026-09-22 — see quotation-line-state.js's
    // nextSentOn header comment). The FOR UPDATE lock above already
    // serializes concurrent sends on this job, so this plain read is safe.
    const [[maxRow]] = await conn.query(
      'SELECT MAX(sent_on) AS maxSentOn FROM quotation_details WHERE job_id = ?',
      [jobId],
    );
    const sentOn = quotationLineState.nextSentOn(now, maxRow.maxSentOn);

    await conn.query(
      `UPDATE quotation_details SET sent_on = ?
        WHERE job_id = ? AND (${quotationLineState.statePredicateSql('quotation_details', quotationLineState.STATE.DRAFT)})`,
      [sentOn, jobId],
    );

    // Store the pre-status only on the FIRST entry into the material flow —
    // a job already at 16 keeps whatever it stored the first time.
    if (Number(job.job_status) !== STATUS_PENDING_FOR_MATERIAL) {
      await storePreMaterialStatus(jobId, Number(job.job_status), conn);
    }

    await conn.query(
      `UPDATE tbl_job
          SET approval_sent_on_date_time = ?,
              no_of_req_approval = COALESCE(no_of_req_approval, 0) + 1,
              job_status = ?,
              material_sub_status = ?,
              last_update_time = ?
        WHERE job_id = ? AND fk_easyfixter_id = ?`,
      [now, STATUS_PENDING_FOR_MATERIAL, MATERIAL_SUB_STATUS_REVIEW_PENDING, now, jobId, efrId],
    );

    if (Array.isArray(checkInImageRefs) && checkInImageRefs.length) {
      for (const ref of checkInImageRefs) {
        if (!ref || !String(ref).trim()) continue;
        await conn.query(
          `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, created_date)
           VALUES (?, ?, ?, ?, ?)`,
          // Check-in evidence attached to an estimate. Stored under the one
          // vocabulary every reader in the estate understands — see
          // utils/job-image-buckets.js.
          [jobId, String(ref).trim(), persistedCategory('Booking'), 0, now],
        );
      }
    }

    await conn.commit();
    logger.info('Estimate sent for approval · jobId=' + jobId + ' · status=' + STATUS_PENDING_FOR_MATERIAL + '/' + MATERIAL_SUB_STATUS_REVIEW_PENDING);
    return { sent: true };
  } catch (e) {
    if (!e.status) logger.error('Send for approval failed, rolled back · jobId=' + jobId + ' · ' + e.message);
    try { await conn.rollback(); } catch { /* already rolled back above (422 path) */ }
    throw e;
  } finally {
    conn.release();
  }
}

/* ─── Material Required — RETIRED as its own transition, kept as an ALIAS
 * (Material Request Flow v2, 2026-09-21) ───────────────────────────────
 * material_sub_status = 1 (Quotation Pending) is no longer written by this
 * codebase — the "raise a request" and "send it for review" steps have
 * merged into ONE action (sendForApproval). This endpoint is kept only so
 * older app builds that still call it keep working: it is now a literal
 * alias, with sendForApproval's own rules (a job with no draft line -> 422;
 * reachable from 1/2/20/16; 15 -> 409 "Your previous quotation is with the
 * client — send this one after they decide"). Positive behaviour change
 * older builds must tolerate: previously a bare 2/20 job with NO lines could
 * be marked material-required; now it 422s ("Add materials before sending
 * for approval") because there is nothing to send.
 *
 * Returns { ok: true, status: 16 } (sendForApproval's own `{ sent: true }`
 * carries no `status` key — normalised here so old callers reading
 * `out.status` still see 16 on success).
 */
async function materialRequired(jobId, efrId) {
  logger.info('Material required (alias of sendForApproval) · jobId=' + jobId);
  await sendForApproval(jobId, efrId, {});
  return { ok: true, status: STATUS_PENDING_FOR_MATERIAL };
}

/* ─── Job images ────────────────────────────────────────────────────────
 * Record job image refs (already-uploaded S3 keys) against the job.
 * category ∈ { Booking, Completion } — maps to the
 * JobSupportings/<Category>_<JobID>_<Seq> key convention. The caller sends
 * `refs[]` of canonical S3 keys (multipart byte upload is a // VERIFY in the
 * route — for now we persist refs the app already produced).
 *
 * Booking-stage rows get job_stage = 0; Completion gets job_stage = 5
 * (matching the admin transaction-view STAGE_MAP: 5 → checkout). Multi-row
 * insert → transaction.
 *
 * The category the app SENDS ('Booking' / 'Completion') is not the category
 * STORED: `persistedCategory` maps it onto the legacy 'checkin' / 'checkout'
 * vocabulary, so one column speaks one language. The S3 key convention is
 * unchanged — it is a separate namespace and the presign path depends on its
 * shape. See utils/job-image-buckets.js for why.
 *
 * Returns { ok: true, inserted: <n> }.
 */
async function recordImages(jobId, efrId, { category, refs }) {
  logger.info('Record job images · jobId=' + jobId + ' · category=' + category + ' · refs=' + ((Array.isArray(refs) ? refs : []).length));
  const job = await jobForTech(jobId, efrId);
  if (!job) logger.warn('Record images failed · job not found or not owned · jobId=' + jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }
  if (!IMAGE_CATEGORIES.has(category)) {
    logger.warn('Record images rejected · invalid image category · category=' + category);
    const e = new Error('invalid image category'); e.status = 400; throw e;
  }
  const jobStage = category === 'Completion' ? 5 : 0;
  const cleaned = (Array.isArray(refs) ? refs : [])
    .map((r) => String(r || '').trim())
    .filter(Boolean);
  if (cleaned.length === 0) return { ok: true, inserted: 0 };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const createdDate = new Date();
    for (const ref of cleaned) {
      await conn.query(
        `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, created_date)
         VALUES (?, ?, ?, ?, ?)`,
        [jobId, ref, persistedCategory(category), jobStage, createdDate],
      );
    }
    await conn.commit();
    logger.info('Recorded ' + cleaned.length + ' job images · jobId=' + jobId + ' · category=' + category);
    return { ok: true, inserted: cleaned.length };
  } catch (e) {
    logger.error('Record images failed, rolled back · jobId=' + jobId + ' · ' + e.message);
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/* ─── Delete one before/after photo ─────────────────────────────────────
 * The technician took the wrong photo. Until now that was permanent from the
 * app: the only deletes in the estate were the two admin routes on
 * routes/admin/job-documents.js, and nothing mobile.
 *
 * TWO GUARDS, and neither is optional.
 *
 * 1. CATEGORY. Delegates to the shared job-image.service deleteJobImage() with
 *    an explicit `categories` allowlist — the before/after PROOF buckets from
 *    utils/job-image-buckets.js and nothing else. tbl_job_image is one table
 *    holding several unrelated kinds of evidence (Purchase Order, Job Sheet,
 *    the customer's feedback PDF, the customer's signature), and an image_id is
 *    just an integer: without the allowlist, "delete my photo" is
 *    "delete any row on this job" and a mistyped id removes a signed document.
 *    The allowlist is DERIVED from the same constants the readers bucket on, so
 *    a category added there cannot silently fall outside this guard — and a
 *    category added to DOCUMENT_CATEGORIES stays undeletable by construction.
 *
 * 2. STATUS — `DELETABLE_STATUSES` below. A CLOSED ALLOWLIST, deliberately, not
 *    "anything that is not completed": a status this backend gains later is
 *    refused until somebody decides it should be allowed, which is the safe
 *    direction when the mistake is irreversible.
 *
 *      2  IN_PROGRESS                — the technician is on site working
 *      15 ESTIMATE_PENDING_APPROVAL  — still on site, waiting on the client
 *      16 PENDING_FOR_MATERIAL       — still on site, building/awaiting review
 *                                      of a material estimate (2026-09-18,
 *                                      sub-project D) — added here because
 *                                      sendForApproval no longer moves a job
 *                                      straight to 15; a job in the tech's
 *                                      hands lands on 16 first (both sub-
 *                                      states), and evidence should be
 *                                      un-takeable through that whole window
 *                                      for the same reason 15 already was.
 *                                      15 is kept as-is (additive, not a
 *                                      narrowing) for any job already at 15
 *                                      from before this feature shipped.
 *
 *    2/15/16 are the statuses in which the app lets a proof photo be ADDED
 *    (the order page gates its Work sections on status 2 or 15 — the app's
 *    own gating for 16 is out of this repo's scope), so delete gets
 *    precisely the same window as create: there is no state in which a photo
 *    can be taken and not un-taken. Everything else is refused because the
 *    evidence has left the technician's hands — 20
 *    PENDING_TO_CLOSE means the checkout was submitted and billing is reading
 *    it, 3/5 are completed, 10 is a closed visit, 6 is cancelled, and 0/1
 *    precede any work photo existing at all. Deleting proof off a completed or
 *    invoiced job is the one mistake nothing downstream can undo.
 *
 * Ownership is checked first (jobForTech), so a tech can never address another
 * technician's job, and the image must belong to THIS job (jobId guard) so an
 * id from one job cannot delete a row on another.
 *
 * Returns { ok: true, imageId, category }.
 */
const DELETABLE_STATUSES = new Set([2, STATUS_ESTIMATE_PENDING_APPROVAL, STATUS_PENDING_FOR_MATERIAL]);

/** The proof buckets, and only those — never a document, signature or PDF. */
const DELETABLE_IMAGE_CATEGORIES = [
  ...PROOF_BEFORE_CATEGORIES,
  ...PROOF_AFTER_CATEGORIES,
];

async function deleteImage(jobId, efrId, imageId) {
  logger.info('Delete job image · jobId=' + jobId + ' · imageId=' + imageId);
  const job = await jobForTech(jobId, efrId);
  if (!job) {
    logger.warn('Delete job image failed · job not found or not owned · jobId=' + jobId);
    const e = new Error('job not found'); e.status = 404; throw e;
  }
  if (!DELETABLE_STATUSES.has(Number(job.job_status))) {
    logger.warn('Delete job image rejected · status not deletable · jobId=' + jobId
      + ' · status=' + job.job_status);
    const e = new Error('photos can only be removed while the job is in progress');
    e.status = 409; throw e;
  }

  const removed = await deleteJobImage({
    imageId: Number(imageId),
    jobId: Number(jobId),
    categories: DELETABLE_IMAGE_CATEGORIES,
  });
  if (!removed) {
    // Either the row is not on this job, or it is not a before/after work photo.
    // ONE 404 for both: telling a caller which of the two it was would confirm
    // that a document row with that id exists on the job.
    logger.warn('Delete job image failed · no matching work photo · jobId=' + jobId
      + ' · imageId=' + imageId);
    const e = new Error('photo not found'); e.status = 404; throw e;
  }
  logger.info('Job image deleted · jobId=' + jobId + ' · imageId=' + imageId
    + ' · category=' + removed.image_category);
  return { ok: true, imageId: removed.image_id, category: removed.image_category };
}

/* ─── Questionnaire ─────────────────────────────────────────────────────
 * Fetch the client questionnaire (the legacy "client report" questions) for
 * this job's client, with any already-submitted answers merged in.
 *
 * Questions come from tbl_questionaire_details (joined to its active
 * tbl_questionaire header scoped to the job's client). Answers come from
 * tbl_questionaire_answer keyed by (job_id, c_qd_id). The merge is done in
 * one LEFT JOIN so the app gets the question text + current answer in a
 * single round-trip.
 *
 * Returns:
 *   { questions: [{ questionId, question, type, category, seq, mandatory,
 *                   values, answer, comments }] }
 */
async function getQuestionnaire(jobId, efrId) {
  logger.info('Get job questionnaire · jobId=' + jobId);
  const job = await jobForTech(jobId, efrId);
  if (!job) logger.warn('Get questionnaire failed · job not found or not owned · jobId=' + jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }

  const [rows] = await pool.query(
    `SELECT qd.c_qd_id            AS questionId,
            qd.c_qd_text          AS question,
            qd.c_qd_type          AS type,
            qd.c_qd_category      AS category,
            qd.c_qd_seq           AS seq,
            qd.c_qd_mandatory     AS mandatory,
            qd.c_qd_values        AS \`values\`,
            qa.c_qd_ans           AS answer,
            qa.c_qd_comments      AS comments
       FROM tbl_questionaire_details qd
       INNER JOIN tbl_questionaire q
               ON q.c_questionaire_id = qd.c_questionaire_id
              AND q.status = 1
              AND q.client_id = ?
       LEFT JOIN tbl_questionaire_answer qa
              ON qa.c_qd_id = qd.c_qd_id
             AND qa.job_id = ?
      WHERE qd.status = 1
      ORDER BY qd.c_qd_seq, qd.c_qd_id`,
    [job.fk_client_id, jobId],
  );
  logger.info('Returning ' + rows.length + ' questionnaire questions · jobId=' + jobId);

  return {
    questions: rows.map((r) => ({
      questionId: r.questionId,
      question: r.question || null,
      type: r.type || null,
      category: r.category || null,
      seq: r.seq,
      mandatory: r.mandatory === 1 || r.mandatory === true,
      values: r.values || null,
      answer: r.answer ?? null,
      comments: r.comments ?? null,
    })),
  };
}

/*
 * Submit questionnaire answers. `answers` is an array of
 *   { questionId, answer, comments? }
 * Each is UPSERTed into tbl_questionaire_answer keyed by (job_id, c_qd_id):
 * there's no reliable composite unique key on that legacy table, so we do a
 * manual UPDATE-then-INSERT per answer (same defensive pattern the verify-otp
 * device_info upsert uses). All wrapped in one transaction.
 *
 * c_questionaire_id is resolved from tbl_questionaire_details for the row so
 * the answer carries the right questionnaire FK (the app only sends
 * questionId = c_qd_id). inserted_by / updated_by stamp the technician.
 *
 * Returns { submitted: true, count: <n> }.
 */
async function submitQuestionnaire(jobId, efrId, answers) {
  logger.info('Submit questionnaire answers · jobId=' + jobId + ' · answers=' + ((Array.isArray(answers) ? answers : []).length));
  const job = await jobForTech(jobId, efrId);
  if (!job) logger.warn('Submit questionnaire failed · job not found or not owned · jobId=' + jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }

  const list = Array.isArray(answers) ? answers : [];
  if (list.length === 0) return { submitted: true, count: 0 };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const now = new Date();
    let count = 0;
    for (const a of list) {
      const qid = Number(a?.questionId);
      if (!Number.isInteger(qid) || qid <= 0) continue;
      const answer = a?.answer != null ? String(a.answer) : null;
      const comments = a?.comments != null ? String(a.comments) : null;

      // Resolve the parent questionnaire id for this question (scoped to the
      // job's client so a tech can't answer another client's question).
      const [[qd]] = await conn.query(
        `SELECT qd.c_questionaire_id
           FROM tbl_questionaire_details qd
           INNER JOIN tbl_questionaire q
                   ON q.c_questionaire_id = qd.c_questionaire_id
                  AND q.client_id = ?
          WHERE qd.c_qd_id = ? LIMIT 1`,
        [job.fk_client_id, qid],
      );
      if (!qd) continue; // question not part of this client's questionnaire
      const questionaireId = qd.c_questionaire_id;

      // UPDATE first (one answer per question per job)…
      const [upd] = await conn.query(
        `UPDATE tbl_questionaire_answer
            SET c_qd_ans = ?, c_qd_comments = ?, updated_by = ?, update_date = ?
          WHERE job_id = ? AND c_qd_id = ?`,
        [answer, comments, efrId, now, jobId, qid],
      );
      // …INSERT if no existing row.
      if (upd.affectedRows === 0) {
        await conn.query(
          `INSERT INTO tbl_questionaire_answer
             (c_qd_id, job_id, c_questionaire_id, c_qd_ans, c_qd_comments,
              inserted_by, insert_date)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [qid, jobId, questionaireId, answer, comments, efrId, now],
        );
      }
      count += 1;
    }
    await conn.commit();
    logger.info('Questionnaire answers saved · count=' + count + ' · jobId=' + jobId);
    return { submitted: true, count };
  } catch (e) {
    logger.error('Submit questionnaire failed, rolled back · jobId=' + jobId + ' · ' + e.message);
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/* ─── Work progress (lifecycle timeline) ────────────────────────────────
 * Returns the job's lifecycle stages as an ordered timeline the app renders
 * as a progress tracker. Each stage carries a `done` flag + a timestamp
 * derived from the canonical tbl_job audit columns, with the scheduling_history
 * sub-schedule count surfaced as the "Scheduled" stage detail.
 *
 * Stages (mirrors the Order Lifecycle stages + the admin transaction view):
 *   booked → scheduled → checkedIn → quotationSent → quotationActioned →
 *   completed
 *
 * Returns { stages: [{ key, label, done, at }] }.
 */
async function getWorkProgress(jobId, efrId) {
  logger.info('Get job work progress timeline · jobId=' + jobId);
  const job = await jobForTech(jobId, efrId);
  if (!job) logger.warn('Get work progress failed · job not found or not owned · jobId=' + jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }

  // Pull the audit-stamp columns + one derived quotation-action timestamp.
  const [[row]] = await pool.query(
    `SELECT j.job_id, j.job_status,
            j.created_date_time, j.scheduled_date_time,
            j.checkin_date_time, j.checkout_date_time,
            j.approval_sent_on_date_time,
            j.approved_on_date_time, j.approval_reject_date_time,
            (SELECT COUNT(*) FROM scheduling_history sh WHERE sh.job_id = j.job_id) AS schedule_count,
            (SELECT MAX(qd.action_on) FROM quotation_details qd
              WHERE qd.job_id = j.job_id AND qd.action_on IS NOT NULL) AS quotation_actioned_on
       FROM tbl_job j
      WHERE j.job_id = ? LIMIT 1`,
    [jobId],
  );

  const approvalActioned = row.approved_on_date_time || row.approval_reject_date_time || row.quotation_actioned_on || null;

  const stages = [
    { key: 'booked',            label: 'Booked',             at: row.created_date_time || null },
    { key: 'scheduled',         label: 'Scheduled',          at: row.scheduled_date_time || null,
      scheduleCount: Number(row.schedule_count) || 0 },
    { key: 'checkedIn',         label: 'Checked In',         at: row.checkin_date_time || null },
    { key: 'quotationSent',     label: 'Estimate Sent',      at: row.approval_sent_on_date_time || null },
    { key: 'quotationActioned', label: 'Estimate Actioned',  at: approvalActioned },
    { key: 'completed',         label: 'Completed',          at: row.checkout_date_time || null },
  ].map((s) => ({ ...s, done: Boolean(s.at) }));

  logger.info('Returning ' + stages.length + ' work-progress stages · jobId=' + jobId + ' · status=' + row.job_status);
  return { stages };
}

module.exports = {
  jobForTech,
  getRateCard,
  getJobMaterials,
  listQuotationLines,
  addQuotationLine,
  addQuotationLines,
  deleteQuotationLine,
  deleteAllQuotationLines,
  sendForApproval,
  materialRequired,
  recordImages,
  deleteImage,
  DELETABLE_STATUSES,
  DELETABLE_IMAGE_CATEGORIES,
  getQuestionnaire,
  submitQuestionnaire,
  getWorkProgress,
  IMAGE_CATEGORIES,
};
