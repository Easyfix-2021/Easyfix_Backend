/*
 * Joi validators for the Customer Magic-Link Completion flow
 * (POST /api/public/job-completion/:token/...).
 *
 * These shapes are TOKEN-bound — the route layer verifies the JWT in
 * the URL and pins the jobId from the token, so NONE of these schemas
 * accept a jobId in the body / params. That's a deliberate isolation
 * choice: the public surface can never be coaxed into addressing a
 * different job than the one the token was minted for.
 *
 * Shape notes:
 *   - `pin_code` is `/^\d{6}$/` (Indian PIN), matching tbl_pincode.
 *   - `gps_location` is "lat,lng" CSV; accepts empty string for the
 *     "user denied geolocation" path (the form still submits).
 *   - `additional_number` is exactly 10 digits to mirror the customer
 *     mobile shape used everywhere else in the platform.
 *   - `services[].quantity` is capped at 99 — the rate-card UI maxes
 *     out at 2 digits and we don't want a typo writing a 4-digit qty
 *     into a customer invoice.
 *   - max 50 services per submission is a soft DoS guard; real flows
 *     pick 1–4 line items.
 */

const Joi = require('joi');
const {
  CANCEL_REASONS,
  RESCHEDULE_REASONS,
} = require('../services/job-magic-link.service');

const intId = Joi.number().integer().positive();

/*
 * Customer cancel / reschedule request bodies.
 *
 * `reason` is constrained to the SAME frozen lists the prefill returns
 * (services/job-magic-link.service.js) so the FE dropdown options and the
 * server-side allowlist can never drift. `remarks` is an optional free-text
 * note (capped at 1000 chars to bound storage / abuse).
 *
 * `preferred_datetime` (reschedule only) accepts BOTH ISO-8601 and the
 * legacy "YYYY-MM-DD HH:mm" shape the FE date-picker emits — Joi.date()
 * with two explicit formats parses either into a Date the route stores as
 * a MySQL DATETIME. Absent → stored as NULL.
 */
const cancelRequestBody = Joi.object({
  reason: Joi.string().valid(...CANCEL_REASONS).required(),
  remarks: Joi.string().trim().max(1000).allow('').optional(),
});

const rescheduleRequestBody = Joi.object({
  reason: Joi.string().valid(...RESCHEDULE_REASONS).required(),
  remarks: Joi.string().trim().max(1000).allow('').optional(),
  // Accept ISO-8601 OR the legacy "YYYY-MM-DD HH:mm" string. Joi.date().iso()
  // covers the ISO case; the string pattern covers the space-separated legacy
  // shape (Joi.date() rejects the space form). The route normalises whichever
  // matched into a single MySQL DATETIME string before INSERT.
  preferred_datetime: Joi.alternatives()
    .try(
      Joi.date().iso(),
      Joi.string().pattern(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/),
    )
    .optional()
    .messages({ 'alternatives.match': 'preferred_datetime must be ISO-8601 or "YYYY-MM-DD HH:mm".' }),
});

const serviceLine = Joi.object({
  client_service_id: intId.required(),
  quantity: Joi.number().integer().min(1).max(99).required(),
});

const submitBody = Joi.object({
  customer_name: Joi.string().trim().max(100).required(),
  customer_email: Joi.alternatives(
    Joi.string().email().max(120),
    Joi.string().valid(''),
  ).optional(),
  // address / city / PIN are BOOKED, display-only on the customer confirmation
  // form — the customer can't edit them (the map pin captures GPS only), so
  // requiring them would dead-end any booking that happens to lack one. Optional
  // here; acceptSubmission COALESCEs, so an omitted value keeps the booked one.
  address: Joi.string().trim().max(500).allow('').optional(),
  city_id: intId.optional(),
  pin_code: Joi.alternatives(
    Joi.string().pattern(/^\d{6}$/),
    Joi.string().valid(''),
  ).optional(),
  time_slot: Joi.string().trim().max(50).required(),
  // Must be strictly in the future. Plain `.greater('now')` — no
  // grace-period buffer because no other validator in this repo uses
  // one and the FE's date-picker already prevents past selection;
  // this is a server-side belt-and-braces guard against tampering /
  // replayed submissions. Reject reason surfaced to the FE: the
  // customer fixed a wrong slot or the link sat in their inbox long
  // enough that the chosen time is now stale.
  requested_date_time: Joi.date().iso().greater('now').required().messages({
    'date.greater': 'Requested date & time must be in the future.',
  }),

  additional_name: Joi.string().trim().max(100).allow('').optional(),
  additional_number: Joi.string().pattern(/^\d{10}$/).allow('').optional(),
  building: Joi.string().trim().max(200).allow('').optional(),
  landmark: Joi.string().trim().max(200).allow('').optional(),
  gps_location: Joi.alternatives(
    Joi.string().pattern(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/),
    Joi.string().valid(''),
  ).optional(),
  address_instruction: Joi.string().trim().max(500).allow('').optional(),
  job_desc: Joi.string().trim().max(500).allow('').optional(),

  // Per-client custom-property fields (driven by tbl_client_custom_properties;
  // see services/job-magic-link.service.js::fetchPrefill). The FE only renders
  // these inputs when the client has the matching row, and only marks them
  // required when `mandatory=true`. They're always optional at the validator
  // level — `mandatory` is a per-CLIENT contract, not a per-route contract.
  branch_details: Joi.string().trim().max(200).allow('').optional(),
  building_name:  Joi.string().trim().max(200).allow('').optional(),
  product_code:   Joi.string().trim().max(200).allow('').optional(),

  // Generic per-client custom-property values keyed by the property's
  // (lower-cased) name. The 3 canonical fields above keep their dedicated
  // tbl_job columns; ALL other client-defined fields ride here and are
  // persisted inside customer_submitted_payload JSON. Mandatory enforcement
  // is dynamic (per-client, runtime) in acceptSubmission — see
  // services/job-magic-link.service.js::enforceMandatoryCustomProps — so this
  // shape stays permissive (a `mandatory` flag is a per-CLIENT contract, not a
  // per-route one). Caps mirror the canonical fields (50 keys, 500 chars).
  custom_properties: Joi.object()
    .pattern(Joi.string().max(80), Joi.string().allow('').max(500))
    .max(50)
    .optional(),

  services: Joi.array().items(serviceLine).max(50).optional(),
});

const tokenParam = Joi.object({
  token: Joi.string().min(10).required(),
}).unknown(true);

const imageIdParam = Joi.object({
  imageId: intId.required(),
}).unknown(true);

module.exports = {
  submitBody,
  tokenParam,
  imageIdParam,
  cancelRequestBody,
  rescheduleRequestBody,
};
