/*
 * services/city.service.js — the new-city APPROVAL flow, and above all the
 * REJECT path, which is a MERGE across eleven tables.
 *
 * ─── WHY THE ASSERTIONS ARE ON THE TRACE ───────────────────────────────────
 *
 * A merge that repoints ten of eleven tables returns exactly the same 200 as
 * one that repoints all eleven. A merge that ALSO repoints
 * `tbl_zone_city_mapping.city_zone_id` — a different id space, 15.9% of whose
 * values resolve in tbl_city — returns the same 200 while silently corrupting
 * every zone mapping that touched the rejected city. Neither is visible in a
 * response body, so a status-code test passes green against both.
 *
 * What is asserted here is therefore the STATEMENT LEDGER: which tables were
 * UPDATEd, with which two ids, in one transaction, and which columns were
 * left alone. Plus the connection lifecycle — acquire, commit-or-rollback,
 * release — on every path including the ones that throw, in the shape
 * routes/admin/products.js was moved to on 2026-09-08.
 *
 * ─── THE COLUMNS THAT MUST NOT MOVE ────────────────────────────────────────
 *   tbl_zone_city_mapping.city_zone_id — that table's own PK.
 *   tbl_easyfixer.efr_zone_city_id     — FKs to city_zone_id above
 *                                        (zone.service.js:57,
 *                                        job.service.js:2107). Its 78.8%
 *                                        overlap with tbl_city ids is
 *                                        coincidence, not a relationship.
 * Both are proven-negative, so they get explicit negative assertions rather
 * than being merely absent from the positive list.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const citiesRouter = require('../routes/admin/cities');

/* ─── the ledger ───────────────────────────────────────────────────────────
 *
 * A purpose-built double rather than tests/helpers/fake-pool.js, for the same
 * reason tests/admin-products-routes.test.js has one: that fake's makeConn()
 * hands out a fresh connection each call with a no-op release(), so it can
 * neither count acquisitions nor notice a leak — the two things half of this
 * file exists to measure.
 */
let L;
let plan;

function reset() {
  L = { acquires: 0, releases: 0, begins: 0, commits: 0, rollbacks: 0, conn: [], pool: [] };
  plan = {
    approvalCols: true,          // migration applied?
    creatorCols: true,
    acquireError: null,
    target: { city_id: 500, city_status: 2 },
    replacement: { city_id: 900, city_status: 1 },
    unverifiedRows: 0,           // rows in tbl_opencity_servicetype
    unverifiedThrows: null,
    cityUpdateAffected: 1,
    cityRow: { city_id: 500, city_name: 'Nowhere', city_status: 1 },
    rowsFor: {},                 // table -> total rows referencing the rejected city
    remaining: {},               // table -> rows still to drain (chunked UPDATEs)
    failOn: null,
  };
}

