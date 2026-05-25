/*
 * OpenAPI auto-generator — turns the live Express app into a Swagger spec
 * at runtime. NO hand-written YAML for endpoints. Adding a route +
 * Joi validator means the route appears in /api/docs automatically.
 *
 * How it works:
 *
 *   1. Walk `app._router.stack` recursively. For every layer that's a
 *      Route, record (method, full-path, middleware-chain). For every
 *      layer that's a mounted sub-router, recurse with the mount prefix.
 *
 *   2. For each route, walk its middleware chain and look for two
 *      kinds of introspection tags:
 *
 *        - `validate()` returns a middleware with `_openapi = { schema, source }`
 *          → schema is converted via joi-to-swagger to a JSON Schema
 *            object; placed into `parameters` (when source = path/query)
 *            or `requestBody` (when source = body).
 *
 *        - Auth middlewares (`requireAuth`, `requireTechAuth`,
 *          `requireSpocAuth`) carry `_openapi = { security: '<scheme>' }`
 *          → mapped to the corresponding `securitySchemes` entry.
 *
 *   3. Tier prefix → tag mapping derives a default tag from the path
 *      so endpoints group sensibly in Swagger UI without anyone having
 *      to write a tag line by hand.
 *
 *   4. Merge with `docs/openapi-base.js` (the static info / servers /
 *      schemas / securitySchemes scaffolding) and serve.
 *
 * Adding a richer description for one endpoint? Use the `describe()`
 * helper (see `routeMeta()` at the bottom of this file) — attach a no-
 * op middleware tagged with `_openapi = { summary, description, tags }`
 * to override the defaults. This is purely opt-in; the autogen produces
 * usable docs without it.
 */

const j2s = require('joi-to-swagger');

// ─── Public entry ───────────────────────────────────────────────────
function buildOpenApiPaths(app) {
  const routes = collectRoutes(app);
  const paths = {};
  for (const r of routes) {
    if (shouldSkipRoute(r)) continue;
    const apiPath = expressToOpenApiPath(r.path);
    if (!paths[apiPath]) paths[apiPath] = {};
    paths[apiPath][r.method.toLowerCase()] = buildOperation(r);
  }
  return paths;
}

// ─── Step 1: walk Express's router tree ─────────────────────────────
/*
 * Recursively descend `app._router.stack`. Each "layer" is one of:
 *   - layer.route        → a leaf route declaration (router.get('/x', …))
 *   - layer.name === 'router' && layer.handle.stack
 *                        → a mounted sub-router (router.use('/admin', …))
 *   - everything else    → middleware that doesn't define routes (cors,
 *                          body parsers, error handlers, …); ignored.
 *
 * `layer.regexp` for a mounted sub-router encodes the mount path; we
 * extract the literal prefix from it (Express stores e.g.
 * `/^\/admin\/?(?=\/|$)/i` for `router.use('/admin', …)`).
 */
function collectRoutes(app) {
  if (!app._router || !Array.isArray(app._router.stack)) return [];
  const out = [];
  walk(app._router.stack, '', out);
  return out;
}

function walk(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      // Direct route — push one record per HTTP method.
      const fullPath = joinPath(prefix, layer.route.path);
      const middlewares = layer.route.stack.map((s) => s.handle);
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (!enabled) continue;
        out.push({ method: method.toUpperCase(), path: fullPath, middlewares });
      }
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      // Mounted sub-router — recurse with the resolved prefix.
      const sub = prefix + extractMountPrefix(layer);
      walk(layer.handle.stack, sub, out);
    }
    // Other middlewares (`layer.handle` without `.route` or `.stack`)
    // don't contribute routes; they may be tier-level auth applied via
    // `router.use(requireAuth)` — we don't pick those up via this
    // traversal directly, but they get attached when we see the
    // sub-router as part of a tier-level `router.use()` chain (see
    // resolveSecurityForRoute() below).
  }
}

