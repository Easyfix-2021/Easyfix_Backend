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
const scheduler = require('./server/scheduler');

const app = express();
const PORT = parseInt(process.env.PORT || '5100', 10);

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(httpLog);

app.use(cors);
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

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
    if (process.env.TEST_EMAILS || process.env.TEST_MOBILE) {
      logger.test(`TEST MODE active — outgoing emails redirect to "${process.env.TEST_EMAILS || '—'}", SMS/WhatsApp to "${process.env.TEST_MOBILE || '—'}".`);
    }
    if (String(process.env.NOTIFICATIONS_DISABLE).toLowerCase() === 'true') {
      logger.test(`Notifications DISABLED — no real SMS / email / WhatsApp / push will be sent.`);
    }
    // Register cron jobs only AFTER the HTTP listener is up — guarantees
    // a job can't fire before the app is healthy enough to serve dependent
    // queries. CRON_DISABLED=true env flag short-circuits inside init().
    scheduler.init();
  });

  const shutdown = async (signal) => {
    logger.shutdown(`Shutdown requested (${signal}) — closing connections gracefully…`);
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
