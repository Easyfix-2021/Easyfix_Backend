/*
 * Helpers for the /api/integration/v1/* legacy-shape endpoints.
 * Job status codes → human-readable strings EXACTLY as the Dropwizard service returned.
 */

const logger = require('../logger');
// Slot-label → canonical band, so the legacy availability count keeps matching
// jobs whose time_slot this backend now writes in the canonical vocabulary.
const slotModel = require('./time-slot');

/*
 * The [fromHour, toHour) window a slot LABEL denotes, across BOTH vocabularies
 * tbl_job.time_slot has ever spoken. Used ONLY to widen the availability COUNT
 * in checkFirefoxAvailability — never to write anything.
 *
 * Keys are lower-cased/whitespace-collapsed so 'Morning 9 to 2' and
 * 'morning  9 to 2' hit the same row. The canonical four bands are resolved via
 * slotModel instead (they are what new rows store), so only the legacy
 * word-leading labels — which normaliseSlotLabel deliberately refuses to guess
 * at — need spelling out here. 'After Hours' is absent on purpose: it is the
 * OVERNIGHT window (19:00 → 09:00), not a contiguous [from, to) range, so it
 * falls back to plain label equality.
 */
const SLOT_HOURS = Object.freeze({
  'morning 9 to 2':    [9, 14],
  'morning 9 to 12':   [9, 12],
  'afternoon 12 to 5': [12, 17],
  'afternoon 12 to 2': [12, 14],
  'evening 2 to 7':    [14, 19],
});

const CANONICAL_BAND_HOURS = Object.freeze({
  '9AM to 12PM': [9, 12],
  '12PM to 3PM': [12, 15],
  '3PM to 7PM':  [15, 19],
});

function slotHourRange(rawSlot, bandSlot) {
  const key = String(rawSlot || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return SLOT_HOURS[key] || CANONICAL_BAND_HOURS[bandSlot] || null;
}

const STATUS_LABELS = {
  0: 'Unconfirmed', 1: 'Scheduled', 2: 'In-Progress',
  3: 'Completed', 5: 'Completed', 6: 'Cancelled',
  7: 'Enquiry', 9: 'Call Later', 10: 'Revisit',
};

function statusLabel(code) {
  return STATUS_LABELS[Number(code)] || 'Unknown';
}

// Dropwizard parses "DD-MM-YYYY HH:mm" (India common format). Use this for IN and OUT.
function parseLegacyDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const m = String(s).match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) {
    const iso = new Date(s);
    return isNaN(iso) ? null : iso;
  }
  const [, d, mo, y, h, mi] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h || 0), Number(mi || 0));
}

function formatLegacyDate(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date)) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Pincode availability check used by `/v1/easyfixers/availability-status`.
 *
 * VERIFIED 2026-05-12 against EasyFix_API legacy code:
 *   - `dao/FirefoxCityDao.java::getFirefoxCityMappingByPincode` — joins
 *     `pincode_firefox_city_mapping` (id, pincode, city_name, firefox_city_id)
 *     with `firefox_city_mapping` (id, city_name, city_id, no_of_slot).
 *   - `dao/JobDAO.java::getEasyfixerAvailabilityStatus` — counts existing
 *     scheduled jobs for the city/date/timeSlot, filtered to service category 21.
 *
 * Returns boolean availability. Caller wraps in legacy `{isAvailabil: "Yes"|"No"}`.
 */