function respond(text, params) {
  if (/^\s*SHOW COLUMNS FROM tbl_city LIKE 'approval_decision'/i.test(text)) return plan.approvalCols ? [{ Field: 'approval_decision' }] : [];
  if (/^\s*SHOW COLUMNS FROM tbl_city LIKE 'created_by_type'/i.test(text))   return plan.creatorCols ? [{ Field: 'created_by_type' }] : [];
  /*
   * The subject lock and the replacement lock are now BYTE-IDENTICAL SQL:
   * `SELECT city_id, city_status FROM tbl_city WHERE city_id = ? FOR UPDATE`.
   * The replacement gained FOR UPDATE on 2026-09-09 so its status cannot be
   * changed by a concurrent deactivate while the merge runs.
   *
   * This used to key on the tail (`FOR UPDATE` = subject, no tail =
   * replacement). The moment both grew the tail, that discriminator answered
   * BOTH reads with the subject row — every reject test failed at once, which
   * is the good outcome; a discriminator that had degraded silently would have
   * left the suite green while testing a merge into itself.
   *
   * Keying on the PARAMETER is not available either: one test deliberately
   * calls rejectCity(500, 500) to prove self-merge is refused. So this keys on
   * ORDER, which the code fixes — the subject is locked first, the replacement
   * second. `L.conn` already holds the current query (it is pushed before
   * respond runs), so the first such read sees a count of 1.
   */
  if (/^\s*SELECT city_id, city_status FROM tbl_city/i.test(text)) {
    const nth = L.conn.filter((c) => /^\s*SELECT city_id, city_status FROM tbl_city/i.test(c.sql)).length;
    if (nth <= 1) return plan.target ? [plan.target] : [];
    return plan.replacement ? [plan.replacement] : [];
  }
  if (/FROM tbl_opencity_servicetype/i.test(text)) {
    if (plan.unverifiedThrows) throw plan.unverifiedThrows();
    return [{ n: plan.unverifiedRows }];
  }
  if (/^\s*SELECT COUNT\(\*\) AS total FROM tbl_city/i.test(text))  return [{ total: 7 }];
  if (/^\s*UPDATE tbl_city\b/i.test(text))                          return { affectedRows: plan.cityUpdateAffected };
  if (/^\s*UPDATE\s+(\w+)\s+SET/i.test(text)) {
    const t = text.match(/^\s*UPDATE\s+(\w+)\s+SET/i)[1];
    const want = t in plan.rowsFor ? plan.rowsFor[t] : 1;
    /*
     * The merge UPDATEs carry LIMIT and are re-issued until one comes back
     * short, so the double has to DRAIN like a real table. Returning the full
     * count on every pass — which is what it used to do — makes the loop
     * immortal: each pass reports a full chunk, so the caller keeps asking.
     * That is a fake modelling a table that refills itself.
     */
    const limit = (text.match(/LIMIT\s+(\d+)/i) || [])[1];
    if (!limit) return { affectedRows: want };
    if (plan.remaining[t] === undefined) plan.remaining[t] = want;
    const n = Math.min(plan.remaining[t], Number(limit));
    plan.remaining[t] -= n;
    return { affectedRows: n };
  }
  if (/^\s*SELECT\s+c\.city_id/i.test(text))                        return plan.cityRow ? [plan.cityRow] : [];
  if (/^\s*SELECT\s*\n?\s*c\.city_id/i.test(text))                  return [{ city_id: 1 }];
  if (/FROM tbl_city\s+c/i.test(text))                              return [{ city_id: 1, city_name: 'Pendingville' }];
  void params;
  return [];
}

db.pool.getConnection = async () => {
  if (plan.acquireError) throw plan.acquireError();
  L.acquires++;
  let released = false;
  const conn = {
    async query(sql, params) {
      const text = String(sql);
      L.conn.push({ sql: text, params });
      if (plan.failOn && plan.failOn.test(text)) throw new Error('ER_LOCK_WAIT_TIMEOUT: simulated mid-merge failure');
      return [respond(text, params), []];
    },
    async beginTransaction() { L.begins++; },
    async commit() { L.commits++; },
    async rollback() { L.rollbacks++; },
    release() {
      // Loud, not a soft flag: a double release hands back a connection
      // another request may already own.
      if (released) throw new Error('DOUBLE RELEASE');
      released = true;
      L.releases++;
    },
  };
  conn.execute = conn.query;
  return conn;
};
db.pool.query = async (sql, params) => {
  const text = String(sql);
  L.pool.push({ sql: text, params });
  return [respond(text, params), []];
};

// The service memoises its schema probes in module scope, so a scenario that
// flips `approvalCols` needs a fresh module instance.
function loadService() {
  delete require.cache[require.resolve('../services/city.service')];
  return require('../services/city.service');
}

const allSql = () => L.conn.concat(L.pool);
const merges = () => L.conn.filter((c) => /^\s*UPDATE/i.test(c.sql) && !/^\s*UPDATE tbl_city\b/i.test(c.sql));

beforeEach(reset);

