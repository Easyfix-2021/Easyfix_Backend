/*
 * routes/admin/products.js — the three TRANSACTIONAL handlers, plus the
 * ordinary route behaviour that had no coverage at all.
 *
 * ─── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * On 2026-09-08 all three write handlers were changed from
 *
 *     const conn = await pool.getConnection();     // ABOVE the try
 *     try { ... } finally { conn.release(); }
 *
 * to
 *
 *     let conn;
 *     try { conn = await pool.getConnection(); ... }
 *     finally { if (conn) conn.release(); }
 *
 * That change is INVISIBLE in every response body. Same 201, same 404, same
 * JSON. The only thing that moved is what happens when `getConnection()`
 * itself rejects — which mysql2 does, with `Queue limit reached.`, precisely
 * when the pool is saturated. Express 4 attaches no .catch to an async
 * handler's promise, so a rejection there reaches no error middleware, sends
 * no response, and on Node 20 (`--unhandled-rejections=throw`) exits the
 * process. One request's pool fault becomes a container restart that kills
 * every in-flight request.
 *
 * So the assertions here are on the TRACE, not the result:
 *   - how many connections were acquired, and were they all released
 *   - whether commit or rollback ran
 *   - whether the handler's own promise SETTLED
 *
 * A test that only checked status codes passes just as green against the
 * broken version, which is the whole reason this file is worth writing.
 * `controlUnwrapped` at the bottom is the differential control: it proves the
 * harness can still observe a rejection, so "settled" is a measurement rather
 * than a harness that is incapable of failing.
 *
 * NOTE ON THE TABLES. products.js's own header records that `product`,
 * `product_code` and `product_additional_image` do NOT exist in the live
 * schema — every endpoint currently fails with ER_NO_SUCH_TABLE, deliberately
 * and loudly. That makes the mid-transaction-failure path the ONLY path this
 * feature can take today, and makes its connection hygiene the thing most
 * worth pinning.
 */
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const { errorHandler } = require('../middleware/error-handler');
const router = require('../routes/admin/products');

/* ─── the connection ledger ────────────────────────────────────────────────
 *
 * A purpose-built double rather than tests/helpers/fake-pool.js: that fake's
 * makeConn() has a no-op `release()` and hands out a fresh connection every
 * call, so it can neither count acquisitions nor notice a double release —
 * the two things this file exists to measure.
 */
let L;      // the ledger for the current test
let plan;   // how the double should behave for the current test

function resetLedger() {
  L = { acquires: 0, releases: 0, begins: 0, commits: 0, rollbacks: 0, queries: [] };
  plan = { acquireError: null, failOn: null, failWith: null, rollbackThrows: false, affectedRows: 1, productExists: true };
}

function rowsFor(text) {
  // `product\b` cannot match `product_code` / `product_additional_image` —
  // `_` is a word character — so the parent-row statements are addressed
  // exactly, and the child-table writes fall through to the generic result.
  // The existence probe returns ROWS, not a result header — PATCH destructures
  // `const [[exists]] = await conn.query(...)`, so an object here silently reads
  // as "no such product" and every PATCH test 404s for the wrong reason.
  if (/^\s*SELECT\s+id\s+FROM\s+product\b/i.test(text)) return plan.productExists ? [{ id: 1 }] : [];
  if (/^\s*INSERT INTO product\b/i.test(text)) return { insertId: 9001 };
  if (/^\s*(UPDATE|DELETE FROM) product\b/i.test(text)) return { affectedRows: plan.affectedRows };
  return { affectedRows: 1 };
}

db.pool.getConnection = async () => {
  if (plan.acquireError) throw plan.acquireError();
  L.acquires++;
  let released = false;
  const conn = {
    async query(sql, params) {
      const text = String(sql);
      L.queries.push({ sql: text, params });
      if (plan.failOn && plan.failOn.test(text)) {
        throw plan.failWith ? plan.failWith() : new Error("ER_NO_SUCH_TABLE: Table 'easyfix.product' doesn't exist");
      }
      return [rowsFor(text), []];
    },
    async beginTransaction() { L.begins++; },
    async commit() { L.commits++; },
    async rollback() {
      L.rollbacks++;
      if (plan.rollbackThrows) throw new Error('ROLLBACK FAILED — connection already gone');
    },
    release() {
      if (released) {
        // Not a soft flag: a double release returns a connection that another
        // request may already own, so the double MUST make it loud. If this
        // ever fires it surfaces as a rejected handler promise, which the
        // `settled` assertions below all read.
        throw new Error('DOUBLE RELEASE — this connection was already returned to the pool');
      }
      released = true;
      L.releases++;
    },
  };
  conn.execute = conn.query;
  return conn;
};
db.pool.query = async (sql, params) => {
  L.queries.push({ sql: String(sql), params });
  return [rowsFor(String(sql)), []];
};