async function checkFirefoxAvailability(pool, { pincode, requestedDate, timeSlot }) {
  logger.info('Check firefox availability · pincode=' + pincode + ' · timeSlot=' + (timeSlot || ''));
  if (!pincode) {
    logger.warn('Firefox availability · no pincode supplied');
    return false;
  }

  // Look up the firefox-city mapping for this pincode.
  const [[fcm]] = await pool.query(
    `SELECT fcm.city_id, fcm.no_of_slot
       FROM pincode_firefox_city_mapping pfcm
       LEFT JOIN firefox_city_mapping fcm ON fcm.id = pfcm.firefox_city_id
      WHERE pfcm.pincode = ?
      LIMIT 1`,
    [String(pincode)]
  );
  if (!fcm || fcm.city_id == null || fcm.no_of_slot == null) {
    logger.info('Firefox availability · no city mapping for pincode');
    return false;
  }

  // requestedDate from legacy contract is "DD-MM-YYYY" or full datetime.
  // The legacy SQL uses DATEDIFF(requested_date_time, :requestedDate) so we
  // need a date string; coerce input to a Date then format YYYY-MM-DD for MySQL.
  const dt = parseLegacyDate(requestedDate);
  if (!dt) {
    logger.warn('Firefox availability · unparseable requestedDate');
    return false;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const dateOnly = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;

  /*
   * Slot match, widened 2026-07-31. tbl_job.time_slot is now written as one of
   * four canonical BANDS ('9AM to 12PM' …) by every create path — INCLUDING the
   * one this same integration posts through (routes/integration/v1 POST /jobs →
   * job.service.create → resolveTimeSlot). So matching only the partner's
   * verbatim string stopped counting the very bookings this endpoint creates,
   * silently disabling per-city slot capacity gating: a partner could book 20
   * jobs into a 5-slot city and keep being told "Yes".
   *
   * ⚠ THE BAND ALONE IS NOT ENOUGH. slotModel.normaliseSlotLabel is anchored on
   * a LEADING DIGIT, so it returns null for exactly the word-leading vocabulary
   * partners send ('Morning 9 to 2', 'Afternoon 12 to 5', 'Evening 2 to 7') —
   * the widened predicate then collapsed straight back to raw equality. Hence
   * SLOT_HOURS below: the explicit hour range each known label denotes, matched
   * against the job's own appointment HOUR. That is the same "read the datetime,
   * not the string" rule the rest of the codebase now follows, and it works for
   * every stored vocabulary at once because none of them is read.
   *
   * ⚠ COLLATION FOLDS CASE, NOT SPACES — the hole the fold arms below close.
   * MySQL's default collation is case-insensitive, so `tj.time_slot = '9AM to
   * 12PM'` already matches a row storing '9am to 12pm'. It does NOT match
   * '9 am to 12 pm', which is live on prod (see the census in
   * services/time-slot.js): the interior spaces make it a different string to
   * every collation we run. Such a row escaped ALL THREE original arms at once
   * whenever it also carried the 00:00 midnight sentinel — arms 1 and 2 miss it
   * on the spacing, and arm 3 is explicitly gated out by
   * `TIME(...) <> '00:00:00'`. Those bookings were invisible to the count, so a
   * city already at capacity kept answering "Yes" and got overbooked.
   *
   * So each equality arm gains a SPACING-INSENSITIVE twin: REPLACE(LOWER(x),
   * ' ', '') is the SQL mirror of slotModel's foldSlot (lower-case + strip
   * whitespace), and slotModel.canonicalSlot is its JS side — bound as the
   * parameter so the two can be read against each other instead of drifting.
   * Narrow on purpose, exactly like the JS: it folds case and spacing and
   * nothing else, so 'Morning 9 to 2' and '3 PM–4 PM' still do NOT collapse into
   * a band here.
   *
   * NON-SARGABLE, AND THAT COSTS NOTHING HERE — verified against the rest of
   * this same WHERE clause rather than assumed:
   *   · `DATEDIFF(tj.requested_date_time, ?) = 0` already wraps the datetime in
   *     a function, so no index on requested_date_time was ever usable;
   *   · arm 5 already wraps the same column in TIME()/HOUR();
   *   · an OR-block can only be index-driven via index_merge union, which needs
   *     EVERY arm indexable — arm 5 has made that impossible since it was added.
   * The only sargable predicate on tbl_job is `fk_service_catg_id = 21`, and it
   * is what drives the access path. The fold therefore adds per-row CPU on rows
   * the server is already examining; it does not change how they are reached.
   *
   * NO DOUBLE-COUNTING. All five alternatives are ORed inside ONE `COUNT(*)`
   * over a single row source, so they are a row-level predicate, not a join: a
   * row satisfying an exact arm AND its folded twin (the common case — the fold
   * SUBSUMES its twin, since two strings equal under a CI collation stay equal
   * after lower-casing and removing spaces) still contributes exactly 1. The
   * exact arms are retained anyway, unchanged, so the predicate stays a provable
   * strict SUPERSET of the legacy `tj.time_slot = ?` — the count can only go UP,
   * and availability never gets looser than the legacy contract.
   */
  const rawSlot  = String(timeSlot || '');
  const bandSlot = slotModel.normaliseSlotLabel(rawSlot);
  const hours    = slotHourRange(rawSlot, bandSlot);
  // The JS side of the fold. canonicalSlot returns the canonical band when the
  // partner's label cosmetically names one and the trimmed input otherwise —
  // either way it is fold-equivalent to rawSlot, so binding it matches exactly
  // the same rows. It is here to NAME what the REPLACE(LOWER(...)) pair does.
  const foldSlotParam = slotModel.canonicalSlot(rawSlot);
  const [[{ cnt }]] = await pool.query(
    `SELECT COUNT(*) AS cnt
       FROM tbl_job tj
       LEFT JOIN tbl_address ta ON ta.address_id = tj.fk_address_id
      WHERE tj.fk_service_catg_id = 21
        AND DATEDIFF(tj.requested_date_time, ?) = 0
        AND (
              tj.time_slot = ?
           OR REPLACE(LOWER(tj.time_slot), ' ', '') = REPLACE(LOWER(?), ' ', '')
           OR (? IS NOT NULL AND tj.time_slot = ?)
           OR (? IS NOT NULL
               AND REPLACE(LOWER(tj.time_slot), ' ', '') = REPLACE(LOWER(?), ' ', ''))
           OR (? IS NOT NULL
               AND TIME(tj.requested_date_time) <> '00:00:00'
               AND HOUR(tj.requested_date_time) >= ?
               AND HOUR(tj.requested_date_time) <  ?)
            )
        AND ta.city_id = ?`,
    [
      dateOnly,
      rawSlot,                                                    // exact, partner's spelling
      foldSlotParam,                                              // …spacing-insensitive twin
      bandSlot, bandSlot,                                         // exact, canonical band
      bandSlot, bandSlot,                                         // …spacing-insensitive twin
      hours ? 1 : null, hours ? hours[0] : 0, hours ? hours[1] : 0, // appointment-hour arm
      fcm.city_id,
    ]
  );

  logger.info('Firefox availability=' + (Number(cnt) < Number(fcm.no_of_slot) ? 'Yes' : 'No') + ' · booked=' + cnt + ' · slots=' + fcm.no_of_slot + ' · date=' + dateOnly);
  return Number(cnt) < Number(fcm.no_of_slot);
}

/**
 * Decathlon-specific pincode serviceability lookup.
 *
 * VERIFIED 2026-05-12 against EasyFix_API `EasyfixerResource.java:309`:
 *   - Gates on the authenticated client's name === "Decathlon Sports India Private Limited"
 *   - Then checks existence in `pincode_decathlon (id, pincode, state_name)`
 *
 * `clientName` is supplied by the basic-auth client lookup (tbl_client_website).
 */
async function checkDecathlonServiceability(pool, { pincode, clientName }) {
  logger.info('Check Decathlon serviceability · pincode=' + pincode);
  if (!pincode) {
    logger.info('Decathlon serviceability · no pincode supplied');
    return null; // legacy returned null isAvailabil on missing pincode
  }
  if (clientName !== 'Decathlon Sports India Private Limited') {
    logger.info('Decathlon serviceability · non-Decathlon client, skipping');
    return null;
  }
  // Live-DB-verified 2026-05-12: `pincode_decathlon` table does NOT exist
  // in the production `easyfix` schema. The legacy EasyFix_API code
  // referenced it but the table was never created. Catch the ER_NO_SUCH_TABLE
  // error and return null so the Decathlon branch degrades gracefully
  // (matches legacy behaviour of returning `isAvailabil: null`).
  try {
    const [[row]] = await pool.query(
      'SELECT id FROM pincode_decathlon WHERE pincode = ? LIMIT 1',
      [String(pincode)]
    );
    logger.info('Decathlon serviceability=' + (row ? 'Yes' : 'No'));
    return !!row;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      logger.warn('Decathlon serviceability · pincode_decathlon table missing, returning null');
      return null;
    }
    throw err;
  }
}

