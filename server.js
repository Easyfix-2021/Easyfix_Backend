require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const compression = require('compression');

const logger = require('./logger');
const cors = require('./cors');
const { testConnection, closePool } = require('./db');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/error-handler');
const { rateLimit } = require('./middleware/rate-limit');
const httpLog = require('./middleware/http-log');
const requestContext = require('./utils/request-context');
const scheduler = require('./server/scheduler');

const app = express();
const PORT = parseInt(process.env.PORT || '5100', 10);

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(httpLog);

app.use(cors);
app.use(compression({ threshold: 1024 }));
/*
 * ─── JSON BODY LIMIT: 25 MB, GLOBAL ──────────────────────────────────────────
 *
 * WHY 25 MB (2026-08-07, business-owner call). The only caller that needs it is
 * the PUBLIC website-booking route (routes/public/website-booking.js), which
 * accepts up to FIVE customer photos of the fault as base64 data URLs inline in
 * the JSON body. Its combined DECODED ceiling is 12 MB; base64 emits 4 chars per
 * 3 bytes, so a maximal legal booking is ≈16.8 M characters on the wire, plus
 * the address / description / data-URL-prefix slack. 25 MB clears that with
 * ~8 MB of headroom, so a booking we would ACCEPT can never die at body-parser
 * with an opaque 413 instead of our own field-level 400.
 *
 * ⚠ BLAST RADIUS — THIS IS NOT SCOPED TO THAT ROUTE. It is the app-level parser,
 * so it applies to EVERY route on this backend: /api/admin, /api/client,
 * /api/mobile, /api/integration, /api/webhook, /api/public, /api/internal. Any
 * endpoint will now buffer up to 25 MB of request body IN MEMORY before its
 * handler — or even its Joi validator — sees a single field. Nothing about the
 * per-route validators changed; the exposure is the buffering itself.
 *
 * What actually bounds the abuse is the rate limiting, not this number:
 *   · /api/integration — 1200/min per Basic-Auth identity (mounted below)
 *   · /api/mobile      — 600/min per IP
 *   · /api/client      — 600/min per IP
 *   · /api/public/website-booking — its OWN 8-per-10-min per-IP submit limiter
 *     (routes/public/website-booking.js), which is the real cap on how much
 *     photo payload one IP can push at us.
 *   · /api/admin       — DELIBERATELY UNCAPPED (see the Phase 14 note below):
 *     capping it would self-DoS a staff data-entry spree. Admin is authenticated
 *     staff, so the 25 MB ceiling there is a trusted-caller footgun, not an
 *     anonymous-attacker surface.
 *
 * ALTERNATIVE CONSIDERED AND NOT TAKEN — a PATH-SCOPED parser:
 *
 *     app.use('/api/public/website-booking', express.json({ limit: '25mb' }));
 *     app.use(express.json({ limit: '10mb' }));            // global stays small
 *
 * mounted in THAT order (scoped one FIRST). That would confine the larger limit
 * to the single route that needs it and leave every other endpoint at 10 MB. It
 * was rejected only to keep one obvious, greppable number rather than two
 * order-dependent ones — if the exposure above ever becomes a concern, this is
 * the change to make, and the ORDER is the whole trick.
 *
 * What does NOT work, and was MEASURED rather than assumed: mounting a
 * router-level `express.json({ limit: '25mb' })` inside routes/public/* AFTER
 * this global parser. body-parser sets `req._body = true` once it has parsed,
 * and every later express.json() instance short-circuits on that flag, so the
 * inner parser never runs; and a body over the GLOBAL limit is rejected by this
 * line with `entity.too.large` (HTTP 413) before the router is reached at all.
 * Reproduced against this exact mount order: inner parser observed `req._body`
 * already true on a small body, and a body over the global limit returned 413
 * `entity.too.large` with the router-level middleware never invoked. A
 * router-level override is therefore dead code that LOOKS load-bearing.
 *
 * urlencoded is DELIBERATELY LEFT AT 10 MB. Nothing posts photos (or anything
 * else multi-MB) as form-encoded — website-booking is JSON-only, and file
 * uploads elsewhere go through multer/multipart, which this parser never sees.
 * Raising it would widen the buffered-body surface for zero benefit, and
 * urlencoded is the more expensive parse per byte (qs key explosion). The two
 * limits differing is intentional, not an oversight.
 */
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Bind the request into AsyncLocalStorage so every log line emitted while
// handling it (logger.* in handlers/services) is auto-stamped with the request's
// surface + identity. Mounted AFTER the body parsers ON PURPOSE: those read the
// request stream (created before our middleware) and the handler continuation
// chains off the stream's 'end' event, which would drop an als.run() established
// earlier. From here on the chain is sync-dispatch + promise-awaits, which
// AsyncLocalStorage preserves. (httpLog above doesn't need this — it reads `req`
// directly.) Verified: context survives the parser + awaited DB calls.
app.use((req, res, next) => requestContext.run(req, next));

