/*
 * Confirm & Schedule address picker (2026-09-17) — the backend half.
 *
 * THE PRODUCT RULES this file pins (My Orders → Unconfirmed → Confirm & Schedule):
 *   - a saved address is NEVER edited from that screen;
 *   - picking a saved address uses it EXACTLY AS IS — the job is re-pointed at
 *     that tbl_address row (tbl_job.fk_address_id), nothing is copied or
 *     overwritten;
 *   - "Add New Address" ALWAYS creates a NEW tbl_address row for this customer;
 *   - the picker lists only COMPLETE addresses that BELONG to this customer.
 *
 * Three seams, one per layer:
 *   GET  /api/admin/customers/:id?complete=1  the list (routes/admin/customers.js)
 *   updateBody                                 the PATCH wire shape (validators/job.validator.js)
 *   job.service update()                       the re-point itself (services/job.service.js)
 *
 * The negative assertions ("no UPDATE tbl_address", "no UPDATE tbl_job") are the
 * point, not decoration: the in-place `address` block update() already has
 * rewrites a SHARED row — sibling jobs and completed history point at it — and
 * that is exactly what the picker exists to stop doing.
 *
 * Non-destructive: fake pool (tests/helpers/fake-pool.js), no real DB, nothing
 * is written anywhere. Runner: `node --test`.
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const CUSTOMER_ID = 7;
const OTHER_CUSTOMER_ID = 8;
const CURRENT_ADDRESS_ID = 11;
const OWNED_ADDRESS_ID = 12;
const FOREIGN_ADDRESS_ID = 99;
const MINTED_ADDRESS_ID = 555;

// address_id → owning customer_id, for the ownership SELECT below.
const ADDRESS_OWNER = new Map([
  [CURRENT_ADDRESS_ID, CUSTOMER_ID],
  [OWNED_ADDRESS_ID, CUSTOMER_ID],
  [FOREIGN_ADDRESS_ID, OTHER_CUSTOMER_ID],
]);

const STORED_JOB = () => ({
  job_id: 100,
  job_status: 9,
  fk_customer_id: CUSTOMER_ID,
  fk_address_id: CURRENT_ADDRESS_ID,
  job_reference_id: 'REF-100',   // already set, so the REF- back-fill stays silent
  time_slot: null,
  requested_date_time: null,
});
const scenario = { job: STORED_JOB() };

// Install BEFORE requiring anything that captures the pool.
const fake = installFakePool([
  [/INFORMATION_SCHEMA/i, (sql) => {
    if (/client_entered_address/.test(sql)) return [{ present: 1 }];
    if (/COUNT\(\*\) AS n/i.test(sql)) return [{ n: 0 }];
    return [];
  }],
  [/SHOW COLUMNS/i, []],
  [/SELECT \* FROM tbl_customer WHERE customer_id/i, [{ customer_id: CUSTOMER_ID, customer_name: 'Asha' }]],
  [/SELECT \* FROM tbl_address/i, [{ address_id: OWNED_ADDRESS_ID, customer_id: CUSTOMER_ID }]],
  [/SELECT address_id FROM tbl_address WHERE address_id = \? AND customer_id = \?/i,
    (_sql, params) => (ADDRESS_OWNER.get(Number(params[0])) === Number(params[1])
      ? [{ address_id: Number(params[0]) }] : [])],
  [/INSERT INTO tbl_address/i, { insertId: MINTED_ADDRESS_ID, affectedRows: 1 }],
  // Stateful, so getById() after commit reads the re-pointed id back — the FE's
  // sibling fan-out depends on the PATCH response carrying the NEW fk_address_id.
  [/UPDATE tbl_job SET fk_address_id = \?/i, (_sql, params) => {
    scenario.job.fk_address_id = params[0];
    return { affectedRows: 1 };
  }],
  [/SELECT j\.\*/, () => [{ ...scenario.job }]],
]);
after(() => fake.restore());

const customersRouter = require('../routes/admin/customers');
const { updateBody } = require('../validators/job.validator');
const jobSvc = require('../services/job.service');

