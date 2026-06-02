const router = require('express').Router();
const { pool, getPoolStats } = require('../db');
const { modernOk, modernError } = require('../utils/response');
const integrationRouter = require('./integration');

router.get('/health', (_req, res) => {
  modernOk(res, { status: 'ok', uptime: process.uptime() });
});

router.get('/health/db', async (_req, res) => {
  const started = Date.now();
  try {
    const [rows] = await pool.query('SELECT 1 AS ok, DATABASE() AS db, NOW() AS ts');
    return modernOk(res, {
      db: rows[0].db,
      ts: rows[0].ts,
      latencyMs: Date.now() - started,
      pool: getPoolStats(),
    });
  } catch (err) {
    return modernError(res, 503, 'database unavailable', { code: err.code, pool: getPoolStats() });
  }
});

// Auth routes — public; JWT issued on successful OTP verification.
router.use('/auth', require('./auth'));

// Shared lookups (cities, services, clients, users, etc.) — auth required.
router.use('/shared', require('./shared'));

// Admin routes — requireAuth + role(['admin']) applied inside admin router.
router.use('/admin', require('./admin'));

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