/**
 * The `GET /v1/services` catalogue — a client's own priced service list,
 * nested category → service-type → services.
 *
 * VERIFIED against EasyFix_API ClientServicesDAO.java:76-142 +
 * ServicesResource.java:81-100 (the `website`-role branch, which is the shape
 * the published client documentation shows).
 *
 * ─── Why this is per-client and not a global catalogue ───────────────────
 *
 * Every row comes from `tbl_client_service`, which IS the client's rate card:
 * the same service type carries a different `total_amount` for each client.
 * Returning the global `tbl_service_type` list (which is what this endpoint
 * did before) leaks nothing but is useless — it can't carry a price, so the
 * `services` array came back empty and integrators had no service_id to book
 * with. The client filter is therefore load-bearing, not a permission check.
 *
 * Legacy quirks deliberately preserved, because integrators built against them:
 *   - `service_status = 1` only; LIMIT 100 (legacy `setMaxResults(100)`).
 *   - `service_id` is `client_service_id` — the per-client row id, NOT a global
 *     service id. It is what `POST /v1/jobs` expects back in service_type.services.
 *   - `service_name` is the RATE CARD name (`crc_ratecard_name`), not the
 *     service-type name.
 *   - One entry per distinct service_type within a category.
 *
 * Deliberately NOT preserved: legacy grouped categories with a HashMap, so
 * category order varied between identical calls. We order by category then
 * type so responses are stable and diffable.
 */
