const { pool } = require('../db');
const logger = require('../logger');
const s3Storage = require('../utils/s3-storage');

/*
 * Webhook delivery service.
 * Replaces the legacy Webhook_2023 Node.js :7070 service. Three responsibilities:
 *
 *   1. Event + mapping registry (webhook_events, webhook_client_url_mapping).
 *   2. Payload enrichment — 5-table JOIN against tbl_job and friends, returning
 *      the exact JSON shape existing integrators (Decathlon, Powermax, etc.)
 *      depend on. This is a ZERO-DRIFT contract — altering field names breaks
 *      production client callbacks.
 *   3. Outbound dispatcher with retry + DLQ — improvements over legacy, which
 *      had none of these.
 *
 * Dispatch is fire-and-forget from the caller's POV (setImmediate). Internal
 * retries run in-process with exponential backoff.
 *
 * Live data reality (2026-04-17):
 *   - 6 real events (id 1-6). Ids 7 (name="xyz") and 8 (name=null) are junk;
 *     lookups filter them out via `status='active' AND name IS NOT NULL`.
 *   - 24 active mappings; 3 known live clients (10, 189, 213). Decathlon
 *     (client_id=213) stores an auth token in webhook_client_url_mapping.authorization
 *     that MUST be sent as the outbound `Authorization` header.
 */

const EVENT_NAMES = Object.freeze({
  TechAssigned:        'TechAssigned',
  TechStart:           'TechStart',
  TechVisitComplete:   'TechVisitComplete',
  TechVisitInComplete: 'TechVisitInComplete',
  RescheduleTech:      'RescheduleTech',
  CancelJob:           'CancelJob',
});

// Outbound URL root for image paths in payload. Keeps compat with legacy
// which stored full URLs (not relative paths) in jobImage[].image.
const IMAGE_URL_BASE = process.env.WEBHOOK_IMAGE_URL_BASE || 'https://qa.easyfix.in/easydoc';

// ─── Registry: events ───────────────────────────────────────────────
async function listEvents({ includeInactive = false } = {}) {
  logger.info('Listing webhook events · includeInactive=' + includeInactive);
  const where = includeInactive ? "WHERE name IS NOT NULL"
                                : "WHERE status = 'active' AND name IS NOT NULL";
  const [rows] = await pool.query(
    `SELECT id, name, \`desc\`, status, createdAt, updatedAt FROM webhook_events ${where} ORDER BY id ASC`
  );
  logger.info('Found ' + rows.length + ' webhook events');
  return rows;
}

async function getEventByName(name) {
  const [[row]] = await pool.query(
    `SELECT id, name, \`desc\`, status FROM webhook_events
      WHERE name = ? AND status = 'active' LIMIT 1`,
    [name]
  );
  return row || null;
}

async function createEvent({ name, desc }, actor) {
  logger.info('Creating webhook event · name=' + name);
  const [r] = await pool.query(
    `INSERT INTO webhook_events (name, \`desc\`, status, createdAt, updatedAt, createdBy)
     VALUES (?, ?, 'active', ?, ?, ?)`,
    [name, desc || null, new Date(), new Date(), actor?.user_id || null]
  );
  logger.info('Webhook event created · id=' + r.insertId);
  return { id: r.insertId, name, desc, status: 'active' };
}

async function updateEvent(id, { desc, status }, actor) {
  logger.info('Updating webhook event · id=' + id + (status !== undefined ? ' · status=' + status : ''));
  const sets = [], vals = [];
  if (desc !== undefined)   { sets.push('`desc` = ?'); vals.push(desc); }
  if (status !== undefined) { sets.push('status = ?'); vals.push(status); }
  if (sets.length === 0) return null;
  sets.push('updatedAt = ?', 'updatedBy = ?');
  vals.push(new Date(), actor?.user_id || null, id);
  await pool.query(`UPDATE webhook_events SET ${sets.join(', ')} WHERE id = ?`, vals);
  const [[row]] = await pool.query('SELECT * FROM webhook_events WHERE id = ?', [id]);
  logger.info('Webhook event updated · id=' + id);
  return row;
}

