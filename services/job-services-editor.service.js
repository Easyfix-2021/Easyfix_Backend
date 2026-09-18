/*
 * ═══════════ THE ONE-LIST SERVICES EDITOR (Uplifted tab, 2026-09-16) ═══════════
 *
 *   GET /admin/jobs/:id/service-catalog   what the editor can show and offer
 *   PUT /admin/jobs/:id/services          the COMPLETE desired set, applied
 *
 * A NEW editor, used by the Schedule & Assign Uplifted tab only. The existing
 * service writers (POST /:id/services, PATCH /:id/services/:jobServiceId,
 * DELETE/restore, and PATCH /:id's services[]) are deliberately untouched.
 *
 * ─── WHY A COMPLETE SET, AND NOT ANOTHER "ADD" ENDPOINT ───────────────────
 *
 * The inline POST /:id/services finds the newest row for a service with NO
 * status filter and overwrites its quantity: re-adding a service already on the
 * job at qty 2 with qty 1 silently LOWERS it, and answers "reactivated". A
 * one-list editor sends the whole list the operator is looking at, so the
 * server can DIFF it against what is actually active — insert what is new,
 * change what moved, soft-delete what was dropped — and nothing is ever
 * overwritten by accident. Re-submitting the same list writes nothing.
 *
 * ─── THE PRICES ARE THE WRITER'S PRICES ───────────────────────────────────
 *
 * unit_client / unit_tx come from utils/rate-card-calc.js computeJobServiceCharges
 * at quantity 1 — the SAME function every tbl_job_services writer, this one
 * included, stores from. So the editor's preview is what saving stores:
 *   unit_client = total_cost at qty 1  (the unit price the client is billed)
 *   unit_tx     = easyfixer_charge at qty 1  (the technician's residual)
 * ⚠ NOT the /service-breakdown endpoint's numbers: that runs a DIFFERENT, clamped
 * cascade (client-rate-cards calculateCharges), so on a rate card whose fixed
 * leg exceeds what remains the two differ. Matching the WRITER is the point.
 *
 * ─── WHAT THE DATA ACTUALLY LOOKS LIKE (QA, 2026-09-16) ───────────────────
 *
 * The rules below are shaped by these, not by the tidy case:
 *   - 278,759 of 502,246 active job-service rows point at a rate-card product
 *     that is now INACTIVE, and 3,913 at another client's product. A rule that
 *     every submitted service must be an active product of this client would
 *     make most historical jobs un-saveable. So ANY service already active on
 *     the job may be KEPT (at any quantity) or dropped; only ADDING is held to
 *     "an active product of this client, in this job's category".
 *   - 10,737 jobs carry duplicate active rows for one service. The editor
 *     treats a service as one line: on_job_qty is the SUM, job_service_id the
 *     newest row. Resubmitting that sum is a no-op; a different quantity
 *     collapses the group onto the newest row.
 *   - 445 active rows have no service_id at all. They cannot be named in a
 *     request, so they are never shown in `products`/`foreign` and NEVER
 *     modified here — a list the editor cannot display must not be a list it
 *     can silently delete.
 *   - 84,203 jobs have no fk_service_catg_id; almost all carry no category on
 *     their rows either. Hence `categories` and the categoryId-on-save rule.
 */
const { pool } = require('../db');
const logger = require('../logger');
const { computeJobServiceCharges } = require('../utils/rate-card-calc');
const { ACTIVE_SERVICE_ROWS } = require('./job-service-breakdown.service');

const MAX_QUANTITY = 100;
// The CRM's isJobClosed: a completed job's service lines are its billing lines.
const CLOSED_STATUSES = new Set([3, 5]);

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* The two per-unit prices the writer would store, at quantity 1. */
function unitPrices(rateCardRow) {
  if (!rateCardRow) return { unit_client: null, unit_tx: null };
  const ch = computeJobServiceCharges(rateCardRow, 1);
  return { unit_client: ch.total_cost, unit_tx: ch.easyfixer_charge };
}

/*
 * A job's ACTIVE rows, grouped into service LINES by service_id. Rows with no
 * service_id are left out entirely (see the header). Active = the shared rule
 * the breakdown and billing surfaces use, so all three see the same rows.
 *
 * Each row's category is its own js.service_category_id, falling back to the
 * product's cs.service_catg_id when the row carries none — the integration path
 * writes rows with no category (job 482512 on QA), and classifying those as
 * "no category" would put a Cycle line outside a Cycle job.
 */
