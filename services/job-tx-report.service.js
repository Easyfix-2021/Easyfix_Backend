'use strict';
/*
 * tbl_job_tx_report — a technician's on-site CLAIM that the desk resolves
 * (V3 Phase 3; migrations/2026-09-24-v3-phase3-tables.sql).
 *
 *   additional_work  "I have found additional work" (design sheet 09-11). He
 *                    prices nothing; his work-found photos ARE the report and
 *                    the desk prices it (routes/admin/ops-desk.js).
 *   cant_complete    "Can't complete" with a reason and proof (sheet 13).
 *   help             "Need help" with a picked reason (sheet 13b).
 *   cancel           the proof + ₹250 record behind a CANCEL REQUEST (sheet
 *                    08c). The request itself stays on tbl_job.is_cancelled_by_app
 *                    — the CRM's Technician Requests queue and the reject button
 *                    read and clear it there — so this row carries only what that
 *                    flag cannot: which photos, and whether this ask paid him.
 *
 * A CLAIM, NOT A DECISION. Every kind is something he tells us; the desk (or
 * the client) decides. That is why the rows are read by services/job-pending
 * -on.js — "pending on EasyFix" is literally "an open row here".
 *
 * ONE OPEN ROW PER (job, kind) is the generated open_dedupe_key's UNIQUE index,
 * not the read in open() — see the migration header. OPEN_STATUSES below must
 * stay the exact set the generated column spells ('open','priced','returned');
 * a test pins the two together.
 */

const { pool } = require('../db');
const logger = require('../logger');

const KIND = Object.freeze({
  ADDITIONAL_WORK: 'additional_work',
  CANT_COMPLETE: 'cant_complete',
  HELP: 'help',
  CANCEL: 'cancel',
});

const STATUS = Object.freeze({
  OPEN: 'open',
  PRICED: 'priced',
  RETURNED: 'returned',
  APPROVED: 'approved',
  RESOLVED: 'resolved',
  UNDONE: 'undone',
});

// The in-flight states — the generated column's IF(status IN (...)) verbatim.
const OPEN_STATUSES = Object.freeze([STATUS.OPEN, STATUS.PRICED, STATUS.RETURNED]);

/*
 * Need-help reasons (design sheet 13b), code → the label the desk reads. A
 * FIXED list, not a lookup table: five situations the bench is trained on, and
 * reason_text is re-read from here at write time so the technician never types
 * the words on the desk board.
 */
const HELP_REASONS = Object.freeze({
  gate: 'Stopped at the gate',
  arguing: 'Customer is arguing',
  unsure: 'Not sure about the work',
  colour: 'Need colour code or spare',
  unsafe: 'Does not feel safe here',
});

// VARCHAR(255) CSV. 10 ids of up to 10 digits + commas = 109 bytes.
const MAX_PROOF_IDS = 10;

/*
 * visit_charge_awarded is TINYINT(1), which db.js's typeCast hands back as a
 * JS boolean — CAST so the flag arrives as 0/1 like every other status read
 * that needs its value, not a WHERE literal.
 */
const COLUMNS = `id, job_id, efr_id, kind, reason_code, reason_text, proof_image_ids,
       status, booked_meanwhile, left_site_on, client_amount, tx_amount, price_note,
       return_note, CAST(visit_charge_awarded AS SIGNED) AS visit_charge_awarded,
       prev_job_status, reported_on, resolved_on, resolved_by`;