// ─── Registry: mappings ─────────────────────────────────────────────
async function listMappings({ clientId, eventId, includeInactive = false } = {}) {
  logger.info('Listing webhook mappings · clientId=' + (clientId ?? 'any') + ' · eventId=' + (eventId ?? 'any') + ' · includeInactive=' + includeInactive);
  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push("m.status = 'active'");
  if (clientId != null) { clauses.push('m.client_id = ?'); params.push(clientId); }
  if (eventId != null)  { clauses.push('m.event_id = ?');  params.push(eventId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT m.id, m.client_id, m.event_id, e.name AS event_name,
            m.call_back_url, m.authorization, m.status, m.createdAt, m.updatedAt,
            c.client_name
       FROM webhook_client_url_mapping m
       LEFT JOIN webhook_events e ON e.id = m.event_id
       LEFT JOIN tbl_client c ON c.client_id = m.client_id
       ${where} ORDER BY m.id ASC`,
    params
  );
  logger.info('Found ' + rows.length + ' webhook mappings');
  return rows;
}

async function activeMappingsFor(clientId, eventId) {
  const [rows] = await pool.query(
    `SELECT id, client_id, event_id, call_back_url, authorization
       FROM webhook_client_url_mapping
      WHERE client_id = ? AND event_id = ? AND status = 'active'`,
    [clientId, eventId]
  );
  return rows;
}

async function createMapping({ clientId, eventId, callBackUrl, authorization }) {
  logger.info('Creating webhook mapping · clientId=' + clientId + ' · eventId=' + eventId);
  const [r] = await pool.query(
    `INSERT INTO webhook_client_url_mapping
       (client_id, event_id, call_back_url, authorization, status, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [clientId, eventId, callBackUrl, authorization || null, new Date(), new Date()]
  );
  logger.info('Webhook mapping created · id=' + r.insertId);
  return { id: r.insertId };
}

async function updateMapping(id, { callBackUrl, authorization, status }) {
  logger.info('Updating webhook mapping · id=' + id + (status !== undefined ? ' · status=' + status : ''));
  const sets = [], vals = [];
  if (callBackUrl !== undefined)   { sets.push('call_back_url = ?'); vals.push(callBackUrl); }
  if (authorization !== undefined) { sets.push('authorization = ?'); vals.push(authorization); }
  if (status !== undefined)        { sets.push('status = ?'); vals.push(status); }
  if (sets.length === 0) return null;
  sets.push('updatedAt = ?');
  vals.push(new Date(), id);
  await pool.query(`UPDATE webhook_client_url_mapping SET ${sets.join(', ')} WHERE id = ?`, vals);
  const [[row]] = await pool.query('SELECT * FROM webhook_client_url_mapping WHERE id = ?', [id]);
  logger.info('Webhook mapping updated · id=' + id);
  return row;
}

async function deleteMapping(id) {
  logger.info('Soft-deleting webhook mapping · id=' + id);
  // Soft-delete: flip status to 'inactive' rather than DELETE. Audit-friendly.
  await pool.query("UPDATE webhook_client_url_mapping SET status = 'inactive', updatedAt = ? WHERE id = ?",
    [new Date(), id]);
  logger.info('Webhook mapping deleted · id=' + id);
}

// ─── Enrichment: build the payload exactly as legacy did ────────────
function fmtDateTime(d) {
  if (!d) return null;
  if (typeof d === 'string') return d;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function buildJobPayload(jobId, eventName) {
  const [[job]] = await pool.query(
    `SELECT j.*,
            cu.customer_name, cu.customer_mob_no, cu.customer_email,
            ef.efr_name AS easyfixer_name, ef.efr_email AS easyfixer_email,
            sb.user_name AS sb_user_name, sb.official_email AS sb_user_email,
            sb.mobile_no AS sb_mobile, sb.alternate_no AS sb_alternate,
            sp.contact_name AS spoc_name, sp.contact_email AS spoc_email,
            sp.contact_no AS spoc_mobile, sp.contact_alt_no AS spoc_alt,
            rr.reschedule_reason AS rr_reason
       FROM tbl_job j
       LEFT JOIN tbl_customer        cu ON cu.customer_id = j.fk_customer_id
       LEFT JOIN tbl_easyfixer       ef ON ef.efr_id      = j.fk_easyfixter_id
       LEFT JOIN tbl_user            sb ON sb.user_id     = j.fk_scheduled_by
       LEFT JOIN tbl_client_contacts sp ON sp.id          = j.reporting_contact_id
       LEFT JOIN reschedule_reason_app rr ON rr.id        = j.reschedule_reason_id
      WHERE j.job_id = ? LIMIT 1`,
    [jobId]
  );
  if (!job) return null;

  const [images] = await pool.query(
    `SELECT image, image_category FROM tbl_job_image WHERE job_id = ? ORDER BY image_id ASC`,
    [jobId]
  );

  const [services] = await pool.query(
    `SELECT js.quantity, js.service_type_id, js.service_id, js.total_charge,
            st.service_type_name,
            cs.rate_card_id, rc.crc_ratecard_name AS rate_card_name
       FROM tbl_job_services js
       LEFT JOIN tbl_service_type     st ON st.service_type_id = js.service_type_id
       LEFT JOIN tbl_client_service   cs ON cs.client_service_id = js.service_id
       LEFT JOIN tbl_client_rate_card rc ON rc.crc_id = cs.rate_card_id
      WHERE js.job_id = ?
      ORDER BY js.job_service_id ASC`,
    [jobId]
  );

  return {
    id: job.job_id,
    ssp: job.client_ref_id || null, // TODO verify vs legacy — blueprint unclear on this field
    status: job.job_status,
    jobType: job.job_type,
    cancelBy: job.cancel_by,
    customer: {
      name: job.customer_name || '',
      customerEmail: job.customer_email || '',
      customerMobileNo: job.customer_mob_no || '',
    },
    /*
     * Resolve image URLs for outbound webhook payloads. Three shapes
     * exist in tbl_job_image.image after the 2026-05-14 S3 migration:
     *
     *   1. Absolute URL (legacy import — preserve verbatim).
     *   2. S3 key like "Job_Images/<jobId>_<seq>" — mint a presigned
     *      URL on the spot. External clients consume this URL later,
     *      so we generate a LONGER TTL than the 5-min UI default —
     *      see WEBHOOK_S3_PRESIGN_TTL_SEC override.
     *   3. Bare filename — legacy local file under /easydoc/upload_jobs/.
     */
    jobImage: await Promise.all(images.map(async (img) => {
      const stored = String(img.image || '');
      let url;
      if (stored.startsWith('http')) {
        url = stored;
      } else if (s3Storage.isEnabled() && stored.startsWith('Job_Images/')) {
        // Webhook receivers (Decathlon etc.) may consume the URL hours
        // after delivery; bump TTL to 24h. Falls back to local URL if
        // S3 lookup fails so the receiver still gets something usable.
        const ttl = Number(process.env.WEBHOOK_S3_PRESIGN_TTL_SEC) || 24 * 3600;
        try {
          // eslint-disable-next-line no-shadow
          const { GetObjectCommand } = require('@aws-sdk/client-s3');
          const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
          const { S3Client } = require('@aws-sdk/client-s3');
          const cli = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
          url = await getSignedUrl(cli, new GetObjectCommand({
            Bucket: s3Storage.bucketName(),
            Key: stored,
          }), { expiresIn: ttl });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('webhook: S3 presign failed for', stored, e?.message);
          url = `${IMAGE_URL_BASE}/upload_jobs/${stored}`;
        }
      } else {
        url = `${IMAGE_URL_BASE}/upload_jobs/${stored}`;
      }
      return { image: url, image_category: img.image_category || '' };
    })),
    clientSpoc: {
      name: job.spoc_name || '',
      email: job.spoc_email || '',
      mobileNo: job.spoc_mobile || '',
      alternateNo: job.spoc_alt || '',
    },
    collectedBy: job.collected_by,
    jobCancelBy: job.job_cancel_reason_id_by_easyfixer,
    /*
     * jobServices is OMITTED for CancelJob — legacy Webhook_2023 did the same
     * (src/services/job.service.js: `if (event !== "CancelJob")` gates the
     * jobServices include). Sending it made the payload 39 top-level keys
     * against legacy's 38 and Decathlon's endpoint rejected the whole body
     * with HTTP 400 on every attempt.
     *
     * Spread rather than a conditional value: an explicit `undefined` would
     * still create the key under JSON.stringify semantics in some shapes, and
     * the contract here is about the key being ABSENT, not empty.
     */
    ...(eventName === EVENT_NAMES.CancelJob ? {} : {
      jobServices: services.map((s) => ({
        quantity: s.quantity,
        serviceType: { serviceTypeName: s.service_type_name || '' },
        clientService: {
          rate_card_id: s.rate_card_id,
          clientRateCard: { serviceName: s.rate_card_name || '' },
        },
      })),
    }),
    referenceId: job.job_reference_id || `REF-${job.job_id}`,
    revisitDate: fmtDateTime(job.revisit_date),
    scheduledBy: {
      mobileNo:    job.sb_mobile || null,
      userName:    job.sb_user_name || '',
      userEmail:   job.sb_user_email || '',
      alternateNo: job.sb_alternate || null,
    },
    cancelReason: job.cancel_reason_id,
    cancelComment: job.cancel_comment,
    easyfixerName: job.easyfixer_name || '',
    enquiryReason: job.enquiry_reason_id,
    problemReason: job.problemReason ? String(job.problemReason) : null,
    requestedTime: job.requested_time || null,
    scheduledDate: fmtDateTime(job.scheduled_date_time),
    cancelReasonId: job.cancel_reason_id,
    easyfixerEmail: job.easyfixer_email || '',
    enquiryComment: job.enquiry_comment,
    jobDescription: job.job_desc || '',
    enquiryDateTime: fmtDateTime(job.enquiry_date_time),
    problemReasonId: job.problem_reason_id,
    revisitReasonId: job.revisit_reason_id,
    revisitTimeSlot: job.revisit_time_slot,
    canceledDateTime: fmtDateTime(job.cancel_date_time),
    jobProblemReason: job.problem_reason_id ? { id: job.problem_reason_id } : null,
    jobRevisitReason: job.revisit_reason_id ? { id: job.revisit_reason_id } : null,
    clientReferenceId: job.client_ref_id,
    requestedDateTime: fmtDateTime(job.requested_date_time),
    rescheduleRemarks: job.reschedule_remarks,
    rescheduleReasonId: job.reschedule_reason_id,
    appCheckoutDateTime: fmtDateTime(job.app_checkout_date_time),
    jobRescheduleReason: job.reschedule_reason_id ? {
      id: job.reschedule_reason_id,
      reason: job.rr_reason || '',
    } : null,
    ticketCreatedDateTime: fmtDateTime(job.ticket_created_date_time),
    _fk_client_id: job.fk_client_id, // internal — NOT part of outbound payload, stripped before send
  };
}

// ─── Dispatcher ─────────────────────────────────────────────────────
const MAX_ATTEMPTS = 3;
function backoffMs(attempt) {
  // attempt 1 → 0ms (immediate), 2 → 30_000, 3 → 300_000 (5 min)
  return [0, 30_000, 300_000][Math.max(0, attempt - 1)] || 300_000;
}

async function logDelivery({ clientId, eventId, jobId, callBackUrl, jobData, httpStatus, error, dlq }) {
  // Legacy webhook_logs has no status/http_code/attempt columns. We log the
  // base envelope and embed delivery metadata into job_data to preserve forensics.
  const enriched = { ...jobData };
  if (httpStatus != null) enriched.__delivery = { httpStatus };
  if (error) enriched.__delivery = { ...(enriched.__delivery || {}), error };
  if (dlq)   enriched.__delivery = { ...(enriched.__delivery || {}), dlq: true };

  await pool.query(
    `INSERT INTO webhook_logs (client_id, event_id, job_id, call_back_url, job_data, insert_date)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [clientId, eventId, jobId, callBackUrl, JSON.stringify(enriched), new Date()]
  );
}

/*
 * Is another attempt with the SAME payload capable of a different outcome?
 *
 * 4xx says the server understood the request and rejected it — replaying an
 * unchanged body cannot turn it into a 2xx, so a retry only multiplies the
 * POSTs the client receives and the rows written to webhook_logs. A live 400
 * from a partner endpoint was logged three times for one event, which read as
 * three duplicate deliveries in an audit.
 *
 * The two exceptions are the 4xx codes that are explicitly about TIMING
 * rather than the payload: 408 (server gave up waiting) and 429 (rate
 * limited). Both can succeed unchanged once the backoff has elapsed.
 *
 * 5xx and anything else is treated as transient and retried — including a
 * network-level throw, which never reaches this function and is retried by
 * the catch branch.
 */
function isRetryable(status) {
  if (status === 408 || status === 429) return true;
  return !(status >= 400 && status < 500);
}

async function deliverWithRetry(context, attempt = 1) {
  const { mapping, event, jobId, payload } = context;
  try {
    const res = await fetch(mapping.call_back_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(mapping.authorization ? { Authorization: mapping.authorization } : {}),
      },
      body: JSON.stringify({ event: event.name, jobData: payload }),
      signal: AbortSignal.timeout(15_000),
    });
    const ok = res.ok;
    const who = `client=${mapping.client_id} · event=${event.name} · job=${jobId} · attempt ${attempt}`;
    if (ok) logger.webhook(`delivered · ${who} · status=${res.status}`);
    else    logger.warn(`Webhook non-2xx · ${who} · status=${res.status}`);
    await logDelivery({
      clientId: mapping.client_id, eventId: event.id, jobId,
      callBackUrl: mapping.call_back_url,
      jobData: payload,
      httpStatus: res.status,
      dlq: !ok && (!isRetryable(res.status) || attempt >= MAX_ATTEMPTS),
    });
    if (!ok && isRetryable(res.status) && attempt < MAX_ATTEMPTS) {
      setTimeout(() => deliverWithRetry(context, attempt + 1), backoffMs(attempt + 1)).unref();
    } else if (!ok) {
      logger.warn(`Webhook not retried · ${who} · status=${res.status} · `
        + (isRetryable(res.status) ? 'attempts exhausted' : 'non-retryable status'));
    }
  } catch (err) {
    logger.error(`Webhook error · client=${mapping.client_id} · event=${event.name} · job=${jobId} · attempt ${attempt} · ${err.message}`);
    await logDelivery({
      clientId: mapping.client_id, eventId: event.id, jobId,
      callBackUrl: mapping.call_back_url,
      jobData: payload,
      error: err.message,
      dlq: attempt >= MAX_ATTEMPTS,
    });
    if (attempt < MAX_ATTEMPTS) {
      setTimeout(() => deliverWithRetry(context, attempt + 1), backoffMs(attempt + 1)).unref();
    }
  }
}

/**
 * Dispatch a webhook event for a job. Fire-and-forget from the caller:
 * the returned promise resolves once the FIRST delivery attempt has been
 * scheduled, not when it completes. Retries run async in the background.
 */
/*
 * Record a dispatch that never became a delivery attempt.
 *
 * deliverWithRetry logs both success and failure, but every early return in
 * dispatch() used to leave NO trace at all — so a client whose mapping was
 * missing or inactive went silent with nothing in webhook_logs to show for
 * it. That is indistinguishable from "the event never fired", which is the
 * one question this table has to be able to answer once the legacy
 * dispatcher is switched off.
 *
 * Written with call_back_url NULL (no URL was chosen) and the reason under
 * __delivery.skipped, reusing the same envelope key that marks a row as
 * written by this service rather than by legacy.
 */
async function logSkip({ clientId, eventId, jobId, reason }) {
  try {
    await pool.query(
      `INSERT INTO webhook_logs (client_id, event_id, job_id, call_back_url, job_data, insert_date)
       VALUES (?, ?, ?, NULL, ?, ?)`,
      [clientId || null, eventId || null, jobId || null,
       JSON.stringify({ __delivery: { skipped: reason } }), new Date()]
    );
  } catch (err) {
    // Never let bookkeeping break a dispatch path that is already bailing out.
    logger.warn(`Webhook skip-log failed · job=${jobId} · reason=${reason} · ${err.message}`);
  }
}

async function dispatch({ eventName, jobId }) {
  logger.info('Dispatching webhook · event=' + eventName + ' · job=' + jobId);
  /*
   * Outbound kill switch. ENABLED-style flag: dispatch proceeds unless the
   * value is explicitly falsy ("false"/"0"/"no"). An UNSET variable keeps
   * webhooks ENABLED, which preserves the behaviour every environment has
   * today — a rename must not silence production if one env file is missed.
   * Set WEBHOOK_OUTBOUND_ENABLED=false everywhere except Prod.
   */
  const flag = String(process.env.WEBHOOK_OUTBOUND_ENABLED ?? '').trim().toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'no') {
    logger.test(`Webhook suppressed (WEBHOOK_OUTBOUND_ENABLED=${flag}) · event=${eventName} · job=${jobId}`);
    return { disabled: true };
  }

  const event = await getEventByName(eventName);
  if (!event) {
    logger.warn(`Webhook skipped · unknown event "${eventName}" · job=${jobId}`);
    await logSkip({ jobId, reason: `unknown event "${eventName}"` });
    return { unknownEvent: true };
  }

  const payload = await buildJobPayload(jobId, eventName);
  if (!payload) {
    logger.warn(`Webhook skipped · job ${jobId} not found · event=${eventName}`);
    await logSkip({ eventId: event.id, jobId, reason: 'job not found' });
    return { jobMissing: true };
  }
  const clientId = payload._fk_client_id;
  delete payload._fk_client_id;

  if (!clientId) {
    logger.debug({ eventName, jobId }, 'webhook skipped — job has no client_id');
    await logSkip({ eventId: event.id, jobId, reason: 'job has no client_id' });
    return { noClient: true };
  }

  const mappings = await activeMappingsFor(clientId, event.id);
  if (mappings.length === 0) {
    logger.info('No active webhook mapping · client=' + clientId + ' · event=' + eventName + ' · job=' + jobId);
    await logSkip({ clientId, eventId: event.id, jobId, reason: 'no active mapping' });
    return { dispatched: 0, reason: 'no active mapping' };
  }

  for (const mapping of mappings) {
    // Fire-and-forget: deliverWithRetry swallows errors internally.
    setImmediate(() => deliverWithRetry({ mapping, event, jobId, payload }));
  }
  logger.info('Scheduled ' + mappings.length + ' webhook deliveries · event=' + eventName + ' · job=' + jobId);
  return { dispatched: mappings.length };
}

/**
 * Admin-triggered manual delivery for a single mapping. Useful for ops
 * reconciliation when a client complains "didn't get the webhook".
 */
async function manualDispatch({ eventName, jobId, mappingId }) {
  logger.info('Manual webhook dispatch · event=' + eventName + ' · job=' + jobId + ' · mapping=' + mappingId);
  const event = await getEventByName(eventName);
  if (!event) logger.warn('Manual webhook dispatch skipped · unknown event "' + eventName + '"');
  if (!event) throw Object.assign(new Error('event not found'), { status: 404 });
  const payload = await buildJobPayload(jobId, eventName);
  if (!payload) logger.warn('Manual webhook dispatch skipped · job ' + jobId + ' not found');
  if (!payload) throw Object.assign(new Error('job not found'), { status: 404 });
  delete payload._fk_client_id;

  const [[mapping]] = await pool.query(
    'SELECT id, client_id, event_id, call_back_url, authorization FROM webhook_client_url_mapping WHERE id = ?',
    [mappingId]
  );
  if (!mapping) logger.warn('Manual webhook dispatch skipped · mapping ' + mappingId + ' not found');
  if (!mapping) throw Object.assign(new Error('mapping not found'), { status: 404 });

  return new Promise((resolve) => {
    setImmediate(async () => {
      await deliverWithRetry({ mapping, event, jobId, payload });
      resolve({ dispatched: true });
    });
  });
}

// ─── Logs query ─────────────────────────────────────────────────────
async function listLogs({ clientId, eventId, jobId, limit = 50, offset = 0 } = {}) {
  logger.info('Listing webhook logs · clientId=' + (clientId ?? 'any') + ' · eventId=' + (eventId ?? 'any') + ' · jobId=' + (jobId ?? 'any') + ' · limit=' + limit + ' · offset=' + offset);
  const clauses = [];
  const params = [];
  if (clientId != null) { clauses.push('client_id = ?'); params.push(clientId); }
  if (eventId != null)  { clauses.push('event_id = ?');  params.push(eventId); }
  if (jobId != null)    { clauses.push('job_id = ?');    params.push(jobId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Number(limit), Number(offset));
  const [rows] = await pool.query(
    `SELECT id, client_id, event_id, job_id, call_back_url, insert_date,
            JSON_EXTRACT(job_data, '$.__delivery') AS delivery_meta
       FROM webhook_logs ${where}
       ORDER BY id DESC LIMIT ? OFFSET ?`,
    params
  );
  logger.info('Found ' + rows.length + ' webhook logs');
  return rows;
}

module.exports = {
  EVENT_NAMES,
  listEvents, getEventByName, createEvent, updateEvent,
  listMappings, activeMappingsFor, createMapping, updateMapping, deleteMapping,
  buildJobPayload,
  dispatch, manualDispatch,
  listLogs,
};