function extractMountPrefix(layer) {
  // Express stores `/^\/<prefix>\/?(?=\/|$)/i` for typical mount paths.
  // The cleanest extraction is the `keys`-aware path-to-regexp source,
  // but Express also exposes `layer.regexp.fast_slash` for `/` mounts.
  if (layer.regexp.fast_slash) return '';
  if (layer.path) return layer.path;        // newer Express versions
  const src = layer.regexp.toString();
  // Match: /^\/admin\/?(?=\/|$)/i  →  capture "admin"
  const m = /^\/\^\\\/(.+?)\\\/\?\(\?=\\\/\|\$\)\/i$/.exec(src);
  if (m) return '/' + m[1].replace(/\\\//g, '/');
  // Fallback: strip the regex anchors heuristically.
  return '/' + src.replace(/^\/\^\\\//, '').replace(/\\\/\?\(\?=\\\/\|\$\)\/i$/, '').replace(/\\\//g, '/');
}

function joinPath(prefix, p) {
  if (!prefix) return p;
  if (p === '/' || p === '') return prefix;
  return (prefix + p).replace(/\/+/g, '/');
}

// ─── Step 2: per-route metadata extraction ──────────────────────────
function buildOperation(route) {
  const op = {
    tags: [inferTag(route.path)],
    summary: inferSummary(route),
    parameters: [],
    responses: defaultResponses(),
  };

  // Security — first auth middleware we find on the chain wins.
  const security = resolveSecurityForRoute(route);
  if (security) op.security = [{ [security]: [] }];

  // Walk validation middlewares + custom describe() metadata.
  for (const mw of route.middlewares) {
    if (!mw || !mw._openapi) continue;
    const meta = mw._openapi;

    if (meta.schema) {
      // joi-to-swagger conversion. Wrapped in try/catch so a single
      // exotic Joi shape doesn't crash the whole spec build.
      let converted;
      try { converted = j2s(meta.schema).swagger; }
      catch (e) {
        converted = { type: 'object', description: `joi-to-swagger failed: ${e.message}` };
      }
      const source = meta.source || 'body';
      if (source === 'body') {
        op.requestBody = {
          required: true,
          content: { 'application/json': { schema: converted } },
        };
      } else if (source === 'query' || source === 'params') {
        // Decompose the object schema into individual parameter entries.
        const props = (converted && converted.properties) || {};
        const required = new Set((converted && converted.required) || []);
        for (const [name, propSchema] of Object.entries(props)) {
          op.parameters.push({
            in: source === 'params' ? 'path' : 'query',
            name,
            required: source === 'params' || required.has(name),
            schema: propSchema,
          });
        }
      }
    }
    if (meta.summary)     op.summary     = meta.summary;
    if (meta.description) op.description = meta.description;
    if (meta.tags)        op.tags        = Array.isArray(meta.tags) ? meta.tags : [meta.tags];
    if (meta.requestBody) op.requestBody = meta.requestBody;       // override
    if (meta.responses)   op.responses   = { ...op.responses, ...meta.responses };
  }

  // Path params declared in the URL but not covered by a Joi validator —
  // still need to appear in `parameters` for the spec to validate.
  const pathParams = matchPathParams(route.path);
  for (const param of pathParams) {
    if (!op.parameters.some((p) => p.in === 'path' && p.name === param)) {
      op.parameters.push({
        in: 'path', name: param, required: true,
        schema: { type: 'string' },
        description: '(undocumented — add a Joi params validator with this field to enrich)',
      });
    }
  }

  return op;
}

function resolveSecurityForRoute(route) {
  for (const mw of route.middlewares) {
    if (mw && mw._openapi && mw._openapi.security) return mw._openapi.security;
  }
  // Heuristic fallback based on path tier — covers cases where the
  // auth middleware is applied at the router-mount level (e.g.
  // `router.use(requireAuth)` in routes/admin/index.js) and therefore
  // isn't on the route's own `stack`. Picks the right Bearer scheme by
  // path prefix. Strip the `/api` mount-root prefix first so the
  // checks work whether the autogen sees `/api/admin/x` or `/admin/x`.
  const p = route.path.replace(/^\/api(?=\/|$)/, '');
  if (p.startsWith('/admin/'))   return 'bearerAdmin';
  if (p.startsWith('/mobile/'))  return 'bearerTech';
  if (p.startsWith('/client/'))  return 'bearerClient';
  if (p.startsWith('/shared/'))  return 'bearerAdmin';     // any-tier; pick admin as the default
  if (p.startsWith('/integration/v1/')) return 'basicIntegration';
  return null;
}

function inferTag(p) {
  // /api/admin/notices/:id → "Admin — Notices"; /api/mobile/jobs → "Mobile — Jobs"; etc.
  // Strip the leading `/api` if present so the tier extraction works
  // whether the autogen sees `/api/...` or `/...`.
  const stripped = p.replace(/^\/api(?=\/|$)/, '');
  const m = /^\/([^/]+)(?:\/([^/]+))?/.exec(stripped);
  if (!m) return 'Other';
  const tier = m[1];
  const segment = m[2];
  const tierLabel = ({
    admin: 'Admin', mobile: 'Mobile', client: 'Client', shared: 'Shared',
    auth: 'Auth', integration: 'Integration', health: 'Health',
  })[tier] || cap(tier);
  if (!segment || segment.startsWith(':') || segment.startsWith('{')) return tierLabel;
  return `${tierLabel} — ${cap(segment.replace(/-/g, ' '))}`;
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function inferSummary(route) {
  // Generic auto-summary — e.g. "POST /admin/notices/{noticeId}/publish".
  // Devs who want richer text attach a `describe()` middleware (see
  // `routeMeta` below).
  return `${route.method} ${expressToOpenApiPath(route.path)}`;
}

function matchPathParams(p) {
  const out = [];
  for (const m of p.matchAll(/:([a-zA-Z0-9_]+)/g)) out.push(m[1]);
  return out;
}

function expressToOpenApiPath(p) {
  return p.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
}

function defaultResponses() {
  return {
    '200': { description: 'Success' },
    '400': { description: 'Validation failed (Joi)' },
    '401': { description: 'Unauthorized' },
    '500': { description: 'Server error' },
  };
}

function shouldSkipRoute(r) {
  // Hide health probes from the consumer-facing docs; they're noisy and
  // not part of the API contract any frontend cares about.
  if (r.path === '/health' || r.path === '/health/db') return true;
  return false;
}

// ─── Optional: describe() helper for richer summaries / descriptions ─
/*
 * Usage in a route file:
 *
 *   const { describe } = require('../../docs/openapi-autogen');
 *   router.get(
 *     '/notices/:id',
 *     describe('Get notice detail by id', { tags: ['Admin — Notices'] }),
 *     validate(idParam, 'params'),
 *     handler,
 *   );
 *
 * `describe()` returns a no-op middleware tagged with `_openapi`
 * metadata the autogen consumes. Purely opt-in — every endpoint already
 * gets a usable summary from `inferSummary()`; describe() is for when
 * you want to write something better.
 */
function describe(summary, extras = {}) {
  const mw = (_req, _res, next) => next();
  mw._openapi = { summary, ...extras };
  return mw;
}

module.exports = { buildOpenApiPaths, describe };
