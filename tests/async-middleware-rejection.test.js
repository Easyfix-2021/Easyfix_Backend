/*
 * A DB fault inside an auth middleware must produce an ERROR, not an OUTAGE.
 *
 * Background (2026-09-08): the pool threw "Queue limit reached." from
 * findUserById inside requireAuth. That await sat outside the try that covers
 * only verifyToken, Express 4 attaches no .catch to an async middleware's
 * promise, and Node 20 defaults to --unhandled-rejections=throw — so the
 * container exited 1 and restarted, killing every in-flight request.
 *
 * WHY THE ASSERTION LOOKS LIKE THIS. The fix changes nothing observable on the
 * happy path: same 401s, same req.user, byte-identical responses. The only
 * thing that moved is what happens to a REJECTION. So the assertion cannot be
 * on the result — it has to be on the trace: does the promise the middleware
 * returns settle, and does the error reach `next`? A test that only checked
 * responses would pass just as green against the broken version.
 *
 * `controlUnwrapped` is the differential control: the same shape WITHOUT the
 * wrapper must still reject. Without it, a harness that could never observe a
 * rejection at all would report all five middlewares as fixed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const ROOT = path.join(__dirname, '..');
const POOL_ERROR = () => new Error('Queue limit reached.');

/** Replace a module in the require cache before the subject requires it. */
function stub(relPath, exports) {
  const resolved = require.resolve(path.join(ROOT, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

/** Drop a module so the next require() re-runs it against current stubs. */
function uncache(relPath) {
  delete require.cache[require.resolve(path.join(ROOT, relPath))];
}

/**
 * Drive a middleware to the point where its DB lookup rejects, and report what
 * the middleware did with that rejection.
 *
 * Returns { threw, nextArg }. `threw` true means the returned promise rejected
 * — in Express 4 that is an unhandled rejection, i.e. a process exit.
 */
async function driveToDbFault(middleware, req) {
  let nextArg = 'NEXT_NOT_CALLED';
  const res = {
    statusCode: null,
    setHeader() {}, set() {},
    status(c) { this.statusCode = c; return this; },
    json() { return this; },
  };
  const next = (err) => { nextArg = err; };
  try {
    await middleware(req, res, next);
    return { threw: false, nextArg };
  } catch (err) {
    return { threw: true, nextArg, err };
  }
}

function assertSurvivesDbFault(name, result) {
  assert.equal(
    result.threw, false,
    `${name}: the returned promise REJECTED. In Express 4 that is an unhandled `
    + 'rejection and, on Node >= 15, a process exit — the whole container restarts '
    + 'for one request\'s DB fault. Wrap it with utils/async-middleware.js.'
  );
  assert.ok(
    result.nextArg instanceof Error,
    `${name}: expected next(err) so the error handler can return a 500; got ${String(result.nextArg)}`
  );
  assert.match(result.nextArg.message, /Queue limit reached/);
}

test('requireAuth routes a pool fault to next() instead of exiting the process', async () => {
  stub('utils/jwt', { verifyToken: () => ({ sub: 42 }), jobShareGuestClaims: () => null });
  stub('services/auth.service', { findUserById: async () => { throw POOL_ERROR(); } });
  stub('services/tech-auth.service', { findById: async () => null });
  uncache('middleware/auth.js');
  const requireAuth = require(path.join(ROOT, 'middleware/auth.js'));

  assertSurvivesDbFault('requireAuth', await driveToDbFault(requireAuth, {
    headers: { authorization: 'Bearer t' }, query: {},
  }));

  // The OpenAPI introspection tag must survive wrapping — docs/openapi-autogen.js
  // reads it off the exported function to attach the right security scheme.
  assert.deepEqual(requireAuth._openapi, { security: 'bearerAdmin' });
  // Route-stack tests locate guards by entry.name; the wrapper must keep it.
  assert.equal(requireAuth.name, 'requireAuth');
});

test('requireTechAuth routes a pool fault to next()', async () => {
  stub('services/tech-auth.service', { findById: async () => { throw POOL_ERROR(); } });
  uncache('middleware/tech-auth.js');
  const requireTechAuth = require(path.join(ROOT, 'middleware/tech-auth.js'));

  const token = jwt.sign({ sub: 'efr:7' }, process.env.JWT_SECRET);
  assertSurvivesDbFault('requireTechAuth', await driveToDbFault(requireTechAuth, {
    headers: { authorization: `Bearer ${token}` }, cookies: {},
  }));
  assert.deepEqual(requireTechAuth._openapi, { security: 'bearerTech' });
});

test('requireSpocAuth routes a pool fault to next()', async () => {
  stub('services/client-auth.service', { findSpocById: async () => { throw POOL_ERROR(); } });
  stub('services/client-access.service', { accessFromSpoc: () => ({}) });
  uncache('middleware/client-auth.js');
  const requireSpocAuth = require(path.join(ROOT, 'middleware/client-auth.js'));

  const token = jwt.sign({ sub: 'spoc:9' }, process.env.JWT_SECRET);
  assertSurvivesDbFault('requireSpocAuth', await driveToDbFault(requireSpocAuth, {
    headers: { authorization: `Bearer ${token}` }, cookies: {},
  }));
});

test('role() and roleByName() guards route a pool fault to next()', async () => {
  stub('services/role.service', {
    getRoleById: async () => { throw POOL_ERROR(); },
    getRoleByName: async () => { throw POOL_ERROR(); },
    ROLE_ID_TO_GROUP: {},
    GROUPS: ['admin', 'client', 'mobile', 'finance'],
  });
  uncache('middleware/role.js');
  const { role, roleByName } = require(path.join(ROOT, 'middleware/role.js'));

  const req = { user: { user_role: 1 }, headers: {} };
  assertSurvivesDbFault('roleGuard', await driveToDbFault(role(['admin']), req));
  assertSurvivesDbFault('roleByNameGuard', await driveToDbFault(roleByName(['Admin']), req));
});

test('basicAuth routes a pool fault to next() (integration-partner tier)', async () => {
  stub('db', { pool: { query: async () => { throw POOL_ERROR(); } } });
  uncache('middleware/basic-auth.js');
  const basicAuth = require(path.join(ROOT, 'middleware/basic-auth.js'));

  const creds = Buffer.from('partner:secret').toString('base64');
  assertSurvivesDbFault('basicAuth', await driveToDbFault(basicAuth, {
    headers: { authorization: `Basic ${creds}` },
  }));
});

test('controlUnwrapped: the harness can still observe a rejection', async () => {
  // Differential control. If this passed with threw===false, every assertion
  // above would be vacuous — the harness would be incapable of failing.
  const unwrapped = async (_req, _res, _next) => { throw POOL_ERROR(); };
  const result = await driveToDbFault(unwrapped, { headers: {} });
  assert.equal(result.threw, true, 'control must reject — otherwise the tests above prove nothing');
  assert.equal(result.nextArg, 'NEXT_NOT_CALLED', 'control must not reach next()');
});
