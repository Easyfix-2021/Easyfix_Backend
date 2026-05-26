/*
 * Validators for the Manage Clients flow.
 *
 * One file per Joi-bearing route module — matches the convention of
 * notice.validator.js / job.validator.js / etc. The validate()
 * middleware ((req, schema, source) → ...) tags each handler with
 * _openapi metadata so the Swagger autogen pipeline picks these
 * schemas up at runtime — no manual YAML maintenance.
 *
 * Conventions in here:
 *   - `body` schemas use camelCase, mirroring the FE payload.
 *   - `params` schemas validate the path segments (`:clientId`, `:id`).
 *   - Optional fields default to `.optional()` rather than `.allow(null)`
 *     so the FE can simply omit unset values.
 *   - Strict mode (no unknown keys) on create paths so typos surface
 *     loudly; relaxed on update paths since whitelist is enforced
 *     server-side.
 */

const Joi = require('joi');

/* ─── Path params ─────────────────────────────────────────────────── */

const clientIdParam = Joi.object({
  clientId: Joi.number().integer().positive().required(),
});

// Generic `:id` param — used for contact/billing/custom-prop targets
// where the route already includes :clientId for scope checks.
const idParam = Joi.object({
  id: Joi.number().integer().positive().required(),
});

// Composite for nested resources where both ids matter.
const clientNestedIdParam = Joi.object({
  clientId: Joi.number().integer().positive().required(),
  id:       Joi.number().integer().positive().required(),
});

const clientOnlyIdParam = Joi.object({
  id: Joi.number().integer().positive().required(),
});

/* ─── List query ──────────────────────────────────────────────────── */

const listClientsQuery = Joi.object({
  q:               Joi.string().max(200).optional(),
  includeInactive: Joi.string().valid('true', 'false').optional(),
  limit:           Joi.number().integer().min(1).max(500).optional(),
  offset:          Joi.number().integer().min(0).optional(),
});

/* ─── Client master ───────────────────────────────────────────────── */

/*
 * Full legacy Add-Client surface (matches the EasyFix_CRM form shipped
 * pre-migration). Fields fall into 4 buckets:
 *
 *   master:       clientName, clientEmail, clientAddress, clientType, referenceCode
 *   address parts: building, landmark, cityId, pincode
 *   commercial:   paidBy, collectedBy, travelDistance, bookingCutOff,
 *                 maxOrders / minOrders (alias), couponCode
 *   KYC text + S3 keys for the docs (uploaded separately):
 *                 cinNumber (legacy tan_number),  cinDocKey
 *                 panNumber,                      panDocKey
 *                 mouContact (legacy client_aadhaar), mouDocKey
 *                 logoKey
 *   mapping refs: verticalId, reportingContactIds (array of contact ids)
 *
 * SPOC assignments (Primary/Secondary) are made by a separate call to
 * `upsertPrimarySecondarySpoc` after create — see ClientFormDialog#onSubmit
 * for the FE orchestration. Keeping them out of this body means the
 * legacy `tbl_client` master-row INSERT stays a single statement.
 *
 * LEGACY DEFER — Dashboard Name + Password. Legacy form had these as
 * required fields powering a tbl_client_website-backed client portal
 * login. Ops fills "NA" everywhere; values are never consumed
 * downstream. Per direction 2026-05-25, omitted from this schema.
 * Re-add only when a real client-portal flow lands.
 */
