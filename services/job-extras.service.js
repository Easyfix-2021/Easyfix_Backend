'use strict';
/*
 * services/job-extras.service.js — V3 Phase 4: what a job carries beyond its
 * service lines (spec D8 / D9 / D6), and the desk's visit-2 scheduling (D7).
 *
 *   tools          tbl_job_tool ⋈ tbl_tools — "Tools to carry", set in the CRM.
 *   siteProducts   tbl_job_site_product — "Products at site", set in the CRM.
 *   signatureOn    tbl_job_signature.signed_on — the svg itself is read only by
 *                  the CRM (services/job-signature.service.js getSignature).
 *
 * THE BATCH READ. extrasForJobs(conn, jobIds) is the one reader of all three,
 * used by the technician's job detail (routes/mobile, BACKEND-A) and the CRM
 * editors below. Three queries, whatever the number of jobs; none at all for an
 * empty id list. Every requested job gets an entry, empty when it has nothing,
 * so a caller never has to tell "no tools" from "not asked".
 *
 * Bounded by construction: a job holds at most MAX_TOOLS tools and
 * MAX_SITE_PRODUCTS products (the writers below refuse more), so the rows
 * returned are at most jobIds × (MAX_TOOLS + MAX_SITE_PRODUCTS + 1).
 */
const { pool } = require('../db');
const logger = require('../logger');
const jobLog = require('./job-log.service');

const MAX_TOOLS = 50;
const MAX_SITE_PRODUCTS = 50;
const REVISIT = 10;

function httpError(status, message, code) {
  const e = new Error(message); e.status = status; if (code) e.code = code; return e;
}

// History rows are fail-soft: the change has already committed. Writers are
// BACKEND-A's (job-log.service.js): logToolsSet {count}, logSiteProductsChanged
// {change: added|removed}, logVisitTwoScheduled {visitNumber}. A writer missing
// on a half-landed tree is a TypeError in the same catch.
async function logSoft(name, jobId, details, actor) {
  try {
    await jobLog[name](jobId, details, actor, new Date());
  } catch (e) {
    logger.warn(`Job log ${name} failed (non-fatal) · jobId=${jobId} · ${e.message}`);
  }
}

