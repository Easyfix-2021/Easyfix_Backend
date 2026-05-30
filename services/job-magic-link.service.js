/**
 * services/job-magic-link.service.js
 *
 * Customer Magic-Link Completion for Unconfirmed Orders.
 *
 * Three exports power the feature:
 *   1. fetchPrefill(jobId, pool)         — public GET payload builder
 *   2. sendForJob(jobId, {action}, pool) — admin-triggered WhatsApp send + audit
 *   3. acceptSubmission(jobId, payload, pool) — public POST commit (transactional)
 *
 * Plan: /Users/harshit/.claude/plans/distributed-foraging-perlis.md
 * Schema additions (migration 2026-05-28-magic-link-feature.sql):
 *   tbl_job.customer_submitted_at      DATETIME
 *   tbl_job.customer_submitted_payload JSON
 *   tbl_job.magic_link_sent_at         DATETIME
 *   tbl_job.magic_link_send_count      INT DEFAULT 0
 *   tbl_job.magic_link_last_action     VARCHAR(20)
 *
 * Style: CommonJS, parameterised SQL, mysql2/promise. `pool` is injected
 * (consistent with the rest of services/* — keeps the module unit-testable
 * and free of a direct db.js import).
 */

const { signJobToken } = require('../utils/jwt');
// WhatsApp wrapper — Gallabox.
// CLAUDE.md Step 11 (Notification services) names Gallabox as the canonical
// WhatsApp provider; deployments are configured with GALLABOX_API_KEY /
// _API_SECRET / _CHANNEL_ID. (The Meta Cloud API wrapper at
// services/meta.whatsapp.service.js was an aspirational migration target
// flagged in 2026-05-21 docblocks, but the env-credential migration to Meta
// was never completed on the deployed instances. Stay on Gallabox.)
// Call shape: sendTemplate({ to, recipientName, templateName, bodyValues: { 1, 2, 3 } })
// Both NOTIFICATIONS_DISABLE and TEST_MOBILE are honoured by the Gallabox wrapper.
const whatsappService  = require('./gallabox.whatsapp.service');
const logger           = require('../logger');

/**
 * Time-slot enum surfaced to the customer.
 *
 * Hard-coded (vs. table-driven) because:
 *   - The slot labels are presentation-only — they're stored on tbl_job.time_slot
 *     as a VARCHAR matching what the CRM has historically written.
 *   - No corresponding lookup table exists in easyfix_core; the 5 legacy
 *     services all hard-code the same set.
 *   - Keeping it in code avoids an extra round-trip on every prefill fetch.
 */
const TIME_SLOTS = ['9 AM – 12 PM', '12 PM – 3 PM', '3 PM – 7 PM', 'After Hours'];

/**
 * Resolve the customer-visible base URL for the magic link.
 *
 * MAGIC_LINK_BASE_URL is set per-environment (staging/prod). Default lands
 * on qa for safety — a missing env var should never silently leak prod URLs
 * into dev WhatsApps.
 */
function magicLinkUrl(token) {
  const base = process.env.MAGIC_LINK_BASE_URL || 'https://qa.easyfix.in';
  return `${base.replace(/\/$/, '')}/job-completion/${token}`;
}

/**
 * Probe whether tbl_city has an is_active column.
 *
 * Why a runtime probe (vs assume): tbl_city schema has drifted across
 * environments — QA shows `is_active` but older snapshots don't. We can't
 * alter the shared schema (5-service rule in EasyFix_Backend/CLAUDE.md),
 * so we adapt at read time. The probe is memoised after first call.
 */
let _cityIsActiveProbed = false;
let _cityHasIsActive = false;
async function cityHasIsActive(pool) {
  if (_cityIsActiveProbed) return _cityHasIsActive;
  try {
    await pool.query('SELECT city_id FROM tbl_city WHERE is_active = 1 LIMIT 1');
    _cityHasIsActive = true;
  } catch (_e) {
    _cityHasIsActive = false;
  }
  _cityIsActiveProbed = true;
  return _cityHasIsActive;
}

