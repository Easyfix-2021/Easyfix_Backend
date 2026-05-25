const path = require('node:path');
const fs = require('node:fs');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');

const { buildOpenApiPaths } = require('./openapi-autogen');

/*
 * Swagger / OpenAPI UI + spec — auto-generated from the live app.
 *
 * Surfaces (mounted in server.js):
 *
 *   GET /api/docs           — Swagger UI (interactive)
 *   GET /api/openapi.json   — Raw OpenAPI 3 spec (for codegen tools)
 *
 * How the spec is assembled:
 *
 *   1. STATIC SCAFFOLDING comes from `docs/openapi.yaml` — info, servers,
 *      tag descriptions, security-scheme definitions, reusable schemas
 *      (Job, Notice, etc.). Hand-curated so the spec has rich docs.
 *
 *   2. PATHS are generated at runtime by `openapi-autogen.js` walking
 *      `app._router.stack`. Every registered route with a Joi validator
 *      auto-appears in the docs — zero YAML maintenance. The autogen
 *      reads the `_openapi` tags on `validate()` + auth middlewares to
 *      extract request schemas + security schemes.
 *
 *   3. Build is LAZY-on-first-request — by the time someone visits
 *      /api/docs, server.js has called `init(app)` so the spec is ready.
 *      Cached after first build; rebuild only happens on server restart.
 *
 * Enable / disable: strict opt-in via SWAGGER_ENABLED=true env. Default
 * OFF in every environment (see .env.example).
 */

const SPEC_PATH = path.join(__dirname, 'openapi.yaml');

function isEnabled() {
  return String(process.env.SWAGGER_ENABLED || '').toLowerCase() === 'true';
}

// Reference to the Express app — set by init(app). Until init runs,
// the spec build returns the static scaffolding only (no paths).
let _app = null;
let _cachedSpec = null;

/*
 * Call once from server.js AFTER all routes are mounted:
 *
 *   app.use('/api', routes);
 *   require('./docs/swagger').init(app);
 *
 * Caches the app reference so the lazy spec-build can introspect
 * `app._router.stack`. We don't build the spec NOW because some routes
 * may be mounted lazily; but in practice everything's registered by the
 * end of server.js's module load, so first-request build returns the
 * full picture.
 */
function init(app) {
  _app = app;
}

function buildSpec() {
  if (_cachedSpec) return _cachedSpec;

  // 1. Load the static scaffolding (info, servers, schemas, security, tags).
  const raw = fs.readFileSync(SPEC_PATH, 'utf8');
  const spec = yaml.load(raw);

  // 2. REPLACE the hand-written paths with auto-derived ones. The YAML's
  //    paths section becomes irrelevant — everything comes from the
  //    live router stack. Hand-curated paths used to be here; they're
  //    deleted to make the autogen the only source of truth.
  spec.paths = _app ? buildOpenApiPaths(_app) : {};

  // 3. Patch `servers` so "Try it out" hits the current runtime.
  const runtimeBase = process.env.SWAGGER_PUBLIC_URL
    || `http://localhost:${process.env.PORT || 5100}/api`;
  if (runtimeBase && Array.isArray(spec.servers)) {
    const filtered = spec.servers.filter((s) => s.url !== runtimeBase);
    spec.servers = [{ url: runtimeBase, description: 'Current runtime' }, ...filtered];
  }

  _cachedSpec = spec;
  return spec;
}

/*
 * Express mountable. When SWAGGER_ENABLED isn't 'true', returns a 404
 * handler so the docs surface isn't even advertised. When enabled,
 * lazily builds the spec on first request + serves the standard
 * swagger-ui-express bundle.
 */
function makeDocsMiddleware() {
  if (!isEnabled()) {
    return (_req, res) => res.status(404).json({ success: false, error: 'docs disabled' });
  }
  // Lazy build: we can't call buildSpec() at module-load time because
  // routes aren't mounted yet. Instead, swagger-ui-express's `setup()`
  // accepts a function for the spec — it's called per request, but
  // buildSpec() memoises so the cost is one-time.
  return [
    ...swaggerUi.serve,
    (req, res, next) => swaggerUi.setup(buildSpec(), {
      customSiteTitle: 'EasyFix Backend API',
      swaggerOptions: {
        persistAuthorization: true,
        defaultModelsExpandDepth: 1,
        docExpansion: 'list',
        filter: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      },
      customCss: '.swagger-ui .topbar { display: none } .swagger-ui .info { margin: 20px 0 }',
    })(req, res, next),
  ];
}

function jsonSpecHandler(_req, res) {
  if (!isEnabled()) {
    return res.status(404).json({ success: false, error: 'docs disabled' });
  }
  res.json(buildSpec());
}

module.exports = {
  isEnabled,
  init,
  makeDocsMiddleware,
  jsonSpecHandler,
};
