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
   * Still a strict SUPERSET of the original `tj.time_slot = ?`: three ORed
   * alternatives, the first of which is that predicate unchanged. The count can
   * only go UP, so availability never gets looser than the legacy contract.
   */
  const rawSlot  = String(timeSlot || '');
  const bandSlot = slotModel.normaliseSlotLabel(rawSlot);
  const hours    = slotHourRange(rawSlot, bandSlot);
  const [[{ cnt }]] = await pool.query(
    `SELECT COUNT(*) AS cnt
       FROM tbl_job tj
       LEFT JOIN tbl_address ta ON ta.address_id = tj.fk_address_id
      WHERE tj.fk_service_catg_id = 21
        AND DATEDIFF(tj.requested_date_time, ?) = 0
        AND (
              tj.time_slot = ?
           OR (? IS NOT NULL AND tj.time_slot = ?)
           OR (? IS NOT NULL
               AND TIME(tj.requested_date_time) <> '00:00:00'
               AND HOUR(tj.requested_date_time) >= ?
               AND HOUR(tj.requested_date_time) <  ?)
            )
        AND ta.city_id = ?`,
    [
      dateOnly,
      rawSlot,
      bandSlot, bandSlot,
      hours ? 1 : null, hours ? hours[0] : 0, hours ? hours[1] : 0,
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

module.exports = {
  STATUS_LABELS,
  statusLabel,
  parseLegacyDate,
  formatLegacyDate,
  checkFirefoxAvailability,
  checkDecathlonServiceability,
};
