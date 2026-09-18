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
const { resolveMaterialPrice } = require('./material-price-resolver');

// Job status codes (mirror services/job.service.js STATUS — duplicated as a
// local const so this service has no circular dependency on job.service.js,
// which the no-edit rule forbids us touching).
const STATUS_ESTIMATE_PENDING_APPROVAL = 15;
// Material Management phase 2, sub-project D (2026-09-18) — see
// docs/superpowers/specs/2026-09-18-pending-for-material-status-16-design.md.
const STATUS_IN_PROGRESS = 2;
const STATUS_IN_PROGRESS_ALT = 20;
const STATUS_PENDING_FOR_MATERIAL = 16;
// material_sub_status: 1 = Quotation Pending, 2 = Review Pending.
const MATERIAL_SUB_STATUS_QUOTATION_PENDING = 1;
const MATERIAL_SUB_STATUS_REVIEW_PENDING = 2;

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
 *   amount     → quotation_details.unit_price for PRODUCT lines. For a
 *              MATERIAL line this is only a suggestion: the server
 *              re-resolves the price via resolveMaterialPrice() and stores
 *              THAT, ignoring `amount` unless the resolver has no price at
 *              all (source 'none' — phase-1 "Price Pending"), so a modified
 *              app can never quote an arbitrary number.
 *
 * status defaults to 1 (active, pending approval) — same default the admin
 * route uses. easyfxer_id (legacy typo) stamps the technician who raised
 * the line. sent_on = now marks it raised-from-app.
 *
 * Returns { lineId }.
 */
async function addQuotationLine(jobId, efrId, { type, itemId, name, quantity, amount, materialId, brandId }) {
  logger.info('Add quotation line · jobId=' + jobId + ' · type=' + type + ' · itemId=' + (itemId || null) + ' · materialId=' + (materialId || null) + ' · qty=' + quantity);
  const job = await jobForTech(jobId, efrId);
  if (!job) logger.warn('Add quotation line failed · job not found or not owned · jobId=' + jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }

  const isProduct = type === 'product';
  let clientServiceId = null;
  let materialIdOut = null;
  let lineName = name || null;
  let unitPrice = amount;

  if (isProduct) {
    clientServiceId = itemId || null;
  } else {
    // Material line — master-list only. A missing material_id means the
    // client is still on the old free-text path (or Others reached this
    // endpoint by mistake, which it never should — Others posts to
    // material-request instead) — reject rather than silently accepting it.
    if (!materialId) {
      logger.warn('Add quotation line rejected · material_id required · jobId=' + jobId);
      const e = new Error('material_id is required for material lines'); e.status = 422; throw e;
    }

    const ctx = await jobEstimateContext(jobId);
    const [[material]] = await pool.query(
      `SELECT material_id, material_name, service_catg_id, CAST(status AS SIGNED) AS status
         FROM tbl_material_master WHERE material_id = ? LIMIT 1`,
      [materialId],
    );
    if (!material || material.status !== 1 || Number(material.service_catg_id) !== Number(ctx.fk_service_catg_id)) {
      logger.warn('Add quotation line rejected · material not available for this job · jobId=' + jobId + ' · materialId=' + materialId);
      const e = new Error('material not found for this job'); e.status = 422; throw e;
    }

    const resolved = await resolveMaterialPrice({
      clientId: job.fk_client_id, materialId, brandId: brandId || null, stateId: ctx.state_id,
    });
    unitPrice = resolved.source === 'none' ? (Number(amount) || 0) : (Number(resolved.price) || 0);
    materialIdOut = materialId;
    lineName = material.material_name;
  }

  const [ins] = await pool.query(
    `INSERT INTO quotation_details
       (type, name, unit, unit_price,
        tx_charge, client_charge, margin,
        status, easyfxer_id, sent_on,
        job_id, client_service_id, material_id)
     VALUES (?, ?, ?, ?, 0, 0, 0, 1, ?, ?, ?, ?, ?)`,
    [
      type, lineName, quantity, unitPrice,
      efrId, new Date(),
      jobId, clientServiceId, materialIdOut,
    ],
  );
  logger.info('Quotation line created · id=' + ins.insertId + ' · jobId=' + jobId);
  return { lineId: ins.insertId };
}

/*
 * Delete one quotation line. Self-scoped: the line must belong to a job
 * owned by this technician (we re-resolve the job from the line's job_id
 * and re-check ownership) so a tech can't delete another tech's estimate
 * line by guessing an id. Returns { deleted: true }; throws 404 if the
 * line doesn't exist or isn't this tech's.
 */