/**
 * Build the public GET prefill response for the magic-link landing page.
 *
 * Caller contract: routes/public/job-completion.js has already verified the
 * JWT (verifyJobToken) and live order state (requireUnconfirmedJob). This
 * function is therefore free to assume the job exists in status=9 — the
 * 404 throw below is purely defensive in case the row was deleted between
 * the auth check and this read (extremely unlikely but cheap to guard).
 *
 * The payload is intentionally *non-sensitive*: no internal user IDs,
 * no rate-card prices, no other clients' data. Even if a magic link
 * leaked, the worst exposure is one customer's own contact/address —
 * which they already know.
 *
 * Concurrency: secondary lookups (cities, services, images) run via
 * Promise.all because they're mutually independent. Saves ~3× the
 * latency vs sequential.
 */
async function fetchPrefill(jobId, pool) {
  const [jobRows] = await pool.query(
    `SELECT j.job_id, j.fk_client_id, j.fk_address_id, j.requested_date_time,
            j.time_slot, j.job_desc, j.additional_name, j.additional_number,
            COALESCE(j.job_customer_name, cu.customer_name) AS customer_name,
            cu.customer_mob_no, cu.customer_email,
            ad.address, ad.building, ad.landmark, ad.city_id, ad.pin_code,
            ad.gps_location, ad.address_instruction,
            cl.client_name
       FROM tbl_job j
       LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
       LEFT JOIN tbl_address  ad ON ad.address_id  = j.fk_address_id
       LEFT JOIN tbl_client   cl ON cl.client_id   = j.fk_client_id
      WHERE j.job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!jobRows || jobRows.length === 0) {
    throw { status: 404, code: 'JOB_NOT_FOUND', message: 'Order not found' };
  }
  const row = jobRows[0];

  // Build the city query based on schema probe.
  const hasFlag = await cityHasIsActive(pool);
  const citySql = hasFlag
    ? 'SELECT city_id, city_name FROM tbl_city WHERE is_active = 1 ORDER BY city_name ASC'
    : 'SELECT city_id, city_name FROM tbl_city ORDER BY city_name ASC LIMIT 500';

  const [cityResult, serviceResult, imageResult] = await Promise.all([
    pool.query(citySql),
    pool.query(
      `SELECT cs.client_service_id, cs.service_type_id, cs.service_catg_id,
              cs.charge_type, st.service_type_name, sc.service_catg_name
         FROM tbl_client_service cs
         LEFT JOIN tbl_service_type st ON st.service_type_id = cs.service_type_id
         LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = cs.service_catg_id
        WHERE cs.client_id = ? AND cs.service_status = 1
        ORDER BY st.service_type_name ASC
        LIMIT 1000`,
      [row.fk_client_id],
    ),
    pool.query(
      `SELECT image_id, image
         FROM tbl_job_image
        WHERE job_id = ?
        ORDER BY image_id ASC`,
      [jobId],
    ),
  ]);

  const cityRows    = cityResult[0]    || [];
  const serviceRows = serviceResult[0] || [];
  const imageRows   = imageResult[0]   || [];

  // Previously-submitted picks (2026-05-28 fix): the FE seeds its picker
  // from this list on round-2 visits to the magic link. Without it, a
  // returning customer's form starts empty, and the next submit's
  // bidirectional reconcile would soft-delete every active row (data loss).
  //
  // tbl_job_services stores `service_id` = service_type_id (see the INSERT
  // in acceptSubmission below, ~line 580), NOT the client_service_id the
  // FE picker is keyed on. We reverse-resolve by joining back to
  // tbl_client_service on service_type_id under THIS job's client — the
  // same client scope the rate-card query above uses. If a previously-
  // active row no longer maps to a live rate-card row (e.g. ops retired
  // that client_service entry), we omit it from the seed; the FE simply
  // doesn't re-tick it, which is the safest behaviour.
  const [selectedRows] = await pool.query(
    `SELECT cs.client_service_id, js.quantity
       FROM tbl_job_services js
       JOIN tbl_client_service cs
         ON cs.service_type_id = js.service_id
        AND cs.client_id       = ?
        AND cs.service_status  = 1
      WHERE js.job_id = ?
        AND js.job_service_status = 1`,
    [row.fk_client_id, jobId],
  );

  return {
    jobId,
    customer: {
      name:   row.customer_name   || '',
      mobile: row.customer_mob_no || '',
      email:  row.customer_email  || '',
    },
    address: {
      address:             row.address || '',
      building:            row.building || '',
      landmark:            row.landmark || '',
      city_id:             row.city_id || null,
      pin_code:            row.pin_code || '',
      gps_location:        row.gps_location || '',
      address_instruction: row.address_instruction || '',
    },
    schedule: {
      requested_date_time: row.requested_date_time,
      time_slot:           row.time_slot || '',
    },
    jobDesc: row.job_desc || '',
    additional: {
      name:   row.additional_name   || '',
      number: row.additional_number || '',
    },
    client: {
      id:   row.fk_client_id,
      name: row.client_name || '',
    },
    cityOptions: cityRows.map((c) => ({ value: c.city_id, label: c.city_name })),
    timeSlots: TIME_SLOTS,
    services: serviceRows.map((s) => ({
      client_service_id:  s.client_service_id,
      service_type_id:    s.service_type_id,
      service_catg_id:    s.service_catg_id,
      charge_type:        s.charge_type,
      service_type_name:  s.service_type_name || '',
      service_catg_name:  s.service_catg_name || '',
    })),
    // FE contract: round-2 picker seed. Empty array when the customer
    // hasn't submitted yet. Keys MUST stay exactly client_service_id +
    // quantity — the FE keys its Map by client_service_id.
    selectedServices: selectedRows.map((s) => ({
      client_service_id: s.client_service_id,
      quantity:          s.quantity,
    })),
    images: imageRows.map((i) => ({
      image_id: i.image_id,
      key:      i.image,
    })),
  };
}

/**
 * Fire the WhatsApp send + audit the attempt on tbl_job.
 *
 * Race-safe send-cap enforcement (2026-05-28):
 *   The 3-send cap is enforced by a SINGLE atomic UPDATE that increments
 *   send_count only while it's < 3. Concurrent senders (cron + manual
 *   click, rapid double-click) cannot bypass the cap — InnoDB row locks
 *   serialise the UPDATE, and the loser sees affectedRows=0 and gets a
 *   429 SEND_LIMIT_REACHED back. See the inline comment in sendForJob.
 *
 *   Increment happens BEFORE the provider call so two callers can't each
 *   reserve send #3. If the provider rejects (delivered:false) or throws,
 *   we decrement the slot via another atomic UPDATE — failed attempts
 *   don't burn a slot, but in-flight reservations always do.
 *
 * Action coercion:
 *   Defensive: if caller passes 'first' but a link was already sent, we
 *   coerce to 'resend'. The admin route already does this in the route
 *   handler — duplicating here keeps the service self-consistent for any
 *   future caller (webhook re-trigger, ops CLI, etc.).
 */
async function sendForJob(jobId, { action } = {}, pool) {
  const [rows] = await pool.query(
    `SELECT j.job_id, j.fk_client_id, j.magic_link_sent_at, j.magic_link_send_count,
            cu.customer_name, cu.customer_mob_no, cl.client_name
       FROM tbl_job j
       LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
       LEFT JOIN tbl_client   cl ON cl.client_id   = j.fk_client_id
      WHERE j.job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!rows || rows.length === 0) {
    throw { status: 404, code: 'JOB_NOT_FOUND', message: 'Order not found' };
  }
  const row = rows[0];

  let effectiveAction = action || 'first';
  if (effectiveAction === 'first' && row.magic_link_sent_at != null) {
    effectiveAction = 'resend';
  }

  const token = signJobToken({ jobId });
  const url   = magicLinkUrl(token);

  /*
   * Race-safety: do the 3-send cap check + increment in a SINGLE atomic
   * UPDATE before calling the WhatsApp provider.
   *
   * Why this order:
   *   - Two concurrent senders (cron + manual click, double-click) would
   *     race a read-then-write pattern: both read send_count=2, both pass
   *     the `< 3` cap check, both send, send_count ends at 4. Bypass.
   *   - A single UPDATE … WHERE magic_link_send_count < 3 is atomic in
   *     MySQL (InnoDB row lock). If the row was already at 3, affectedRows
   *     comes back as 0 and we throw SEND_LIMIT_REACHED. No double-send.
   *
   * Why BEFORE the provider call:
   *   - Reserving the slot first prevents two callers from each thinking
   *     they own send #3. If Meta then fails, we DECREMENT the slot
   *     (single atomic UPDATE) so the slot isn't permanently burned.
   *   - Trade-off: if the process crashes between increment and Meta
   *     response, one slot is lost. Acceptable — the cap is 3 attempts,
   *     not 3 deliveries, and a hard crash mid-call is rare enough to
   *     beat the double-send risk we'd otherwise inherit.
   */
  const sentAt = new Date();
  const [reserveResult] = await pool.query(
    `UPDATE tbl_job
        SET magic_link_send_count   = magic_link_send_count + 1,
            magic_link_sent_at      = ?,
            magic_link_last_action  = ?
      WHERE job_id = ?
        AND magic_link_send_count < 3`,
    [sentAt, effectiveAction, jobId],
  );
  if (!reserveResult || reserveResult.affectedRows === 0) {
    throw { status: 429, code: 'SEND_LIMIT_REACHED', message: 'Send limit reached' };
  }

  let response;
  try {
    response = await whatsappService.sendTemplate({
      to: row.customer_mob_no,
      recipientName: row.customer_name || '',
      templateName: 'confirm_order',
      bodyValues: {
        1: row.customer_name || 'there',
        2: row.client_name   || '',
        3: url,
      },
    });
  } catch (err) {
    // Provider threw — roll back the reserved slot so it isn't burned.
    // Single atomic UPDATE keeps this race-safe even if a parallel send
    // is incrementing concurrently.
    await pool.query(
      `UPDATE tbl_job
          SET magic_link_send_count = magic_link_send_count - 1
        WHERE job_id = ?
          AND magic_link_send_count > 0`,
      [jobId],
    );
    throw err;
  }

  if (!response.delivered) {
    // Send did not deliver — release the reserved slot so retries can
    // still happen within the 3-attempt cap. Single atomic UPDATE.
    logger.warn(
      { jobId, action: effectiveAction, error: response.error, disabled: response.disabled },
      'magic-link: WhatsApp send did not deliver — releasing reserved slot',
    );
    await pool.query(
      `UPDATE tbl_job
          SET magic_link_send_count = magic_link_send_count - 1
        WHERE job_id = ?
          AND magic_link_send_count > 0`,
      [jobId],
    );
    return {
      delivered:           false,
      error:               response.error || null,
      disabled:            !!response.disabled,
      token,
      url,
      action:              effectiveAction,
      send_count:          row.magic_link_send_count || 0,
      magic_link_sent_at:  sentAt.toISOString(),
    };
  }

  return {
    delivered:           true,
    error:               null,
    token,
    url,
    action:              effectiveAction,
    send_count:          (row.magic_link_send_count || 0) + 1,
    magic_link_sent_at:  sentAt.toISOString(),
  };
}

