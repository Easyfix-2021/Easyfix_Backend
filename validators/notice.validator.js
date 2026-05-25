const Joi = require('joi');

/*
 * Notice Board validators — for routes/admin/notices.js and
 * routes/admin/notice-categories.js.
 *
 * Conventions:
 *  - target_surfaces is a CSV subset of {crm,client,technician}.
 *    Empty is rejected (a notice must target at least one surface).
 *  - audience_scope='all' is the only supported value for v1; the
 *    schema accepts 'city'/'specific' so callers can be future-proof,
 *    but the service rejects anything other than 'all' until those
 *    targeting paths land in Phase 2.
 *  - publish_at < expire_at when both are present (publish_at can be
 *    null = draft only).
 */

const SURFACES = ['crm', 'client', 'technician'];

const surfaceCsv = Joi.string()
  .pattern(/^(crm|client|technician)(,(crm|client|technician))*$/)
  .custom((value, helpers) => {
    const parts = value.split(',');
    const uniq = new Set(parts);
    if (uniq.size !== parts.length) return helpers.error('any.invalid');
    return value;
  }, 'no-duplicate-surfaces')
  .messages({ 'any.invalid': 'target_surfaces must contain unique surfaces' });

const isoOrMysqlDate = Joi.alternatives().try(
  Joi.date().iso(),
  // MySQL DATETIME-ish (YYYY-MM-DD HH:mm or YYYY-MM-DD HH:mm:ss)
  Joi.string().pattern(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/),
);

// ─── Categories ──────────────────────────────────────────────────────
const categoryCreate = Joi.object({
  name:                Joi.string().trim().min(2).max(60).required(),
  color:               Joi.string().trim().pattern(/^#[0-9a-fA-F]{6}$/).required(),
  applies_to_surfaces: surfaceCsv.default('crm,client,technician'),
  sort_order:          Joi.number().integer().min(0).default(0),
});

const categoryUpdate = Joi.object({
  name:                Joi.string().trim().min(2).max(60).optional(),
  color:               Joi.string().trim().pattern(/^#[0-9a-fA-F]{6}$/).optional(),
  applies_to_surfaces: surfaceCsv.optional(),
  sort_order:          Joi.number().integer().min(0).optional(),
  is_active:           Joi.boolean().optional(),
}).min(1);

const categoryIdParam = Joi.object({
  categoryId: Joi.number().integer().positive().required(),
});

// ─── Notices ─────────────────────────────────────────────────────────
const noticeIdParam = Joi.object({
  noticeId: Joi.number().integer().positive().required(),
});

const noticeListQuery = Joi.object({
  q:           Joi.string().allow('', null).optional(),
  status:      Joi.string().valid('draft', 'scheduled', 'published', 'archived').optional(),
  surface:     Joi.string().valid(...SURFACES).optional(),
  category_id: Joi.number().integer().positive().optional(),
  limit:       Joi.number().integer().min(1).max(200).default(25),
  offset:      Joi.number().integer().min(0).default(0),
});

const noticeActiveQuery = Joi.object({
  surface: Joi.string().valid(...SURFACES).required(),
  limit:   Joi.number().integer().min(1).max(50).default(20),
});

// Image attachments — array of public URLs returned by the existing
// /api/shared/upload endpoint. Capped at 5 to keep the modal layout
// + payload size reasonable. Accept both absolute URLs and the relative
// "/easydoc/…" form publicUrlFor() returns (uri allowRelative:true).
const imagesArray = Joi.array()
  .items(Joi.string().trim().min(1).max(500))
  .max(5)
  .default([]);

// Create accepts a draft OR a directly-published notice. The service
// derives `status` from `status_intent` + `publish_at`:
//   intent=draft     → draft   (publish_at optional, ignored)
//   intent=publish   → published if publish_at<=NOW else scheduled
const noticeCreate = Joi.object({
  title:           Joi.string().trim().min(2).max(255).required(),
  body:            Joi.string().trim().min(1).required(),
  category_id:     Joi.number().integer().positive().required(),
  target_surfaces: surfaceCsv.required(),
  audience_scope:  Joi.string().valid('all', 'city', 'specific').default('all'),
  audience_ref_id: Joi.number().integer().positive().allow(null).optional(),
  action_url:      Joi.string().trim().uri().max(500).allow('', null).optional(),
  images:          imagesArray,
  is_pinned:       Joi.boolean().default(false),
  publish_at:      isoOrMysqlDate.allow(null).optional(),
  expire_at:       isoOrMysqlDate.allow(null).optional(),
  status_intent:   Joi.string().valid('draft', 'publish').default('draft'),
}).custom((obj, helpers) => {
  if (obj.publish_at && obj.expire_at) {
    const p = new Date(obj.publish_at).getTime();
    const e = new Date(obj.expire_at).getTime();
    if (!(p < e)) return helpers.error('any.invalid', { reason: 'expire_at must be after publish_at' });
  }
  return obj;
}, 'publish-vs-expire');

// Update — same fields except status_intent (use /publish or /archive
// for state transitions). Locked-once-published is enforced in service.
const noticeUpdate = Joi.object({
  title:           Joi.string().trim().min(2).max(255).optional(),
  body:            Joi.string().trim().min(1).optional(),
  category_id:     Joi.number().integer().positive().optional(),
  target_surfaces: surfaceCsv.optional(),
  audience_scope:  Joi.string().valid('all', 'city', 'specific').optional(),
  audience_ref_id: Joi.number().integer().positive().allow(null).optional(),
  action_url:      Joi.string().trim().uri().max(500).allow('', null).optional(),
  // Update replaces the full image list (no per-image add/remove). The
  // FE form re-sends the surviving URLs after the operator's edits.
  images:          Joi.array().items(Joi.string().trim().min(1).max(500)).max(5).optional(),
  is_pinned:       Joi.boolean().optional(),
  publish_at:      isoOrMysqlDate.allow(null).optional(),
  expire_at:       isoOrMysqlDate.allow(null).optional(),
}).min(1).custom((obj, helpers) => {
  if (obj.publish_at && obj.expire_at) {
    const p = new Date(obj.publish_at).getTime();
    const e = new Date(obj.expire_at).getTime();
    if (!(p < e)) return helpers.error('any.invalid', { reason: 'expire_at must be after publish_at' });
  }
  return obj;
}, 'publish-vs-expire');

const noticePublishBody = Joi.object({
  publish_at: isoOrMysqlDate.allow(null).optional(),
  expire_at:  isoOrMysqlDate.allow(null).optional(),
});

const noticeMarkReadBody = Joi.object({
  surface: Joi.string().valid(...SURFACES).default('crm'),
});

module.exports = {
  categoryCreate,
  categoryUpdate,
  categoryIdParam,
  noticeIdParam,
  noticeListQuery,
  noticeActiveQuery,
  noticeCreate,
  noticeUpdate,
  noticePublishBody,
  noticeMarkReadBody,
};