/* ─── the merge trace ──────────────────────────────────────────────────── */

test('reject · repoints exactly the eleven measured columns, each with (replacement, rejected)', async () => {
  const city = loadService();
  const out = await city.rejectCity(500, 900, 42);

  const seen = merges().map((c) => c.sql.match(/^\s*UPDATE\s+(\w+)\s+SET\s+(\w+)/i).slice(1, 3).join('.'));
  const expected = city.MERGE_TARGETS.map(([t, c]) => `${t}.${c}`);

  assert.deepEqual(seen, expected, 'the merge set drifted from MERGE_TARGETS');
  assert.deepEqual(expected, [
    'tbl_address.city_id',
    'tbl_zone_city_mapping.city_id',
    'tbl_pincode.city_id',
    'tbl_easyfixer.efr_cityId',
    'tbl_client.client_city_id',
    'tbl_client_billing.c_bill_city_id',
    'tbl_client_store.city_id',
    'tbl_user.city_id',
    'firefox_city_mapping.city_id',
    'tbl_zone_master.city_id',
    'lms_chase_assignment.city_id',
  ], 'the measured merge scope changed — re-run the correspondence test before editing this list');

  for (const c of merges()) {
    assert.deepEqual(c.params, [900, 500],
      `${c.sql} must move rows FROM the rejected city TO the replacement, in that order`);
  }
  assert.equal(out.merged_into_city_id, 900);
});

test('reject · NEVER touches city_zone_id or efr_zone_city_id — a different id space', async () => {
  const city = loadService();
  await city.rejectCity(500, 900, 42);

  for (const c of allSql()) {
    assert.ok(!/\bSET\s+city_zone_id\b/i.test(c.sql),
      'tbl_zone_city_mapping.city_zone_id is that table\'s own PK — repointing it corrupts zone mappings');
    assert.ok(!/\bSET\s+efr_zone_city_id\b/i.test(c.sql),
      'efr_zone_city_id FKs to city_zone_id, not to tbl_city');
  }
  assert.ok(!city.MERGE_TARGETS.some(([, col]) => col === 'city_zone_id' || col === 'efr_zone_city_id'));
});

test('reject · reports per-table row counts so the operator sees the blast radius', async () => {
  plan.rowsFor = { tbl_address: 41000, tbl_pincode: 3, tbl_user: 0 };
  const city = loadService();
  const out = await city.rejectCity(500, 900, 42);

  assert.equal(out.moved['tbl_address.city_id'], 41000);
  assert.equal(out.moved['tbl_pincode.city_id'], 3);
  assert.equal(out.moved['tbl_user.city_id'], 0);
  assert.equal(Object.keys(out.moved).length, 11);
  assert.equal(out.rows_moved, 41000 + 3 + 0 + 8, 'total is the sum of every table, not of the non-zero ones');
});

test('reject · retires the city to 0 and records merged_into_city_id, in the SAME transaction', async () => {
  const city = loadService();
  await city.rejectCity(500, 900, 42);

  const retire = L.conn.filter((c) => /^\s*UPDATE tbl_city\b/i.test(c.sql));
  assert.equal(retire.length, 1);
  assert.match(retire[0].sql, /city_status = \?/);
  assert.match(retire[0].sql, /approval_decision = 'rejected'/);
  assert.match(retire[0].sql, /merged_into_city_id = \?/);
  // approved_at (2026-09-16): a bound Date, never SQL NOW() — see
  // services/city.service.js::rejectCity.
  assert.doesNotMatch(retire[0].sql, /NOW\(\)/);
  const rp = retire[0].params;
  assert.equal(rp[0], 0);
  assert.equal(rp[1], 42);
  assert.ok(rp[2] instanceof Date, 'approved_at is the third bound value');
  assert.equal(rp[3], 900);
  assert.equal(rp[4], 500);

  assert.equal(L.begins, 1, 'one transaction');
  assert.equal(L.commits, 1);
  assert.equal(L.rollbacks, 0);
  // The retire statement must be the LAST write: repointing after the city is
  // already inactive would leave a half-merged city if the merge then failed.
  assert.equal(L.conn.at(-1).sql.trim().startsWith('UPDATE tbl_city'), true);
});

