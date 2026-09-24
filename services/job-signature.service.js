'use strict';
/*
 * services/job-signature.service.js — the customer's signature (V3 4.1, D6).
 *
 * Needed only when no customer PIN was verified on the job; the mobile
 * checkout (BACKEND-A) accepts "PIN verified OR a row here".
 *
 * WHAT IS STORED: SVG PATH DATA ONLY — the string that goes in a <path d="…">,
 * one path, each stroke a subpath starting with M/m. Never an <svg> document,
 * never markup, never a data URL. The CRM renders it inside its OWN
 * <svg viewBox="0 0 width height"><path d={svg}/></svg>, so the only thing a
 * caller controls is geometry.
 *
 * The check is a whitelist over the path grammar's character set: command
 * letters, digits, '.', ',', '+', '-', 'e'/'E' (exponents) and whitespace.
 * '<', '>', quotes, ':', ';', '/', '&', '(' … are all absent from it, so no
 * tag, attribute, entity, url() or javascript: can be spelled. It does not
 * prove the path parses — a malformed path draws nothing, it cannot execute.
 * ASCII-only, so the 200 KB cap in characters is also the cap in bytes.
 */
const { pool } = require('../db');
const logger = require('../logger');
const jobLog = require('./job-log.service');
const lifecycle = require('./mobile-job-lifecycle.service');

const SVG_MAX = 200 * 1024;
const DIM_MIN = 1;
const DIM_MAX = 4096;
const SIGNABLE = new Set([2, 20]); // IN_PROGRESS and IN_PROGRESS_ALT
const PATH_DATA = /^[Mm][MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$/;

function httpError(status, message, code) {
  const e = new Error(message); e.status = status; if (code) e.code = code; return e;
}

const isPathData = (s) => typeof s === 'string' && s.length <= SVG_MAX && PATH_DATA.test(s) && /\d/.test(s);

// 'YYYY-MM-DD HH:MM:SS' IST — what the pool (dateStrings, +05:30) reads back.
const istString = (d) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 19).replace('T', ' ');

/*
 * POST /mobile/jobs/:id/signature. Owner-guarded (404 for a job that is not
 * his), status 2/20 only (409), one row per job — a re-sign replaces it.
 */
async function saveSignature(jobId, efrId, { svg, width, height }) {
  const path = typeof svg === 'string' ? svg.trim() : svg;
  if (!isPathData(path)) throw httpError(400, 'svg must be SVG path data (M… L… commands only)', 'BAD_SIGNATURE');
  const job = await lifecycle.getOwnedJob(jobId, efrId);
  if (!SIGNABLE.has(Number(job.job_status))) {
    throw httpError(409, 'A signature can only be taken while the job is in progress', 'JOB_NOT_IN_PROGRESS');
  }
  const now = new Date();
  await pool.query(
    `INSERT INTO tbl_job_signature (job_id, efr_id, svg_path, width, height, signed_on)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE efr_id = VALUES(efr_id), svg_path = VALUES(svg_path),
       width = VALUES(width), height = VALUES(height), signed_on = VALUES(signed_on)`,
    [Number(jobId), Number(efrId), path, width, height, now],
  );
  logger.info(`Signature taken · jobId=${jobId} · efrId=${efrId} · bytes=${path.length}`);
  try {
    await jobLog.logSignatureTaken(Number(jobId), {}, { efr_id: Number(efrId) }, now);
  } catch (e) {
    logger.warn(`Job log logSignatureTaken failed (non-fatal) · jobId=${jobId} · ${e.message}`);
  }
  return { signatureOn: istString(now) };
}

// GET /admin/jobs/:id/signature → { svg, width, height, signedOn } | null
async function getSignature(jobId) {
  const [[row]] = await pool.query(
    'SELECT svg_path, width, height, signed_on FROM tbl_job_signature WHERE job_id = ? LIMIT 1',
    [Number(jobId)],
  );
  if (!row) return null;
  return { svg: row.svg_path, width: Number(row.width), height: Number(row.height), signedOn: String(row.signed_on) };
}

module.exports = { saveSignature, getSignature, isPathData, SVG_MAX, DIM_MIN, DIM_MAX };