function proofIdsToCsv(ids) {
  const clean = [...new Set((ids || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
  return clean.length ? clean.slice(0, MAX_PROOF_IDS).join(',') : null;
}

function proofIdsFromCsv(csv) {
  return String(csv || '').split(',').map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
}

async function byId(id, runner = pool) {
  const [[row]] = await runner.query(`SELECT ${COLUMNS} FROM tbl_job_tx_report WHERE id = ? LIMIT 1`, [id]);
  return row || null;
}

/** The job's in-flight row of this kind, or null. */
async function findOpen(jobId, kind, runner = pool) {
  const [[row]] = await runner.query(
    `SELECT ${COLUMNS} FROM tbl_job_tx_report
      WHERE job_id = ? AND kind = ? AND status IN (?)
      ORDER BY id DESC LIMIT 1`,
    [Number(jobId), kind, OPEN_STATUSES],
  );
  return row || null;
}

/**
 * Open a claim, or return the one already open. `{ row, created }`.
 *
 * The read first handles the ordinary double tap; the UNIQUE index handles the
 * two writes that raced past it, and the loser re-reads and returns the
 * winner — the same body, never a 500 (tbl_job_permission_request's pattern).
 */
async function open({ jobId, efrId, kind, reasonCode = null, reasonText = null, proofImageIds = [], prevJobStatus = null }) {
  const existing = await findOpen(jobId, kind);
  if (existing) return { row: existing, created: false };
  let insertId;
  try {
    // new Date() + the pool's +05:30 session = IST verbatim. Never NOW().
    const [ins] = await pool.query(
      `INSERT INTO tbl_job_tx_report
         (job_id, efr_id, kind, reason_code, reason_text, proof_image_ids, status, prev_job_status, reported_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [Number(jobId), Number(efrId), kind, reasonCode, reasonText, proofIdsToCsv(proofImageIds),
        STATUS.OPEN, prevJobStatus, new Date()],
    );
    insertId = ins.insertId;
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      const winner = await findOpen(jobId, kind);
      if (winner) {
        logger.info('Tx report race resolved to existing · job=' + jobId + ' · kind=' + kind + ' · id=' + winner.id);
        return { row: winner, created: false };
      }
    }
    throw e;
  }
  logger.info('Tx report opened · id=' + insertId + ' · job=' + jobId + ' · kind=' + kind);
  return { row: await byId(insertId), created: true };
}

/*
 * The rows a technician's job screen can still be showing: in flight, or
 * approved (the additional work he may now do). Newest first and bounded — a
 * job has a handful of claims, and LIMIT keeps it that way if one misbehaves.
 */
async function forJob(jobId, runner = pool) {
  const [rows] = await runner.query(
    `SELECT ${COLUMNS} FROM tbl_job_tx_report
      WHERE job_id = ? AND status IN (?)
      ORDER BY id DESC LIMIT 20`,
    [Number(jobId), [...OPEN_STATUSES, STATUS.APPROVED]],
  );
  return rows;
}

/** In-flight rows for MANY jobs in ONE query — pending-on's batch read. */
async function openForJobs(runner, jobIds) {
  const ids = [...new Set((jobIds || []).map(Number).filter(Number.isSafeInteger))];
  if (!ids.length) return [];
  const [rows] = await runner.query(
    `SELECT id, job_id, kind, status, reason_code, left_site_on
       FROM tbl_job_tx_report
      WHERE job_id IN (?) AND status IN (?)`,
    [ids, OPEN_STATUSES],
  );
  return rows;
}

/**
 * Close a claim the TECHNICIAN withdrew ("customer changed their mind").
 * Guarded on the row still being in one of `fromStatuses`, so an undo racing a
 * desk resolution loses cleanly: false = nothing was undone.
 */
async function markUndone(id, fromStatuses = [STATUS.OPEN]) {
  const [res] = await pool.query(
    `UPDATE tbl_job_tx_report SET status = ?, resolved_on = ?
      WHERE id = ? AND status IN (?)`,
    [STATUS.UNDONE, new Date(), Number(id), fromStatuses],
  );
  return Number(res.affectedRows) > 0;
}

async function setVisitChargeAwarded(id, awarded) {
  await pool.query('UPDATE tbl_job_tx_report SET visit_charge_awarded = ? WHERE id = ?', [awarded ? 1 : 0, Number(id)]);
}

module.exports = {
  KIND,
  STATUS,
  OPEN_STATUSES,
  HELP_REASONS,
  MAX_PROOF_IDS,
  byId,
  findOpen,
  open,
  forJob,
  openForJobs,
  markUndone,
  setVisitChargeAwarded,
  proofIdsFromCsv,
  proofIdsToCsv,
};
