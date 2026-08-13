/*
 * Joi validation wrapper.
 * Usage: router.post('/x', validate(schema), handler)
 *
 * On failure: responds 400 with { success:false, error:'Validation failed', details:[...] }
 * for modern routes, or legacy-shape for /api/integration/* routes.
 */

const { modernError, legacyError } = require('../utils/response');
const logger = require('../logger');
const { redactUrl } = require('../utils/log-format');

function isIntegrationRoute(req) {
  return req.originalUrl.startsWith('/api/integration/');
}

/*
 * Field-name allowlist for the request-body sample we log alongside a
 * 400 (2026-06-05). Keeps PII and secrets out of structured logs while
 * still surfacing the shape of the offending payload so prod debugging
 * is possible. Any field NOT on this list is replaced with `'***'` (or
 * `'<obj>'` for nested objects). Conservative by default — add a field
 * here only after confirming it's non-sensitive, since downstream sinks
 * (CloudWatch, etc.) will receive it.
 */
const LOGGABLE_FIELDS = new Set([
  'jobId', 'customerId', 'efrId', 'reportingContactId', 'spocJobId', 'useAlt',
  'page', 'limit', 'offset', 'status', 'statuses', 'mode', 'tab',
  'category_id', 'service_type_id', 'fk_client_id', 'fk_service_catg_id',
  'fk_service_type_id', 'deepskill_id', 'id', 'sourceType', 'type',
  'noticeId', 'roleId', 'menuId',
]);
function redactedSample(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!LOGGABLE_FIELDS.has(k)) { out[k] = '***'; continue; }
    if (v && typeof v === 'object') { out[k] = '<obj>'; continue; }
    out[k] = v;
  }
  return out;
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
      /*
       * Log every 400 (2026-06-05). Was previously silent — operators
       * hit "Validation failed" toasts on prod with no way for backend
       * ops to see what was rejected. `warn` level (not `error`) because
       * a 400 is a CLIENT mistake, not a server bug — but we still want
       * it visible in the default log stream for prod debugging. The
       * request body sample is redacted via the allowlist above so PII
       * / free-text fields never land in structured logs.
       */
      try {
        logger.warn({
          method: req.method,
          // A validation failure is exactly when a malformed identity value is
          // in flight, so this line must not carry it.
          url: redactUrl(req.originalUrl),
          source,
          details,
          sample: redactedSample(req[source]),
          userId: req.user?.user_id || null,
        }, '400 validation failed');
      } catch { /* logger failures must never propagate to the client */ }

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
