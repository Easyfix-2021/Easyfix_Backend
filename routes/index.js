const router = require('express').Router();
const { pool, getPoolStats } = require('../db');
const { getReadPoolStats, identify, breakerOpen } = require('../db-read');
const { modernOk, modernError } = require('../utils/response');
const integrationRouter = require('./integration');
const lookup = require('../services/lookup.service');

router.get('/health', (_req, res) => {
  // Surface the new-CRM menu-visibility filter alongside basic liveness so
  // ops can answer "why is menu X missing in prod?" with a single GET call
  // (and our smoke tests can assert the resolved set matches expectations
  // without DB diving). `enabled=false` means the allowlist is OFF and every
  // menu_status=1 row reaches the sidebar.
  const visible = lookup._test.resolveVisibleMenuIds();
  const overrideEmails = lookup._test.resolveMenuOverrideEmails();
  modernOk(res, {
    status: 'ok',
    uptime: process.uptime(),
    menuFilter: {
      enabled: visible !== null,
      visibleCount: visible ? visible.size : null,
      overrideEmailCount: overrideEmails.size,
    },
  });
});

/*
 * Reports BOTH pools.
 *
 * The replica block is the answer to "is the read replica ever actually
 * used?" — a question nothing else can answer, because a replica that is
 * unreachable and a replica that is serving every read both leave the
 * application working. `replica.reads` staying at 0 under real traffic is
 * the alarm; `distinctFromPrimary: false` catches the subtler case of
 * DB_READ_HOST pointing at the primary under another name, which sheds no
 * load while looking perfectly healthy.
 *
 * A replica probe failure does NOT make this endpoint 503. The replica is an
 * optimisation, and the service is healthy without it — reporting otherwise
 * would page someone for a degradation that costs nothing but throughput.
 */
router.get('/health/db', async (_req, res) => {
  const started = Date.now();
  try {
    const [rows] = await pool.query('SELECT 1 AS ok, DATABASE() AS db, NOW() AS ts');

    const replica = getReadPoolStats();
    /*
     * Skip the probe while the breaker is OPEN.
     *
     * An unreachable replica costs DB_READ_CONNECT_TIMEOUT (5s) per probe, and
     * this endpoint probed unconditionally — so on production, where the
     * replica is currently unreachable, /api/health/db took 5,003ms on EVERY
     * call. Any monitor or load-balancer check with a sub-5s timeout would
     * declare the backend unhealthy over an optimisation that is deliberately
     * wired to no flow at all.
     *
     * Reporting the last known state during the cooldown is not a loss of
     * information: reachable:false with the recorded error code is exactly
     * what the probe would have told us, arrived at without the wait. The
     * cooldown still lets one probe through periodically, so recovery is
     * detected on its own.
     */
    if (replica.configured && breakerOpen()) {
      replica.reachable = false;
      replica.probeSkipped = 'breaker open — reporting last known state without paying the connect timeout';
    } else if (replica.configured) {
      const t0 = Date.now();
      try {
        const id = await identify();
        replica.reachable = true;
        replica.latencyMs = Date.now() - t0;
        replica.readOnly = id.readOnly;
        replica.serverId = id.serverId;
        replica.hostname = id.hostname;
        replica.distinctFromPrimary = id.distinctFromPrimary;
      } catch (err) {
        replica.reachable = false;
        replica.error = err.code || err.message;
      }
    }

    return modernOk(res, {
      db: rows[0].db,
      ts: rows[0].ts,
      latencyMs: Date.now() - started,
      pool: getPoolStats(),
      replica,
    });
  } catch (err) {
    return modernError(res, 503, 'database unavailable', {
      code: err.code, pool: getPoolStats(), replica: getReadPoolStats(),
    });
  }
});

// Auth routes — public; JWT issued on successful OTP verification.
router.use('/auth', require('./auth'));

// Shared lookups (cities, services, clients, users, etc.) — auth required.
router.use('/shared', require('./shared'));

// Admin routes — requireAuth + role(['admin']) applied inside admin router.
router.use('/admin', require('./admin'));

// HRMS "My Profile" — SELF-SERVICE, for EVERY authenticated CRM user, so it
// mounts here rather than under /admin (which is role-gated, scope-filtered and
// mobile-masked — all three wrong for a user reading their own record). Every
// route inside acts on req.user.user_id only; see routes/profile.js.
router.use('/profile', require('./profile'));

// Client Dashboard (SPOC) — auth via tbl_client_contacts + OTP.
router.use('/client', require('./client'));

// Technician Mobile — auth via tbl_easyfixer + OTP.
router.use('/mobile', require('./mobile'));

// Integration routes — legacy contract, HTTP Basic Auth.
router.use('/integration', integrationRouter);

// Inbound provider webhooks (Gallabox WhatsApp conversational flow, etc.).
// No JWT — each sub-router verifies its own shared secret.
router.use('/webhook', require('./webhook'));

module.exports = router;