async function loadActiveLines(db, jobId, { forUpdate = false } = {}) {
  if (forUpdate) {
    // Lock the job's rows FIRST, on the table alone — a FOR UPDATE across the
    // joins below would also lock the client's rate-card rows.
    await db.query(
      `SELECT js.job_service_id FROM tbl_job_services js
        WHERE js.job_id = ? AND ${ACTIVE_SERVICE_ROWS} FOR UPDATE`,
      [jobId],
    );
  }
  const [rows] = await db.query(
    `SELECT js.job_service_id, js.service_id, js.quantity,
            COALESCE(js.service_category_id, CS.service_catg_id) AS catg_id,
            COALESCE(NULLIF(TRIM(CR.crc_ratecard_name), ''), st.service_type_name, js.service_charge_description) AS name,
            st.service_type_name,
            sc.service_catg_name,
            CS.total_amount, CS.easyfix_direct_fixed, CS.easyfix_direct_variable,
            CS.overhead_fixed, CS.overhead_variable, CS.client_fixed, CS.client_variable,
            CS.client_service_id AS rate_card_present
       FROM tbl_job_services js
       LEFT JOIN tbl_client_service   CS ON CS.client_service_id = js.service_id
       LEFT JOIN tbl_client_rate_card CR ON CR.crc_id = CS.rate_card_id
       LEFT JOIN tbl_service_type     st ON st.service_type_id = COALESCE(js.service_type_id, CS.service_type_id)
       LEFT JOIN tbl_service_catg     sc ON sc.service_catg_id = COALESCE(js.service_category_id, CS.service_catg_id)
      WHERE js.job_id = ? AND ${ACTIVE_SERVICE_ROWS}
      ORDER BY js.job_service_id ASC`,
    [jobId],
  );
  const lines = new Map();
  for (const r of rows) {
    const sid = Number(r.service_id);
    if (!Number.isInteger(sid) || sid <= 0) continue;
    const qty = Number(r.quantity) || 1;
    const line = lines.get(sid);
    if (!line) {
      lines.set(sid, {
        service_id: sid,
        job_service_id: Number(r.job_service_id),
        job_service_ids: [Number(r.job_service_id)],
        quantity: qty,
        catg_id: r.catg_id == null ? null : Number(r.catg_id),
        name: r.name ?? null,
        service_type_name: r.service_type_name ?? null,
        service_catg_name: r.service_catg_name ?? null,
        rateCard: r.rate_card_present == null ? null : r,
      });
    } else {
      // ORDER BY job_service_id ASC, so the later row is the newer one.
      line.job_service_ids.push(Number(r.job_service_id));
      line.job_service_id = Number(r.job_service_id);
      line.quantity += qty;
    }
  }
  return lines;
}

/*
 * The category this job's services live in, and where that answer came from:
 *   'job'       tbl_job.fk_service_catg_id — authoritative
 *   'services'  the job has none, but its active lines carry exactly ONE
 *   null        neither; the editor must pick one (see `categories`)
 */
async function resolveCategory(db, job, lines) {
  const jobCatg = Number(job.fk_service_catg_id) || null;
  const nameOf = async (id) => {
    const [[row]] = await db.query('SELECT service_catg_name FROM tbl_service_catg WHERE service_catg_id = ?', [id]);
    return row?.service_catg_name ?? null;
  };
  if (jobCatg) return { id: jobCatg, name: await nameOf(jobCatg), source: 'job' };
  const distinct = [...new Set([...lines.values()].map((l) => l.catg_id).filter((c) => c))];
  if (distinct.length === 1) return { id: distinct[0], name: await nameOf(distinct[0]), source: 'services' };
  return null;
}

