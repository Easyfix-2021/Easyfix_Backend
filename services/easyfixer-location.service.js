const { pool } = require('../db');
const logger = require('../logger');

/*
 * Easyfixer location enrichment (2026-07-09).
 *
 * Self-registered technicians submit ONLY a 6-digit pincode (+ name +
 * mobile) from the app. The registration write-path historically stored
 * that pincode verbatim in tbl_easyfixer.efr_pin_no and left the city FK
 * unresolved ("CRM resolves it during verification"). But the CRM screens
 * read location from the resolved FK / tbl_user columns, so City / State /
 * State-User / GPS all render blank on the Registered-Easyfixers list and
 * the Self-Registration Verification page.
 *
 * This helper resolves the submitted pincode into a city FK, state, and GPS
 * centroid (via the existing, idempotent `pincode.service.ensurePincode`)
 * and backfills the blanks on tbl_easyfixer + tbl_user so those screens
 * populate automatically.
 *
 * Contract:
 *   - FAIL-SOFT: callers wrap in try/catch. A geocode miss, a non-India
 *     pincode, or a Google outage must never block a technician's submit or
 *     a CRM page load. On any throw the raw pincode stays saved and the CRM
 *     can still resolve the FK by hand.
 *   - IDEMPOTENT: only fills columns that are currently blank (COALESCE /
 *     NULLIF guards), so it never clobbers a city FK an operator set during
 *     verification, nor a GPS value written elsewhere.
 *   - "GPS Location" prefers a real DEVICE fix (lat,lng captured at submit,
 *     passed as deviceLat/deviceLng) and falls back to the PINCODE CENTROID
 *     (from tbl_pincode / Google) when no device fix is available — e.g. the
 *     read-time backfill, or a technician who denied location permission.
 *
 * Shared by:
 *   - services/mobile-registration.service.js   (write-time, on submit)
 *   - services/easyfixer-verification.service.js (lazy read-time backfill)
 */
async function enrichEasyfixerLocationFromPincode({ efrId, pincode, userId = null, deviceLat = null, deviceLng = null }) {
  const pin = String(pincode == null ? '' : pincode).trim();
  if (!/^\d{6}$/.test(pin)) return { enriched: false, reason: 'invalid-pincode' };

  // Lazy require: sidestep any module load-order cycle with the callers.
  const pincodeService = require('./pincode.service');

  // Dedup-first + geocode + find-or-create city/state; throws on a
  // non-geocodable / non-India pincode (caller catches).
  const resolved = await pincodeService.ensurePincode(pin, { userId, createdByEfrId: efrId });
  const cityId = resolved.city_id != null ? Number(resolved.city_id) : null;

  // GPS: prefer a real DEVICE fix captured at submit (write-time) over the
  // pincode centroid. Guard for finite, in-range coords and reject (0,0) —
  // the app's "no fix" sentinel. Read-time backfill passes no device coords,
  // so it falls back to the centroid.
  const dLat = Number(deviceLat);
  const dLng = Number(deviceLng);
  const hasDeviceFix = Number.isFinite(dLat) && Number.isFinite(dLng)
    && Math.abs(dLat) <= 90 && Math.abs(dLng) <= 180 && !(dLat === 0 && dLng === 0);
  const gps = hasDeviceFix
    ? `${dLat},${dLng}`
    : (resolved.lat != null && resolved.lng != null ? `${resolved.lat},${resolved.lng}` : null);

  // tbl_easyfixer — fill the city FK (detail page: city → state → state-user)
  // and the GPS centroid, only where currently blank. NULLIF(efr_cityId, 0)
  // treats the legacy "0 = unset" sentinel as blank alongside NULL.
  await pool.query(
    `UPDATE tbl_easyfixer
        SET efr_cityId   = COALESCE(NULLIF(efr_cityId, 0), ?),
            efr_base_gps = COALESCE(NULLIF(efr_base_gps, ''), ?)
      WHERE efr_id = ?`,
    [cityId, gps, efrId],
  );

  // tbl_user — the Registered-Easyfixers LIST reads location from here
  // (U.city / U.state / U.pin_code, and resolves State-User by matching
  // U.city against tbl_city.city_name). Fill blanks only.
  if (userId) {
    await pool.query(
      `UPDATE tbl_user
          SET city     = COALESCE(city, ?),
              state    = COALESCE(state, ?),
              pin_code = COALESCE(pin_code, ?)
        WHERE user_id = ?`,
      [resolved.city_name || null, resolved.state_name || null, pin, userId],
    );
  }

  logger.info(
    'Easyfixer location enriched from pincode · efrId=' + efrId
    + ' pincode=' + pin
    + ' cityId=' + (cityId == null ? '-' : cityId)
    + ' gps=' + (gps ? 'yes' : 'no'),
  );
  return {
    enriched: true,
    city_id: cityId,
    city_name: resolved.city_name || null,
    state_name: resolved.state_name || null,
    gps,
  };
}

module.exports = { enrichEasyfixerLocationFromPincode };
