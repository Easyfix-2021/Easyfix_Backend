const Joi = require('joi');

/*
 * Theme & Branding validators — for routes/admin/branding.js and
 * routes/public/branding.js.
 *
 * Two unrelated shapes live here:
 *
 *  1. SETTINGS  — free-text/boolean chrome copy persisted to easyfix_properties
 *     (environment banner, maintenance banner, login tagline). Every field is
 *     optional and `''` is a MEANINGFUL value: it is how an operator clears a
 *     banner. `.min(1)` stops an empty PUT from being a no-op write.
 *
 *  2. VARIANTS  — rows in easyfix_theme_variant: a dated window during which
 *     the login page wears a festival ornament.
 */

// ─── Ornament key ────────────────────────────────────────────────────
/*
 * SECURITY — this is the one field that must not be a free string.
 *
 * GET /api/public/branding/active is UNAUTHENTICATED and presigns whatever
 * ornament_key the row holds. If an operator (or a hijacked admin session)
 * could store `easyfixer_documents/<aadhaar-scan>` here, that public endpoint
 * would happily mint a presigned URL for it — an arbitrary-object read out of
 * the whole bucket. So the key is pinned to the `Branding/` prefix that
 * POST /variants/:id/ornament writes, and the resolver in
 * services/branding.service.js re-checks the prefix before presigning
 * (defence in depth: validation alone would not cover rows written by hand).
 *
 * The second branch is the LOCAL-dev fallback, where the "key" is the relative
 * /easydoc URL writeBuffer() returns and no presigning happens at all.
 */
const ornamentKey = Joi.alternatives()
  .try(
    Joi.string().trim().pattern(/^Branding\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/).max(255),
    Joi.string().trim().pattern(/^\/[A-Za-z0-9._\-/]+$/).max(255),
  )
  .messages({
    'alternatives.match': 'ornament_key must be a "Branding/…" S3 key returned by the ornament upload',
  });

// DATE-only. Deliberately a string pattern, not Joi.date(): a timezone-bearing
// ISO instant round-trips through UTC and can land the window a day early or
// late in a DATE column (the QuickSight date trap, same fix).
const dateOnly = Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/)
  .messages({ 'string.pattern.base': 'must be YYYY-MM-DD' });

/*
 * Anchors are PERCENTAGES of the login-page canvas and scale is a percentage of
 * the ornament's natural size. Negative / >100 anchors are legal and useful —
 * that is how an ornament is bled off the edge of the frame — so the bounds
 * only exist to keep the value inside DECIMAL(6,2) and to reject nonsense that
 * would render the ornament invisible.
 */
const percent = Joi.number().min(-500).max(500).precision(2);
const scalePercent = Joi.number().min(1).max(1000).precision(2);

// ─── Render mode ─────────────────────────────────────────────────────
/*
 * How the uploaded asset relates to the official EasyFix lockup.
 *
 *   'overlay'  the ornament is composited OVER the lockup — the historic and
 *              only behaviour before this field existed.
 *   'replace'  the uploaded asset IS the brand mark for that window and the
 *              lockup is not drawn beneath it (a designer-supplied complete
 *              festive lockup).
 *
 * `.lowercase()` normalises 'Overlay'/'REPLACE' rather than 400-ing on them:
 * the vocabulary is a UI radio, not user data, and a case mismatch from a
 * script is a typo, not an attack. The stored value is always canonical, so
 * services/branding.service.js can compare it with `===`.
 *
 * DEFAULT ONLY ON CREATE — see the update schema for why.
 */
const renderMode = Joi.string().trim().lowercase().valid('overlay', 'replace')
  .messages({ 'any.only': 'render_mode must be "overlay" or "replace"' });

// ─── Settings ────────────────────────────────────────────────────────
const brandingSettings = Joi.object({
  envBannerText:             Joi.string().trim().max(200).allow('').optional(),
  envBannerEnabled:          Joi.boolean().optional(),
  maintenanceBannerText:     Joi.string().trim().max(300).allow('').optional(),
  maintenanceBannerEnabled:  Joi.boolean().optional(),
  loginTagline:              Joi.string().trim().max(160).allow('').optional(),
}).min(1);

// ─── Variants ────────────────────────────────────────────────────────
const variantIdParam = Joi.object({
  id: Joi.number().integer().positive().required(),
});

const variantListQuery = Joi.object({
  // Disabled variants stay listed by default — the admin screen is a calendar,
  // and a retired festival window is exactly what an operator re-enables next
  // year. Pass includeDisabled=false for the live-only view.
  includeDisabled: Joi.boolean().default(true),
  limit:           Joi.number().integer().min(1).max(200).default(100),
  offset:          Joi.number().integer().min(0).default(0),
});

// `helpers.error('any.invalid')` with an explicit reason keeps the 400 body
// readable — the route surfaces `details[].message` straight to the operator.
function windowIsOrdered(obj, helpers) {
  if (obj.starts_on && obj.ends_on && obj.ends_on < obj.starts_on) {
    return helpers.error('any.invalid', { reason: 'ends_on must not be before starts_on' });
  }
  return obj;
}

const variantCreate = Joi.object({
  name:         Joi.string().trim().min(2).max(80).required(),
  starts_on:    dateOnly.required(),
  ends_on:      dateOnly.required(),
  ornament_key: ornamentKey.allow(null, '').optional(),
  anchor_x:     percent.default(50),
  anchor_y:     percent.default(0),
  scale:        scalePercent.default(100),
  animated:     Joi.boolean().default(true),
  // 'overlay' is the default so a client that predates this field — or one that
  // simply does not care — creates a variant that behaves exactly as variants
  // always have. The DB column carries the same default for the same reason.
  render_mode:  renderMode.default('overlay'),
  enabled:      Joi.boolean().default(true),
})
  .custom(windowIsOrdered, 'window-ordering')
  .messages({ 'any.invalid': 'ends_on must not be before starts_on' });

/*
 * PATCH is partial, so a body carrying only ONE of the two dates cannot be
 * range-checked here — the other half lives in the DB. The route re-runs the
 * comparison against the MERGED row before it writes; this custom only catches
 * the case where both arrive together.
 *
 * NOT ONE FIELD HERE CARRIES A `.default()`, and render_mode least of all. Joi
 * MATERIALISES a defaulted key even when the caller never sent it, and
 * updateVariant builds its SET clause from hasOwnProperty — so a default here
 * would put `render_mode = 'overlay'` into the UPDATE of every PATCH. An
 * operator dragging the anchor on a 'replace' variant would silently reset it
 * to 'overlay' and get their lockup back with no idea why. PATCH is partial by
 * contract: omitting a field must leave the stored value untouched.
 */
const variantUpdate = Joi.object({
  name:         Joi.string().trim().min(2).max(80).optional(),
  starts_on:    dateOnly.optional(),
  ends_on:      dateOnly.optional(),
  ornament_key: ornamentKey.allow(null, '').optional(),
  anchor_x:     percent.optional(),
  anchor_y:     percent.optional(),
  scale:        scalePercent.optional(),
  animated:     Joi.boolean().optional(),
  render_mode:  renderMode.optional(),
  enabled:      Joi.boolean().optional(),
})
  .min(1)
  .custom(windowIsOrdered, 'window-ordering')
  .messages({ 'any.invalid': 'ends_on must not be before starts_on' });

module.exports = {
  brandingSettings,
  variantIdParam,
  variantListQuery,
  variantCreate,
  variantUpdate,
};
