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

// Job status codes (mirror services/job.service.js STATUS — duplicated as a
// local const so this service has no circular dependency on job.service.js,
// which the no-edit rule forbids us touching).
const STATUS_ESTIMATE_PENDING_APPROVAL = 15;

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
  const job = await jobForTech(jobId, efrId);
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

  return {
    items: rows.map((r) => ({
      clientRateCardId: r.clientRateCardId,
      name: r.name || null,
      price: Number(r.price) || 0,
      serviceTypeId: r.serviceTypeId,
    })),
  };
}

/* ─── Quotation lines ───────────────────────────────────────────────────
 * Insert one estimate line (product or material) into quotation_details.
 *
 *   type      'product' | 'material'
 *   itemId    optional — for product → client_service_id (rate-card row);
 *             for material → material_id. Bound to the matching column.
 *   name      display label (required for material; product can derive from
 *             rate-card but the app always sends a name too).
 *   quantity  → quotation_details.unit  (legacy column name for qty)
 *   amount    → quotation_details.unit_price
 *
 * status defaults to 1 (active, pending approval) — same default the admin
 * route uses. easyfxer_id (legacy typo) stamps the technician who raised
 * the line. sent_on = NOW() marks it raised-from-app.
 *
 * Returns { lineId }.
 */
async function addQuotationLine(jobId, efrId, { type, itemId, name, quantity, amount }) {
  const job = await jobForTech(jobId, efrId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }

  const isProduct = type === 'product';
  // Bind itemId to the correct FK column; the other stays NULL.
  const clientServiceId = isProduct ? (itemId || null) : null;
  const materialId      = isProduct ? null : (itemId || null);

  const [ins] = await pool.query(
    `INSERT INTO quotation_details
       (type, name, unit, unit_price,
        tx_charge, client_charge, margin,
        status, easyfxer_id, sent_on,
        job_id, client_service_id, material_id)
     VALUES (?, ?, ?, ?, 0, 0, 0, 1, ?, NOW(), ?, ?, ?)`,
    [
      type, name || null, quantity, amount,
      efrId,
      jobId, clientServiceId, materialId,
    ],
  );
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
  const job = await jobForTech(jobId, efrId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }

  // Ensure the line belongs to THIS job (defends against cross-job ids).
  const [[line]] = await pool.query(
    'SELECT id, job_id FROM quotation_details WHERE id = ? LIMIT 1',
    [lineId],
  );
  if (!line || Number(line.job_id) !== Number(jobId)) {
    const e = new Error('quotation line not found'); e.status = 404; throw e;
  }
  await pool.query('DELETE FROM quotation_details WHERE id = ? AND job_id = ?', [lineId, jobId]);
  return { deleted: true };
}

/* ─── Send estimate for SPOC approval ───────────────────────────────────
 * Marks the estimate "sent for approval": stamps
 * tbl_job.approval_sent_on_date_time = NOW(), bumps no_of_req_approval,
 * and moves the order into ESTIMATE_PENDING_APPROVAL (15). This is the
 * single source of "estimate sent" the admin quotations expiry endpoint
 * reads (routes/admin/quotations.js GET /expiry/:jobId).
 *
 * `checkInImageRefs` (optional) — if the app passes check-in image S3 keys
 * alongside the send, we record them as Booking-stage refs so the estimate
 * carries its site photos. Multi-step write (job UPDATE + N image inserts)
 * → wrapped in a transaction per the coding rules.
 *
 * Returns { sent: true }.
 */
async function sendForApproval(jobId, efrId, { checkInImageRefs } = {}) {
  const job = await jobForTech(jobId, efrId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `UPDATE tbl_job
          SET approval_sent_on_date_time = NOW(),
              no_of_req_approval = COALESCE(no_of_req_approval, 0) + 1,
              job_status = ?,
              last_update_time = NOW()
        WHERE job_id = ? AND fk_easyfixter_id = ?`,
      [STATUS_ESTIMATE_PENDING_APPROVAL, jobId, efrId],
    );

    if (Array.isArray(checkInImageRefs) && checkInImageRefs.length) {
      for (const ref of checkInImageRefs) {
        if (!ref || !String(ref).trim()) continue;
        await conn.query(
          `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, created_date)
           VALUES (?, ?, ?, ?, NOW())`,
          [jobId, String(ref).trim(), 'Booking', 0],
        );
      }
    }

    await conn.commit();
    return { sent: true };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
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
 * Returns { ok: true, inserted: <n> }.
 */
async function recordImages(jobId, efrId, { category, refs }) {
  const job = await jobForTech(jobId, efrId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }
  if (!IMAGE_CATEGORIES.has(category)) {
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
    for (const ref of cleaned) {
      await conn.query(
        `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, created_date)
         VALUES (?, ?, ?, ?, NOW())`,
        [jobId, ref, category, jobStage],
      );
    }
    await conn.commit();
    return { ok: true, inserted: cleaned.length };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
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
  const job = await jobForTech(jobId, efrId);
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
  const job = await jobForTech(jobId, efrId);
  if (!job) { const e = new Error('job not found'); e.status = 404; throw e; }

  const list = Array.isArray(answers) ? answers : [];
  if (list.length === 0) return { submitted: true, count: 0 };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
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
            SET c_qd_ans = ?, c_qd_comments = ?, updated_by = ?, update_date = NOW()
          WHERE job_id = ? AND c_qd_id = ?`,
        [answer, comments, efrId, jobId, qid],
      );
      // …INSERT if no existing row.
      if (upd.affectedRows === 0) {
        await conn.query(
          `INSERT INTO tbl_questionaire_answer
             (c_qd_id, job_id, c_questionaire_id, c_qd_ans, c_qd_comments,
              inserted_by, insert_date)
           VALUES (?, ?, ?, ?, ?, ?, NOW())`,
          [qid, jobId, questionaireId, answer, comments, efrId],
        );
      }
      count += 1;
    }
    await conn.commit();
    return { submitted: true, count };
  } catch (e) {
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
  const job = await jobForTech(jobId, efrId);
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

  return { stages };
}

module.exports = {
  jobForTech,
  getRateCard,
  addQuotationLine,
  deleteQuotationLine,
  sendForApproval,
  recordImages,
  getQuestionnaire,
  submitQuestionnaire,
  getWorkProgress,
  IMAGE_CATEGORIES,
};