// Maintenance gate — 503s API traffic while an in-process destructive operation
// runs (today: the QA database refresh, which drops the schema this process is
// connected to). Mounted AFTER request-context so the refusals still log with
// their request identity, and BEFORE the routes so no handler can reach a
// half-restored database. Inert unless a job raises it; /api/health stays exempt
// so Docker's HEALTHCHECK can't restart the container mid-restore.
app.use(require('./middleware/maintenance').maintenance);

// Phase 14 — per-tier rate limits. Integration + mobile + client get their own
// bucket; admin is uncapped to avoid self-DoSing a data-entry spree.
app.use('/api/integration', rateLimit({ windowMs: 60_000, max: 1200, key: (req) =>
  req.headers.authorization ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':')[0] : req.ip }));
app.use('/api/mobile', rateLimit({ windowMs: 60_000, max: 600 }));
app.use('/api/client', rateLimit({ windowMs: 60_000, max: 600 }));

// ─── Swagger / OpenAPI docs (auto-generated) ──────────────────────
// Audience: Mobile App + Client Dashboard developers consuming this
// backend. Mounted BEFORE the main `/api` router so the docs surface
// isn't behind requireAuth — devs read the spec without a token, then
// paste credentials into the "Authorize" dialog to try endpoints.
//
// The spec is AUTO-DERIVED from the live Express + Joi setup:
//   - openapi-autogen walks app._router.stack at first-request time
//   - validate() middlewares carry _openapi tags so their Joi schemas
//     become parameter / requestBody schemas in the docs
//   - auth middlewares carry _openapi.security so the right Bearer
//     scheme is attached automatically
//   - Adding a new route + Joi validator is sufficient for the route
//     to appear in /api/docs. Zero YAML to maintain.
//
// Strict opt-in via SWAGGER_ENABLED=true env (default OFF every env).
const swaggerDocs = require('./docs/swagger');
app.use('/api/docs', swaggerDocs.makeDocsMiddleware());
app.get('/api/openapi.json', swaggerDocs.jsonSpecHandler);

// Public router — token-only auth (verifyJobToken + requireUnconfirmedJob
// applied per-endpoint). Used by the customer magic-link form. Mounted
// before the main /api router so no admin middleware (requireAuth /
// maskMobile) accidentally wraps it. Express matches more-specific path
// prefixes first, so /api/public/* lands here and never reaches the
// authed routes aggregator.
app.use('/api/public', require('./routes/public'));

// Internal router — machine-to-machine only (currently the legacy Java CRM's
// /resolveJobImage action). Auth is a shared secret header per-endpoint, NOT a
// JWT. Mounted here — a sibling of /api/public, ahead of the /api aggregator —
// so no requireAuth / maskMobile middleware wraps it.
app.use('/api/internal', require('./routes/internal'));

app.use('/api', routes);

// Public URL shortener redirect — `GET /book/:code` → 302 to the long URL.
// Mounted at the Express root (NOT under /api/public) so the resulting
// short links are actually short. Lives below the /api mounts so it
// can't accidentally shadow them; the inner router only registers
// /book/:code so non-matching paths fall through to the 404 handler.
app.use('/', require('./routes/public/url-shortener'));

// Tell the swagger module which Express app to introspect. Called
// AFTER `app.use('/api', routes)` so the entire router stack is
// registered by the time the first /api/docs request triggers the
// spec build. swaggerDocs.init() just caches the `app` reference;
// the actual walk happens lazily on first request.
swaggerDocs.init(app);

app.use(notFound);
app.use(errorHandler);

