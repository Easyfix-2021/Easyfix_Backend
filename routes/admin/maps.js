/*
 * Google Maps proxy endpoints — used by Book New Call's address field
 * for autosuggest + GPS auto-fill (admin / CRM staff surface).
 *
 * Why proxy: keeps GOOGLE_MAPS_API_KEY server-side (never shipped to
 * the browser bundle), centralises request budgeting + caching, and
 * lets us bolt on per-user rate limits later without touching the
 * client. Frontend hits `/admin/maps/autocomplete?q=…` and
 * `/admin/maps/geocode?address=…` with debounced/keyed requests.
 *
 * The actual Google calls + LRU cache + error-mapping live in
 * `services/maps.service.js` (extracted 2026-05-28 so the customer-
 * facing magic-link page at `/api/public/maps/*` can reuse them with
 * token-gated auth). This file is now just JWT-authed handler glue +
 * Joi validators.
 */

const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const mapsService = require('../../services/maps.service');

/*
 * GET /admin/maps/autocomplete?q=<text>
 *
 * Wraps Google Places Autocomplete. Returns:
 *   { items: [{ place_id, description, primary, secondary }] }
 */
router.get('/autocomplete', validate(Joi.object({
  q: Joi.string().min(3).max(200).required(),
}), 'query'), async (req, res, next) => {
  try {
    const out = await mapsService.autocomplete(String(req.query.q).trim());
    modernOk(res, out);
  } catch (e) {
    if (e && e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * GET /admin/maps/geocode?place_id=<id>  OR  ?address=<text>  OR  ?latlng=<lat,lng>
 *
 * Wraps Google Geocoding. Returns:
 *   { lat, lng, formatted_address, address_components: {...} }
 *
 * `latlng` (CSV) variant is used by the draggable map marker on Book
 * New Call / Confirm & Schedule so a pin-drop autopopulates PIN /
 * city / formatted address.
 */
router.get('/geocode', validate(Joi.object({
  place_id: Joi.string().min(5).max(300).optional(),
  address:  Joi.string().min(3).max(500).optional(),
  latlng:   Joi.string().pattern(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).optional(),
}).or('place_id', 'address', 'latlng'), 'query'), async (req, res, next) => {
  try {
    const out = await mapsService.geocode({
      place_id: req.query.place_id ? String(req.query.place_id) : null,
      address:  req.query.address  ? String(req.query.address)  : null,
      latlng:   req.query.latlng   ? String(req.query.latlng)   : null,
    });
    modernOk(res, out);
  } catch (e) {
    if (e && e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * GET /admin/maps/config (2026-05-28)
 *
 * Runtime fallback for the FE's Google Maps JS API key. Sits under
 * /admin/* so only authenticated ops users can fetch it (consistency
 * with the rest of the FE → BE call surface). See the matching
 * /api/public/maps/config for the customer-facing token-gated mirror.
 */
router.get('/config', (_req, res) => {
  modernOk(res, { apiKey: mapsService.getConfigKey() });
});

module.exports = router;