beforeEach(() => { fake.reset(); scenario.job = STORED_JOB(); });

const SERVICED = [2, 3, 5, 10, 15, 20, 21];
const callsMatching = (re) => fake.calls.filter((c) => re.test(c.sql));
const indexOfCall = (re) => fake.calls.findIndex((c) => re.test(c.sql));

// ─── GET /api/admin/customers/:id ────────────────────────────────────

async function getCustomer(query) {
  const layer = customersRouter.stack.find((e) => e.route && e.route.path === '/:id' && e.route.methods.get);
  assert.ok(layer, 'GET /:id must be mounted');
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const req = { user: { user_id: 1 }, params: { id: String(CUSTOMER_ID) }, query, method: 'GET' };
  let failure = null;
  for (const { handle } of layer.route.stack) await handle(req, res, (e) => { failure = e; });
  if (failure) throw failure;
  return res;
}
const addressListCall = () => {
  const found = callsMatching(/SELECT \* FROM tbl_address/i);
  assert.equal(found.length, 1, 'exactly one saved-address query');
  return found[0];
};

// The query as it shipped before the picker — pinned verbatim, because Manage
// Customers and every other caller without the flag must see it unchanged.
const UNCHANGED_SQL = `SELECT * FROM tbl_address
        WHERE address_id IN (
          SELECT DISTINCT fk_address_id FROM tbl_job
           WHERE fk_customer_id = ? AND fk_address_id IS NOT NULL
             AND job_status IN (?, ?, ?, ?, ?, ?, ?)
        )
        ORDER BY address_id DESC LIMIT 50`;

test('GET /:id WITHOUT complete: the address query is byte-for-byte unchanged', async () => {
  for (const query of [{}, { complete: '0' }, { complete: 'false' }]) {
    fake.reset();
    const res = await getCustomer(query);
    assert.equal(res.statusCode, 200);
    const call = addressListCall();
    assert.equal(call.sql, UNCHANGED_SQL, `complete=${query.complete} must not narrow the list`);
    assert.doesNotMatch(call.sql, /\bcustomer_id = \?/, 'no ownership predicate without the flag');
    assert.deepEqual(call.params, [String(CUSTOMER_ID), ...SERVICED]);
  }
});

test('GET /:id?complete=1 (and =true): ownership + completeness predicates, all bound', async () => {
  for (const flag of ['1', 'true']) {
    fake.reset();
    const res = await getCustomer({ complete: flag });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    // Response shape unchanged: the customer row spread, plus addresses[].
    assert.equal(res.body.data.customer_id, CUSTOMER_ID);
    assert.ok(Array.isArray(res.body.data.addresses));

    const { sql, params } = addressListCall();
    // The serviced IN-list, order and cap are all kept…
    assert.match(sql, /job_status IN \(\?, \?, \?, \?, \?, \?, \?\)/);
    assert.match(sql, /ORDER BY address_id DESC LIMIT 50\s*$/);
    // …and the new predicates are added to the OUTER WHERE, before ORDER BY.
    const orderAt = sql.indexOf('ORDER BY');
    const subqueryEnd = sql.search(/\n\s*\)/);   // the IN-list's closing paren, on its own line
    assert.ok(subqueryEnd > 0 && subqueryEnd < orderAt);
    for (const re of [
      /\bAND customer_id = \?/,
      /TRIM\(COALESCE\(address, ''\)\) <> ''/,
      /TRIM\(COALESCE\(building, ''\)\) <> ''/,
      /city_id IS NOT NULL AND city_id > 0/,
      /pin_code REGEXP \?/,
      /TRIM\(COALESCE\(gps_location, ''\)\) <> ''/,
    ]) {
      const m = re.exec(sql);
      assert.ok(m, `complete=${flag}: missing ${re}`);
      assert.ok(m.index > subqueryEnd && m.index < orderAt,
        `${re} must sit after the IN-list and before ORDER BY`);
    }
    // Values are bound, never interpolated: the customer id and the PIN pattern.
    assert.deepEqual(params, [String(CUSTOMER_ID), ...SERVICED, String(CUSTOMER_ID), '^[0-9]{6}$']);
    assert.doesNotMatch(sql, new RegExp(`customer_id = ${CUSTOMER_ID}`));
  }
});