/* ─── the migration is not applied ─────────────────────────────────────── */

test('reject · works with the audit columns ABSENT, minus the stamp', async () => {
  plan.approvalCols = false;
  const city = loadService();
  const out = await city.rejectCity(500, 900, 42);

  const retire = L.conn.find((c) => /^\s*UPDATE tbl_city\b/i.test(c.sql));
  assert.ok(!/approved_by|approved_at|approval_decision|merged_into_city_id/.test(retire.sql),
    'a column the migration has not created must not appear in the SQL');
  assert.deepEqual(retire.params, [0, 500]);
  assert.equal(out.audit_recorded, false);
  assert.equal(merges().length, 11, 'the merge itself still runs — only the audit stamp is skipped');
  assert.equal(L.commits, 1);
});

test('approve · works with the audit columns ABSENT, minus the stamp', async () => {
  plan.approvalCols = false;
  const city = loadService();
  await city.approveCity(500, 42);

  const upd = L.pool.find((c) => /^\s*UPDATE tbl_city\b/i.test(c.sql));
  assert.ok(!/approved_by|approval_decision/.test(upd.sql));
  assert.deepEqual(upd.params, [1, 500, 2]);
});

test('the schema probe is memoised — one SHOW COLUMNS across many calls', async () => {
  const city = loadService();
  await city.approveCity(500, 42);
  await city.approveCity(501, 42);
  await city.rejectCity(500, 900, 42);
  const probes = L.pool.filter((c) => /SHOW COLUMNS FROM tbl_city LIKE 'approval_decision'/i.test(c.sql));
  assert.equal(probes.length, 1);
});

test('the approval-column probe is taken BEFORE a connection is held', async () => {
  const city = loadService();
  await city.rejectCity(500, 900, 42);
  // Asking the pool for a second connection while holding one is how a
  // saturated pool deadlocks against itself.
  assert.equal(L.conn.some((c) => /SHOW COLUMNS/i.test(c.sql)), false,
    'the probe must not run on the transaction connection');
  assert.ok(L.pool.some((c) => /SHOW COLUMNS FROM tbl_city LIKE 'approval_decision'/i.test(c.sql)));
});

/* ─── refusals ─────────────────────────────────────────────────────────── */

async function refusal(fn) {
  try { await fn(); } catch (e) { return e; }
  throw new Error('expected a refusal, got success');
}

test('approve · a city that is not pending is a 409, never a silent success', async () => {
  plan.cityUpdateAffected = 0;
  plan.cityRow = { city_id: 500, city_name: 'Already Live', city_status: 1 };
  const city = loadService();
  const e = await refusal(() => city.approveCity(500, 42));
  assert.equal(e.status, 409);
  assert.match(e.message, /not pending/i);
  // The guard is in the WHERE clause, so the check and the write are one
  // statement and two concurrent approvals cannot both win.
  const upd = L.pool.find((c) => /^\s*UPDATE tbl_city\b/i.test(c.sql));
  assert.match(upd.sql, /WHERE city_id = \? AND city_status = \?/);
  assert.equal(upd.params.at(-1), 2);
});

test('approve · a city that does not exist is a 404', async () => {
  plan.cityUpdateAffected = 0;
  plan.cityRow = null;
  const city = loadService();
  const e = await refusal(() => city.approveCity(500, 42));
  assert.equal(e.status, 404);
});

test('reject · a city that is not pending is a 409 and moves nothing', async () => {
  plan.target = { city_id: 500, city_status: 1 };
  const city = loadService();
  const e = await refusal(() => city.rejectCity(500, 900, 42));
  assert.equal(e.status, 409);
  assert.equal(merges().length, 0);
  assert.equal(L.rollbacks, 1);
  assert.equal(L.releases, 1);
});