const createClientBody = Joi.object({
  // master
  clientName:        Joi.string().max(255).required(),
  clientEmail:       Joi.string().email().max(255).optional().allow('', null),
  clientAddress:     Joi.string().max(500).optional().allow('', null),
  clientType:        Joi.string().max(50).optional().allow('', null),
  referenceCode:     Joi.string().max(50).optional().allow('', null),
  // address parts
  building:          Joi.string().max(200).optional().allow('', null),
  landmark:          Joi.string().max(200).optional().allow('', null),
  cityId:            Joi.number().integer().positive().optional(),
  pincode:           Joi.string().pattern(/^[0-9]{6}$/).optional().allow('', null),
  // commercial
  paidBy:            Joi.number().integer().min(0).max(10).optional(),
  collectedBy:       Joi.number().integer().min(0).max(10).optional(),
  travelDistance:    Joi.number().min(0).max(10000).optional(),
  bookingCutOff:     Joi.number().integer().min(0).max(48).optional(),
  maxOrders:         Joi.number().integer().min(0).optional(),
  minOrders:         Joi.number().integer().min(0).optional(),
  couponCode:        Joi.string().max(50).optional().allow('', null),
  // KYC + logo (text fields + already-uploaded S3 keys)
  cinNumber:         Joi.string().max(100).optional().allow('', null),
  cinDocKey:         Joi.string().max(500).optional().allow('', null),
  panNumber:         Joi.string().max(50).optional().allow('', null),
  panDocKey:         Joi.string().max(500).optional().allow('', null),
  mouContact:        Joi.string().max(200).optional().allow('', null),
  mouDocKey:         Joi.string().max(500).optional().allow('', null),
  logoKey:           Joi.string().max(500).optional().allow('', null),
  // mapping refs
  verticalId:        Joi.number().integer().positive().optional(),
  reportingContactIds: Joi.array().items(Joi.number().integer().positive()).optional(),
}).options({ stripUnknown: true });

// Edit is partial; accept any whitelisted column (snake or camel).
// Server-side whitelist in client.service.js#updateClient is the
// definitive guard — Joi here just trims + bounds the values.
const updateClientBody = Joi.object({
  // camelCase
  clientName:    Joi.string().max(255).optional(),
  clientEmail:   Joi.string().email().max(255).optional().allow('', null),
  clientAddress: Joi.string().max(500).optional().allow('', null),
  clientStatus:  Joi.number().integer().valid(0, 1).optional(),
  clientType:    Joi.string().max(50).optional().allow('', null),
  referenceCode: Joi.string().max(50).optional().allow('', null),
  bookingCutOff: Joi.number().integer().min(0).max(48).optional(),
  maxOrders:     Joi.number().integer().min(0).optional(),
  minOrders:     Joi.number().integer().min(0).optional(),
  travelDistance: Joi.number().min(0).optional(),
  verticalId:    Joi.number().integer().positive().optional(),
  collectedBy:   Joi.number().integer().min(0).max(10).optional(),
  paidBy:        Joi.number().integer().min(0).max(10).optional(),
  building:      Joi.string().max(200).optional().allow('', null),
  landmark:      Joi.string().max(200).optional().allow('', null),
  cityId:        Joi.number().integer().positive().optional(),
  pincode:       Joi.string().pattern(/^[0-9]{6}$/).optional().allow('', null),
  couponCode:    Joi.string().max(50).optional().allow('', null),
  cinNumber:     Joi.string().max(100).optional().allow('', null),
  cinDocKey:     Joi.string().max(500).optional().allow('', null),
  panNumber:     Joi.string().max(50).optional().allow('', null),
  panDocKey:     Joi.string().max(500).optional().allow('', null),
  mouContact:    Joi.string().max(200).optional().allow('', null),
  mouDocKey:     Joi.string().max(500).optional().allow('', null),
  logoKey:       Joi.string().max(500).optional().allow('', null),
  reportingContactIds: Joi.array().items(Joi.number().integer().positive()).optional(),
  // snake_case fallback (legacy clients)
  client_name:    Joi.string().max(255).optional(),
  client_email:   Joi.string().email().max(255).optional().allow('', null),
  client_address: Joi.string().max(500).optional().allow('', null),
  client_status:  Joi.number().integer().valid(0, 1).optional(),
  client_type:    Joi.string().max(50).optional().allow('', null),
  reference_code: Joi.string().max(50).optional().allow('', null),
  booking_cut_off: Joi.number().integer().min(0).max(48).optional(),
  max_orders:     Joi.number().integer().min(0).optional(),
  travel_distance: Joi.number().min(0).optional(),
  vertical_id:    Joi.number().integer().positive().optional(),
  collected_by:   Joi.number().integer().min(0).max(3).optional(),
}).min(1);

/* ─── Client contacts (SPOCs) ─────────────────────────────────────── */

const createContactBody = Joi.object({
  contactName:  Joi.string().max(200).required(),
  contactEmail: Joi.string().email().max(255).required(),
  contactNo:    Joi.string().pattern(/^[0-9]{10}$/).required(),
  contactAltNo: Joi.string().pattern(/^[0-9]{10}$/).optional().allow('', null),
  contactDesgn: Joi.string().max(100).optional().allow('', null),
  managerId:    Joi.number().integer().positive().optional(),
}).options({ stripUnknown: true });

