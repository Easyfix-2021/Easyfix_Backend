const Joi = require('joi');

const intId = Joi.number().integer().positive();

const citiesQuery = Joi.object({
  stateId: intId.optional(),
  q: Joi.string().min(1).max(100).optional(),
  limit: Joi.number().integer().min(1).max(1000).default(500),
  includeInactive: Joi.boolean().default(false),
});

const serviceTypesQuery = Joi.object({
  categoryId: intId.optional(),
  includeInactive: Joi.boolean().default(false),
});

const clientsQuery = Joi.object({
  q: Joi.string().min(1).max(100).optional(),
  limit: Joi.number().integer().min(1).max(500).default(100),
  offset: Joi.number().integer().min(0).default(0),
  includeInactive: Joi.boolean().default(false),
});

const clientServicesQuery = Joi.object({
  clientId: intId.required(),
  includeInactive: Joi.boolean().default(false),
});

const usersQuery = Joi.object({
  q: Joi.string().min(1).max(100).optional(),
  roleGroup: Joi.string().valid('admin', 'client', 'mobile', 'default').optional(),
  limit: Joi.number().integer().min(1).max(500).default(100),
  offset: Joi.number().integer().min(0).default(0),
  includeInactive: Joi.boolean().default(false),
});

const banksQuery = Joi.object({
  q: Joi.string().min(1).max(100).optional(),
});

const simpleIncludeInactive = Joi.object({
  includeInactive: Joi.boolean().default(false),
});

// Project Managers picker — optional user_type narrows to Primary (1) or
// Secondary (2) SPOC; omitted returns both. (tbl_vertical_mapping.user_type)
const projectManagersQuery = Joi.object({
  userType: Joi.number().integer().valid(1, 2).optional(),
});

module.exports = {
  citiesQuery,
  serviceTypesQuery,
  clientsQuery,
  clientServicesQuery,
  usersQuery,
  banksQuery,
  simpleIncludeInactive,
  projectManagersQuery,
};
