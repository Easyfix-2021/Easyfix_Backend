/*
 * Joi validation wrapper.
 * Usage: router.post('/x', validate(schema), handler)
 *
 * On failure: responds 400 with { success:false, error:'Validation failed', details:[...] }
 * for modern routes, or legacy-shape for /api/integration/* routes.
 */

const { modernError, legacyError } = require('../utils/response');

function isIntegrationRoute(req) {
  return req.originalUrl.startsWith('/api/integration/');
}

function validate(schema, source = 'body') {
  const mw = (req, res, next) => {
    const { value, error } = schema.validate(req[source], {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });

    if (error) {
      const details = error.details.map((d) => ({ field: d.path.join('.'), message: d.message }));
      if (isIntegrationRoute(req)) {
        return legacyError(res, 400, 'Validation failed', details);
      }
      return modernError(res, 400, 'Validation failed', details);
    }

    req[source] = value;
    return next();
  };
  // OpenAPI introspection tag — picked up by docs/openapi-autogen.js to
  // auto-generate request schemas. No runtime effect; pure metadata so the
  // autogen can find the Joi schema + its source (body / query / params)
  // by walking app._router.stack. This is how "create a route → it auto-
  // appears in /api/docs" works without any hand-written YAML.
  mw._openapi = { schema, source };
  return mw;
}

module.exports = validate;