// ─── updateBody ──────────────────────────────────────────────────────

// Exactly the options middleware/validate.js runs with.
const check = (body) => updateBody.validate(body, { abortEarly: false, stripUnknown: true, convert: true });
const FULL_NEW_ADDRESS = () => ({
  address: '  12 MG Road  ',
  building: ' Tower B, Flat 402 ',
  landmark: '',
  address_instruction: null,
  city_id: 4,
  pin_code: '110001',
  gps_location: '28.6139,77.2090',
});

test('updateBody accepts fk_address_id (a positive integer)', () => {
  const { error, value } = check({ fk_address_id: OWNED_ADDRESS_ID });
  assert.equal(error, undefined);
  assert.equal(value.fk_address_id, OWNED_ADDRESS_ID);
  for (const bad of [0, -3, 1.5, 'abc', null]) {
    assert.ok(check({ fk_address_id: bad }).error, `fk_address_id=${bad} must be rejected`);
  }
});

test('updateBody accepts a complete new_address (and trims address / building)', () => {
  const { error, value } = check({ new_address: FULL_NEW_ADDRESS() });
  assert.equal(error, undefined);
  assert.equal(value.new_address.address, '12 MG Road');
  assert.equal(value.new_address.building, 'Tower B, Flat 402');
  // The two optional fields really are optional.
  const { landmark, address_instruction, ...required } = FULL_NEW_ADDRESS();
  void landmark; void address_instruction;
  assert.equal(check({ new_address: required }).error, undefined);
});

test('updateBody rejects an incomplete new_address', () => {
  const cases = {
    'no address':         { address: undefined },
    'blank address':      { address: '   ' },
    'no building':        { building: undefined },
    'blank building':     { building: '  ' },
    'no city':            { city_id: undefined },
    'no PIN':             { pin_code: undefined },
    '5-digit PIN':        { pin_code: '11000' },
    'no GPS':             { gps_location: undefined },
    'blank GPS':          { gps_location: '' },
    'malformed GPS':      { gps_location: 'near the temple' },
  };
  for (const [label, patch] of Object.entries(cases)) {
    const addr = { ...FULL_NEW_ADDRESS(), ...patch };
    for (const k of Object.keys(addr)) if (addr[k] === undefined) delete addr[k];
    assert.ok(check({ new_address: addr }).error, `${label} must be a 400`);
  }
});

test('updateBody rejects any two (or all three) of fk_address_id / new_address / address', () => {
  const fk = { fk_address_id: OWNED_ADDRESS_ID };
  const nw = { new_address: FULL_NEW_ADDRESS() };
  const inPlace = { address: { building: 'B-2' } };
  for (const body of [{ ...fk, ...nw }, { ...fk, ...inPlace }, { ...nw, ...inPlace }, { ...fk, ...nw, ...inPlace }]) {
    const { error } = check(body);
    assert.ok(error, `${Object.keys(body).join('+')} must be rejected`);
    assert.ok(error.details.some((d) => d.type === 'object.oxor'), 'rejected by the exclusivity rule');
  }
  // The in-place block on its own keeps working for its other callers.
  assert.equal(check(inPlace).error, undefined);
});

// ─── PATCH /api/admin/jobs/:id (the real route chain) ────────────────

/*
 * The route validates with stripUnknown, logs field names and hands req.body to
 * job.update — so an undeclared key would vanish silently. Walk the REAL
 * middleware chain (validate → scopedJob → canPatchJob → handler) with
 * job.update stubbed on the module object the router calls through.
 */