const updateContactBody = Joi.object({
  // camelCase
  contactName:  Joi.string().max(200).optional(),
  contactEmail: Joi.string().email().max(255).optional(),
  contactNo:    Joi.string().pattern(/^[0-9]{10}$/).optional(),
  contactAltNo: Joi.string().pattern(/^[0-9]{10}$/).optional().allow('', null),
  contactDesgn: Joi.string().max(100).optional().allow('', null),
  managerId:    Joi.number().integer().positive().optional(),
  status:       Joi.number().integer().valid(0, 1).optional(),
  // snake_case
  contact_name:  Joi.string().max(200).optional(),
  contact_email: Joi.string().email().max(255).optional(),
  contact_no:    Joi.string().pattern(/^[0-9]{10}$/).optional(),
  contact_alt_no: Joi.string().pattern(/^[0-9]{10}$/).optional().allow('', null),
  contact_desgn: Joi.string().max(100).optional().allow('', null),
  manager_id:    Joi.number().integer().positive().optional(),
}).min(1);

// Duplicate-check endpoint takes email AND/OR phone; at least one
// must be present.
const contactDuplicateCheckQuery = Joi.object({
  email:     Joi.string().email().max(255).optional(),
  phone:     Joi.string().pattern(/^[0-9]{10}$/).optional(),
  excludeId: Joi.number().integer().positive().optional(),
}).or('email', 'phone');

/* ─── Client billing ──────────────────────────────────────────────── */

const createBillingBody = Joi.object({
  name:          Joi.string().max(255).required(),
  address:       Joi.string().max(500).required(),
  commAddr:      Joi.string().max(500).optional().allow('', null),
  cityId:        Joi.number().integer().positive().required(),
  pin:           Joi.string().pattern(/^[0-9]{6}$/).required(),
  email:         Joi.string().email().max(255).optional().allow('', null),
  // legacy enum: monthly / fortnight / weekly — kept as free-text since
  // the source-of-truth list isn't bound in legacy
  frequencyType: Joi.string().max(50).optional().allow('', null),
  // number of days
  paymentCycle:  Joi.number().integer().min(0).max(365).optional(),
}).options({ stripUnknown: true });

const updateBillingBody = Joi.object({
  // camelCase
  name:          Joi.string().max(255).optional(),
  address:       Joi.string().max(500).optional(),
  commAddr:      Joi.string().max(500).optional().allow('', null),
  cityId:        Joi.number().integer().positive().optional(),
  pin:           Joi.string().pattern(/^[0-9]{6}$/).optional(),
  email:         Joi.string().email().max(255).optional().allow('', null),
  frequencyType: Joi.string().max(50).optional().allow('', null),
  paymentCycle:  Joi.number().integer().min(0).max(365).optional(),
  // snake_case
  c_bill_name:    Joi.string().max(255).optional(),
  c_bill_address: Joi.string().max(500).optional(),
  c_bill_comm_addr: Joi.string().max(500).optional().allow('', null),
  c_bill_city_id:  Joi.number().integer().positive().optional(),
  c_bill_pin:      Joi.string().pattern(/^[0-9]{6}$/).optional(),
  c_bill_email:    Joi.string().email().max(255).optional().allow('', null),
  c_bill_freq_type: Joi.string().max(50).optional().allow('', null),
  c_bill_payment_cycle: Joi.number().integer().min(0).max(365).optional(),
}).min(1);

/* ─── Custom properties ───────────────────────────────────────────── */

const createCustomPropertyBody = Joi.object({
  // Lower-snake (e.g. "branch_name") OR free-form label — both used
  // by the legacy data set. We don't enforce a vocabulary because the
  // value-keys in legacy DB are inconsistent ("Branch Name", "branch_name",
  // "BranchName"). Normalisation is the read endpoint's job.
  name:       Joi.string().max(100).required(),
  label:      Joi.string().max(200).optional().allow('', null),
  value:      Joi.string().max(500).optional().allow('', null),
  mandatory:  Joi.boolean().optional(),
}).options({ stripUnknown: true });

