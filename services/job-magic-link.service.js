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
const urlShortener     = require('./url-shortener.service');
const { maskMobile }   = require('../utils/mask-mobile');
const s3Storage        = require('../utils/s3-storage');
const logger           = require('../logger');

/*
 * Best-effort short-TTL presigned GET for a customer-uploaded media key.
 * Returns null (not throw) on empty key or presign failure so a single bad
 * key never 500s the whole magic-link load — the FE degrades to a placeholder
 * tile for that item. The public route group is designed for exactly these
 * unauthenticated, time-limited URLs.
 */
async function presignMediaKey(key) {
  if (!key) return null;
  try { return await s3Storage.getPresignedUrl(key); }
  catch (e) { logger.warn({ err: e.message, key }, 'magic-link: media presign failed'); return null; }
}

/**
 * Customer-request reason lists — DYNAMIC from action_taken_reason.
 *
 * Ops created dedicated magic-link customer action_types (2026-07-09):
 *   action_type 39 = Cancel, 38 = Reschedule; both user_type = 2, status = 1.
 * The prefill returns these lists AND the submit routes validate the chosen
 * text against the SAME query (getCancelReasons / getRescheduleReasons), so
 * the FE dropdown options and the server-side allowlist can never drift. The
 * deprecated per-type tables (tbl_cancel_reason / reschedule_reason_app) are
 * no longer used for the magic-link flow.
 */
const MAGIC_LINK_REASON = Object.freeze({ cancel: 39, reschedule: 38 });
const MAGIC_LINK_REASON_USER_TYPE = 2;

async function fetchReasonList(pool, actionType) {
  try {
    const [rows] = await pool.query(
      `SELECT action_desc FROM action_taken_reason
        WHERE action_type = ? AND user_type = ? AND status = 1
        ORDER BY id ASC`,
      [actionType, MAGIC_LINK_REASON_USER_TYPE],
    );
    return rows.map((r) => r.action_desc).filter(Boolean);
  } catch (err) {
    // Fail-soft: a reason-list read must never break the whole prefill page.
    logger.warn('Magic-link reason list fetch failed · actionType=' + actionType + ' · ' + (err && err.message ? err.message : err));
    return [];
  }
}
async function getCancelReasons(pool)     { return fetchReasonList(pool, MAGIC_LINK_REASON.cancel); }
async function getRescheduleReasons(pool) { return fetchReasonList(pool, MAGIC_LINK_REASON.reschedule); }

/* ─── Client custom-property helpers (shared by prefill + submit) ─────────
 *
 * tbl_client_custom_properties is an overloaded key/value table. Some rows are
 * OPERATOR CONFIG (auto-send gate, send-cap, collected-by preference) — those
 * must NEVER render on the customer-facing form nor be enforced as "mandatory"
 * against a customer submission. Everything else is a customer-facing field.
 *
 * Three keys are CANONICAL — they have dedicated tbl_job columns + dedicated
 * top-level submit-payload keys (the CRM Book-New-Call flow uses the same
 * three). Every OTHER customer-facing field travels in the submit payload's
 * `custom_properties` map and is persisted only inside the
 * customer_submitted_payload JSON snapshot (no schema change needed).
 */
const CONFIG_PROP_KEYS = Object.freeze(new Set([
  'auto_process_unconfirmed_order',
  'max_magic_link_send_count',
  'collected_by',
]));

// Raw prop name → canonical key (dedicated tbl_job column + top-level payload key).
const CANONICAL_PROP_ALIASES = Object.freeze({
  branch: 'branch_details', branch_details: 'branch_details',
  building: 'building_name', building_name: 'building_name',
  property: 'building_name', property_name: 'building_name',
  sku: 'product_code', product_code: 'product_code',
});

// Collapse to lowercase a-z0-9 single-underscore so "Max Magic-Link Send Count",
// "max_magic_link_send_count", "max magic link send count" all compare equal.
function normalizePropKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/*
 * Built-in field aliases. A client may have a custom-property row whose name
 * duplicates a field the form ALREADY collects in a dedicated input (most
 * commonly "Pin Code", but also City / Address / Email / Alternate contact /
 * etc.). Rendering it again as a generic custom field is redundant and
 * confusing (see the "Pin Code" dup under Additional Details). We therefore:
 *   - strip these from the prefill's custom_properties so the FE never renders
 *     a second input, AND
 *   - still enforce a `mandatory` flag by reading the value from the matching
 *     BUILT-IN payload field (so e.g. a mandatory "Landmark" custom prop is
 *     satisfied by the address-section Landmark field).
 * The map value is the submit-payload key the value lives under. `__on_file`
 * is a sentinel for the customer's mobile, which is resolved server-side and
 * is always present (the link can't be sent without it) — so it's always
 * considered satisfied. NOTE: "building"/"property" intentionally map to the
 * CANONICAL building_name custom prop (a property/building NAME), NOT the
 * address-section "Building / Floor" field — they are different data.
 */
const BUILTIN_ALIAS_TO_PAYLOAD = Object.freeze({
  pin_code: 'pin_code', pincode: 'pin_code', pin: 'pin_code', zip: 'pin_code',
  zipcode: 'pin_code', postal_code: 'pin_code', postalcode: 'pin_code',
  city: 'city_id', town: 'city_id', city_name: 'city_id',
  address: 'address', complete_address: 'address', full_address: 'address',
  landmark: 'landmark',
  gps: 'gps_location', gps_location: 'gps_location', location: 'gps_location',
  coordinates: 'gps_location', lat_lng: 'gps_location', latlng: 'gps_location',
  lat_long: 'gps_location', gps_coordinates: 'gps_location',
  email: 'customer_email', customer_email: 'customer_email', e_mail: 'customer_email', mail: 'customer_email',
  customer_name: 'customer_name', name: 'customer_name', full_name: 'customer_name', cust_name: 'customer_name',
  alternate_name: 'additional_name', additional_name: 'additional_name',
  alt_name: 'additional_name', alternate_contact_name: 'additional_name',
  alternate_number: 'additional_number', additional_number: 'additional_number',
  alt_number: 'additional_number', secondary_number: 'additional_number',
  alternate_contact_number: 'additional_number', alternate_mobile: 'additional_number',
  address_instruction: 'address_instruction', address_instructions: 'address_instruction',
  instructions: 'address_instruction', landing_notes: 'address_instruction', delivery_instructions: 'address_instruction',
  mobile: '__on_file', phone: '__on_file', mobile_no: '__on_file', mobile_number: '__on_file',
  phone_number: '__on_file', contact: '__on_file', contact_number: '__on_file', customer_mobile: '__on_file',
});