async function patchJob(body) {
  const jobsRouter = require('../routes/admin/jobs');
  const layer = jobsRouter.stack.find((e) => e.route && e.route.path === '/:id' && e.route.methods.patch);
  assert.ok(layer, 'PATCH /:id must be mounted');
  const all = { mode: 'all', ids: [], placeholders: '' };
  const req = {
    params: { id: '100' }, query: {}, body, method: 'PATCH', originalUrl: '/api/admin/jobs/100',
    user: { user_id: 77, permissions: { menuIds: [], actionPermissions: ['isJobEdit'] } },
    userRole: { role_name: 'Project Manager' },
    scope: { clients: all, cities: all, states: all, verticals: all },
    allowedStages: null,
  };
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const seen = [];
  const realUpdate = jobSvc.update;
  jobSvc.update = async (id, input) => { seen.push({ id, input }); return { job_id: 100 }; };
  try {
    for (const { handle } of layer.route.stack) {
      let nexted = false;
      await handle(req, res, (e) => { if (e) throw e; nexted = true; });
      if (!nexted) break;
    }
  } finally {
    jobSvc.update = realUpdate;
  }
  return { res, seen };
}

test('PATCH /jobs/:id carries fk_address_id and new_address through to job.update intact', async () => {
  const a = await patchJob({ fk_address_id: String(OWNED_ADDRESS_ID) });
  assert.equal(a.res.statusCode, 200);
  assert.equal(a.seen.length, 1);
  assert.deepEqual(a.seen[0].input, { fk_address_id: OWNED_ADDRESS_ID });

  const b = await patchJob({ new_address: FULL_NEW_ADDRESS(), job_desc: 'confirmed' });
  assert.equal(b.res.statusCode, 200);
  assert.equal(b.seen.length, 1);
  assert.equal(b.seen[0].input.new_address.address, '12 MG Road');
  assert.equal(b.seen[0].input.new_address.gps_location, '28.6139,77.2090');

  const c = await patchJob({ fk_address_id: OWNED_ADDRESS_ID, new_address: FULL_NEW_ADDRESS() });
  assert.equal(c.res.statusCode, 400, 'both at once is refused at the wire');
  assert.equal(c.seen.length, 0, 'and never reaches the service');
});

// ─── job.service update() ────────────────────────────────────────────

const ACTOR = { user_id: 9 };

test('update(): fk_address_id owned by the customer re-points the job and edits NO address', async () => {
  const updated = await jobSvc.update(100, { fk_address_id: OWNED_ADDRESS_ID }, ACTOR);

  const own = callsMatching(/SELECT address_id FROM tbl_address WHERE address_id = \? AND customer_id = \?/i);
  assert.equal(own.length, 1, 'ownership is checked');
  assert.deepEqual(own[0].params, [OWNED_ADDRESS_ID, CUSTOMER_ID]);

  const repoint = callsMatching(/UPDATE tbl_job SET fk_address_id = \?/i);
  assert.equal(repoint.length, 1);
  assert.deepEqual(repoint[0].params, [OWNED_ADDRESS_ID, 100]);

  assert.equal(callsMatching(/UPDATE tbl_address/i).length, 0, 'the saved address is used exactly as is');
  assert.equal(callsMatching(/INSERT INTO tbl_address/i).length, 0, 'nothing is copied into a new row');

  // client_entered_address snapshot runs BEFORE the job stops pointing at the old row.
  const snapAt = indexOfCall(/SET j\.client_entered_address = a\.address/);
  assert.ok(snapAt !== -1, 'the client-entered address is snapshotted');
  assert.ok(snapAt < indexOfCall(/UPDATE tbl_job SET fk_address_id = \?/i), 'snapshot precedes the re-point');

  // A structural edit: the nested-only stamp fires.
  assert.equal(callsMatching(/UPDATE tbl_job SET last_update_time = \?, created_date_time = \?/).length, 1);
  // getById after commit carries the new id back to the caller.
  assert.equal(updated.fk_address_id, OWNED_ADDRESS_ID);
});