test('reject · a missing city is a 404 and moves nothing', async () => {
  plan.target = null;
  const city = loadService();
  const e = await refusal(() => city.rejectCity(500, 900, 42));
  assert.equal(e.status, 404);
  assert.equal(merges().length, 0);
  assert.equal(L.releases, 1);
});

test('reject · a missing replacement is a 400 and moves nothing', async () => {
  plan.replacement = null;
  const city = loadService();
  const e = await refusal(() => city.rejectCity(500, 900, 42));
  assert.equal(e.status, 400);
  assert.match(e.message, /Unknown replacement_city_id 900/);
  assert.equal(merges().length, 0);
  assert.equal(L.rollbacks, 1);
  assert.equal(L.releases, 1);
});

for (const [label, status] of [['inactive', 0], ['pending', 2]]) {
  test(`reject · merging into a ${label} replacement is a 400 — the trap`, async () => {
    plan.replacement = { city_id: 900, city_status: status };
    const city = loadService();
    const e = await refusal(() => city.rejectCity(500, 900, 42));
    assert.equal(e.status, 400);
    assert.match(e.message, /not an active city/);
    assert.equal(merges().length, 0, 'live rows must not move onto a city that is itself unresolved');
    assert.equal(L.releases, 1);
  });
}

test('reject · replacement === city is a 400, and never takes a connection', async () => {
  const city = loadService();
  const e = await refusal(() => city.rejectCity(500, 500, 42));
  assert.equal(e.status, 400);
  assert.equal(L.acquires, 0, 'a check this cheap must not cost a pool connection');
});

/* ─── the unverifiable column ──────────────────────────────────────────── */

test('reject · REFUSES with 409 naming the table when the unverified column has rows', async () => {
  plan.unverifiedRows = 4;
  const city = loadService();
  const e = await refusal(() => city.rejectCity(500, 900, 42));
  assert.equal(e.status, 409);
  assert.match(e.message, /tbl_opencity_servicetype\.open_city_id/);
  assert.match(e.message, /4 row\(s\)/);
  assert.equal(merges().length, 0, 'refuse BEFORE moving anything, not halfway through');
  assert.equal(L.rollbacks, 1);
  assert.equal(L.releases, 1);
});

test('reject · the unverified column is probed, never repointed', async () => {
  const city = loadService();
  await city.rejectCity(500, 900, 42);
  const touched = allSql().filter((c) => /tbl_opencity_servicetype/i.test(c.sql));
  assert.equal(touched.length, 1);
  assert.match(touched[0].sql, /^\s*SELECT COUNT/i, 'the guard must READ that table, never write it');
  assert.deepEqual(touched[0].params, [500]);
});