async function start() {
  try {
    await testConnection();
  } catch (err) {
    logger.error(`Could not connect to the database — ${err.message || err.code}. Server will not start.`);
    process.exit(1);
  }

  // Warm the easyfix_properties cache so getProperty(...) is sync from
  // the first request onward. Failure here is non-fatal — the service
  // logs a warn and callers fall back to process.env.
  try {
    await require('./services/properties.service').preload();
  } catch (err) {
    logger.warn(`Properties preload failed — ${err.message}. Continuing with env-only config.`);
  }

  // Schema parity check — fails the boot if any column the code touches
  // is missing from the live INFORMATION_SCHEMA. Caught 6 phantom-column
  // bugs during the final migration audit; cheap to run on every start
  // (~50ms of metadata queries).
  // Override with SKIP_SCHEMA_VERIFY=true for emergency boots.
  if (String(process.env.SKIP_SCHEMA_VERIFY).toLowerCase() !== 'true') {
    try {
      const { verifySchemaAgainstLiveDb } = require('./scripts/schema-verify');
      const report = await verifySchemaAgainstLiveDb();
      if (!report.ok) {
        logger.error(`Schema parity check FAILED — ${report.requiredMismatches.length} mismatches:`);
        for (const m of report.requiredMismatches) {
          logger.error(`  ${m.table}.${m.col || m.missing}`);
        }
        logger.error('Server will not start. Run migrations or set SKIP_SCHEMA_VERIFY=true to override.');
        process.exit(1);
      }
      logger.info(`Schema parity OK — ${report.columnsChecked} columns / ${report.tablesChecked} tables verified` +
        (report.optionalMissing.length ? ` (${report.optionalMissing.length} optional tables missing — handled gracefully)` : ''));
    } catch (err) {
      logger.error(`Schema verify crashed — ${err.message}. Server will not start.`);
      process.exit(1);
    }
  } else {
    logger.warn('Schema verify SKIPPED via SKIP_SCHEMA_VERIFY=true.');
  }

  const server = app.listen(PORT, () => {
    const env = process.env.NODE_ENV || 'development';
    logger.ready(`Server is ready — listening on http://localhost:${PORT} (${env} mode)`);
    /*
     * ENVIRONMENT is not a label — it GATES destructive, environment-specific
     * behaviour. The QA database refresh registers its cron and runs only when
     * this is exactly 'qa' (server/scheduler.js + qa-db-refresh.service.js), and
     * it names the environment in ops alert emails.
     *
     * A wrong or missing value is otherwise SILENT: the job simply never
     * registers, no error is raised, and the first symptom is someone noticing
     * weeks later that QA data is stale. So state the resolved value plainly at
     * boot, and warn when it's absent. Distinct from NODE_ENV above, which is
     * about build/runtime mode, not about which deployment this process IS.
     */
    const deployEnv = String(process.env.ENVIRONMENT || '').trim();
    if (!deployEnv) {
      logger.warn(
        'ENVIRONMENT is NOT set — environment-gated jobs (e.g. the QA database refresh) will '
        + 'refuse to run and ops alerts will be labelled "unknown". Set it in the compose '
        + 'environment: block ("qa" / "production"), or in .env for local dev.',
      );
    } else if (deployEnv.toLowerCase() === 'qa') {
      logger.info(`ENVIRONMENT = "${deployEnv}" — QA-only jobs are ARMED on this host (incl. the database refresh, which drops and reloads ${process.env.DB_NAME || 'the DB'}).`);
    } else {
      logger.info(`ENVIRONMENT = "${deployEnv}" — QA-only jobs are disabled on this host.`);
    }
    if (process.env.TEST_EMAILS || process.env.TEST_MOBILE) {
      logger.test(`TEST MODE active — outgoing emails redirect to "${process.env.TEST_EMAILS || '—'}", SMS/WhatsApp to "${process.env.TEST_MOBILE || '—'}".`);
    }
    if (String(process.env.NOTIFICATIONS_DISABLE).toLowerCase() === 'true') {
      logger.test(`Notifications DISABLED — no real SMS / email / WhatsApp / push will be sent.`);
    }
    // Fail loud if the FCM v1 service account is missing — otherwise every push
    // silently returns not-delivered (the prod incident on 2026-07-02).
    if (!require('./services/fcm.service').isConfigured()) {
      logger.warn('FCM v1 NOT configured — push notifications will NOT be sent. Set FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY.');
    }
    // Register cron jobs only AFTER the HTTP listener is up — guarantees
    // a job can't fire before the app is healthy enough to serve dependent
    // queries. CRON_DISABLED=true env flag short-circuits inside init().
    scheduler.init();
  });

  // AI-calling media websocket (Plivo <Stream> ⇄ OpenAI Realtime). Attached to
  // the SAME HTTP server's `upgrade` event (no extra port). Wrapped so a missing
  // `ws` dependency or any attach error degrades the AI-calling flow to OFF
  // WITHOUT crashing the shared backend. Gated per-connection by ai.calling.enabled.
  try {
    require('./services/ai-voice-server.service').attach(server);
  } catch (err) {
    logger.warn(`AI voice ws server not attached — ${err.message}. AI-calling flow disabled (shared backend unaffected).`);
  }
  // AI Teleprompter STT sidecar (self-hosted OSS speech-to-text). Auto-started as a
  // managed child process ONLY when STT_AUTOSTART=true (model loads once, not
  // per-call); otherwise a no-op (run the sidecar separately + set STT_SERVICE_URL).
  // Guarded so a missing Python / spawn failure can't disrupt the shared backend.
  try { require('./services/stt-sidecar.service').maybeStart(); } catch (err) { logger.warn('STT sidecar autostart skipped — ' + err.message); }
  // Re-drain any post-call mappings left at 'mapping' by a restart mid-queue
  // (the post-call queue is in-memory + bounded). Best-effort, non-blocking.
  try { require('./services/ai-post-call-queue').recoverPending(); } catch { /* noop */ }

  const shutdown = async (signal) => {
    logger.shutdown(`Shutdown requested (${signal}) — closing connections gracefully…`);
    // Close any live AI-call media sockets FIRST (while the DB pool is still
    // open) so each call's teardown can persist its transcript/result. Guarded
    // so a missing/never-attached ws server can't disrupt shutdown.
    try { require('./services/ai-voice-server.service').shutdown(); } catch { /* noop */ }
    try { require('./services/stt-sidecar.service').shutdown(); } catch { /* noop */ }
    try { require('./services/audio-transcode-pool').shutdown(); } catch { /* noop */ }
    // Stop cron BEFORE closing the HTTP server so an in-flight cron task
    // doesn't keep the pool alive past closePool().
    scheduler.stop();
    server.close(async () => {
      await closePool().catch(() => {});
      logger.shutdown('Server stopped. Goodbye.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start();
}

module.exports = app;