test('update(): fk_address_id of ANOTHER customer is a 400 and writes nothing to tbl_job', async () => {
  await assert.rejects(
    () => jobSvc.update(100, { fk_address_id: FOREIGN_ADDRESS_ID, job_desc: 'edited too' }, ACTOR),
    (err) => err.status === 400 && /does not belong to this customer/.test(err.message),
  );
  assert.equal(callsMatching(/UPDATE tbl_job/i).length, 0,
    'refused before ANY write — not even the scalar job_desc UPDATE ran');
  assert.equal(callsMatching(/UPDATE tbl_address|INSERT INTO tbl_address/i).length, 0);
  assert.equal(scenario.job.fk_address_id, CURRENT_ADDRESS_ID);
});

test('update(): re-picking the CURRENT address is a no-op (no ownership check, no write)', async () => {
  // Pre-selected by default in the picker; a legacy current row may not be keyed
  // to this customer and must still book as-is.
  ADDRESS_OWNER.set(CURRENT_ADDRESS_ID, OTHER_CUSTOMER_ID);
  try {
    const out = await jobSvc.update(100, { fk_address_id: CURRENT_ADDRESS_ID }, ACTOR);
    assert.equal(out.fk_address_id, CURRENT_ADDRESS_ID);
    assert.equal(callsMatching(/SELECT address_id FROM tbl_address/i).length, 0);
    assert.equal(callsMatching(/UPDATE tbl_job|UPDATE tbl_address|INSERT INTO tbl_address/i).length, 0);
  } finally {
    ADDRESS_OWNER.set(CURRENT_ADDRESS_ID, CUSTOMER_ID);
  }
});

test('update(): new_address INSERTs a row for the job\'s customer and re-points the job', async () => {
  const updated = await jobSvc.update(100, { new_address: { ...FULL_NEW_ADDRESS(), address: '12 MG Road', building: 'Tower B' } }, ACTOR);

  const ins = callsMatching(/INSERT INTO tbl_address/i);
  assert.equal(ins.length, 1, 'always a NEW row');
  const cols = /\(([^)]+)\)\s*VALUES/i.exec(ins[0].sql)[1].split(',').map((s) => s.trim());
  const bound = Object.fromEntries(cols.map((c, i) => [c, ins[0].params[i]]));
  assert.equal(bound.customer_id, CUSTOMER_ID, 'owned by the JOB\'s customer, never a caller-supplied one');
  assert.equal(bound.address, '12 MG Road');
  assert.equal(bound.building, 'Tower B');
  assert.equal(bound.city_id, 4);
  assert.equal(bound.pin_code, '110001');
  assert.equal(bound.gps_location, '28.6139,77.2090');

  const repoint = callsMatching(/UPDATE tbl_job SET fk_address_id = \?/i);
  assert.equal(repoint.length, 1);
  assert.deepEqual(repoint[0].params, [MINTED_ADDRESS_ID, 100]);

  assert.equal(callsMatching(/UPDATE tbl_address/i).length, 0, 'no existing address is touched');
  assert.equal(callsMatching(/SELECT address_id FROM tbl_address WHERE address_id/i).length, 0);
  assert.ok(indexOfCall(/SET j\.client_entered_address/) < indexOfCall(/UPDATE tbl_job SET fk_address_id/));
  assert.equal(updated.fk_address_id, MINTED_ADDRESS_ID);
});

test('update(): re-pointing a job with no customer is a 400 before any write', async () => {
  scenario.job.fk_customer_id = null;
  for (const input of [{ new_address: FULL_NEW_ADDRESS() }, { fk_address_id: OWNED_ADDRESS_ID }]) {
    fake.reset();
    await assert.rejects(() => jobSvc.update(100, input, ACTOR), (err) => err.status === 400);
    assert.equal(callsMatching(/UPDATE |INSERT /i).length, 0);
  }
});

test('update(): a re-point alongside scalar edits still stamps the structural timestamps', async () => {
  await jobSvc.update(100, { fk_address_id: OWNED_ADDRESS_ID, remarks: 'call before arriving' }, ACTOR);
  const scalar = callsMatching(/UPDATE tbl_job SET remarks = \?/);
  assert.equal(scalar.length, 1);
  assert.match(scalar[0].sql, /last_update_time = \?, created_date_time = \?/,
    'a remarks-only edit skips the stamp — a remarks + address re-point must not');
});