async function deleteQuotationLine(jobId, efrId, lineId) {
  logger.info('Delete quotation line · jobId=' + jobId + ' · lineId=' + lineId);
  const job = await jobForTech(jobId, efrId);
  if (!job) logger.warn('Delete quotation line failed · job not found or not owned · jobId=' + jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }

  // Ensure the line belongs to THIS job (defends against cross-job ids).
  const [[line]] = await pool.query(
    'SELECT id, job_id FROM quotation_details WHERE id = ? LIMIT 1',
    [lineId],
  );
  if (!line || Number(line.job_id) !== Number(jobId)) {
    logger.warn('Delete quotation line failed · line not found for job · jobId=' + jobId + ' · lineId=' + lineId);
    const e = new Error('quotation line not found'); e.status = 404; throw e;
  }
  await pool.query('DELETE FROM quotation_details WHERE id = ? AND job_id = ?', [lineId, jobId]);
  logger.info('Quotation line deleted · id=' + lineId + ' · jobId=' + jobId);
  return { deleted: true };
}

/* ─── Send estimate for SPOC approval ───────────────────────────────────
 * Marks the estimate "sent for approval": stamps
 * tbl_job.approval_sent_on_date_time = now, bumps no_of_req_approval,
 * and moves the order into PENDING_FOR_MATERIAL (16) with
 * material_sub_status = 2 (Review Pending) — NOT 15. This is the behaviour
 * change sub-project D exists for: an unreviewed quote used to reach the
 * client straight from here (job_status = 15, which the client portal
 * treats as "awaiting your decision"); now a PM reviews it first
 * (POST /api/admin/jobs/:id/material-review) and ONLY an approve there
 * moves the job to 15. This is the single source of "estimate sent" the
 * admin quotations expiry endpoint reads (routes/admin/quotations.js GET
 * /expiry/:jobId) — that reader is unaffected, since it keys off
 * approval_sent_on_date_time, not job_status.
 *
 * `checkInImageRefs` (optional) — if the app passes check-in image S3 keys
 * alongside the send, we record them as Booking-stage refs so the estimate
 * carries its site photos. Multi-step write (job UPDATE + N image inserts)
 * → wrapped in a transaction per the coding rules.
 *
 * Returns { sent: true }.
 */
async function sendForApproval(jobId, efrId, { checkInImageRefs } = {}) {
  logger.info('Send estimate for approval · jobId=' + jobId + ' · checkInImageRefs=' + ((Array.isArray(checkInImageRefs) ? checkInImageRefs : []).length));
  const job = await jobForTech(jobId, efrId);
  if (!job) logger.warn('Send for approval failed · job not found or not owned · jobId=' + jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const now = new Date();

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
    logger.error('Send for approval failed, rolled back · jobId=' + jobId + ' · ' + e.message);
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/* ─── Material Required (Material Management phase 2, sub-project D) ───
 * A technician on a 2/20 job flags that the job cannot close without
 * material: moves the order to PENDING_FOR_MATERIAL (16) with
 * material_sub_status = 1 (Quotation Pending). The estimate stays editable
 * in this sub-state — send-for-approval (above) is the transition into
 * sub-status 2 (Review Pending), which the PM then approves/rejects via
 * POST /api/admin/jobs/:id/material-review.
 *
 * Guarded to source statuses 2/20 only — those are exactly the "Pending to
 * Close on App" statuses the design's flow diagram starts from. Anything
 * else 409s rather than silently accepting: a job not yet checked in, or
 * already closed/cancelled, has no "material required" moment.
 *
 * Returns { ok: true, status: 16 }.
 */
async function materialRequired(jobId, efrId) {
  logger.info('Mark job material-required · jobId=' + jobId);
  const job = await jobForTech(jobId, efrId);
  if (!job) logger.warn('Material-required failed · job not found or not owned · jobId=' + jobId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }

  if (![STATUS_IN_PROGRESS, STATUS_IN_PROGRESS_ALT].includes(Number(job.job_status))) {
    logger.warn('Material-required refused · jobId=' + jobId + ' · job_status=' + job.job_status);
    const e = new Error('Only a job pending to close on the app can be marked material-required');
    e.status = 409; throw e;
  }

  const now = new Date();
  await pool.query(
    `UPDATE tbl_job
        SET job_status = ?,
            material_sub_status = ?,
            last_update_time = ?
      WHERE job_id = ? AND fk_easyfixter_id = ?`,
    [STATUS_PENDING_FOR_MATERIAL, MATERIAL_SUB_STATUS_QUOTATION_PENDING, now, jobId, efrId],
  );
  logger.info('Job marked material-required · jobId=' + jobId + ' · status=' + STATUS_PENDING_FOR_MATERIAL + '/' + MATERIAL_SUB_STATUS_QUOTATION_PENDING);
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
  addQuotationLine,
  deleteQuotationLine,
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