// True when a prop name duplicates a built-in form field (so it should not be
// rendered as a separate generic custom input).
function isBuiltinAliasProp(name) {
  return Object.prototype.hasOwnProperty.call(BUILTIN_ALIAS_TO_PAYLOAD, normalizePropKey(name));
}

function propFlagTruthy(val) {
  if (val == null) return false;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  const s = String(val).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

// "branch_details" → "Branch Details" (fallback label when the client set none).
function prettyPropName(name) {
  return String(name || '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/*
 * Normalise raw tbl_client_custom_properties rows across the legacy column-name
 * drift into { name, mandatory, label, value } (name lower-cased + trimmed),
 * filtering out the operator-config rows. Mirrors routes/admin/clients.js
 * GET /:clientId/custom-properties EXACTLY — including the legacy
 * `c_prop_mandatory` flag, which the earlier inline prefill normalisation
 * dropped (so a legacy-schema client's mandatory flag was silently ignored).
 */
function normaliseCustomPropRows(rows) {
  return (rows || [])
    .map((r) => ({
      name: String(
        r.property_name ?? r.c_prop_name ?? r.name ?? r.key ?? r.field_name ?? ''
      ).toLowerCase().trim(),
      mandatory: propFlagTruthy(
        r.is_mandatory ?? r.c_prop_mandatory ?? r.mandatory ?? r.required ?? r.is_required ?? r.is_required_field
      ),
      label: r.property_label ?? r.c_prop_label ?? r.label ?? r.display_name ?? null,
      value: r.property_value ?? r.c_prop_values ?? r.value ?? r.field_value ?? null,
    }))
    .filter((p) => p.name && !CONFIG_PROP_KEYS.has(normalizePropKey(p.name)));
}

// Load + normalise a client's CUSTOMER-FACING custom properties (config rows
// already stripped). Same status filter as the prefill query.
async function loadCustomerFacingProps(clientId, pool) {
  if (!clientId) return [];
  const [rows] = await pool.query(
    `SELECT * FROM tbl_client_custom_properties
      WHERE client_id = ? AND (status IS NULL OR status = 1)`,
    [clientId],
  );
  return normaliseCustomPropRows(rows);
}

// Resolve the value the customer submitted for a given prop. Canonical props
// arrive as top-level payload keys; everything else lives in the
// `custom_properties` map (matched case-insensitively to tolerate FE casing).
function resolveSubmittedPropValue(prop, payload) {
  const canonical = CANONICAL_PROP_ALIASES[prop.name];
  if (canonical) {
    const v = payload[canonical];
    return v == null ? '' : String(v).trim();
  }
  // Built-in-alias props (e.g. "Pin Code") aren't rendered as a separate input
  // — their value lives in the matching built-in payload field. The customer's
  // mobile is server-resolved and always on file, so treat it as satisfied.
  const builtin = BUILTIN_ALIAS_TO_PAYLOAD[normalizePropKey(prop.name)];
  if (builtin) {
    if (builtin === '__on_file') return 'on-file';
    const v = payload[builtin];
    return v == null ? '' : String(v).trim();
  }
  const map = (payload && payload.custom_properties) || {};
  let v = map[prop.name];
  if (v == null) {
    const hit = Object.keys(map).find((k) => k.toLowerCase().trim() === prop.name);
    if (hit != null) v = map[hit];
  }
  return v == null ? '' : String(v).trim();
}

/*
 * Server-side enforcement of mandatory client custom properties — belt-and-
 * braces over the FE gate. Throws a 400 (mapped by mapKnownError in the public
 * route) listing the missing field labels so a tampered or older client that
 * skips a required field is rejected before any DB write happens.
 */
async function enforceMandatoryCustomProps(jobId, payload, pool) {
  const [[job]] = await pool.query(
    'SELECT fk_client_id FROM tbl_job WHERE job_id = ? LIMIT 1',
    [jobId],
  );
  if (!job) return; // acceptSubmission's own 404 covers the missing-job case
  const props = await loadCustomerFacingProps(job.fk_client_id, pool);
  const missing = props
    .filter((p) => p.mandatory && !resolveSubmittedPropValue(p, payload))
    .map((p) => p.label || prettyPropName(p.name));
  if (missing.length) {
    throw {
      status: 400,
      code: 'MANDATORY_CUSTOM_PROP_MISSING',
      message: `Please fill the required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
    };
  }
}

/**
 * Human label for a numeric tbl_job.job_status.
 *
 * No shared label helper is exported from services/job.service.js (it only
 * exports the STATUS code map), so we inline a small map here covering the
 * codes the customer-facing surface can encounter. Status 9 (CALL_LATER /
 * UNCONFIRMED alias) renders as "Unconfirmed" — the customer-facing name.
 * Unknown codes fall back to "Order" so the FE never renders a bare number.
 */
const ORDER_STATUS_LABELS = Object.freeze({
  0:  'Booked',
  1:  'Scheduled',
  2:  'In Progress',
  3:  'Completed',
  5:  'Completed',
  6:  'Cancelled',
  7:  'Enquiry',
  9:  'Unconfirmed',
  10: 'Revisit',
});
function orderStatusLabel(status) {
  const code = Number(status);
  return ORDER_STATUS_LABELS[code] || 'Order';
}

/**
 * Resolve the client's PRIMARY internal EasyFix SPOC for a job.
 *
 * The Primary SPOC is the tbl_vertical_mapping row with user_type=1 for the
 * job's client (Secondary=2 — see services/client-verticals.service.js and
 * project memory "Manage Clients flow"). Joined to tbl_user for the display
 * name + mobile. Column-name landmines confirmed against
 * client-verticals.service.js: tbl_user uses single `user_name` + mobile on
 * `mobile_no`.
 *
 * Returns { name: string|null, mobile: string|null, user_id: number|null }.
 * `mobile` is the RAW mobile and `user_id` is the vm.user_id (tbl_user PK).
 * Callers decide whether to mask: fetchPrefill masks it before returning to
 * the client; the spoc-call route uses it raw to bridge the Kaleyra call
 * (the real number is NEVER shipped to the client) AND stamps user_id as
 * the reciever_id on the tbl_job_caller_info audit row.
 *
 * Schema-drift safe: if tbl_vertical_mapping lacks user_type on this deploy,
 * we cannot identify a Primary specifically — return nulls rather than guess.
 * LEFT JOIN + null-tolerant so a missing user row degrades to nulls.
 */
async function resolveJobSpoc(jobId, pool) {
  const [rows] = await pool.query(
    `SELECT vm.user_id AS spoc_user_id, u.user_name AS spoc_name, u.mobile_no AS spoc_mobile
       FROM tbl_job j
       JOIN tbl_vertical_mapping vm ON vm.client_id = j.fk_client_id AND vm.user_type = 1
       LEFT JOIN tbl_user u         ON u.user_id    = vm.user_id
      WHERE j.job_id = ?
      ORDER BY vm.user_id ASC
      LIMIT 1`,
    [jobId],
  ).catch((e) => {
    // user_type column absent on this deploy (older schema) → can't pick a
    // Primary. Treat as "no SPOC mapped" rather than 500 the public surface.
    logger.warn({ jobId, err: e && e.message }, 'magic-link: SPOC lookup failed — treating as no SPOC');
    return [[]];
  });
  const row = rows && rows[0];
  if (!row) return { name: null, mobile: null, user_id: null };
  return {
    name:    row.spoc_name   || null,
    mobile:  row.spoc_mobile || null,
    user_id: row.spoc_user_id != null ? Number(row.spoc_user_id) : null,
  };
}

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
  return `${base.replace(/\/$/, '')}/public/job-completion/${token}`;
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
 * Probe whether tbl_address has an address_instruction column.
 *
 * Same drift story as cityHasIsActive — `address_instruction` exists on
 * the EasyFix QA snapshot taken 2026-05-28 but is absent on older
 * deploys (verified 2026-05-31 when fetchPrefill 500'd with
 * "Unknown column 'ad.address_instruction' in 'field list'"). When
 * absent, fetchPrefill returns it as NULL (so the FE form just shows
 * an empty Address Instructions field) and acceptSubmission omits the
 * column from the UPDATE SET clause (so customer-supplied instructions
 * are silently dropped — degraded but non-crashing).
 *
 * If/when ops backfills the column on every environment, the probe
 * returns true everywhere and behaviour upgrades automatically.
 */
let _addrInstrProbed = false;
let _addrHasInstruction = false;
async function addressHasInstruction(pool) {
  if (_addrInstrProbed) return _addrHasInstruction;
  try {
    await pool.query('SELECT address_instruction FROM tbl_address LIMIT 1');
    _addrHasInstruction = true;
  } catch (_e) {
    _addrHasInstruction = false;
  }
  _addrInstrProbed = true;
  return _addrHasInstruction;
}

/**
 * Probe whether tbl_job has the three Book-New-Call custom-prop columns.
 *
 * Per services/job.service.js (~line 1023): `branch_details` is the only
 * column verified to exist on the prod schema. `product_code` and
 * `building_name` are conceptually-named fields that DON'T exist as
 * columns on most deploys; the create flow folds them into `remarks`.
 *
 * For the magic-link submission path we conservatively probe each column
 * separately and only write the ones that exist. When a column is
 * absent, the customer-supplied value is silently dropped from the
 * UPDATE — degraded but non-crashing, mirroring `addressHasInstruction`.
 * Memoised after first call.
 */
let _jobColsProbed = false;
const _jobCols = { branch_details: false, building_name: false, product_code: false };
async function jobHasColumn(pool, col) {
  if (_jobColsProbed) return _jobCols[col];
  for (const c of Object.keys(_jobCols)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`SELECT \`${c}\` FROM tbl_job LIMIT 1`);
      _jobCols[c] = true;
    } catch (_e) {
      _jobCols[c] = false;
    }
  }
  _jobColsProbed = true;
  return _jobCols[col];
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
  logger.info('Build magic-link prefill · jobId=' + jobId);
  // Schema-drift gate: older deploys lack tbl_address.address_instruction.
  // When absent, project NULL into the same column slot so downstream
  // code doesn't have to branch on its presence.
  const addrHasInstr   = await addressHasInstruction(pool);
  const addrInstrSelect = addrHasInstr
    ? 'ad.address_instruction'
    : 'NULL AS address_instruction';

  const [jobRows] = await pool.query(
    `SELECT j.job_id, j.fk_client_id, j.fk_address_id, j.requested_date_time,
            j.time_slot, j.job_desc, j.additional_name, j.additional_number,
            j.job_status,
            COALESCE(j.job_customer_name, cu.customer_name) AS customer_name,
            cu.customer_mob_no, cu.customer_email,
            ad.address, ad.building, ad.landmark, ad.city_id, ad.pin_code,
            ad.gps_location, ${addrInstrSelect},
            cl.client_name,
            ow.user_name AS owner_name, ow.mobile_no AS owner_mobile
       FROM tbl_job j
       LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
       LEFT JOIN tbl_address  ad ON ad.address_id  = j.fk_address_id
       LEFT JOIN tbl_client   cl ON cl.client_id   = j.fk_client_id
       LEFT JOIN tbl_user     ow ON ow.user_id     = j.job_owner
      WHERE j.job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!jobRows || jobRows.length === 0) {
    throw { status: 404, code: 'JOB_NOT_FOUND', message: 'Order not found' };
  }
  const row = jobRows[0];

  // Server-side prefill fallback: some bookings captured the PIN but not the
  // city FK (tbl_address.city_id NULL). tbl_pincode maps pincode → city_id as
  // a pure-DB lookup, so derive the city when it's missing but a valid 6-digit
  // PIN is present. Best-effort — a lookup miss just leaves the city blank as
  // before. (The reverse, PIN-from-city, isn't possible: a city has many PINs.)
  let derivedCityId = row.city_id || null;
  const rowPin = row.pin_code ? String(row.pin_code).trim() : '';
  if (!derivedCityId && /^\d{6}$/.test(rowPin)) {
    try {
      const [[pcRow]] = await pool.query(
        'SELECT city_id FROM tbl_pincode WHERE pincode = ? AND city_id IS NOT NULL LIMIT 1',
        [rowPin],
      );
      if (pcRow && pcRow.city_id) derivedCityId = pcRow.city_id;
    } catch (e) {
      logger.warn({ err: e.message, jobId, pin: rowPin }, 'magic-link: city-from-pincode derive failed');
    }
  }

  // Build the city query based on schema probe.
  const hasFlag = await cityHasIsActive(pool);
  const citySql = hasFlag
    ? 'SELECT city_id, city_name FROM tbl_city WHERE is_active = 1 ORDER BY city_name ASC'
    : 'SELECT city_id, city_name FROM tbl_city ORDER BY city_name ASC LIMIT 500';

  const [cityResult, serviceResult, imageResult, customPropResult] = await Promise.all([
    pool.query(citySql),
    // Client rate-card services for the picker. Column model (verified
    // against services/client-rate-cards.service.js ~line117 and the legacy
    // ClientDaoImpl.java#666): tbl_client_service carries a SINGULAR
    // `service_type_id` FK + a `rate_card_id` FK. The service-type name and
    // its category both resolve THROUGH `service_type_id` (the row's own
    // `service_catg_id` is unreliable — it's NULL on many client rows, which
    // is why the customer-facing picker previously rendered BLANK names).
    //   - service_type_name : from tbl_service_type via service_type_id
    //   - service_catg_name : from tbl_service_catg via st.service_catg_id
    //                          (the type's category, NOT cs.service_catg_id)
    //   - service_name      : the rate-card display name (crc_ratecard_name)
    //                          via rate_card_id → tbl_client_rate_card. This
    //                          is the friendly per-client label the CRM
    //                          AutoServicesTable shows as the primary line,
    //                          so the public picker can show a real name even
    //                          when service_type_name is generic/null.
    pool.query(
      `SELECT cs.client_service_id, cs.service_type_id, st.service_catg_id,
              cs.charge_type, cs.total_amount,
              st.service_type_name,
              sc.service_catg_name,
              cr.crc_ratecard_name AS service_name
         FROM tbl_client_service cs
         LEFT JOIN tbl_service_type     st ON st.service_type_id = cs.service_type_id
         LEFT JOIN tbl_service_catg     sc ON sc.service_catg_id = st.service_catg_id
         LEFT JOIN tbl_client_rate_card cr ON cr.crc_id          = cs.rate_card_id
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
    // Per-client custom properties (e.g. branch_details / building_name /
    // product_code). The legacy table has loose column naming across
    // deploys — `SELECT *` + a JS fallback chain matches what the admin
    // CRUD endpoint at routes/admin/clients.js does for the CRM Book-New-
    // Call flow. Surfacing the same shape on the public magic-link form
    // lets the FE enforce the same mandatory/visibility rules without
    // duplicating the per-client config.
    //
    // status filter: rows with status=1 (active) are returned; legacy
    // rows with NULL status are also included so older configs that
    // never set the column keep working.
    pool.query(
      `SELECT * FROM tbl_client_custom_properties
        WHERE client_id = ? AND (status IS NULL OR status = 1)`,
      [row.fk_client_id],
    ),
  ]);

  const cityRows       = cityResult[0]       || [];
  const serviceRows    = serviceResult[0]    || [];
  const imageRows      = imageResult[0]      || [];
  const customPropRows = customPropResult[0] || [];
  logger.info('Loaded prefill lookups · services=' + serviceRows.length + ' images=' + imageRows.length + ' cities=' + cityRows.length + ' customProps=' + customPropRows.length);

  // Resolve the client's Primary internal SPOC (user_type=1). The real
  // mobile NEVER leaves the server — we mask it before returning. The
  // spoc-call route re-resolves the raw number server-side to bridge a
  // Kaleyra call. Independent of the secondary lookups above, but cheap
  // enough to run sequentially after them.
  const spoc = await resolveJobSpoc(jobId, pool);

  // Build a Google Maps link. Prefer precise GPS ("lat,lng") when present;
  // else fall back to the URL-encoded address string; else null when we
  // have neither.
  let mapsLink = null;
  const gps = row.gps_location ? String(row.gps_location).trim() : '';
  if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(gps)) {
    mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(gps)}`;
  } else if (row.address && String(row.address).trim()) {
    mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(row.address).trim())}`;
  }

  // Normalise custom-property rows across the legacy column-name drift via the
  // shared helper (see top-of-file normaliseCustomPropRows + the matching
  // routes/admin/clients.js GET /:clientId/custom-properties chain). The helper
  // also strips operator-config rows (auto-process / send-cap / collected_by)
  // so they never render as customer-facing inputs.
  const customProperties = normaliseCustomPropRows(customPropRows);

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

  logger.info('Returning prefill · jobId=' + jobId + ' status=' + (row.job_status != null ? Number(row.job_status) : null) + ' preselectedServices=' + selectedRows.length);

  return {
    jobId,
    // Flat job_id + order-status fields for the expanded Job Completion /
    // Order page header. `order_status` is the numeric tbl_job.job_status;
    // `order_status_label` is the customer-facing human label.
    job_id:             jobId,
    order_status:       row.job_status != null ? Number(row.job_status) : null,
    order_status_label: orderStatusLabel(row.job_status),
    // Flat client_name (also nested under `client` below for back-compat).
    client_name: row.client_name || '',
    // Google Maps link for the order address (GPS-preferred). null when
    // neither GPS nor an address string is available.
    maps_link: mapsLink,
    // Internal EasyFix Primary SPOC. mobile is ALWAYS masked here — the raw
    // number is resolved server-side only inside the spoc-call bridge.
    spoc: {
      name:          spoc.name,
      mobile_masked: spoc.mobile ? maskMobile(spoc.mobile) : null,
    },
    // The job OWNER (the customer's EasyFix coordinator). Surfaced UNMASKED so
    // the customer can call their coordinator once the booking is confirmed.
    // Resolved LIVE from job_owner → tbl_user (independent of the prod-only
    // tbl_job.job_primary_spoc snapshot column).
    job_owner: {
      name:   row.owner_name || null,
      mobile: row.owner_mobile || null,
    },
    // Reason lists — DB-driven from action_taken_reason (magic-link customer
    // action_types 39=cancel, 38=reschedule, user_type=2). Same query the
    // submit routes validate against, so options and allowlist can't drift.
    cancel_reasons:     await getCancelReasons(pool),
    reschedule_reasons: await getRescheduleReasons(pool),
    // Customer's OWN mobile, UNMASKED. It is the customer's own number on
    // their own order; the FE renders it read-only. (Distinct from the
    // masked `customer.mobile` kept below for back-compat.)
    customer_mob: row.customer_mob_no || '',
    customer: {
      name:   row.customer_name   || '',
      mobile: row.customer_mob_no || '',
      email:  row.customer_email  || '',
    },
    address: {
      address:             row.address || '',
      building:            row.building || '',
      landmark:            row.landmark || '',
      city_id:             derivedCityId,
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
      // service_name = rate-card display label (friendly per-client name);
      // the FE picker prefers it over service_type_name. Empty string when
      // the row has no rate_card_id mapped.
      service_name:       s.service_name || '',
      service_type_name:  s.service_type_name || '',
      service_catg_name:  s.service_catg_name || '',
      // Billing label derived per-row: 'Free' when no charge is configured
      // (total_amount null or 0), else 'Paid'. Drives the FE's Free/Paid
      // badge on each service line.
      billing_label:      (s.total_amount == null || Number(s.total_amount) === 0) ? 'Free' : 'Paid',
    })),
    // FE contract: round-2 picker seed. Empty array when the customer
    // hasn't submitted yet. Keys MUST stay exactly client_service_id +
    // quantity — the FE keys its Map by client_service_id.
    selectedServices: selectedRows.map((s) => ({
      client_service_id: s.client_service_id,
      quantity:          s.quantity,
    })),
    images: await Promise.all(imageRows.map(async (i) => ({
      image_id: i.image_id,
      key:      i.image,
      url:      await presignMediaKey(i.image),
    }))),
    // Videos shared by the customer via the public Product Photos/Videos
    // picker (or via the conversational chat flow — both write to
    // tbl_job_media). Probe-gated so deploys without the 2026-06-03 migration
    // applied still get `videos: []` silently (no 500). FE renders these as a
    // distinct tile group below photos in the customer-facing picker.
    videos: await (async () => {
      try {
        const [vRows] = await pool.query(
          `SELECT media_id, s3_key FROM tbl_job_media WHERE job_id = ? ORDER BY media_id ASC`,
          [jobId],
        );
        return await Promise.all(vRows.map(async (v) => ({
          media_id: v.media_id,
          key:      v.s3_key,
          url:      await presignMediaKey(v.s3_key),
        })));
      } catch (_e) {
        return [];
      }
    })(),
    // Per-client custom-property descriptors. FE canonicalises `name`
    // (e.g. `branch | branch_details → branch_details`) before keying its
    // input map. Empty array when the client has no rows configured.
    // Built-in-alias props (e.g. "Pin Code", "City", "Email") are stripped
    // here so the FE never renders a second input for a field the form already
    // collects — their `mandatory` flag is still enforced server-side against
    // the matching built-in field (see enforceMandatoryCustomProps).
    custom_properties: customProperties.filter((p) => !isBuiltinAliasProp(p.name)),
    // Whether a Support line is configured (SUPPORT_PHONE set). Drives the
    // "Contact Support" affordance — hidden entirely when no support number
    // exists, so the customer never opens a dead-end dialog.
    support_available: !!(process.env.SUPPORT_PHONE || '').trim(),
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
 *   reserve send #3. Only the counter is reserved up front — sent_at and
 *   last_action are stamped AFTER confirmed delivery, so a failed send
 *   never leaves audit columns claiming a dispatch. If the provider
 *   rejects (delivered:false) or throws, we decrement the slot via
 *   another atomic UPDATE — failed attempts don't burn a slot, but
 *   in-flight reservations always do.
 *
 * Action coercion:
 *   Defensive: if caller passes 'first' but a link was already sent, we
 *   coerce to 'resend'. The admin route already does this in the route
 *   handler — duplicating here keeps the service self-consistent for any
 *   future caller (webhook re-trigger, ops CLI, etc.).
 */
