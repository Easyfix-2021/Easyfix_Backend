/*
 * RATE-LIMIT BUCKET-KEY tests for /api/public/website-booking.
 *
 * WHY THIS FILE EXISTS. `clientIp()` used to return the FIRST value of the
 * caller's own X-Forwarded-For header, and every limiter on this router keys on
 * it. Rotating one header therefore minted a fresh bucket per request and
 * defeated all three caps — on the only sub-router in this backend that is both
 * UNAUTHENTICATED and able to create master data (tbl_state / tbl_city /
 * tbl_pincode, via resolveCityId → pincodeService.ensurePincode) and spend
 * Google Geocoding budget. The fix keys on req.ip, which Express derives from
 * the trusted-proxy chain.
 *
 * WHAT IS ASSERTED. The TRACE, not the status code. A 429 looks identical
 * whichever key produced it, so every test here reads the actual bucket key the
 * router computed: middleware/rate-limit is wrapped in the require cache so each
 * `key(req)` is recorded on the way through, and the REAL limiter still runs
 * behind the wrapper (so the cap test is the real cap, at the real configured
 * max, read off the limiter's own options rather than hardcoded).
 *
 * THE PROXY MODEL. server.js does `app.set('trust proxy', 1)` for the single
 * nginx hop that fronts the backend, and that nginx sets X-Forwarded-For with
 * `$proxy_add_x_forwarded_for` — APPEND, not overwrite. So whatever the client
 * writes stays to the LEFT of the address nginx actually saw, and Express (with
 * one trusted hop) reads the RIGHTMOST entry. `nginx()` below reproduces exactly
 * that, which is what makes "same peer, different spoof" a meaningful test: both
 * requests really do arrive with different X-Forwarded-For values.
 *
 * NO DATABASE, NO JOB, NO GEOCODING. Every request is shaped to fail its Joi
 * schema, and validate() is mounted AFTER the limiter on all three routes — so
 * the bucket key is computed and recorded, then the request dies at 400 without
 * reaching a handler. The fake pool is installed only so requiring the router
 * cannot touch a real DB.
 *
 * Runner: `TZ=UTC node --test --test-force-exit tests/website-booking-ip-bucket.test.js`
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([]);

// ─── The seam: record every bucket key the router computes ───────────
/*
 * The three limiters are built at MODULE LOAD of the router, so the wrapper has
 * to be in the require cache before the router is required. It delegates to the
 * real rateLimit(), so the counting/429 behaviour under test is the production
 * one — the wrapper only observes the key and the configured max.
 */
const rateLimitPath = require.resolve('../middleware/rate-limit');
const realRateLimitModule = require(rateLimitPath);
const realRateLimit = realRateLimitModule.rateLimit;

/** Every bucket key computed, in request order. Cleared per test. */
const keys = [];
/** 'wb-post' → the max that limiter was actually configured with. */
const maxByPrefix = {};

require.cache[rateLimitPath].exports = {
  ...realRateLimitModule,
  rateLimit(opts) {
    const inner = realRateLimit(opts);
    return (req, res, next) => {
      const k = String(opts.key(req));
      keys.push(k);
      maxByPrefix[k.split(':')[0]] = opts.max;
      return inner(req, res, next);
    };
  },
};

const bookingRouter = require('../routes/public/website-booking');

// ─── Harness ─────────────────────────────────────────────────────────

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());

  // MIRRORS server.js:63. One trusted hop = the one nginx in front of us.
  app.set('trust proxy', 1);

  /*
   * Stand-in for nginx's `proxy_set_header X-Forwarded-For
   * $proxy_add_x_forwarded_for`: whatever the client sent is kept, and the
   * address nginx itself saw is APPENDED. `x-test-peer` is this harness's way
   * of saying "the real TCP peer nginx observed"; it is consumed here and never
   * reaches the router, so it is not a header the router could read.
   *
   * `x-test-direct` skips the proxy entirely, for the no-XFF socket-address
   * case (a request that reaches :5100 without passing nginx).
   */
  app.use((req, _res, next) => {
    const peer = req.headers['x-test-peer'];
    delete req.headers['x-test-peer'];
    if (req.headers['x-test-direct']) {
      delete req.headers['x-test-direct'];
      delete req.headers['x-forwarded-for'];
      return next();
    }
    const existing = req.headers['x-forwarded-for'];
    const seen = peer || '203.0.113.9';
    req.headers['x-forwarded-for'] = existing ? `${existing}, ${seen}` : seen;
    return next();
  });

  app.use('/api/public/website-booking', bookingRouter);
  // eslint-disable-next-line no-unused-vars -- Express needs the 4-arity form.
  app.use((err, _req, res, _next) => {
    res.status(err && err.status ? err.status : 500).json({ success: false });
  });

  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  require.cache[rateLimitPath].exports = realRateLimitModule;
  fake.restore();
});

/*
 * One request that is guaranteed to be rejected by Joi, so it never reaches a
 * handler — the limiter (mounted first on every route) has already run.
 *   post  → {} is missing every required field
 *   ctx   → ?code= 60 chars busts Joi's max(50)
 *   serv  → no ?pincode
 */
const PATHS = {
  post: { method: 'POST', path: '/', prefix: 'wb-post' },
  ctx: { method: 'GET', path: `/context?code=${'x'.repeat(60)}`, prefix: 'wb-ctx' },
  serv: { method: 'GET', path: '/serviceability', prefix: 'wb-serv' },
};

