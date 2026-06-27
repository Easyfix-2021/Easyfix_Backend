const { pool } = require('../db');
const logger = require('../logger');
const jobService = require('./job.service');

/*
 * Bulk job upload from parsed Excel rows (rev. 2026-05-19).
 *
 * Behaviour change: every row is now created in UNCONFIRMED status
 * (job_status = 9 / CALL_LATER) regardless of source. The legacy 17-col
 * format used to create BOOKED jobs directly; the new 10-col format is
 * a "pre-fill" of the Unconfirmed bucket — operators complete the
 * remaining details (city, pin, service type, owner, time slot) via
 * the per-row Confirm & Schedule flow before the order is actually
 * booked.
 *
 * Scope: one client per batch. The operator picks the client on the
 * upload form; we DON'T accept a per-row client column (the new
 * spreadsheet doesn't have one). `clientId` is passed in via the
 * service options.
 *
 * Per-row failures are still surfaced individually — we never roll
 * back already-created rows.
 */

function validateParsed(parsed) {
  const errors = [];
  if (!parsed.customer?.customer_name) errors.push('customer_name is required');
  if (!parsed.requested_date_time) errors.push('date_of_appointment is required (dd-mm-yyyy)');
  if (!parsed.address?.address) errors.push('address is required');
  if (parsed.service_type_raw && !parsed.job_type) {
    errors.push(`unrecognised Type of Service "${parsed.service_type_raw}" (allowed: Installation, Repair, UnInstallation)`);
  }
  return errors;
}

/*
 * Compose a `tbl_job.remarks` string that captures the upload-only
 * fields that don't have dedicated columns:
 *   - Product Quantity (the new spreadsheet has it as a flat int)
 *   - Mode of Payment  (free-text label from the dropdown)
 *   - Special Comments (operator-typed)
 *
 * Folded as a structured prefix so the Job Transaction view can parse
 * it back into separate columns later, same convention as
 * JobOutcomeDialog's `[Unreachable · ... · Reason: X]` prefix.
 */
function composeRemarks(parsed) {
  const parts = [];
  if (parsed.product_quantity != null) parts.push(`Qty: ${parsed.product_quantity}`);
  if (parsed.mode_of_payment) parts.push(`Mode of Payment: ${parsed.mode_of_payment}`);
  const prefix = parts.length ? `[Bulk Upload · ${parts.join(' · ')}]` : '';
  return [prefix, parsed.special_comments || ''].filter(Boolean).join(' ').trim() || undefined;
}

async function bulkUpload({ rows, skipCount, totalRows }, actor, opts = {}) {
  const { dryRun = false, clientId = null } = opts;
  logger.info('Bulk job upload · clientId=' + clientId + ' · totalRows=' + totalRows + ' · skipCount=' + skipCount + ' · dryRun=' + dryRun);

  if (!clientId) {
    const err = new Error('clientId is required — pick a client on the upload form');
    err.status = 400;
    throw err;
  }
  // Confirm the client actually exists + is active so we don't dump 200
  // rows under a deleted client_id.
  const [[client]] = await pool.query(
    'SELECT client_id, client_name FROM tbl_client WHERE client_id = ? AND client_status = 1 LIMIT 1',
    [clientId]
  );
  if (!client) {
    const err = new Error(`client_id ${clientId} not found or inactive`);
    err.status = 400;
    throw err;
  }

  const results = [];
  let createdCount = 0;
  let failedCount = skipCount;

  for (const { rowNumber, raw, parsed, skipReason } of rows) {
    // Surface Client Reference ID + Date of Appointment on EVERY
    // result row (regardless of status) so the FE can render them
    // in the report table without needing a parallel raw-row dict.
    // `raw` carries the unmodified string for failed/skipped rows
    // (since `parsed` may not exist); `parsed` is preferred for
    // success/valid rows because it's already cleaned.
    const baseRow = {
      rowNumber,
      client_ref_id: parsed?.client_ref_id ?? (raw?.client_ref_id || null) ?? null,
      date_of_appointment:
        parsed?.requested_date_time
          ? new Date(parsed.requested_date_time).toISOString()
          : (raw?.date_of_appointment ? String(raw.date_of_appointment) : null),
    };

    if (skipReason) {
      results.push({ ...baseRow, status: 'skipped', reason: skipReason });
      continue;
    }

    const errors = validateParsed(parsed);
    if (errors.length) {
      failedCount++;
      results.push({ ...baseRow, status: 'failed', errors, raw });
      continue;
    }

    if (dryRun) {
      results.push({ ...baseRow, status: 'valid' });
      continue;
    }

    // Build the create payload. Note `initial_status: 9` (UNCONFIRMED) —
    // job.service.create() respects this and routes the row straight
    // into the Unconfirmed bucket for ops follow-up via the Confirm
    // flow. City / pin / service type are intentionally absent; the
    // Confirm flow's mandatory-field gates will surface them.
    const payload = {
      fk_client_id: client.client_id,
      initial_status: 9, // UNCONFIRMED — see services/job.service.js STATUS.CALL_LATER
      source_type: 'excel',
      client_ref_id: parsed.client_ref_id,
      job_desc: parsed.job_desc,
      job_type: parsed.job_type || 'Installation',
      requested_date_time: parsed.requested_date_time,
      customer: parsed.customer,
      address: {
        address: parsed.address.address,
        // city_id / pin_code intentionally omitted — Confirm flow gates
        // them as mandatory when ops books the call.
      },
      remarks: composeRemarks(parsed),
    };

    try {
      const created = await jobService.create(payload, actor);
      createdCount++;
      results.push({ ...baseRow, status: 'created', jobId: created.job_id });
    } catch (e) {
      failedCount++;
      logger.warn({ rowNumber, err: e.message }, 'bulk upload row failed');
      results.push({ ...baseRow, status: 'failed', errors: [e.message], raw });
    }
  }

  logger.info('Bulk upload done · created=' + createdCount + ' · failed=' + failedCount + ' · skipped=' + skipCount + ' · totalRows=' + totalRows + ' · dryRun=' + dryRun);
  return {
    summary: {
      totalRows, createdCount, failedCount, skipCount,
      dryRun,
      clientId: client.client_id,
      clientName: client.client_name,
      // The unconfirmed bucket is where the newly-created rows land —
      // surface it on the response so the FE can deep-link the operator
      // there after a successful upload.
      landingTab: 'unconfirmed',
    },
    results,
  };
}

module.exports = { bulkUpload };