async function clientServiceCatalog(pool, { clientId, serviceTypeId } = {}) {
  const clauses = ['cs.client_id = ?', 'cs.service_status = 1'];
  const params = [clientId];
  if (Number(serviceTypeId) > 0) {
    clauses.push('cs.service_type_id = ?');
    params.push(Number(serviceTypeId));
  }
  const [rows] = await pool.query(
    `SELECT cs.client_service_id, cs.service_type_id, cs.service_catg_id,
            cs.charge_type, cs.total_amount,
            st.service_type_name, st.service_type_tool_names,
            sc.service_catg_name, sc.service_catg_desc,
            rc.crc_ratecard_name
       FROM tbl_client_service cs
       LEFT JOIN tbl_service_type    st ON st.service_type_id = cs.service_type_id
       LEFT JOIN tbl_service_catg    sc ON sc.service_catg_id = cs.service_catg_id
       LEFT JOIN tbl_client_rate_card rc ON rc.crc_id         = cs.rate_card_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY cs.service_catg_id ASC, cs.service_type_id ASC, cs.client_service_id ASC
      LIMIT 100`,
    params
  );
  logger.info('Integration service catalogue · clientId=' + clientId + ' · rows=' + rows.length);

  // Two levels of grouping in one pass: category → service-type → services.
  const categories = new Map();
  for (const r of rows) {
    if (!categories.has(r.service_catg_id)) {
      categories.set(r.service_catg_id, {
        service_catg_id: r.service_catg_id,
        service_catg_name: r.service_catg_name,
        service_catg_desc: r.service_catg_desc,
        category_services: [],
        _types: new Map(),
      });
    }
    const cat = categories.get(r.service_catg_id);
    if (!cat._types.has(r.service_type_id)) {
      const entry = {
        service_type: {
          service_type_id: r.service_type_id,
          service_type_name: r.service_type_name,
          services: [],
        },
      };
      // Legacy emitted this key camelCase and dropped it when NULL (Jackson
      // NON_NULL). Matching that exactly so a client mapping the response onto
      // a strict DTO doesn't see a new always-present field.
      if (r.service_type_tool_names != null) {
        entry.service_type.serviceTypeToolNames = r.service_type_tool_names;
      }
      cat._types.set(r.service_type_id, entry);
      cat.category_services.push(entry);
    }
    cat._types.get(r.service_type_id).service_type.services.push({
      service_id: r.client_service_id,
      service_name: r.crc_ratecard_name,
      // Legacy widened the INT column to a Java float, so the wire showed
      // `500.0`. JSON has one number type and JS cannot re-add a trailing
      // `.0`, so this serialises as `500`. Numerically identical — only a
      // client doing raw STRING comparison on the body would notice.
      service_amount: r.total_amount == null ? null : Number(r.total_amount),
      job_charge_type: r.charge_type,
    });
  }

  return [...categories.values()].map(({ _types, ...cat }) => cat);
}

/**
 * Resolve `address.city.city_name` to a city id.
 *
 * Legacy (CitiesDAO.java:44-70) matched city_name with exact equality under a
 * case-insensitive collation and, on no match, returned null so the job was
 * created with a NULL city_id — an address nobody could route to, with no
 * error raised. We keep the permissive lookup (trim + case-insensitive) but
 * report the miss to the caller, which is the one place this diverges from
 * legacy on purpose: silently storing an unroutable address costs a field
 * visit, and an integrator that gets told "unknown city" can fix it.
 */
async function resolveCityId(pool, city) {
  if (!city) return { cityId: null, unknownName: null };
  if (Number(city.city_id) > 0) return { cityId: Number(city.city_id), unknownName: null };
  const name = String(city.city_name || '').trim();
  if (!name) return { cityId: null, unknownName: null };
  const [[row]] = await pool.query(
    'SELECT city_id FROM tbl_city WHERE TRIM(city_name) = ? ORDER BY city_id ASC LIMIT 1',
    [name]
  );
  if (row) return { cityId: row.city_id, unknownName: null };
  logger.warn('Integration: unknown city name · "' + name + '"');
  return { cityId: null, unknownName: name };
}

/*
 * `paymentCollectedBy` is a STRING on the wire and an int in the column.
 * Verbatim from EasyfixAPIUtils.getPaymentCollectByByString (:459-473),
 * including the silent fall-through to 0 for anything unrecognised.
 */
const PAYMENT_COLLECTED_BY = Object.freeze({
  any: 0, serviceman: 1, easyfix: 2, client: 3,
});

function paymentCollectedByCode(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  return PAYMENT_COLLECTED_BY[String(raw).trim().toLowerCase()] ?? 0;
}

module.exports = {
  STATUS_LABELS,
  statusLabel,
  parseLegacyDate,
  formatLegacyDate,
  checkFirefoxAvailability,
  checkDecathlonServiceability,
  clientServiceCatalog,
  resolveCityId,
  paymentCollectedByCode,
  PAYMENT_COLLECTED_BY,
};