async function hit(which, { peer, headers = {} } = {}) {
  const spec = PATHS[which];
  const res = await fetch(`${baseUrl}/api/public/website-booking${spec.path}`, {
    method: spec.method,
    headers: {
      'content-type': 'application/json',
      ...(peer === undefined ? {} : { 'x-test-peer': peer }),
      ...headers,
    },
    ...(spec.method === 'POST' ? { body: '{}' } : {}),
  });
  return res.status;
}

/** The keys recorded since the last reset, then reset. */
function drainKeys() {
  const out = keys.slice();
  keys.length = 0;
  return out;
}

// ─── 1. The fix: a spoofed header can no longer choose the bucket ────

test('two requests with DIFFERENT spoofed X-Forwarded-For but the SAME peer share one bucket', async () => {
  drainKeys();
  await hit('post', { peer: '198.51.100.11', headers: { 'x-forwarded-for': '1.1.1.1' } });
  await hit('post', { peer: '198.51.100.11', headers: { 'x-forwarded-for': '2.2.2.2' } });

  const [first, second] = drainKeys();
  assert.equal(
    first, second,
    `spoofing the header changed the bucket key: ${first} vs ${second} — the cap can be rotated away`,
  );
  assert.equal(first, 'wb-post:198.51.100.11', 'bucket key must be the peer nginx saw');
});

// ─── 2. …without collapsing everyone into one bucket ─────────────────

test('genuinely different peers still get different buckets', async () => {
  drainKeys();
  await hit('post', { peer: '198.51.100.21' });
  await hit('post', { peer: '198.51.100.22' });

  const [a, b] = drainKeys();
  assert.equal(a, 'wb-post:198.51.100.21');
  assert.equal(b, 'wb-post:198.51.100.22');
  assert.notEqual(a, b, 'a key that ignores the client entirely would put all callers in one bucket');
});

// ─── 3. The cap still fires for one real client ──────────────────────

test('the POST cap still fires after the configured max from one real client', async () => {
  drainKeys();
  const peer = '198.51.100.31';
  const max = maxByPrefix['wb-post'];
  assert.ok(Number.isInteger(max) && max > 0, 'limiter max was not observed');

  const statuses = [];
  for (let i = 0; i < max + 1; i += 1) {
    // Each request rotates the spoofable header — the attack the cap must survive.
    statuses.push(await hit('post', { peer, headers: { 'x-forwarded-for': `9.9.9.${i}` } }));
  }

  const seen = drainKeys();
  assert.equal(seen.length, max + 1);
  assert.deepEqual(
    [...new Set(seen)], [`wb-post:${peer}`],
    'every request must land in the one bucket keyed by the real peer',
  );
  assert.equal(statuses[max], 429, `request ${max + 1} must be refused`);
  assert.ok(statuses.slice(0, max).every((s) => s !== 429), 'the first max requests must pass the limiter');
});

// ─── 4. IPv6-mapped IPv4 is ONE bucket, not two ──────────────────────

test('::ffff:1.2.3.4 and 1.2.3.4 are the same bucket', async () => {
  drainKeys();
  await hit('ctx', { peer: '::ffff:198.51.100.41' });
  await hit('ctx', { peer: '198.51.100.41' });

  const [mapped, plain] = drainKeys();
  assert.equal(mapped, 'wb-ctx:198.51.100.41', 'the ::ffff: prefix must be collapsed');
  assert.equal(mapped, plain, 'one client must not hold two buckets');
});

test('a direct request with no X-Forwarded-For keys on the socket address, normalised', async () => {
  drainKeys();
  await hit('ctx', { headers: { 'x-test-direct': '1' } });

  // 127.0.0.1 or ::ffff:127.0.0.1 depending on the listener family — one key either way.
  assert.deepEqual(drainKeys(), ['wb-ctx:127.0.0.1']);
});

// ─── 5. No header at all can choose the bucket ───────────────────────

test('no request header can move the request to another bucket', async () => {
  drainKeys();
  const peer = '198.51.100.51';

  await hit('ctx', { peer });                       // baseline, no extra headers
  const [baseline] = drainKeys();
  assert.equal(baseline, `wb-ctx:${peer}`);

  /*
   * Every header a proxy-aware app has ever been talked into trusting, plus the
   * RFC 7239 one. If clientIp() ever reads any of them again, exactly one of
   * these lines goes red and names the header.
   */
  const CANDIDATES = [
    'x-forwarded-for', 'x-forwarded', 'x-forwarded-host', 'x-original-forwarded-for',
    'forwarded', 'forwarded-for', 'x-real-ip', 'x-client-ip', 'x-cluster-client-ip',
    'client-ip', 'true-client-ip', 'cf-connecting-ip', 'fastly-client-ip',
    'x-appengine-user-ip', 'x-azure-clientip', 'via', 'remote-addr', 'x-remote-addr',
  ];

  for (const header of CANDIDATES) {
    drainKeys();
    await hit('ctx', { peer, headers: { [header]: '203.0.113.77' } });
    const [got] = drainKeys();
    assert.equal(got, baseline, `header "${header}" changed the bucket key to ${got}`);
  }
});

// ─── 6. The three limiters keep separate namespaces ──────────────────

test('each route keeps its own bucket prefix for the same client', async () => {
  drainKeys();
  const peer = '198.51.100.61';
  await hit('ctx', { peer });
  await hit('serv', { peer });
  await hit('post', { peer });

  assert.deepEqual(drainKeys(), [
    `wb-ctx:${peer}`,
    `wb-serv:${peer}`,
    `wb-post:${peer}`,
  ]);
});