after(() => { /* the pool object is process-local to this test file's child */ });

/* ─── the driver ───────────────────────────────────────────────────────────
 *
 * Runs the WHOLE route stack (validate() included) the way
 * tests/client-contacts-write.test.js does, then feeds any next(err) through
 * the repository's REAL errorHandler — so "produces a 500" is measured
 * against middleware/error-handler.js rather than against a stand-in that
 * could agree with a wrong expectation.
 */
function stackFor(routePath, method) {
  const layer = router.stack.find((e) => e.route && e.route.path === routePath && e.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} must be mounted`);
  return layer.route.stack;
}

const makeRes = () => ({
  statusCode: 200, body: null, locals: {},
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

async function call(routePath, method, { body = {}, params = {} } = {}) {
  const stack = stackFor(routePath, method);
  const res = makeRes();
  const req = {
    method: method.toUpperCase(), originalUrl: '/api/admin/products', path: routePath,
    params, query: {}, body, user: { user_id: 1 },
  };
  let nextErr = null;
  let rejected = null;
  try {
    for (const layer of stack) {
      let nexted = false;
      // `await` on the layer IS the probe: if the handler's promise rejects,
      // it lands in the catch below and `rejected` is non-null. In Express 4
      // that same rejection has nowhere to go and terminates the process.
      await layer.handle(req, res, (e) => { if (e) nextErr = e; nexted = true; });
      if (!nexted) break;              // a layer answered (validation 400, a 404, …)
    }
  } catch (e) {
    rejected = e;
  }
  if (nextErr) errorHandler(nextErr, req, res, () => {});
  return { res, nextErr, rejected, settled: rejected === null };
}

/* The three transactional handlers, with a per-route statement chosen to fail
 * AFTER beginTransaction so the failure is genuinely mid-transaction. */
const TXN = [
  {
    name: 'POST /', path: '/', method: 'post',
    args: { body: { name: 'Fridge X', service_id: 5, product_codes: ['SKU-1'] } },
    failOn: /^\s*INSERT INTO product_code\b/i,
    okStatus: 201,
  },
  {
    name: 'PATCH /:id', path: '/:id', method: 'patch',
    args: { body: { name: 'Fridge Y' }, params: { id: '77' } },
    failOn: /^\s*UPDATE product\b/i,
    okStatus: 200,
  },
  {
    name: 'DELETE /:id', path: '/:id', method: 'delete',
    args: { params: { id: '77' } },
    failOn: /^\s*DELETE FROM product_code\b/i,
    okStatus: 200,
  },
];

beforeEach(resetLedger);

/* ─── connection lifecycle ─────────────────────────────────────────────────
 * Nothing below is observable in a response body. That is the point. */

for (const r of TXN) {
  test(`${r.name} · happy path: one acquire, one release, one commit, no rollback`, async () => {
    const { res, settled, rejected } = await call(r.path, r.method, r.args);
    assert.equal(settled, true, `handler promise rejected: ${rejected && rejected.message}`);
    assert.equal(res.statusCode, r.okStatus);
    assert.equal(res.body.success, true, JSON.stringify(res.body));
    assert.equal(L.acquires, 1, 'exactly one connection taken from the pool');
    assert.equal(L.releases, 1, 'and exactly one returned — a leak here starves the pool silently');
    assert.equal(L.begins, 1);
    assert.equal(L.commits, 1);
    assert.equal(L.rollbacks, 0, 'a commit path must not also roll back');
  });

  test(`${r.name} · mid-transaction failure: rolled back, released, and a 500 — not a thrown promise`, async () => {
    plan.failOn = r.failOn;
    const { res, nextErr, settled, rejected } = await call(r.path, r.method, r.args);
    assert.equal(settled, true, `handler promise rejected: ${rejected && rejected.message}`);
    assert.equal(L.acquires, 1);
    assert.equal(L.rollbacks, 1, 'the partial write must be undone');
    assert.equal(L.commits, 0);
    assert.equal(L.releases, 1, 'the finally must still return the connection on the failure path');
    assert.ok(nextErr instanceof Error, 'the error must reach next() so errorHandler can answer');
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { success: false, error: 'Internal Server Error' },
      'ER_NO_SUCH_TABLE must not be echoed to the operator');
  });

  test(`${r.name} · ⚠ the ACQUIRE itself failing settles as a 500 and leaks no connection`, async () => {
    /*
     * THE 2026-09-08 SHAPE, EXACTLY. `Queue limit reached.` is what mysql2
     * rejects getConnection() with once `queueLimit` is hit — i.e. under the
     * load a saturated pool actually produces. With the acquire above the try
     * this test fails on `settled`: the handler's promise rejects, Express 4
     * observes nothing, and the process exits. The response is identical
     * either way, so `settled` is the only assertion that can see the fix.
     */
    plan.acquireError = () => new Error('Queue limit reached.');
    const { res, nextErr, settled, rejected } = await call(r.path, r.method, r.args);
    assert.equal(settled, true,
      'the handler promise REJECTED. In Express 4 that is an unhandled rejection and, '
      + 'on Node >= 15, a process exit — the container restarts for one request\'s pool '
      + `fault. Move the getConnection() back inside the try. (${rejected && rejected.message})`);
    assert.equal(L.acquires, 0, 'nothing was acquired');
    assert.equal(L.releases, 0, 'so nothing may be released — `if (conn)` is what makes that true');
    assert.equal(L.rollbacks, 0, 'and there is no transaction to roll back');
    assert.ok(nextErr instanceof Error);
    assert.match(nextErr.message, /Queue limit reached/,
      'the ORIGINAL pool error must reach next(), not a TypeError from rolling back `undefined`');
    assert.equal(res.statusCode, 500);
  });

  test(`${r.name} · a rollback that ALSO throws neither escapes nor replaces the original error`, async () => {
    /*
     * A connection killed mid-transaction fails its rollback too. If that
     * second throw escaped, the client would see the rollback's message
     * instead of the cause — and the `finally`'s release would be skipped,
     * leaking the connection on exactly the requests where the pool is
     * already in trouble.
     */
    plan.failOn = r.failOn;
    plan.rollbackThrows = true;
    const { res, nextErr, settled, rejected } = await call(r.path, r.method, r.args);
    assert.equal(settled, true, `handler promise rejected: ${rejected && rejected.message}`);
    assert.equal(L.rollbacks, 1, 'the rollback was attempted');
    assert.equal(L.releases, 1, 'and the connection still came back');
    assert.doesNotMatch(nextErr.message, /ROLLBACK FAILED/,
      'the rollback failure must not shadow the error that caused it');
    assert.equal(res.statusCode, 500);
  });
}

test('PATCH /:id · an early 404 return still releases the connection', async () => {
  // `return modernError(...)` inside the try skips the catch entirely — only
  // the `finally` gets the connection back. This is the path a `return` in a
  // try is easiest to get wrong on.
  plan.productExists = false;
  const { res, settled } = await call('/:id', 'patch', { body: { name: 'Nope' }, params: { id: '404404' } });
  assert.equal(settled, true);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { success: false, error: 'product not found' });
  assert.equal(L.rollbacks, 1, 'the transaction opened for the check must be rolled back, not left open');
  assert.equal(L.commits, 0);
  assert.equal(L.releases, 1, 'and the connection returned on the early-return path too');
});

test('DELETE /:id · an early 404 return still releases the connection', async () => {
  plan.affectedRows = 0;
  const { res, settled } = await call('/:id', 'delete', { params: { id: '404404' } });
  assert.equal(settled, true);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { success: false, error: 'product not found' });
  assert.equal(L.rollbacks, 1, 'the child-row DELETEs that already ran must be undone');
  assert.equal(L.commits, 0);
  assert.equal(L.releases, 1);
});

test('no handler releases the same connection twice', async () => {
  /*
   * The double is armed to THROW on a second release (see release() above),
   * so this sweep is what turns that arming into a check: run every route
   * through every outcome and require each to settle. A double release is
   * invisible in a response and only shows up later as a connection handed to
   * two requests at once.
   */
  const outcomes = [
    { label: 'commit',        mutate: () => {} },
    { label: 'rollback',      mutate: (r) => { plan.failOn = r.failOn; } },
    { label: 'early-404',     mutate: () => { plan.affectedRows = 0; plan.productExists = false; } },
    { label: 'acquire-fault', mutate: () => { plan.acquireError = () => new Error('Queue limit reached.'); } },
  ];
  for (const r of TXN) {
    for (const o of outcomes) {
      resetLedger();
      o.mutate(r);
      const { settled, rejected } = await call(r.path, r.method, r.args);
      assert.equal(settled, true, `${r.name} / ${o.label}: ${rejected && rejected.message}`);
      assert.ok(L.releases <= L.acquires, `${r.name} / ${o.label}: released more than acquired`);
      assert.equal(L.releases, L.acquires, `${r.name} / ${o.label}: every acquired connection must come back`);
    }
  }
});

/* ─── validation: nothing reaches the pool ─────────────────────────────────
 * The trace assertion (acquires === 0) is the load-bearing one: a 400 that
 * still took a connection would spend pool capacity on garbage input. */

const REJECTED_BODIES = [
  ['POST /',     '/',    'post',  { }, 'name and service_id are both required'],
  ['POST /',     '/',    'post',  { name: 'x' }, 'service_id is required'],
  ['POST /',     '/',    'post',  { name: '', service_id: 5 }, 'an empty name is not a name'],
  ['POST /',     '/',    'post',  { name: 'x', service_id: 0 }, 'service_id must be positive'],
  ['POST /',     '/',    'post',  { name: 'x', service_id: 5, product_codes: ['y'.repeat(101)] }, 'a code longer than the column'],
  ['POST /',     '/',    'post',  { name: 'x', service_id: 5, additional_image_ids: ['abc'] }, 'image ids are integers'],
  ['PATCH /:id', '/:id', 'patch', { }, 'an empty PATCH body — .min(1) — would issue an UPDATE with no SET'],
  ['PATCH /:id', '/:id', 'patch', { service_id: -1 }, 'a negative service_id'],
];

for (const [label, routePath, method, body, why] of REJECTED_BODIES) {
  test(`${label} · 400 without taking a connection · ${why}`, async () => {
    const { res, settled } = await call(routePath, method, { body, params: { id: '77' } });
    assert.equal(settled, true);
    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'Validation failed');
    assert.ok(Array.isArray(res.body.details) && res.body.details.length > 0, 'the 400 names the field');
    assert.equal(L.acquires, 0, 'validation runs BEFORE the pool is touched');
    assert.equal(L.queries.length, 0, 'and nothing was written');
  });
}

test('POST / defaults are applied before the handler reads them', async () => {
  // The handler does `req.body.product_codes.length` inside the try — it is
  // only safe because Joi defaults the field to []. Without the default that
  // line is a TypeError on the most ordinary possible request.
  const { res, settled } = await call('/', 'post', { body: { name: 'Bare', service_id: 5 } });
  assert.equal(settled, true);
  assert.equal(res.statusCode, 201);
  const ins = L.queries.find((q) => /^\s*INSERT INTO product\b/i.test(q.sql));
  assert.deepEqual(ins.params, ['Bare', ins.params[1], 5, 0], 'primary_img_id defaults to 0, not undefined');
  assert.equal(L.queries.filter((q) => /product_code|product_additional_image/i.test(q.sql)).length, 0,
    'no child rows for empty defaults');
});

test('POST / binds created_on as DATE(?) over a Date, not NOW()', async () => {
  // created_on is DATE. Bound as DATE(?) over a JS Date, never NOW(): the
  // pool is `timezone: '+05:30'`, so a bound Date serialises to the IST wall
  // clock, whereas NOW() resolves in the DB session zone. DATE() (not a bare
  // `?`) takes the IST calendar day explicitly — a bare bind into a DATE
  // column is a truncation note, and a hard error under a strict sql_mode
  // Production has not been verified against.
  await call('/', 'post', { body: { name: 'Fridge Z', service_id: 5 } });
  const ins = L.queries.find((q) => /^\s*INSERT INTO product\b/i.test(q.sql));
  assert.doesNotMatch(ins.sql, /NOW\(\)/, 'created_on must not be SQL NOW()');
  assert.match(ins.sql, /VALUES \(\?, DATE\(\?\), \?, \?\)/, 'created_on must be DATE(?), not a bare bind');
  assert.ok(ins.params[1] instanceof Date, 'created_on must be a bound Date');
});

/* ─── response shapes (utils/response.js modern envelope) ──────────────────── */

test('POST / answers 201 with the modern envelope and the new id', async () => {
  const { res } = await call('/', 'post', { body: { name: 'Fridge', service_id: 5 } });
  assert.equal(res.statusCode, 201, 'a create is 201, not 200');
  assert.deepEqual(res.body, { success: true, data: { id: 9001 }, message: 'product created' });
});

test('PATCH /:id and DELETE /:id answer the modern envelope', async () => {
  const patched = await call('/:id', 'patch', { body: { name: 'x' }, params: { id: '77' } });
  assert.deepEqual(patched.res.body, { success: true, data: { updated: true } });
  resetLedger();
  const deleted = await call('/:id', 'delete', { params: { id: '77' } });
  assert.deepEqual(deleted.res.body, { success: true, data: { deleted: true } });
});

test('PATCH /:id replaces codes wholesale, as the legacy DAO did', async () => {
  await call('/:id', 'patch', { body: { product_codes: ['A', 'B'] }, params: { id: '77' } });
  const del = L.queries.filter((q) => /^\s*DELETE FROM product_code\b/i.test(q.sql));
  const ins = L.queries.filter((q) => /^\s*INSERT INTO product_code\b/i.test(q.sql));
  assert.equal(del.length, 1, 'the old codes go first — the header calls this out as legacy parity');
  assert.equal(ins.length, 2);
  assert.equal(L.commits, 1);
});

test('PATCH /:id with ONLY child collections still checks the parent exists', async () => {
  /*
   * FIXED 2026-09-08 — this test asserted the DEFECT until then.
   *
   * The 404 used to live inside `if (sets.length > 0)`. A body carrying only
   * product_codes / additional_image_ids sets nothing on `product`, so the
   * guard never ran: a PATCH against a nonexistent id DELETEd and INSERTed
   * child rows for a missing parent, committed, and answered 200
   * {updated:true}. Orphan rows, reported as success.
   *
   * The existence check is now unconditional and precedes every write.
   */
  plan.productExists = false;
  const { res, settled } = await call('/:id', 'patch', { body: { product_codes: ['ORPHAN'] }, params: { id: '999999' } });
  assert.equal(settled, true);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { success: false, error: 'product not found' });
  assert.equal(L.commits, 0, 'nothing may be committed for a parent that does not exist');
  assert.equal(L.rollbacks, 1);
  assert.equal(
    L.queries.some((q) => /INSERT INTO product_code/i.test(q.sql)), false,
    'and no child row may be written before the parent is known to exist'
  );
});

test('PATCH /:id · a no-op update is 200, not 404 — affectedRows 0 does not mean "missing"', async () => {
  /*
   * The other direction of the same defect. MySQL reports affectedRows = 0 when
   * an UPDATE MATCHES a row but changes nothing, so re-saving a product with
   * unchanged values used to answer "product not found" for a product that
   * plainly exists. Only an explicit existence check can tell the two apart,
   * which is why the fix is a SELECT rather than a re-reading of the UPDATE.
   */
  plan.productExists = true;
  plan.affectedRows = 0;                 // the row matched; nothing changed
  const { res } = await call('/:id', 'patch', { body: { name: 'Unchanged' }, params: { id: '1' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, data: { updated: true } });
  assert.equal(L.commits, 1);
});

/* ─── gating ───────────────────────────────────────────────────────────────── */

test('the products router declares no gate of its own — it inherits the admin gates', async () => {
  /*
   * products.js has no requireAuth / role / permission layer in it. That is
   * correct only because routes/admin/index.js mounts it BEHIND those gates.
   * Matched by IDENTITY (and, for role(), by the guard's function name, since
   * `role([...])` returns a fresh closure), never by a regex over source —
   * a source-shaped check silently stops finding a guard the moment it is
   * wrapped, which has already happened once in this repo.
   */
  assert.equal(router.stack.filter((e) => !e.route).length, 0,
    'no router.use() gate inside products.js — so the mount position is the whole story');

  const adminRouter = require('../routes/admin/index');
  const requireAuth = require('../middleware/auth');
  const authIdx = adminRouter.stack.findIndex((e) => !e.route && e.handle === requireAuth);
  const roleIdx = adminRouter.stack.findIndex((e) => !e.route && e.handle && e.handle.name === 'roleGuard');
  const productsIdx = adminRouter.stack.findIndex((e) => !e.route && e.handle === router);

  assert.ok(authIdx >= 0, 'requireAuth must be findable on the admin router');
  assert.ok(roleIdx > authIdx, 'the role guard follows authentication');
  assert.ok(productsIdx > roleIdx,
    'product CRUD must mount AFTER requireAuth and role([\'admin\']) — ahead of them it is '
    + 'unauthenticated write access to the catalog');
});

/* ─── differential control ─────────────────────────────────────────────────── */

test('controlUnwrapped: the harness can still observe a rejection', async () => {
  // Without this, a harness incapable of surfacing a rejection would report
  // every `settled` assertion above as green against the broken code.
  const stack = [{ handle: async () => { throw new Error('Queue limit reached.'); } }];
  let rejected = null;
  try {
    for (const layer of stack) await layer.handle({}, makeRes(), () => {});
  } catch (e) { rejected = e; }
  assert.ok(rejected instanceof Error, 'the driver must be able to see a rejected handler promise');
  assert.match(rejected.message, /Queue limit reached/);
});

/* ─── non-Error rejections: the catch must not become the failure ─────────── */

/*
 * A rejection is not guaranteed to be an Error. Before asError() these catches
 * did `logger.error('… ' + e.message)` and `next(e)`, and BOTH broke on a
 * non-object:
 *
 *   e.message  → TypeError raised INSIDE the catch, escaping the handler as an
 *                unhandled rejection. The response is never sent.
 *   next(null) → Express reads a falsy first argument as "no error, continue",
 *                so the request falls through to the 404 handler with no 500
 *                and nothing logged. The failure disappears instead of surfacing.
 *
 * The second is the nastier one: it produces no error anywhere, which is
 * indistinguishable from the request having succeeded.
 */
const NON_ERRORS = [
  { label: 'null',           make: () => null },
  { label: 'a string',       make: () => 'ER_LOCK_DEADLOCK' },
  { label: 'an object literal', make: () => ({ code: 'ER_QUERY_INTERRUPTED', sqlState: '70100' }) },
  { label: 'undefined',      make: () => undefined },
];

for (const r of TXN) {
  for (const ne of NON_ERRORS) {
    test(`${r.name} · a rejection that is ${ne.label} still reaches next() as a real Error`, async () => {
      plan.failOn = r.failOn;
      plan.failWith = ne.make;
      const { res, nextErr, settled, rejected } = await call(r.path, r.method, r.args);

      assert.equal(settled, true,
        `the handler promise REJECTED — the catch itself threw. (${rejected && rejected.message})`);
      assert.ok(nextErr instanceof Error,
        `next() got ${String(nextErr)}, not an Error. A falsy value here is read by Express as `
        + '"no error, continue": no 500, no log, the request quietly 404s');
      assert.notEqual(nextErr, null, 'next(null) means "no error" to Express');
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.body, { success: false, error: 'Internal Server Error' });
      assert.equal(L.releases, L.acquires,
        'and the connection is still returned — a catch that throws skips the finally in some shapes');
    });
  }
}

test('control: a real Error is passed through untouched, not re-wrapped', async () => {
  // Without this, asError() could be replacing every error with a generic one
  // and the assertions above would still pass — losing the driver's own
  // message, code and stack, which is the thing the log exists to carry.
  const original = new Error('Queue limit reached.');
  plan.failOn = /^\s*UPDATE product\b/i;
  plan.failWith = () => original;
  const { nextErr } = await call('/:id', 'patch', { body: { name: 'X' }, params: { id: '77' } });
  assert.equal(nextErr, original, 'the original Error object must reach next(), not a copy');
  assert.equal(nextErr.message, 'Queue limit reached.');
});