async function sendForJob(jobId, { action, override = false } = {}, pool) {
  logger.info('Send magic-link WhatsApp · jobId=' + jobId + ' action=' + (action || 'first') + ' override=' + !!override);
  // Inline subquery pulls the per-client configurable cap so we don't
  // need a second round-trip. NULL when no row → COALESCE → default 3.
  // CAST UNSIGNED defends against ops storing '3 ' / 'three' — bad
  // parses bubble to NULL → default.
  const [rows] = await pool.query(
    `SELECT j.job_id, j.fk_client_id, j.magic_link_sent_at, j.magic_link_send_count,
            cu.customer_name, cu.customer_mob_no, cl.client_name,
            COALESCE(
              (SELECT CAST(NULLIF(ccp_max.c_prop_values, '') AS UNSIGNED)
                 FROM tbl_client_custom_properties ccp_max
                WHERE ccp_max.client_id    = j.fk_client_id
                  -- Normalise BOTH '_' and '-' to spaces on both sides so the
                  -- snake_case legacy name (max_magic_link_send_count) and the
                  -- Title-Case 'Max Magic-Link Send Count' both match. (Was '_'
                  -- only, so the hyphenated literal never matched snake_case rows
                  -- → cap silently fell back to 3 and blocked resends.)
                  AND LOWER(REPLACE(REPLACE(ccp_max.c_prop_name, '_', ' '), '-', ' '))
                      = LOWER(REPLACE('Max Magic-Link Send Count', '-', ' '))
                  AND (ccp_max.status IS NULL OR ccp_max.status = 1)
                LIMIT 1),
              3
            ) AS max_send_count
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
  const maxSendCount = Number(row.max_send_count) || 3;

  let effectiveAction = action || 'first';
  if (effectiveAction === 'first' && row.magic_link_sent_at != null) {
    effectiveAction = 'resend';
  }
  // Override sends get a distinct audit value so the row tooltip + the
  // status panel can flag them as "admin bypassed the cap" later. Stays
  // within the existing varchar(20) column width.
  if (override) effectiveAction = 'resend-override';

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
   *   - Only the COUNTER is reserved here. sent_at / last_action are
   *     stamped after confirmed delivery — a failed send must not light
   *     the "Link Sent" pill or coerce later first-sends to 'resend'.
   *   - Trade-off: if the process crashes between increment and Meta
   *     response, one slot is lost; a crash between provider success and
   *     the post-delivery stamp leaves count incremented without sent_at
   *     (cron may retry within 24h — benign). Acceptable — the cap is 3
   *     attempts, not 3 deliveries, and a hard crash mid-call is rare
   *     enough to beat the double-send risk we'd otherwise inherit.
   */
  const sentAt = new Date();
  // Override path: drop the `< maxSendCount` clause so a send goes
  // through even at-cap. Route-side already verified caller is Admin
  // before passing override=true through. Non-override: enforce the
  // configurable per-client cap.
  const reserveSql = override
    ? `UPDATE tbl_job
          SET magic_link_send_count = magic_link_send_count + 1
        WHERE job_id = ?`
    : `UPDATE tbl_job
          SET magic_link_send_count = magic_link_send_count + 1
        WHERE job_id = ?
          AND magic_link_send_count < ?`;
  const reserveParams = override
    ? [jobId]
    : [jobId, maxSendCount];

  const [reserveResult] = await pool.query(reserveSql, reserveParams);
  if (!reserveResult || reserveResult.affectedRows === 0) {
    throw {
      status: 429,
      code: 'SEND_LIMIT_REACHED',
      message: `Send limit reached (${maxSendCount} sends max for this client). Use the Override action to send anyway.`,
    };
  }
  if (override) {
    logger.warn(
      { jobId, prior_send_count: row.magic_link_send_count, max_send_count: maxSendCount },
      'magic-link: override send — admin bypassed the cap',
    );
  }

  // Shorten the long JWT URL for the WhatsApp body. Gallabox's
  // `confirm_order` template variable {{3}} renders the URL in-line and
  // long JWTs (~200 chars) blow past sensible message length + look
  // suspicious to the customer. We mint a short URL row tagged
  // `purpose='unconfirmed_book'` with a TTL matching the JWT's own
  // lifetime (MAGIC_LINK_TTL_HOURS, default 168h = 7d) so an expired
  // link returns the friendly /book/<code> 410 page rather than a stale
  // redirect to a JWT-expired landing page.
  //
  // Soft fallback: if shortening fails (DB hiccup, network), we keep
  // the long URL and proceed with the send rather than aborting — the
  // customer MUST receive a working link. Warning logged for ops.
  let bodyUrl = url;
  try {
    const ttlHours    = Number(process.env.MAGIC_LINK_TTL_HOURS) || 168;
    const expiresAt   = new Date(Date.now() + ttlHours * 3600 * 1000);
    // `purpose` = 'unconfirmed_book' tags this row in
    // tbl_url_shortener as a customer Unconfirmed-Order booking link.
    // Audit queries like "all customer-book links sent this week" or a
    // future cleanup cron that targets just this flow filter on this
    // exact string — keep it stable across send paths (admin manual,
    // hourly cron, future "bulk send") so the bucket stays consistent.
    const { short_url } = await urlShortener.shortenUrl(
      url,
      { purpose: 'unconfirmed_book', expiresAt },
      pool,
    );
    bodyUrl = short_url;
  } catch (err) {
    logger.warn(
      { jobId, err: err && err.message },
      'magic-link: URL shortening failed — falling back to long JWT URL',
    );
  }

  let response;
  try {
    response = await whatsappService.sendTemplate({
      to: row.customer_mob_no,
      recipientName: row.customer_name || '',
      templateName: 'confirm_order',
      bodyValues: {
        1: row.customer_name || 'there',
        // Append the Job ID to the client name so the confirmation reads
        // "<Client> #<JobId>" (e.g. "For Testing #511425"), giving the
        // customer a stable order reference right in the greeting. `.trim()`
        // keeps it clean ("#511425") when the client name is missing.
        2: `${row.client_name || ''} #${jobId}`.trim(),
        3: bodyUrl,
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

  // Delivery confirmed — stamp the audit columns now. Stamping after
  // success (rather than in the reservation UPDATE) means a failed send
  // never leaves sent_at / last_action claiming a dispatch that didn't
  // happen, and a failed FIRST send can't flip later attempts to 'resend'.
  await pool.query(
    `UPDATE tbl_job SET magic_link_sent_at = ?, magic_link_last_action = ? WHERE job_id = ?`,
    [sentAt, effectiveAction, jobId],
  );

  logger.info('Magic-link sent · jobId=' + jobId + ' action=' + effectiveAction + ' sendCount=' + ((row.magic_link_send_count || 0) + 1));

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
  logger.info('Accept customer submission · jobId=' + jobId + ' services=' + (Array.isArray(payload && payload.services) ? payload.services.length : 0));
  // Mandatory custom-property enforcement is DISABLED for the customer flow
  // (2026-07-08): the job-completion form no longer collects per-client custom
  // properties (Branch Details / Bill Number / Store Code are internal ops fields
  // the customer can't meaningfully provide). Ops still captures them in the CRM
  // Book-New-Call flow. Re-enable this call if custom props become customer-facing.
  // await enforceMandatoryCustomProps(jobId, payload, pool);
  void enforceMandatoryCustomProps; // keep referenced (defined below) — see note above.

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
    // Schema-drift gate for the 3 Book-New-Call custom-prop columns. Probe
    // once (memoised) — only `branch_details` is canonically present on
    // tbl_job (see services/job.service.js ~line 1023). On deploys where
    // building_name / product_code do exist as columns, persist them too;
    // otherwise the customer-supplied values live on in
    // customer_submitted_payload JSON for audit.
    const hasBranchCol   = await jobHasColumn(pool, 'branch_details');
    const hasBuildingCol = await jobHasColumn(pool, 'building_name');
    const hasProductCol  = await jobHasColumn(pool, 'product_code');

    const jobSetClauses = [
      'customer_submitted_at      = ?',
      'customer_submitted_payload = ?',
      'requested_date_time        = COALESCE(?, requested_date_time)',
      'time_slot                  = COALESCE(?, time_slot)',
      'additional_name            = COALESCE(?, additional_name)',
      'additional_number          = COALESCE(?, additional_number)',
      'job_desc                   = COALESCE(?, job_desc)',
      'job_customer_name          = COALESCE(?, job_customer_name)',
    ];
    const jobSetParams = [
      submittedAt,
      JSON.stringify(payload),
      payload.requested_date_time || null,
      payload.time_slot || null,
      payload.additional_name || null,
      payload.additional_number || null,
      (payload.job_desc && String(payload.job_desc).trim()) ? payload.job_desc : null,
      (payload.customer_name && String(payload.customer_name).trim()) ? payload.customer_name : null,
    ];
    if (hasBranchCol) {
      jobSetClauses.push('branch_details = COALESCE(?, branch_details)');
      jobSetParams.push(
        (payload.branch_details && String(payload.branch_details).trim()) ? payload.branch_details : null,
      );
    }
    if (hasBuildingCol) {
      jobSetClauses.push('building_name = COALESCE(?, building_name)');
      jobSetParams.push(
        (payload.building_name && String(payload.building_name).trim()) ? payload.building_name : null,
      );
    }
    if (hasProductCol) {
      jobSetClauses.push('product_code = COALESCE(?, product_code)');
      jobSetParams.push(
        (payload.product_code && String(payload.product_code).trim()) ? payload.product_code : null,
      );
    }
    jobSetClauses.push('last_update_time = ?');
    jobSetParams.push(submittedAt);
    jobSetParams.push(jobId);

    await conn.query(
      `UPDATE tbl_job SET ${jobSetClauses.join(', ')} WHERE job_id = ?`,
      jobSetParams,
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
      // Schema-drift gate: conditionally include the address_instruction
      // SET clause + its parameter only when the column exists on this
      // deploy. Without the gate, deploys missing the column would 500
      // here with `Unknown column 'address_instruction' in 'field list'`
      // — caught 2026-05-31 mirroring the same gate in fetchPrefill.
      // When absent, the customer's address-instruction text is silently
      // dropped (degraded mode); the rest of the address persists.
      const hasAddrInstr = await addressHasInstruction(pool);
      const setClauses = [
        'address             = COALESCE(?, address)',
        'building            = COALESCE(?, building)',
        'landmark            = COALESCE(?, landmark)',
        'city_id             = COALESCE(?, city_id)',
        'pin_code            = COALESCE(?, pin_code)',
        'gps_location        = COALESCE(?, gps_location)',
      ];
      const params = [addressLine, building, landmark, cityId, pinCode, gps];
      if (hasAddrInstr) {
        setClauses.push('address_instruction = COALESCE(?, address_instruction)');
        params.push(addrInstr);
        // 2026-06-03: per ops, `is_instruction_added` must stay 0 even
        // when the text is non-empty. See services/job.service.js
        // insertAddress() for the full rationale. When the customer's
        // payload included the field at all, we still touch the column
        // (reset to 0) so any pre-existing 1 from older code paths is
        // cleared on submission — the invariant must hold cross-tier.
        if (addrInstr != null) {
          setClauses.push('is_instruction_added = ?');
          params.push(0);
        }
      }
      params.push(addressId);

      await conn.query(
        `UPDATE tbl_address SET ${setClauses.join(', ')} WHERE address_id = ?`,
        params,
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
      // SECURITY (2026-05-28 fix): scope the lookup to THIS job's client.
      // Without the `AND client_id = ?` filter, a hostile customer holding
      // a valid magic-link token for job-100 (client A) could POST
      // client_service_ids belonging to clients B / C / D and have them
      // resolved + inserted into tbl_job_services — billing data
      // integrity risk. Mismatched IDs are silently DROPPED (logged at
      // warn) rather than thrown — a stale or wrong ID submitted by the
      // customer shouldn't block their entire submission.
      // Extended projection (2026-06-05) — pull all 7 rate-card columns
      // so the cascade helper can compute the 5 charge columns at write
      // time without a second round-trip.
      // PERF (2026-06-12) — batch the resolution into ONE query keyed by
      // client_service_id IN (?). Previously this ran N sequential SELECTs
      // (Joi caps services at 50) inside the open transaction, extending
      // row-lock time on a public endpoint. The `AND client_id = ?` scope
      // is retained verbatim — it is the cross-client-injection guard and
      // must not be dropped. (We deliberately do NOT reuse loadRateCardRows
      // from utils/rate-card-calc.js: it lacks this client scope and the
      // service_type_id / service_catg_id columns we classify on.)
      const csIds = [...new Set(
        payload.services
          .map((p) => Number(p.client_service_id))
          .filter((n) => Number.isFinite(n) && n > 0),
      )];
      const csById = new Map(); // Number(client_service_id) -> rate-card row
      if (csIds.length > 0) {
        const [csRows] = await conn.query(
          `SELECT client_service_id, service_type_id, service_catg_id,
                  total_amount, easyfix_direct_fixed, easyfix_direct_variable,
                  overhead_fixed, overhead_variable, client_fixed, client_variable
             FROM tbl_client_service
            WHERE client_service_id IN (?) AND client_id = ?`,
          [csIds, clientId],
        );
        for (const row of csRows) {
          csById.set(Number(row.client_service_id), row);
        }
      }
      for (const pick of payload.services) {
        const csId = pick.client_service_id;
        if (!csId) continue;
        const row = csById.get(Number(csId));
        if (!row) {
          logger.warn(
            { jobId, clientId, client_service_id: csId },
            'magic-link: dropping client_service_id that does not belong to job\'s client (possible cross-client injection or stale picker state)',
          );
          continue;
        }
        const serviceTypeId = row.service_type_id;
        if (serviceTypeId == null) continue;
        const quantity = pick.quantity || 1;
        // If the same type appears twice in the payload, keep the highest
        // quantity — defensive against malformed clients. Carry the full
        // rate-card row so the write step can compute charges.
        const prev = resolved.get(serviceTypeId);
        if (!prev || (quantity > prev.quantity)) {
          resolved.set(serviceTypeId, {
            service_catg_id: row.service_catg_id,
            quantity,
            rateCard: row, // for utils/rate-card-calc.js charges cascade
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
      //    caused the billing leak. PERF (2026-06-12) — batch into ONE
      //    UPDATE ... WHERE job_service_id IN (?) instead of N per-row
      //    statements inside the open transaction.
      const dropIds = [...activeByService.entries()]
        .filter(([t]) => !resolved.has(t))
        .map(([, id]) => id);
      if (dropIds.length > 0) {
        await conn.query(
          `UPDATE tbl_job_services
              SET job_service_status = 0
            WHERE job_service_id IN (?)`,
          [dropIds],
        );
      }
      logger.info('Reconciling job services · keep=' + resolved.size + ' softDeleted=' + dropIds.length);

      // d) Apply each submitted pick: UPDATE active row, or INSERT fresh
      //    (never resurrect a soft-deleted ops removal). Charges are
      //    computed from the rate-card row captured in step (a) via the
      //    shared cascade helper.
      const { computeJobServiceCharges } = require('../utils/rate-card-calc');
      for (const [serviceTypeId, info] of resolved.entries()) {
        const ch = computeJobServiceCharges(info.rateCard, info.quantity);
        const activeId = activeByService.get(serviceTypeId);
        if (activeId) {
          // Active row already exists — refresh quantity + recompute the
          // 5 charge columns, keep status=1.
          await conn.query(
            `UPDATE tbl_job_services
                SET quantity            = ?,
                    job_service_status  = 1,
                    service_type_id     = ?,
                    service_category_id = ?,
                    total_charge        = ?,
                    total_cost          = ?,
                    client_charge       = ?,
                    easyfix_charge      = ?,
                    easyfixer_charge    = ?
              WHERE job_service_id = ?`,
            [info.quantity, serviceTypeId, info.service_catg_id,
             ch.total_charge, ch.total_cost, ch.client_charge, ch.easyfix_charge, ch.easyfixer_charge,
             activeId],
          );
        } else {
          // No active row. Either soft-deleted history exists (refuse to
          // resurrect — per ops policy) or no row at all. INSERT either
          // way to preserve the soft-deleted audit history alongside the
          // fresh customer-submitted row.
          await conn.query(
            `INSERT INTO tbl_job_services
               (job_id, service_id, quantity, service_type_id, service_category_id, job_service_status,
                total_charge, total_cost, client_charge, easyfix_charge, easyfixer_charge)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
            [jobId, serviceTypeId, info.quantity, serviceTypeId, info.service_catg_id,
             ch.total_charge, ch.total_cost, ch.client_charge, ch.easyfix_charge, ch.easyfixer_charge],
          );
          if (softDeletedTypes.has(serviceTypeId)) {
            logger.info(
              { jobId, serviceTypeId },
              'magic-link: customer re-submitted a previously ops-removed service — inserting fresh row, not resurrecting soft-deleted history',
            );
          }
        }
      }
      // Mirror onto tbl_job.client_services CSV — same helper as
      // job.service.js::create + update so every services mutator stays
      // in sync with the normalized table (legacy reports read the flat
      // column). Inline require to avoid a circular-dep risk at module
      // load time — only fires when the customer actually submits.
      const { recomputeClientServicesCsv } = require('./job.service');
      await recomputeClientServicesCsv(conn, jobId);
    }

    await conn.commit();

    logger.info('Customer submission committed · jobId=' + jobId);

    return {
      ok: true,
      jobId,
      customer_submitted_at: submittedAt.toISOString(),
    };
  } catch (err) {
    try { await conn.rollback(); } catch (_e) { /* connection already gone */ }
    logger[(err && err.status && err.status < 500) ? 'warn' : 'error']('Customer submission ' + ((err && err.status && err.status < 500) ? 'rejected' : 'failed') + ' · jobId=' + jobId + ' · ' + (err && (err.message || err.code) ? (err.message || err.code) : 'unknown'));
    // Re-throw shaped errors verbatim (they carry status/code already);
    // wrap unknown errors with a 500 envelope for the public route layer.
    if (err && err.status) throw err;
    throw { status: 500, message: err && err.message ? err.message : 'submission failed' };
  } finally {
    conn.release();
  }
}

/*
 * writeCustomerOrderDetails(jobId, fields, pool)
 *
 * Shared finalize writer for customer-supplied order details, used by the
 * CONVERSATIONAL WhatsApp flow (services/whatsapp-conversation.service.js).
 * Writes the SAME tbl_job (schedule + audit) and tbl_address columns that
 * acceptSubmission() does (steps 2 + 4 there) — minus the service
 * reconciliation, since the chat never collects services (and must therefore
 * NOT soft-delete a job's existing tbl_job_services rows).
 *
 * IMPORTANT — keep the column set here in sync with acceptSubmission()'s
 * tbl_job / tbl_address writes above. Both stamp customer_submitted_at +
 * customer_submitted_payload so the existing CRM "Customer Submitted" pill +
 * the Confirm-mode prefill light up identically whether the customer used the
 * form or the chat.
 *
 * `fields` (all optional except none — COALESCE preserves existing on null):
 *   requested_date_time, time_slot, job_desc,
 *   address, building, landmark, city_id, pin_code, gps_location, address_instruction,
 *   payload (object — snapshot stored as customer_submitted_payload JSON).
 */
async function writeCustomerOrderDetails(jobId, fields, pool) {
  logger.info('Write customer order details (chat flow) · jobId=' + jobId);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [jobRows] = await conn.query(
      'SELECT fk_address_id FROM tbl_job WHERE job_id = ? LIMIT 1',
      [jobId],
    );
    if (!jobRows || jobRows.length === 0) {
      throw { status: 404, code: 'JOB_NOT_FOUND', message: 'Order not found' };
    }
    const addressId = jobRows[0].fk_address_id;
    const submittedAt = new Date();

    await conn.query(
      `UPDATE tbl_job SET
         customer_submitted_at      = ?,
         customer_submitted_payload = ?,
         requested_date_time        = COALESCE(?, requested_date_time),
         time_slot                  = COALESCE(?, time_slot),
         job_desc                   = COALESCE(?, job_desc),
         last_update_time           = ?
       WHERE job_id = ?`,
      [
        submittedAt,
        JSON.stringify(fields.payload || fields),
        fields.requested_date_time || null,
        fields.time_slot || null,
        (fields.job_desc && String(fields.job_desc).trim()) ? fields.job_desc : null,
        submittedAt,
        jobId,
      ],
    );

    const addressLine = (fields.address && String(fields.address).length) ? fields.address : null;
    if (addressId && addressLine) {
      const hasAddrInstr = await addressHasInstruction(pool);
      const setClauses = [
        'address      = COALESCE(?, address)',
        'building     = COALESCE(?, building)',
        'landmark     = COALESCE(?, landmark)',
        'city_id      = COALESCE(?, city_id)',
        'pin_code     = COALESCE(?, pin_code)',
        'gps_location = COALESCE(?, gps_location)',
      ];
      const params = [
        addressLine,
        (fields.building && String(fields.building).length) ? fields.building : null,
        (fields.landmark && String(fields.landmark).length) ? fields.landmark : null,
        fields.city_id ?? null,
        fields.pin_code ?? null,
        (fields.gps_location && String(fields.gps_location).length) ? fields.gps_location : null,
      ];
      if (hasAddrInstr) {
        setClauses.push('address_instruction = COALESCE(?, address_instruction)');
        params.push((fields.address_instruction && String(fields.address_instruction).length) ? fields.address_instruction : null);
      }
      params.push(addressId);
      await conn.query(`UPDATE tbl_address SET ${setClauses.join(', ')} WHERE address_id = ?`, params);
    }

    await conn.commit();
    logger.info('Customer order details written · jobId=' + jobId);
    return { jobId, customer_submitted_at: submittedAt.toISOString() };
  } catch (err) {
    try { await conn.rollback(); } catch (_e) { /* connection already gone */ }
    logger[(err && err.status && err.status < 500) ? 'warn' : 'error']('Customer order details write ' + ((err && err.status && err.status < 500) ? 'rejected' : 'failed') + ' · jobId=' + jobId + ' · ' + (err && (err.message || err.code) ? (err.message || err.code) : 'unknown'));
    if (err && err.status) throw err;
    throw { status: 500, message: err && err.message ? err.message : 'write failed' };
  } finally {
    conn.release();
  }
}

module.exports = {
  fetchPrefill,
  sendForJob,
  acceptSubmission,
  writeCustomerOrderDetails,
  resolveJobSpoc,
  orderStatusLabel,
  getCancelReasons,
  getRescheduleReasons,
  TIME_SLOTS,
};
