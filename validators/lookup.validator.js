const Joi = require('joi');

const intId = Joi.number().integer().positive();
// Repeatable id query param: accepts ?clientId=1&clientId=2 (array) OR a bare
// ?clientId=1 (.single() wraps the scalar). Used to scope owner-options lookups
// by the selected client(s)/vertical(s) on the QuickSight reports.
const idArray = Joi.array().items(intId).single();

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
// Optional clientId/verticalId scope the SPOC list to the selected client(s)/
// vertical(s) (QuickSight Client Performance "Project Manager" filter).
const projectManagersQuery = Joi.object({
  userType: Joi.number().integer().valid(1, 2).optional(),
  clientId: idArray.optional(),
  verticalId: idArray.optional(),
});

// Zonal Managers picker — optional clientId/verticalId scope the list to zonal
// owners of cities that back jobs for the selected client(s)/vertical(s)
// (QuickSight Open Orders / City Performance / Client Performance). Omitting
// both returns the full global list (Manage Easyfixers back-compat).
const zonalManagersQuery = Joi.object({
  clientId: idArray.optional(),
  verticalId: idArray.optional(),
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
  zonalManagersQuery,
};