/**
 * Commit the customer's submitted details for an unconfirmed order.
 *
 * Transactional because the write touches FOUR tables:
 *   tbl_job        — audit columns + job_desc + schedule + additional_*
 *   tbl_customer   — name/email (mirrored so CRM list views stay coherent)
 *   tbl_address    — full address re-write on the existing address_id
 *   tbl_job_services — upsert customer's service picks
 *
 * If any step fails, ALL must roll back; a half-applied submission would
 * leave the magic-link surface in an inconsistent state and confuse ops.
 *
 * Service-upsert policy (mirrors the ops Confirm-modal soft-delete pattern
 * at services/job.service.js:1443-1496, with one critical divergence):
 *   - Bidirectional: ACTIVE rows the customer drops on resubmit are
 *     soft-deleted (status=0). Picks the customer adds get UPDATE-or-
 *     INSERT semantics.
 *   - We do NOT resurrect soft-deleted rows. Ops may have pruned a row
 *     for a real reason; silently flipping it back to active because the
 *     customer re-ticked the box would undo that decision. So a re-pick
 *     against a soft-deleted history INSERTS a fresh row instead, leaving
 *     the old audit row visibly status=0.
 *
 * Customer picks send `client_service_id` (rate-card row id) — we resolve
 * each to the underlying service_type_id / service_catg_id via a single
 * lookup before insert. This mirrors the existing create() flow in
 * services/job.service.js (~line 1197): `service_id` on tbl_job_services
 * is the service_type_id.
 */