const updateCustomPropertyBody = Joi.object({
  name:       Joi.string().max(100).optional(),
  label:      Joi.string().max(200).optional().allow('', null),
  value:      Joi.string().max(500).optional().allow('', null),
  mandatory:  Joi.boolean().optional(),
  isMandatory: Joi.boolean().optional(),
  // snake_case
  property_name:  Joi.string().max(100).optional(),
  property_label: Joi.string().max(200).optional().allow('', null),
  property_value: Joi.string().max(500).optional().allow('', null),
  is_mandatory:   Joi.alternatives(Joi.boolean(), Joi.number().valid(0, 1)).optional(),
}).min(1);

/* ─── Client services (catalog) ───────────────────────────────────── */

/*
 * Create: must specify category + at least one service type.
 *   chargeType is free-form (legacy strings: 'Fixed', 'Variable', etc.)
 *   totalCharge is a non-negative decimal.
 */
const createClientServiceBody = Joi.object({
  serviceCategoryId: Joi.number().integer().positive().required(),
  serviceTypeIds:    Joi.array().items(Joi.number().integer().positive()).min(1).required(),
  chargeType:        Joi.string().max(50).optional().allow('', null),
  totalCharge:       Joi.number().min(0).optional(),
}).options({ stripUnknown: true });

// Update is partial; whitelist enforced server-side.
const updateClientServiceBody = Joi.object({
  serviceCategoryId: Joi.number().integer().positive().optional(),
  serviceTypeIds:    Joi.array().items(Joi.number().integer().positive()).min(1).optional(),
  chargeType:        Joi.string().max(50).optional().allow('', null),
  totalCharge:       Joi.number().min(0).optional(),
  serviceStatus:     Joi.number().integer().valid(0, 1).optional(),
}).min(1);

/* ─── Rate cards (bulk upsert) ────────────────────────────────────── */

/*
 * Each row is one (client_id, service_type_id) pair with 6 cost cols.
 * Missing costs default to 0 server-side.
 */
const rateCardRow = Joi.object({
  serviceTypeId:          Joi.number().integer().positive().required(),
  easyfixDirectFixed:     Joi.number().min(0).optional(),
  easyfixDirectVariable:  Joi.number().min(0).optional(),
  overheadFixed:          Joi.number().min(0).optional(),
  overheadVariable:       Joi.number().min(0).optional(),
  clientFixed:            Joi.number().min(0).optional(),
  clientVariable:         Joi.number().min(0).optional(),
});

const bulkUpsertRateCardsBody = Joi.object({
  rows: Joi.array().items(rateCardRow).max(500).required(),
});

/* ─── Tech mapping ────────────────────────────────────────────────── */

const replaceTechMappingBody = Joi.object({
  serviceTypeId: Joi.number().integer().positive().required(),
  efrIds:        Joi.array().items(Joi.number().integer().positive()).required(),
});

const eligibleTechsQuery = Joi.object({
  serviceTypeId:     Joi.number().integer().positive().required(),
  cityId:            Joi.number().integer().positive().optional(),
  cityName:          Joi.string().max(100).optional(),
  query:             Joi.string().max(100).optional(),
  includeUnverified: Joi.string().valid('true', 'false').optional(),
});

/* ─── Vertical mapping ────────────────────────────────────────────── */

/*
 * PUT /:clientId/verticals body:
 *   { assignments: [{ verticalId, userId, userType? }] }
 *
 * `assignments` may be empty (clears all mappings for the client).
 * `userType` is optional — silently dropped server-side if the DB
 * lacks the column. 1=Head, 2=PM by legacy convention; we allow any
 * positive int forward-compat.
 */
const replaceVerticalsBody = Joi.object({
  assignments: Joi.array().items(Joi.object({
    verticalId: Joi.number().integer().positive().required(),
    userId:     Joi.number().integer().positive().required(),
    userType:   Joi.number().integer().min(0).max(99).optional(),
  })).required(),
});

module.exports = {
  // params
  clientIdParam,
  clientOnlyIdParam,
  idParam,
  clientNestedIdParam,
  // queries
  listClientsQuery,
  contactDuplicateCheckQuery,
  // bodies
  createClientBody,
  updateClientBody,
  createContactBody,
  updateContactBody,
  createBillingBody,
  updateBillingBody,
  createCustomPropertyBody,
  updateCustomPropertyBody,
  // verticals
  replaceVerticalsBody,
  // services
  createClientServiceBody,
  updateClientServiceBody,
  // rate cards
  bulkUpsertRateCardsBody,
  // tech mapping
  replaceTechMappingBody,
  eligibleTechsQuery,
};
