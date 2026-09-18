/*
 * QuickSight — Employee Performance: the SPOC-freeze scheduled job.
 *
 * A closed job keeps the Primary SPOC it had when it was first captured, so
 * past revenue never moves when a client is reassigned (tbl_vertical_mapping
 * keeps no history). This job does the capturing; the dashboard's reads never
 * write. The work itself is sources.service.js captureSpocFreeze().
 *
 * HOURLY, so a job is captured within the hour it closes and a same-day
 * reassignment cannot move it. Each run walks the closed jobs checked out since
 * the 1st of the PREVIOUS IST month — the current and the last month are always
 * complete — and inserts only the ones with no row yet.
 *
 * SAFE TO RUN ANYWHERE: until migrations/2026-09-16-create-qs-employee-
 * performance-inputs.sql has created tbl_qs_ep_job_spoc it answers "skipped"
 * and touches nothing. Two replicas racing the same job are harmless — the
 * primary key makes the second insert a no-op (first capture wins). Respects
 * CRON_DISABLED through server/scheduler.js.
 */

'use strict';

const logger = require('../../../logger');
const { captureSpocFreeze } = require('./sources.service');

async function runSpocFreeze() {
  const r = await captureSpocFreeze();
  if (r.skipped) {
    logger.info(`Employee Performance SPOC freeze skipped · ${r.reason}`);
  } else {
    logger.info(`Employee Performance SPOC freeze · ${r.since}..${r.to} · scanned=${r.scanned}`
      + ` · alreadyFrozen=${r.alreadyFrozen} · captured=${r.captured} · withoutSpoc=${r.capturedWithoutSpoc} · ${r.ms}ms`);
  }
  return r;
}

module.exports = { runSpocFreeze };