/* The categories the CLIENT's active rate card actually sells. */
async function clientCategories(db, clientId) {
  const [rows] = await db.query(
    `SELECT DISTINCT sc.service_catg_id AS id, sc.service_catg_name AS name
       FROM tbl_client_service cs
       JOIN tbl_service_catg sc ON sc.service_catg_id = cs.service_catg_id
      WHERE cs.client_id = ? AND cs.service_status = 1
      ORDER BY sc.service_catg_name ASC, sc.service_catg_id ASC`,
    [clientId],
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

/**
 * GET /admin/jobs/:id/service-catalog.
 * @param {object} job        the route's req.scopedJob
 * @param {object} [opts]
 * @param {number} [opts.categoryId]  a category the operator picked — used ONLY
 *   while the job resolves no category of its own; ignored otherwise.
 */
async function getServiceCatalog(job, { categoryId } = {}) {
  const jobId = Number(job.job_id);
  const clientId = Number(job.fk_client_id);
  logger.info('Build service catalog · jobId=' + jobId + ' clientId=' + clientId + ' categoryId=' + (categoryId ?? '-'));

  const lines = await loadActiveLines(pool, jobId);
  const category = await resolveCategory(pool, job, lines);
  const categories = category ? [] : await clientCategories(pool, clientId);
  const effectiveCatg = category ? category.id : (Number(categoryId) || null);

  let types = [];
  let products = [];
  if (effectiveCatg) {
    const [typeRows] = await pool.query(
      `SELECT DISTINCT st.service_type_id, st.service_type_name AS name
         FROM tbl_client_service cs
         JOIN tbl_service_type st ON st.service_type_id = cs.service_type_id
        WHERE cs.client_id = ? AND cs.service_status = 1 AND cs.service_catg_id = ?
        ORDER BY st.service_type_name ASC, st.service_type_id ASC`,
      [clientId, effectiveCatg],
    );
    types = typeRows.map((r) => ({ service_type_id: Number(r.service_type_id), name: r.name }));

    const [productRows] = await pool.query(
      `SELECT cs.client_service_id, cs.service_type_id, st.service_type_name,
              COALESCE(NULLIF(TRIM(CR.crc_ratecard_name), ''), st.service_type_name) AS name,
              cs.total_amount, cs.easyfix_direct_fixed, cs.easyfix_direct_variable,
              cs.overhead_fixed, cs.overhead_variable, cs.client_fixed, cs.client_variable
         FROM tbl_client_service cs
         LEFT JOIN tbl_client_rate_card CR ON CR.crc_id = cs.rate_card_id
         LEFT JOIN tbl_service_type     st ON st.service_type_id = cs.service_type_id
        WHERE cs.client_id = ? AND cs.service_status = 1 AND cs.service_catg_id = ?
        ORDER BY st.service_type_name ASC, name ASC, cs.client_service_id ASC`,
      [clientId, effectiveCatg],
    );
    products = productRows.map((r) => {
      const sid = Number(r.client_service_id);
      const onJob = lines.get(sid);
      return {
        service_id: sid,
        name: r.name ?? null,
        /*
         * ⚠ ALWAYS NULL. No table on the rate-card path carries a product code
         * (tbl_client_service, tbl_client_rate_card, tbl_service_type and
         * tbl_service_catg were all checked on QA). The key ships so the CRM's
         * type holds; it must not render a column from it.
         */
        code: null,
        service_type_id: r.service_type_id == null ? null : Number(r.service_type_id),
        service_type_name: r.service_type_name ?? null,
        ...unitPrices(r),
        on_job_qty: onJob ? onJob.quantity : null,
        job_service_id: onJob ? onJob.job_service_id : null,
      };
    });
  }

  /*
   * `foreign` = every active line the product list does NOT carry, so nothing
   * on the job is invisible to the editor. That is lines from a different
   * category (the case the name was chosen for) AND lines whose product is no
   * longer an active rate-card product of this client — which the PUT lets an
   * operator keep or drop, but never add. While no category is resolved and
   * none was picked, every line is here, because no product list exists yet.
   */
  const productIds = new Set(products.map((p) => p.service_id));
  const foreign = [...lines.values()]
    .filter((l) => !productIds.has(l.service_id))
    .map((l) => ({
      job_service_id: l.job_service_id,
      service_id: l.service_id,
      name: l.name,
      service_type_name: l.service_type_name,
      service_catg_name: l.service_catg_name,
      quantity: l.quantity,
      ...unitPrices(l.rateCard),
    }));

  logger.info('Service catalog built · jobId=' + jobId + ' category=' + (category ? category.id + '/' + category.source : 'none')
    + ' products=' + products.length + ' foreign=' + foreign.length);
  return { category, categories, types, products, foreign };
}

/*
 * The sentence a comment row reads. Names, never ids: the History tab renders
 * it to an operator. One line per kind, omitted when empty.
 */
function changeSummary({ added, updated, removed, categoryName }) {
  const parts = [];
  if (categoryName) parts.push(`category set to ${categoryName}`);
  if (added.length) parts.push('added ' + added.map((a) => `${a.name} ×${a.quantity}`).join(', '));
  if (updated.length) parts.push('quantity changed ' + updated.map((u) => `${u.name} ${u.from} → ${u.to}`).join(', '));
  if (removed.length) parts.push('removed ' + removed.map((r) => r.name).join(', '));
  return 'Services updated: ' + parts.join('; ') + '.';
}

/**
 * PUT /admin/jobs/:id/services — apply the complete desired set.
 * @returns {Promise<{added:number, updated:number, removed:number}>}
 */
async function replaceJobServices(jobId, { categoryId, services }, actor) {
  const id = Number(jobId);
  const desired = Array.isArray(services) ? services : [];
  if (desired.length === 0) throw httpError(400, 'A job needs at least one service.');
  const seen = new Set();
  for (const s of desired) {
    const sid = Number(s.service_id);
    if (seen.has(sid)) throw httpError(400, 'Each service can only be listed once.');
    seen.add(sid);
    const q = Number(s.quantity);
    if (!Number.isInteger(q) || q < 1 || q > MAX_QUANTITY) {
      throw httpError(400, `Quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
    }
  }
  logger.info('Replace job services · jobId=' + id + ' services=' + desired.length + ' categoryId=' + (categoryId ?? '-'));

  const jobService = require('./job.service');
  const createdByCol = await jobService.jobServicesCreatedByColumn();

  const added = [];
  const updated = [];
  const removed = [];
  let categorySet = null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Serialise editors on this job: every read below is against the locked row.
    const [[job]] = await conn.query(
      'SELECT job_id, fk_client_id, fk_service_catg_id, job_status FROM tbl_job WHERE job_id = ? FOR UPDATE',
      [id],
    );
    if (!job) throw httpError(404, 'job not found');
    if (CLOSED_STATUSES.has(Number(job.job_status))) {
      // servicesEditable guards the route; this is the same rule re-read on the
      // LOCKED row, so a job completed mid-request is refused too.
      throw httpError(409, 'Services cannot be changed on a completed job');
    }
    const clientId = Number(job.fk_client_id);
    const lines = await loadActiveLines(conn, id, { forUpdate: true });

    /*
     * CATEGORY. When the job has one, a categoryId that DIFFERS is rejected —
     * a services editor must not be a back door to re-categorise a job, which
     * drives its deep skill and its technician ranking. The same id is accepted
     * silently, so the CRM can always send it. When the job has none, it is
     * required and must be a category the client's rate card sells.
     */
    let effectiveCatg = Number(job.fk_service_catg_id) || null;
    if (effectiveCatg) {
      if (categoryId != null && Number(categoryId) !== effectiveCatg) {
        throw httpError(400, "This job's category is already set and cannot be changed here.");
      }
    } else {
      if (categoryId == null) throw httpError(400, 'Choose a category for this job first.');
      const offered = await clientCategories(conn, clientId);
      const match = offered.find((c) => c.id === Number(categoryId));
      if (!match) throw httpError(400, "That category is not on this client's rate card.");
      effectiveCatg = match.id;
      categorySet = match;
    }

    // Rate-card rows for every service being ADDED (kept lines carry their own).
    const newIds = desired.map((s) => Number(s.service_id)).filter((sid) => !lines.has(sid));
    const catalog = new Map();
    if (newIds.length) {
      const [rows] = await conn.query(
        `SELECT cs.client_service_id, cs.client_id, cs.service_catg_id, cs.service_type_id, cs.service_status,
                COALESCE(NULLIF(TRIM(CR.crc_ratecard_name), ''), st.service_type_name) AS name,
                cs.total_amount, cs.easyfix_direct_fixed, cs.easyfix_direct_variable,
                cs.overhead_fixed, cs.overhead_variable, cs.client_fixed, cs.client_variable
           FROM tbl_client_service cs
           LEFT JOIN tbl_client_rate_card CR ON CR.crc_id = cs.rate_card_id
           LEFT JOIN tbl_service_type     st ON st.service_type_id = cs.service_type_id
          WHERE cs.client_service_id IN (?)`,
        [newIds],
      );
      for (const r of rows) catalog.set(Number(r.client_service_id), r);
    }
    for (const sid of newIds) {
      const product = catalog.get(sid);
      if (!product || Number(product.client_id) !== clientId || Number(product.service_status) !== 1) {
        throw httpError(400, `Service ${sid} is not on this client's rate card.`);
      }
      if (Number(product.service_catg_id) !== effectiveCatg) {
        throw httpError(400, `${product.name || 'Service ' + sid} is from a different category. `
          + "Only services already on the job can be kept from another category; new ones must be in the job's category.");
      }
    }

    // ── Apply the diff ──────────────────────────────────────────────────────
    const softDelete = (ids) => conn.query(
      `UPDATE tbl_job_services SET job_service_status = 0
        WHERE job_id = ? AND job_service_id IN (?)`,
      [id, ids],
    );

    for (const s of desired) {
      const sid = Number(s.service_id);
      const qty = Number(s.quantity);
      const line = lines.get(sid);
      if (line) {
        if (line.quantity === qty) continue; // unchanged — including a duplicate group whose SUM already matches
        /*
         * A line whose rate-card row NO LONGER EXISTS can be kept or dropped, but
         * not re-quantified: there is no price to recompute from, and the cascade
         * given nothing returns zeros — which would silently wipe the line's
         * stored charges. (15 such rows on QA.) An INACTIVE product still has its
         * row and recomputes normally.
         */
        if (!line.rateCard) {
          throw httpError(400, `${line.name || 'Service ' + sid} is no longer on any rate card, so its quantity `
            + 'cannot be changed. Keep it as it is or remove it.');
        }
        const ch = computeJobServiceCharges(line.rateCard, qty);
        await conn.query(
          `UPDATE tbl_job_services
              SET quantity = ?, total_charge = ?, total_cost = ?,
                  client_charge = ?, easyfix_charge = ?, easyfixer_charge = ?
            WHERE job_id = ? AND job_service_id = ?`,
          [qty, ch.total_charge, ch.total_cost, ch.client_charge, ch.easyfix_charge, ch.easyfixer_charge,
           id, line.job_service_id],
        );
        // A duplicate group collapses onto its newest row at the new quantity.
        const older = line.job_service_ids.filter((jsid) => jsid !== line.job_service_id);
        if (older.length) await softDelete(older);
        updated.push({ name: line.name || `Service ${sid}`, from: line.quantity, to: qty });
      } else {
        const product = catalog.get(sid);
        const ch = computeJobServiceCharges(product, qty);
        const cols = ['job_id', 'service_id', 'quantity', 'service_type_id', 'service_category_id', 'job_service_status',
          'total_charge', 'total_cost', 'client_charge', 'easyfix_charge', 'easyfixer_charge'];
        const vals = [id, sid, qty, product.service_type_id ?? null, product.service_catg_id ?? null, 1,
          ch.total_charge, ch.total_cost, ch.client_charge, ch.easyfix_charge, ch.easyfixer_charge];
        if (createdByCol) { cols.push(createdByCol); vals.push(actor?.user_id ?? null); }
        await conn.query(
          `INSERT INTO tbl_job_services (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          vals,
        );
        added.push({ name: product.name || `Service ${sid}`, quantity: qty });
      }
    }
    const wanted = new Set(desired.map((s) => Number(s.service_id)));
    for (const line of lines.values()) {
      if (wanted.has(line.service_id)) continue;
      await softDelete(line.job_service_ids);
      removed.push({ name: line.name || `Service ${line.service_id}` });
    }

    const changed = added.length + updated.length + removed.length > 0;
    if (categorySet) {
      await conn.query('UPDATE tbl_job SET fk_service_catg_id = ? WHERE job_id = ?', [categorySet.id, id]);
    }
    if (changed) await jobService.recomputeClientServicesCsv(conn, id);
    if (changed || categorySet) {
      // new Date() → the pool's +05:30 session, the IST wall clock tbl_job uses.
      await conn.query('UPDATE tbl_job SET last_update_time = ? WHERE job_id = ?', [new Date(), id]);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    if (!e.status) logger.error('Replace job services failed, rolled back · jobId=' + id + ' · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }

  /*
   * ONE audit comment, post-commit and fail-soft — the rule every other writer
   * follows (reschedule, cancel, ops check-in): the change has committed, and a
   * comment failure must not turn it into a 500 that invites a double submit.
   * Nothing changed ⇒ no comment, which is what makes a resubmit write nothing.
   */
  if (added.length || updated.length || removed.length || categorySet) {
    try {
      await require('./job-comment.service').addComment(id, {
        comments: changeSummary({ added, updated, removed, categoryName: categorySet?.name }),
        comment_on: 1,
        commented_by: actor?.user_id ?? null,
      });
    } catch (ce) {
      logger.warn('Services change comment failed (non-fatal) · jobId=' + id + ' · ' + ce.message);
    }
  }

  logger.info('Job services replaced · jobId=' + id + ' added=' + added.length
    + ' updated=' + updated.length + ' removed=' + removed.length + (categorySet ? ' category=' + categorySet.id : ''));
  return { added: added.length, updated: updated.length, removed: removed.length };
}

module.exports = { getServiceCatalog, replaceJobServices, changeSummary, MAX_QUANTITY };