async function acceptSubmission(jobId, payload, pool) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Read the job's address FK + customer FK + client FK so we know what to
    //    update. fk_client_id is captured here so the service-id reconciliation
    //    block below can scope every tbl_client_service lookup to THIS job's
    //    client, preventing a hostile customer from injecting client_service_ids
    //    belonging to OTHER clients into tbl_job_services.
    const [jobRows] = await conn.query(
      'SELECT fk_address_id, fk_customer_id, fk_client_id FROM tbl_job WHERE job_id = ? LIMIT 1',
      [jobId],
    );
    if (!jobRows || jobRows.length === 0) {
      throw { status: 404, code: 'JOB_NOT_FOUND', message: 'Order not found' };
    }
    const {
      fk_address_id: addressId,
      fk_customer_id: customerId,
      fk_client_id:   clientId,
    } = jobRows[0];

    // 2. Audit + schedule + job-level fields on tbl_job.
    //    job_desc only overwrites when payload supplies a non-empty value
    //    (COALESCE on NULL preserves the existing value).
    //
    //    customer_name handling (2026-05-28 fix): the customer-supplied
    //    name is stored on tbl_job.job_customer_name — a job-row copy of
    //    the display name (see MUTABLE_COLUMNS comment in
    //    services/job.service.js ~line 1277). We intentionally do NOT
    //    write back to tbl_customer.customer_name because that would
    //    mutate the master row and bleed the new name into every OTHER
    //    job the same mobile is bound to. Audit isn't lost — the full
    //    customer-supplied name is preserved in customer_submitted_payload
    //    JSON below.
    const submittedAt = new Date();
    await conn.query(
      `UPDATE tbl_job
          SET customer_submitted_at      = ?,
              customer_submitted_payload = ?,
              requested_date_time        = COALESCE(?, requested_date_time),
              time_slot                  = COALESCE(?, time_slot),
              additional_name            = COALESCE(?, additional_name),
              additional_number          = COALESCE(?, additional_number),
              job_desc                   = COALESCE(?, job_desc),
              job_customer_name          = COALESCE(?, job_customer_name),
              last_update_time           = ?
        WHERE job_id = ?`,
      [
        submittedAt,
        JSON.stringify(payload),
        payload.requested_date_time || null,
        payload.time_slot || null,
        payload.additional_name || null,
        payload.additional_number || null,
        (payload.job_desc && String(payload.job_desc).trim()) ? payload.job_desc : null,
        (payload.customer_name && String(payload.customer_name).trim()) ? payload.customer_name : null,
        submittedAt,
        jobId,
      ],
    );

    // 3. Mirror customer email onto tbl_customer (identity-level field —
    //    same email belongs to the same person across all their jobs, so
    //    mirroring is correct here unlike customer_name, which is job-
    //    scoped via job_customer_name above). Only writes when supplied
    //    and only when we have a customer_id — defensive against orphan
    //    job rows; the legacy data has a few.
    if (customerId && payload.customer_email) {
      await conn.query(
        `UPDATE tbl_customer
            SET customer_email = COALESCE(?, customer_email)
          WHERE customer_id = ?`,
        [
          payload.customer_email || null,
          customerId,
        ],
      );
    }

    // 4. Full address overwrite. Address is bound 1:1 to the job's
    //    customer-on-create, so updating in place is correct — we are
    //    NOT mutating a shared address that other jobs reference.
    //
    //    Payload shape (2026-05-28 fix): the Joi validator declares `address`
    //    as a FLAT string and `building`, `landmark`, `city_id`, `pin_code`,
    //    `gps_location`, `address_instruction` as SIBLING top-level keys
    //    (see validators/job-magic-link.validator.js). The FE submits the
    //    same flat shape. Previous code read these as a nested object
    //    (`payload.address.building`, etc.) which evaluated to `undefined`
    //    on every sibling — the COALESCE then preserved existing values
    //    and the customer's address never persisted. Reading flat fixes it.
    //
    //    Empty strings (Joi allows `''` for the optional siblings) collapse
    //    to NULL so COALESCE keeps the existing column value rather than
    //    blanking out a building/landmark ops had set earlier.
    const addressLine = payload.address ?? null;
    const building    = payload.building && String(payload.building).length     ? payload.building     : null;
    const landmark    = payload.landmark && String(payload.landmark).length     ? payload.landmark     : null;
    const cityId      = payload.city_id ?? null;
    const pinCode     = payload.pin_code ?? null;
    const gps         = payload.gps_location && String(payload.gps_location).length ? payload.gps_location : null;
    const addrInstr   = payload.address_instruction && String(payload.address_instruction).length ? payload.address_instruction : null;

    if (addressId && addressLine) {
      await conn.query(
        `UPDATE tbl_address
            SET address             = COALESCE(?, address),
                building            = COALESCE(?, building),
                landmark            = COALESCE(?, landmark),
                city_id             = COALESCE(?, city_id),
                pin_code            = COALESCE(?, pin_code),
                gps_location        = COALESCE(?, gps_location),
                address_instruction = COALESCE(?, address_instruction)
          WHERE address_id = ?`,
        [
          addressLine,
          building,
          landmark,
          cityId,
          pinCode,
          gps,
          addrInstr,
          addressId,
        ],
      );
    }

    // 5. Service upsert — bidirectional reconciliation of the customer's
    //    submitted set against the existing ACTIVE rows.
    //
    //    Bug fix 2026-05-28: previous version was one-way additive — it
    //    upserted picks the customer kept but NEVER deactivated picks
    //    the customer removed on resubmit. Billing risk: customer first
    //    submits [A, B], then resubmits [A], B stayed active.
    //
    //    Pattern mirrors services/job.service.js:1443-1496 (ops Confirm
    //    modal soft-delete pattern), with ONE deliberate divergence: we
    //    do NOT mass-soft-delete-then-reactivate. Ops may have previously
    //    pruned a row to status=0 for a real reason; silently resurrecting
    //    it because the customer happened to re-tick the same box would
    //    undo that decision. So:
    //
    //      • For ACTIVE rows whose service_type_id is NOT in the customer's
    //        submitted set → soft-delete (status=0). These are the picks
    //        the customer dropped.
    //      • For ACTIVE rows whose service_type_id IS in the submitted
    //        set → UPDATE in place (refresh quantity).
    //      • For service_type_ids in the submitted set with NO existing
    //        row at all → INSERT fresh.
    //      • For service_type_ids in the submitted set whose only
    //        existing row is soft-deleted → INSERT a fresh row (do NOT
    //        reactivate). Preserves the audit trail of the ops removal
    //        and clearly marks this as a customer-submitted re-entry.
    //
    //    All writes happen inside the existing transaction (`conn`) so
    //    partial failures roll back cleanly.
    if (Array.isArray(payload.services)) {
      // a) Resolve every submitted client_service_id to its underlying
      //    service_type_id / service_catg_id. Dedupe by service_type_id
      //    in case the customer's picks collapse onto the same type.
      const resolved = new Map(); // service_type_id -> { service_catg_id, quantity }
      for (const pick of payload.services) {
        const csId = pick.client_service_id;
        if (!csId) continue;
        // SECURITY (2026-05-28 fix): scope the lookup to THIS job's client.
        // Without the `AND client_id = ?` filter, a hostile customer holding
        // a valid magic-link token for job-100 (client A) could POST
        // client_service_ids belonging to clients B / C / D and have them
        // resolved + inserted into tbl_job_services — billing data
        // integrity risk. Mismatched IDs are silently DROPPED (logged at
        // warn) rather than thrown — a stale or wrong ID submitted by the
        // customer shouldn't block their entire submission.
        const [csRows] = await conn.query(
          `SELECT service_type_id, service_catg_id
             FROM tbl_client_service
            WHERE client_service_id = ? AND client_id = ? LIMIT 1`,
          [csId, clientId],
        );
        if (!csRows || csRows.length === 0) {
          logger.warn(
            { jobId, clientId, client_service_id: csId },
            'magic-link: dropping client_service_id that does not belong to job\'s client (possible cross-client injection or stale picker state)',
          );
          continue;
        }
        const serviceTypeId = csRows[0].service_type_id;
        if (serviceTypeId == null) continue;
        const quantity = pick.quantity || 1;
        // If the same type appears twice in the payload, keep the highest
        // quantity — defensive against malformed clients.
        const prev = resolved.get(serviceTypeId);
        if (!prev || (quantity > prev.quantity)) {
          resolved.set(serviceTypeId, {
            service_catg_id: csRows[0].service_catg_id,
            quantity,
          });
        }
      }

      // b) Read current rows (active + soft-deleted) so we can classify.
      const [existing] = await conn.query(
        `SELECT job_service_id, service_id, job_service_status
           FROM tbl_job_services
          WHERE job_id = ?`,
        [jobId],
      );
      const activeByService = new Map();
      const softDeletedTypes = new Set();
      for (const r of existing) {
        if (Number(r.job_service_status) === 1) {
          activeByService.set(r.service_id, r.job_service_id);
        } else {
          softDeletedTypes.add(r.service_id);
        }
      }

      // c) Soft-delete any ACTIVE row whose service_type_id is NOT in the
      //    customer's submitted set. This is the missing direction that
      //    caused the billing leak.
      for (const [serviceTypeId, jobServiceId] of activeByService.entries()) {
        if (!resolved.has(serviceTypeId)) {
          await conn.query(
            `UPDATE tbl_job_services
                SET job_service_status = 0
              WHERE job_service_id = ?`,
            [jobServiceId],
          );
        }
      }

      // d) Apply each submitted pick: UPDATE active row, or INSERT fresh
      //    (never resurrect a soft-deleted ops removal).
      for (const [serviceTypeId, info] of resolved.entries()) {
        const activeId = activeByService.get(serviceTypeId);
        if (activeId) {
          // Active row already exists — refresh quantity, keep status=1.
          await conn.query(
            `UPDATE tbl_job_services
                SET quantity            = ?,
                    job_service_status  = 1,
                    service_type_id     = ?,
                    service_category_id = ?
              WHERE job_service_id = ?`,
            [info.quantity, serviceTypeId, info.service_catg_id, activeId],
          );
        } else {
          // No active row. Either soft-deleted history exists (refuse to
          // resurrect — per ops policy) or no row at all. INSERT either
          // way to preserve the soft-deleted audit history alongside the
          // fresh customer-submitted row.
          await conn.query(
            `INSERT INTO tbl_job_services
               (job_id, service_id, quantity, service_type_id, service_category_id, job_service_status)
             VALUES (?, ?, ?, ?, ?, 1)`,
            [jobId, serviceTypeId, info.quantity, serviceTypeId, info.service_catg_id],
          );
          if (softDeletedTypes.has(serviceTypeId)) {
            logger.info(
              { jobId, serviceTypeId },
              'magic-link: customer re-submitted a previously ops-removed service — inserting fresh row, not resurrecting soft-deleted history',
            );
          }
        }
      }
    }

    await conn.commit();

    return {
      ok: true,
      jobId,
      customer_submitted_at: submittedAt.toISOString(),
    };
  } catch (err) {
    try { await conn.rollback(); } catch (_e) { /* connection already gone */ }
    // Re-throw shaped errors verbatim (they carry status/code already);
    // wrap unknown errors with a 500 envelope for the public route layer.
    if (err && err.status) throw err;
    throw { status: 500, message: err && err.message ? err.message : 'submission failed' };
  } finally {
    conn.release();
  }
}

module.exports = {
  fetchPrefill,
  sendForJob,
  acceptSubmission,
};
