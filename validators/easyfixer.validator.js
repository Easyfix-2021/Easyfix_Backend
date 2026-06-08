const Joi = require('joi');

const mobile = Joi.string().pattern(/^[0-9]{10}$/);
const gpsPair = Joi.string().pattern(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
const aadhaar = Joi.string().pattern(/^[0-9]{12}$/);
const pan     = Joi.string().pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/i);

/*
 * Column names below intentionally match the DB schema (snake_case,
 * `lisence` typo preserved). Validator keys = SQL column names so the
 * service layer can copy straight from req.body without renaming.
 */

const listQuery = Joi.object({
  q: Joi.string().min(1).max(100).optional(),
  cityId: Joi.number().integer().positive().optional(),
  serviceCategory: Joi.string().min(1).max(100).optional(),
  isVerified: Joi.boolean().optional(),
  /*
   * 6-status enum (2026-06-08) — matches legacy CRM dropdown:
   *   0 All · 1 Active · 2 Inactive · 3 Idle · 4 Not Eligible
   *   5 Not Suitable · 6 Registration In Progress
   * See services/easyfixer.service.js list() for the per-status
   * priority-aware WHERE clauses (the displayed label is derived from
   * 4 underlying columns per EasyfixerDaoImpl.java#475-505).
   */
  status: Joi.number().integer().valid(0, 1, 2, 3, 4, 5, 6).optional(),
  includeInactive: Joi.boolean().default(false),
  limit: Joi.number().integer().min(1).max(500).default(50),
  offset: Joi.number().integer().min(0).default(0),

  // Manage Easyfixers (parity migration) — dedicated filter params.
  // Additive to `q`; FE may send either/both.
  easyfixerId:      Joi.number().integer().positive().optional(),
  name:             Joi.string().min(1).max(100).optional(),
  mobileNo:         Joi.string().min(1).max(20).optional(),
  efAccount:        Joi.string().valid('under_master', 'master', 'individual').optional(),
  stateId:          Joi.number().integer().positive().optional(),
  serviceType:      Joi.string().min(1).max(100).optional(),
  deepSkillId:      Joi.number().integer().positive().optional(),
  activeFromDate:   Joi.date().iso().optional(),
  activeToDate:     Joi.date().iso().optional(),
  zonalManagerId:   Joi.number().integer().positive().optional(),
  attendance:       Joi.string().valid('present', 'absent', 'on_leave', 'no_information').optional(),
  deepSkillMapped:  Joi.string().valid('mapped', 'not_mapped').optional(),
});

const createBody = Joi.object({
  efr_name:             Joi.string().max(255).required(),
  efr_first_name:       Joi.string().max(100).optional(),
  efr_last_name:        Joi.string().max(100).optional(),
  efr_no:               mobile.required(),
  efr_alt_no:           mobile.optional(),
  efr_email:            Joi.string().email().max(255).optional(),

  efr_address:          Joi.string().max(500).optional(),
  efr_address_res:      Joi.string().max(500).optional(),
  efr_building:         Joi.string().max(255).optional(),
  efr_landmark:         Joi.string().max(255).optional(),
  efr_pin_no:           Joi.string().pattern(/^[0-9]{6}$/).optional(),
  efr_cityId:           Joi.number().integer().positive().required(),
  efr_zone_city_id:     Joi.number().integer().positive().optional(),

  efr_base_gps:         gpsPair.optional(),
  efr_current_gps:      gpsPair.optional(),

  efr_type:             Joi.string().max(100).optional(),
  efr_service_category: Joi.string().max(255).required(),
  efr_service_type:     Joi.string().max(255).required(),

  efr_manager_id:       Joi.number().integer().positive().optional(),
  efr_marital_status:   Joi.string().valid('Single', 'Married', 'Divorced', 'Widowed').optional(),
  efr_children:         Joi.number().integer().min(0).max(20).optional(),
  efr_age:              Joi.number().integer().min(16).max(90).optional(),

  efr_profile_img:      Joi.string().max(500).optional(),
  about_yourself:       Joi.string().max(1000).optional(),

  adhaar_card_number:   aadhaar.optional(),
  pan_card_number:      pan.optional(),
  date_of_birth:        Joi.date().iso().optional(),

  efr_tools:            Joi.string().max(500).optional(),
  skill:                Joi.number().integer().optional(),
  skill_rating:         Joi.number().integer().min(0).max(5).optional(),
  tool_rating:          Joi.number().integer().min(0).max(5).optional(),

  health_insurance:     Joi.boolean().optional(),
  accidental_insurance: Joi.boolean().optional(),
  have_driving_lisence: Joi.boolean().optional(),  // legacy typo preserved to match DB
  have_bike:            Joi.boolean().optional(),
  use_whatsapp:         Joi.boolean().optional(),

  is_technician_verified: Joi.boolean().optional(),
  is_email_verified:      Joi.boolean().optional(),

  experience_id:        Joi.number().integer().positive().optional(),
  user_id:              Joi.number().integer().positive().optional(),
});