const cleanIds = (ids) => [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

async function toolsByJob(conn, ids) {
  const [rows] = await conn.query(
    `SELECT jt.job_id, t.tool_id, t.tool_name
       FROM tbl_job_tool jt
       JOIN tbl_tools t ON t.tool_id = jt.tool_id
      WHERE jt.job_id IN (?)
      ORDER BY jt.job_id, t.tool_name`,
    [ids],
  );
  return rows;
}

async function siteProductsByJob(conn, ids) {
  const [rows] = await conn.query(
    `SELECT id, job_id, name, qty, brand
       FROM tbl_job_site_product
      WHERE job_id IN (?)
      ORDER BY job_id, id`,
    [ids],
  );
  return rows;
}

const toolShape = (r) => ({ id: Number(r.tool_id), name: r.tool_name });
const productShape = (r) => ({ id: Number(r.id), name: r.name, qty: Number(r.qty), brand: r.brand || null });

/**
 * extrasForJobs(conn, jobIds) → Map<jobId, { tools:[{id,name}],
 *   siteProducts:[{id,name,qty,brand}], signatureOn: string|null }>
 * ≤ 3 queries; 0 for no ids. `conn` is any mysql2 query runner (pool or
 * connection); null means the pool.
 */
async function extrasForJobs(conn, jobIds) {
  const out = new Map();
  const ids = cleanIds(jobIds);
  if (!ids.length) return out;
  const db = conn || pool;
  for (const id of ids) out.set(id, { tools: [], siteProducts: [], signatureOn: null });

  const [tools, products, [sigs]] = await Promise.all([
    toolsByJob(db, ids),
    siteProductsByJob(db, ids),
    db.query('SELECT job_id, signed_on FROM tbl_job_signature WHERE job_id IN (?)', [ids]),
  ]);
  for (const r of tools) out.get(Number(r.job_id))?.tools.push(toolShape(r));
  for (const r of products) out.get(Number(r.job_id))?.siteProducts.push(productShape(r));
  for (const r of sigs) {
    const e = out.get(Number(r.job_id));
    if (e) e.signatureOn = r.signed_on == null ? null : String(r.signed_on);
  }
  return out;
}

/* ─── Tools to carry (CRM) ──────────────────────────────────────────── */

async function listJobTools(jobId) {
  return (await toolsByJob(pool, [Number(jobId)])).map(toolShape);
}

/*
 * Replace the job's tool set with `toolIds`, in one transaction.
 * A tool is accepted when it is ACTIVE, or already on this job — so a tool
 * deactivated after it was picked does not make the list unsaveable. Anything
 * else is a 400 naming the ids, and nothing is written.
 * The INSERT's no-op ON DUPLICATE KEY keeps an existing row's added_on/added_by;
 * uq_jt makes a double-submitted PUT land once.
 */
async function setJobTools(jobId, toolIds, actor) {
  const id = Number(jobId);
  const want = cleanIds(toolIds);
  if (want.length > MAX_TOOLS) throw httpError(400, `At most ${MAX_TOOLS} tools per job`);

  if (want.length) {
    const [ok] = await pool.query(
      `SELECT tool_id FROM tbl_tools
        WHERE tool_id IN (?)
          AND ((tool_status = '1' OR tool_status = 1)
               OR tool_id IN (SELECT tool_id FROM tbl_job_tool WHERE job_id = ?))`,
      [want, id],
    );
    const okSet = new Set(ok.map((r) => Number(r.tool_id)));
    const bad = want.filter((t) => !okSet.has(t));
    if (bad.length) throw httpError(400, `Unknown or inactive tool id(s): ${bad.join(', ')}`, 'TOOL_NOT_FOUND');
  }

  const now = new Date();
  const userId = actor && Number.isInteger(Number(actor.user_id)) ? Number(actor.user_id) : null;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (want.length) {
      await conn.query('DELETE FROM tbl_job_tool WHERE job_id = ? AND tool_id NOT IN (?)', [id, want]);
      await conn.query(
        `INSERT INTO tbl_job_tool (job_id, tool_id, added_on, added_by) VALUES ?
         ON DUPLICATE KEY UPDATE tool_id = tool_id`,
        [want.map((t) => [id, t, now, userId])],
      );
    } else {
      await conn.query('DELETE FROM tbl_job_tool WHERE job_id = ?', [id]);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  logger.info(`Job tools set · jobId=${id} · count=${want.length}`);
  await logSoft('logToolsSet', id, { count: want.length }, actor);
  return listJobTools(id);
}

/* ─── Products at site (CRM) ────────────────────────────────────────── */

async function listSiteProducts(jobId) {
  return (await siteProductsByJob(pool, [Number(jobId)])).map(productShape);
}

// ponytail: count-then-insert, so two racing adds can land product 51. The cap
// only bounds the list the phone renders; a UNIQUE rule is not worth it here.
async function addSiteProduct(jobId, { name, qty = 1, brand = null }, actor) {
  const id = Number(jobId);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM tbl_job_site_product WHERE job_id = ?', [id]);
  if (Number(n) >= MAX_SITE_PRODUCTS) throw httpError(409, `At most ${MAX_SITE_PRODUCTS} products per job`, 'TOO_MANY_PRODUCTS');
  const userId = actor && Number.isInteger(Number(actor.user_id)) ? Number(actor.user_id) : null;
  const [r] = await pool.query(
    'INSERT INTO tbl_job_site_product (job_id, name, qty, brand, added_on, added_by) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name, qty, brand || null, new Date(), userId],
  );
  await logSoft('logSiteProductsChanged', id, { change: 'added' }, actor);
  return { id: Number(r.insertId), name, qty: Number(qty), brand: brand || null };
}

async function removeSiteProduct(jobId, rowId, actor) {
  const id = Number(jobId);
  const [r] = await pool.query('DELETE FROM tbl_job_site_product WHERE id = ? AND job_id = ?', [Number(rowId), id]);
  if (!r.affectedRows) throw httpError(404, 'product not found');
  await logSoft('logSiteProductsChanged', id, { change: 'removed' }, actor);
  return { removed: true };
}

/* ─── Visit 2 (spec D7) ─────────────────────────────────────────────── */

/*
 * The desk books the second visit of a revisit job: 10 → 1, same technician,
 * a new appointment. REUSES the CRM's own writers — job.reschedule (appointment,
 * slot columns, stale offers expired, scheduling_history, comment) and
 * job.setStatus (the move, its log row, its webhook) — so visit 2 is scheduled
 * exactly as any CRM reschedule is.
 *
 * visit_number FIRST, and idempotent: GREATEST(COALESCE(visit_number, 1), 2).
 * The mobile checkout already bumps it when it closes into 10 with additional
 * work pending (BACKEND-A, D7); a job that reached 10 any other way (a CRM
 * move, the legacy app) has not been bumped, and this is where it is. A job at
 * 10 has had at least one visit, so the next one is at least visit 2 — the
 * GREATEST never lowers a number the checkout already raised. Doing it first
 * means a failure later leaves the job at 10 with a correct number, and the
 * desk's retry is harmless.
 * ponytail: a THIRD visit booked from a job that reached 10 outside the mobile
 * checkout stays at 2 — count 'Re-visit Required' log rows if that ever matters.
 * ponytail: no claim on the job — two desk users booking at once both succeed
 * and the later appointment wins, as two CRM reschedules would.
 */
async function scheduleVisitTwo(scopedJob, { visitOn }, actor) {
  // eslint-disable-next-line global-require
  const job = require('./job.service');
  const id = Number(scopedJob.job_id);
  if (Number(scopedJob.job_status) !== REVISIT) {
    throw httpError(409, 'Visit 2 can only be scheduled for a job waiting for its revisit', 'NOT_REVISIT');
  }
  if (!scopedJob.fk_easyfixter_id) {
    throw httpError(409, 'This job has no technician to send back', 'NO_TECHNICIAN');
  }
  const when = String(visitOn).replace('T', ' ');
  if (job.formatMysqlDateTimeIST(new Date()) >= when) {
    throw httpError(400, 'Cannot schedule visit 2 at a date and time that has already passed. Pick a future appointment.');
  }

  await pool.query(
    'UPDATE tbl_job SET visit_number = GREATEST(COALESCE(visit_number, 1), 2) WHERE job_id = ? AND job_status = ?',
    [id, REVISIT],
  );
  const visitNumber = Math.max(Number(scopedJob.visit_number) || 1, 2); // what the UPDATE just wrote
  await job.reschedule(id, {
    requestedDateTime: visitOn,
    reasonId: null,
    rescheduleReason: 'Visit 2',
    remarks: 'Visit 2 scheduled with the same technician.',
  }, actor);
  const updated = await job.setStatus(id, { status: job.STATUS.SCHEDULED }, actor);
  logger.info(`Visit 2 scheduled · jobId=${id} · on=${when}`);
  await logSoft('logVisitTwoScheduled', id, { visitNumber }, actor);
  return updated;
}

module.exports = {
  extrasForJobs,
  listJobTools,
  setJobTools,
  listSiteProducts,
  addSiteProduct,
  removeSiteProduct,
  scheduleVisitTwo,
  MAX_TOOLS,
  MAX_SITE_PRODUCTS,
};
