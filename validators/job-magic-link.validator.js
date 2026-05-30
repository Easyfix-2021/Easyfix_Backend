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

const intId = Joi.number().integer().positive();

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
  address: Joi.string().trim().max(500).required(),
  city_id: intId.required(),
  pin_code: Joi.string().pattern(/^\d{6}$/).required(),
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

  services: Joi.array().items(serviceLine).max(50).optional(),
});

const tokenParam = Joi.object({
  token: Joi.string().min(10).required(),
}).unknown(true);

const imageIdParam = Joi.object({
  imageId: intId.required(),
}).unknown(true);

module.exports = { submitBody, tokenParam, imageIdParam };