const updateBody = createBody.fork(
  ['efr_name', 'efr_no', 'efr_cityId', 'efr_service_category', 'efr_service_type'],
  (schema) => schema.optional()
).min(1); // require at least one field

const statusBody = Joi.object({
  active:    Joi.boolean().required(),
  reasonId:  Joi.number().integer().positive().when('active', { is: false, then: Joi.optional(), otherwise: Joi.forbidden() }),
  comment:   Joi.string().max(500).when('active',  { is: false, then: Joi.optional(), otherwise: Joi.forbidden() }),
});

const idParam = Joi.object({
  id: Joi.number().integer().positive().required(),
});

// Shared pagination schema for sub-resource list endpoints
// (/admin/easyfixers/:id/transactions, /:id/mapped-clients).
const listSubresourceQuery = Joi.object({
  limit: Joi.number().integer().min(1).max(500).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

// Body schema for the lazy-fill sub-resource endpoints:
//   POST /admin/easyfixers/aggregates
//   POST /admin/easyfixers/attendance
// The 1000-id cap matches the slice() guard in the service layer.
const efrIdsBody = Joi.object({
  efrIds: Joi.array().items(Joi.number().integer().positive()).min(1).max(1000).required(),
});

// ─── Verification page schemas ─────────────────────────────────────
// Section names mirror the legacy `comment_in_section` strings exactly
// so the comments thread is interoperable with the legacy CRM during
// the cutover window. Keep these in sync with SECTION in
// services/easyfixer-verification.service.js.
const VERIFICATION_SECTIONS = [
  'Registration Details Section',
  'Professional Details Section',
  'Personal Details Section',
  'Banking Details Section',
  'Identity Details Section',
  'Technician Activation Section',
];

const commentBody = Joi.object({
  text:    Joi.string().min(1).max(2000).required(),
  section: Joi.string().valid(...VERIFICATION_SECTIONS).required(),
});

const leadVerificationBody = Joi.object({
  // 0 = Not Eligible / New Lead, 1 = Accepted, 2 = Denied (mirrors legacy)
  personal_details_filled: Joi.number().integer().valid(0, 1, 2).required(),
  reason:     Joi.string().max(1000).allow('', null).optional(),
  efr_cityId: Joi.number().integer().positive().optional(),
});

const professionalBody = Joi.object({
  skill_rating:         Joi.number().integer().min(0).max(10).optional(),
  tool_rating:          Joi.number().integer().min(0).max(10).optional(),
  skill_rating_comment: Joi.string().max(2000).allow('', null).optional(),
  tool_rating_comment:  Joi.string().max(2000).allow('', null).optional(),
  experience_id:        Joi.number().integer().valid(1, 2, 3, 4).optional(),
  progress:             Joi.number().integer().min(0).max(100).optional(),
}).min(1);

const personalFamilyBody = Joi.object({
  is_verified:          Joi.boolean().required(),
  verification_comment: Joi.string().max(2000).allow('', null).optional(),
});

const bankingVerificationBody = Joi.object({
  verification_status:  Joi.number().integer().valid(1, 2).required(), // 1=valid, 2=invalid
  verification_comment: Joi.string().max(2000).allow('', null).when('verification_status', {
    is: 2, then: Joi.string().min(1).max(2000).required(),
  }),
});

const identityVerificationBody = Joi.object({
  verification_status:  Joi.number().integer().valid(1, 2).optional(),
  rejected_reason:      Joi.string().max(2000).allow('', null).optional(),
  adhaar_card_number:   Joi.string().pattern(/^[0-9]{12}$/).optional(),
  pan_card_number:      Joi.string().pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/i).optional(),
  progress:             Joi.number().integer().min(0).max(100).optional(),
}).min(1);

const activationBody = Joi.object({
  activate:                  Joi.boolean().optional(),
  grade:                     Joi.string().valid('Silver', 'Gold', 'Diamond').optional(),
  final_accept_comment:      Joi.string().max(2000).optional(),
  is_eligible_for_offline_orders: Joi.number().integer().valid(0, 1).optional(),
  // Banking sub-fields (Edit Finance Details)
  easyfix_bank_name_id:      Joi.number().integer().min(0).optional(),
  beneficiary_id:            Joi.string().max(100).allow('', null).optional(),
}).min(1);

const mapClientsBody = Joi.object({
  client_ids: Joi.array().items(Joi.number().integer().positive()).max(500).required(),
});

const bgvReportBody = Joi.object({
  bgv_report_img_name: Joi.string().max(500).required(),
});

module.exports = {
  listQuery, createBody, updateBody, statusBody, idParam, listSubresourceQuery, efrIdsBody,
  commentBody, leadVerificationBody, professionalBody, personalFamilyBody,
  bankingVerificationBody, identityVerificationBody, activationBody,
  mapClientsBody, bgvReportBody,
};