test('reject · a MISSING unverified table reads as empty, not as a failure', async () => {
  // Nothing can be orphaned in a table that does not exist.
  plan.unverifiedThrows = () => Object.assign(new Error("Table 'x' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
  const city = loadService();
  const out = await city.rejectCity(500, 900, 42);
  assert.equal(out.rows_moved, 11);
  assert.equal(L.commits, 1);
});

test('reject · any OTHER error from the unverified probe rolls the merge back', async () => {
  plan.unverifiedThrows = () => Object.assign(new Error('access denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
  const city = loadService();
  const e = await refusal(() => city.rejectCity(500, 900, 42));
  assert.equal(e.code, 'ER_TABLEACCESS_DENIED_ERROR');
  assert.equal(merges().length, 0);
  assert.equal(L.rollbacks, 1);
  assert.equal(L.releases, 1);
});

/* ─── connection lifecycle ─────────────────────────────────────────────── */

test('reject · happy path: one acquire, one commit, one release, no rollback', async () => {
  const city = loadService();
  await city.rejectCity(500, 900, 42);
  assert.equal(L.acquires, 1);
  assert.equal(L.releases, 1);
  assert.equal(L.commits, 1);
  assert.equal(L.rollbacks, 0);
});

test('reject · a mid-merge failure rolls back, releases, and propagates', async () => {
  plan.failOn = /^\s*UPDATE tbl_client_store\b/i;
  const city = loadService();
  const e = await refusal(() => city.rejectCity(500, 900, 42));
  assert.match(e.message, /simulated mid-merge failure/);
  assert.equal(L.rollbacks, 1, 'the six tables already repointed must be undone');
  assert.equal(L.commits, 0);
  assert.equal(L.releases, 1, 'the finally must still return the connection on the failure path');
  assert.equal(merges().length, 7, 'it failed ON the 7th, so 6 succeeded and the 7th was attempted');
});

test('reject · getConnection() itself failing leaks nothing', async () => {
  // `Queue limit reached.` is what mysql2 rejects with once queueLimit is hit
  // — i.e. under exactly the load a saturated pool produces. With the acquire
  // ABOVE the try, the finally would throw on `undefined.release()`.
  plan.acquireError = () => new Error('Queue limit reached.');
  const city = loadService();
  const e = await refusal(() => city.rejectCity(500, 900, 42));
  assert.match(e.message, /Queue limit reached/);
  assert.equal(L.acquires, 0);
  assert.equal(L.releases, 0, 'nothing was acquired, so nothing may be released');
});

/* ─── the pending queue ────────────────────────────────────────────────── */

test('pending · selects city_status = 2 and returns a full total for the badge', async () => {
  const city = loadService();
  const out = await city.listPendingCities({ limit: 50, offset: 0 });

  const list = L.pool.find((c) => /FROM tbl_city\s+c/i.test(c.sql) && /LIMIT \? OFFSET \?/i.test(c.sql));
  assert.match(list.sql, /WHERE c\.city_status = \?/);
  assert.deepEqual(list.params, [2, 50, 0]);
  assert.match(list.sql, /COUNT\(\*\) FROM tbl_pincode p WHERE p\.city_id = c\.city_id\)\s*AS pincode_count/);
  assert.match(list.sql, /created_by_name/);
  assert.match(list.sql, /ORDER BY c\.created_date DESC, c\.city_id DESC/);

  const count = L.pool.find((c) => /SELECT COUNT\(\*\) AS total FROM tbl_city/i.test(c.sql));
  assert.deepEqual(count.params, [2]);
  assert.equal(out.total, 7, 'the badge shows the backlog, not the page');
});

test('pending · falls back to city_id ordering when the creator columns are absent', async () => {
  plan.creatorCols = false;
  const city = loadService();
  await city.listPendingCities({});
  const list = L.pool.find((c) => /FROM tbl_city\s+c/i.test(c.sql) && /LIMIT \? OFFSET \?/i.test(c.sql));
  assert.match(list.sql, /ORDER BY c\.city_id DESC/);
  assert.ok(!/tbl_easyfixer cbe/.test(list.sql), 'no join onto a column that does not exist');
  assert.match(list.sql, /NULL AS created_by_name/);
});

test('pending · caps limit at the endpoint maximum', async () => {
  const city = loadService();
  await city.listPendingCities({ limit: 99999, offset: -5 });
  const list = L.pool.find((c) => /LIMIT \? OFFSET \?/i.test(c.sql));
  assert.deepEqual(list.params, [2, 1000, 0]);
});

/* ─── route wiring ─────────────────────────────────────────────────────── */

function layerFor(path, method) {
  return citiesRouter.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
}

test('routes · /pending is declared ABOVE /:cityId', async () => {
  const order = citiesRouter.stack.filter((l) => l.route && l.route.methods.get).map((l) => l.route.path);
  assert.ok(order.indexOf('/pending') < order.indexOf('/:cityId'),
    'declared after /:cityId, "pending" is captured as a cityId and answered with a Joi 400');
});

test('routes · every write is action-gated, and so is the approval worklist', async () => {
  // requireAction() names its returned middleware `actionGuard`, so the guard
  // is identifiable on the layer stack without invoking it.
  const guards = (path, method) => layerFor(path, method).route.stack.filter((s) => s.name === 'actionGuard').length;
  assert.equal(guards('/', 'post'), 1, 'POST / must carry isCityAddNew');
  assert.equal(guards('/:cityId', 'patch'), 1, 'PATCH must carry isCityEdit');
  assert.equal(guards('/:cityId', 'delete'), 1, 'DELETE must carry isCityEdit');
  assert.equal(guards('/:cityId/approve', 'post'), 1);
  assert.equal(guards('/:cityId/reject', 'post'), 1);
  // The two lookup GETs stay open — every city dropdown in the CRM reads them,
  // and gating them would break screens that have nothing to do with approval.
  assert.equal(guards('/', 'get'), 0, 'reading the city master is what every dropdown does');
  assert.equal(guards('/:cityId', 'get'), 0);
  // The worklist is not a lookup. Only the gated Manage Cities pending tab
  // calls it, and its rows name whoever triggered each automatic creation. A
  // read gate here is what makes isCityApprove a boundary rather than a render
  // hint — without it any authenticated CRM user can enumerate the queue and
  // is refused only at the moment they act.
  assert.equal(guards('/pending', 'get'), 1, 'GET /pending must carry isCityApprove');
});

test('routes · the action guard runs BEFORE validation on the write routes', async () => {
  for (const [path, method] of [['/', 'post'], ['/:cityId', 'patch'], ['/:cityId/approve', 'post'], ['/:cityId/reject', 'post'], ['/pending', 'get']]) {
    // middleware/validate.js names its returned middleware `mw`.
    const names = layerFor(path, method).route.stack.map((s) => s.name);
    const firstValidator = names.indexOf('mw');
    assert.ok(firstValidator >= 0, `${method.toUpperCase()} ${path}: expected a validate() layer`);
    assert.ok(names.indexOf('actionGuard') >= 0 && names.indexOf('actionGuard') < firstValidator,
      `${method.toUpperCase()} ${path}: an unauthorised caller must be refused before its payload is parsed`);
  }
});

test('routes · reject requires replacement_city_id', async () => {
  const layer = layerFor('/:cityId/reject', 'post');
  assert.ok(layer, 'POST /:cityId/reject must be mounted');
  // Drive the real validate() middleware with an empty body.
  const stack = layer.route.stack;
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const req = { method: 'POST', originalUrl: '/api/admin/cities/500/reject', params: { cityId: '500' }, query: {}, body: {}, user: { user_id: 1 } };
  // Skip the action guard (it needs a DB) and the params validator; run the
  // BODY validator directly.
  const validator = stack.filter((s) => s.name === 'mw')[1];
  let nexted = false;
  await validator.handle(req, res, () => { nexted = true; });
  assert.equal(nexted, false, 'an empty body must not reach the handler');
  assert.equal(res.statusCode, 400);
  assert.match(JSON.stringify(res.body), /replacement_city_id/);
});

test('reject · the REPLACEMENT is locked, not merely read', async () => {
  /*
   * A plain read is a check without a hold. The replacement's status was
   * verified and then relied on for the rest of the transaction, while nothing
   * stopped a concurrent DELETE /admin/cities/:id from retiring it in the gap.
   * The merge would then complete onto a city that was active when checked and
   * inactive when written to — every moved row landing somewhere that appears
   * in no picker, which is the exact orphaning this flow exists to prevent,
   * and with no error raised.
   *
   * Asserted on the STATEMENT: a missing FOR UPDATE changes no return value,
   * no row count and no status code. Nothing else can see it.
   */
  reset();
  const city = loadService();
  await city.rejectCity(500, 900, 42);

  const locks = L.conn.filter((c) => /^\s*SELECT city_id, city_status FROM tbl_city/i.test(c.sql));
  assert.equal(locks.length, 2, 'both the rejected city and its replacement must be read under lock');
  for (const [i, label] of [[0, 'the rejected city'], [1, 'the replacement']]) {
    assert.match(locks[i].sql, /FOR UPDATE/i, `${label} must be read FOR UPDATE`);
  }
  assert.equal(Number(locks[1].params[0]), 900, 'the second lock must be the replacement');

  /*
   * Lock ORDER is the deadlock argument, so it is pinned rather than left to
   * inspection: subject first, replacement second. The two can never swap
   * roles — a rejection needs a PENDING subject and an ACTIVE replacement, and
   * no city is both — so no two transactions can take these in opposite order.
   */
  assert.equal(Number(locks[0].params[0]), 500, 'the rejected city must be locked FIRST');
  assert.ok(L.conn.indexOf(locks[0]) < L.conn.indexOf(locks[1]));
});

test('reject · the merge is CHUNKED, and still one transaction', async () => {
  /*
   * tbl_address is ~421k rows and the largest single city on QA holds ~60k of
   * them, so the repoint is issued in bounded statements rather than as one
   * unbounded UPDATE. Its city_id is indexed (FK_tbl_address_tbl_city), so
   * each chunk is an index range scan — without that index chunking would be
   * O(n^2) and strictly worse than the single statement it replaced.
   *
   * What is asserted, and why: that no single statement is unbounded, that the
   * chunks sum to the true total (a loop that stops early loses rows silently
   * — same 200, fewer rows moved), and that it is STILL one commit. That last
   * one is the point people get wrong about batching: committing per chunk
   * would release locks sooner but would let an interrupted merge leave a
   * city's rows split across two cities.
   */
  reset();
  plan.rowsFor = { tbl_address: 41000, tbl_pincode: 3 };
  const city = loadService();
  const out = await city.rejectCity(500, 900, 42);

  const addr = L.conn.filter((c) => /^\s*UPDATE tbl_address SET/i.test(c.sql));
  assert.equal(addr.length, 9, '41000 rows at 5000 per chunk is 8 full passes plus a short one');
  for (const c of addr) {
    assert.match(c.sql, /LIMIT 5000/, 'every merge statement must be bounded');
  }
  assert.equal(out.moved['tbl_address.city_id'], 41000, 'the chunks must sum to the real total');

  // Small tables must not pay for this: 3 rows is one short pass, not nine.
  assert.equal(L.conn.filter((c) => /^\s*UPDATE tbl_pincode SET/i.test(c.sql)).length, 1);

  assert.equal(L.begins, 1, 'still ONE transaction');
  assert.equal(L.commits, 1, 'still ONE commit — chunking must not commit per batch');
  assert.equal(L.rollbacks, 0);
});

test('reject · a merge that cannot converge rolls back rather than committing half', async () => {
  /*
   * The runaway guard. Reachable only if an UPDATE stops removing its own
   * matches (from === to), which rejectCity refuses with a 400 before getting
   * here — so this proves the guard's BEHAVIOUR, not a live path. The
   * behaviour that matters is that it rolls back: a loop that will not
   * terminate must not leave a half-merged city behind.
   */
  reset();
  const drainless = { ...plan };
  plan.rowsFor = { tbl_address: 41000 };
  const city = loadService();
  // Refill the table on every pass, so no pass ever comes back short.
  const realRemaining = plan.remaining;
  Object.defineProperty(plan, 'remaining', {
    get() { return new Proxy(realRemaining, { get: () => 41000, set: () => true }); },
    configurable: true,
  });
  await assert.rejects(() => city.rejectCity(500, 900, 42), /did not converge/);
  assert.equal(L.commits, 0, 'nothing may be committed');
  assert.equal(L.rollbacks, 1, 'the whole merge must roll back');
  assert.equal(L.releases, L.acquires, 'and the connection must still be released');
  void drainless;
});
