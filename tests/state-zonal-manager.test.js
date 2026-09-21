/*
 * State-level zonal manager (2026-09-21).
 *
 * The rule: one zonal manager per state, set on tbl_state.state_user and copied
 * onto tbl_city.state_user for every city of the state — because tbl_city is
 * what every report and filter reads. These tests pin the COPY, since that is
 * what would silently break: a manager saved on the state but never pushed to
 * its cities looks correct on the States tab and wrong everywhere else.
 *
 * Like tests/city-pending-and-coverage.test.js, assertions are on the SQL that
 * was written, with the pool stubbed — the return shapes would pass either way.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'db'));

const USERS = {
  7:  { user_id: 7,  user_name: 'Sneha',  user_status: 1, user_role: 12 }, // Zonal Field Team
  8:  { user_id: 8,  user_name: 'Rahul',  user_status: 0, user_role: 12 }, // left the organisation
  9:  { user_id: 9,  user_name: 'Ghost',  user_status: 1, user_role: 19 }, // legacy technician row
};

/*
 * One handler answers both pool.query and a transaction connection's query, and
 * every statement is recorded with where it ran so a test can tell a write
 * inside the transaction from one outside it.
 */
function install({ hasCols = true, states = { 1: null, 2: 5, 3: 5 }, handler = () => null } = {}) {
  const calls = [];
  const conn = { committed: false, rolledBack: false, released: false };
  const answer = async (sql, params, via) => {
    const text = String(sql);
    calls.push({ sql: text, params, via });
    const own = await handler(text, params);
    if (own) return [own, []];
    if (/SHOW COLUMNS FROM tbl_state/i.test(text)) return [hasCols ? [{ Field: 'state_user' }] : [], []];
    if (/FROM tbl_user WHERE user_id = \?/i.test(text)) return [[USERS[params[0]]].filter(Boolean), []];
    if (/SELECT state_id FROM tbl_state WHERE state_id IN/i.test(text)) {
      return [params.filter((id) => id in states).map((id) => ({ state_id: id })), []];
    }
    if (/SELECT state_id FROM tbl_state WHERE state_id = \? FOR UPDATE/i.test(text)) {
      return [params[0] in states ? [{ state_id: params[0] }] : [], []];
    }
    if (/SELECT state_id, state_user FROM tbl_state/i.test(text)) {
      return [params[0] in states ? [{ state_id: params[0], state_user: states[params[0]] }] : [], []];
    }
    if (/SELECT state_user FROM tbl_state/i.test(text)) {
      return [params[0] in states ? [{ state_user: states[params[0]] }] : [], []];
    }
    if (/^\s*UPDATE tbl_city/i.test(text)) return [{ affectedRows: 12 }, []];
    if (/^\s*UPDATE/i.test(text)) return [{ affectedRows: 1 }, []];
    if (/^\s*INSERT/i.test(text)) return [{ insertId: 99, affectedRows: 1 }, []];
    return [[], []];
  };
  db.pool.query = (sql, params) => answer(sql, params, 'pool');
  db.pool.getConnection = async () => Object.assign(conn, {
    query: (sql, params) => answer(sql, params, 'tx'),
    beginTransaction: async () => {},
    commit: async () => { conn.committed = true; },
    rollback: async () => { conn.rolledBack = true; },
    release: () => { conn.released = true; },
  });
  // Fresh modules each time: the column probe is memoised in module scope.
  for (const rel of ['services/state.service', 'services/city.service']) {
    delete require.cache[require.resolve(path.join(ROOT, rel))];
  }
  return { calls, conn, state: require(path.join(ROOT, 'services/state.service')) };
}

const cityUpdates = (calls) => calls.filter((c) => /^\s*UPDATE tbl_city/i.test(c.sql));
const stateUpdates = (calls) => calls.filter((c) => /^\s*UPDATE tbl_state/i.test(c.sql));

/* ─── assign one manager to many states ─────────────────────────────── */

test('assignManager · writes every state AND every city of those states in one transaction', async () => {
  const { calls, conn, state } = install();
  const r = await state.assignManager([2, 3], 7, 42);

  const [st] = stateUpdates(calls);
  assert.equal(st.via, 'tx');
  assert.match(st.sql, /SET state_user = \?, updated_by = \?, updated_on = \? WHERE state_id IN \(\?,\?\)/);
  assert.deepEqual([st.params[0], st.params[1], st.params[3], st.params[4]], [7, 42, 2, 3]);
  assert.ok(st.params[2] instanceof Date, 'updated_on is bound as a JS Date, never SQL NOW()');

  const [ct] = cityUpdates(calls);
  assert.equal(ct.via, 'tx', 'the city copy must be inside the same transaction');
  assert.match(ct.sql, /UPDATE tbl_city SET state_user = \? WHERE state_id IN \(\?,\?\)/);
  assert.deepEqual(ct.params, [7, 2, 3]);

  assert.ok(conn.committed && !conn.rolledBack && conn.released);
  assert.deepEqual(r, { manager_id: 7, manager_name: 'Sneha', states_updated: 2, cities_updated: 12 });
});

for (const [who, id, why] of [
  ['a user who left', 8, /not an active user/],
  ['a non-internal user', 9, /not an internal user/],
  ['an unknown user', 404, /Unknown user/],
]) {
  test(`assignManager · refuses ${who} and writes nothing`, async () => {
    const { calls, conn, state } = install();
    await assert.rejects(state.assignManager([2], id, 42), (e) => e.status === 400 && why.test(e.message));
    assert.equal(stateUpdates(calls).length + cityUpdates(calls).length, 0);
    assert.ok(conn.rolledBack && !conn.committed && conn.released);
  });
}

test('assignManager · an unknown state id rolls the whole move back', async () => {
  const { calls, conn, state } = install();
  await assert.rejects(state.assignManager([2, 77], 7, 42), (e) => e.status === 400 && /77/.test(e.message));
  assert.equal(cityUpdates(calls).length, 0);
  assert.ok(conn.rolledBack);
});

/* ─── edit one state ─────────────────────────────────────────────────── */

test('updateState · a rename alone never touches the cities', async () => {
  const { calls, state } = install();
  const r = await state.updateState(2, { state_name: 'Uttar Pradesh' }, 42);
  assert.equal(stateUpdates(calls).length, 1);
  assert.equal(cityUpdates(calls).length, 0);
  assert.equal(r.cities_updated, 0);
});

test('updateState · a manager change is pushed to every city of the state', async () => {
  const { calls, state } = install();
  const r = await state.updateState(2, { state_user: 7 }, 42);
  const [ct] = cityUpdates(calls);
  assert.equal(ct.via, 'tx');
  assert.deepEqual(ct.params, [7, 2]);
  assert.equal(r.cities_updated, 12);
});

/* ─── re-sync ────────────────────────────────────────────────────────── */

test('resyncState · rewrites only the cities that differ from the state', async () => {
  const { calls, state } = install();
  await state.resyncState(2, 42);
  const [ct] = cityUpdates(calls);
  assert.match(ct.sql, /WHERE state_id = \? AND NOT \(state_user <=> \?\)/);
  assert.deepEqual(ct.params, [5, 2, 5]);
});

test('resyncState · a state with no manager is a 409, not a wipe', async () => {
  const { calls, state } = install();
  await assert.rejects(state.resyncState(1, 42), (e) => e.status === 409);
  assert.equal(cityUpdates(calls).length, 0);
});

/* ─── before the migration ───────────────────────────────────────────── */

test('before the migration · writes answer 503 and the lookup is a quiet null', async () => {
  const { calls, state } = install({ hasCols: false });
  await assert.rejects(state.assignManager([2], 7, 42), (e) => e.status === 503);
  assert.equal(await state.stateManagerFor(2), null);
  assert.equal(calls.filter((c) => /tbl_state WHERE state_id/i.test(c.sql)).length, 0);
});

/* ─── cities pick up their state's manager ───────────────────────────── */

test('createCity · a hand-added city takes its state\'s manager', async () => {
  const { calls } = install({
    handler: (t) => (/SELECT state_id FROM tbl_state WHERE state_id = \? LIMIT 1/i.test(t) ? [{ state_id: 2 }] : null),
  });
  const city = require(path.join(ROOT, 'services/city.service'));
  await city.createCity({ city_name: 'Agra', state_id: 2 });
  const ins = calls.find((c) => /INSERT INTO tbl_city/i.test(c.sql));
  assert.match(ins.sql, /city_status, state_user\)/);
  assert.equal(ins.params[ins.params.length - 1], 5);
});

test('updateCity · moving a city to another state moves it to that state\'s manager', async () => {
  const { calls } = install({
    handler: (t) => (/SELECT state_id FROM tbl_state WHERE state_id = \? LIMIT 1/i.test(t) ? [{ state_id: 3 }] : null),
  });
  const city = require(path.join(ROOT, 'services/city.service'));
  await city.updateCity(10, { state_id: 3 });
  const upd = cityUpdates(calls)[0];
  assert.match(upd.sql, /state_id = \?, state_user = \?/);
  assert.deepEqual(upd.params.slice(0, 2), [3, 5]);
});

test('updateCity · a state with no manager leaves the city\'s manager alone', async () => {
  const { calls } = install({
    handler: (t) => (/SELECT state_id FROM tbl_state WHERE state_id = \? LIMIT 1/i.test(t) ? [{ state_id: 1 }] : null),
  });
  const city = require(path.join(ROOT, 'services/city.service'));
  await city.updateCity(10, { state_id: 1 });
  assert.doesNotMatch(cityUpdates(calls)[0].sql, /state_user/);
});

test('approveCity · re-reads the state\'s manager at approval — the approver fills nothing', async () => {
  const { calls } = install({
    handler: (t) => (/SHOW COLUMNS FROM tbl_city/i.test(t) ? [] : null),
  });
  const city = require(path.join(ROOT, 'services/city.service'));
  await city.approveCity(10, 42);
  const upd = cityUpdates(calls)[0];
  assert.match(upd.sql,
    /state_user = COALESCE\(\(SELECT s\.state_user FROM tbl_state s WHERE s\.state_id = tbl_city\.state_id\), state_user\)/);
});

/* ─── the old back door ──────────────────────────────────────────────── */

test('routes · state writes are gated on isStateEdit and a manager is required on create', () => {
  const src = require('fs').readFileSync(path.join(ROOT, 'routes/admin/states.js'), 'utf8');
  assert.match(src, /requireAction\('isStateEdit'\)/);
  for (const verb of ["router.post('/assign-manager', requireStateEdit", "router.post('/', requireStateEdit",
    "router.patch('/:stateId', requireStateEdit", "router.post('/:stateId/resync', requireStateEdit"]) {
    assert.ok(src.includes(verb), 'ungated write: ' + verb);
  }
  assert.match(src, /createBody = Joi\.object\(\{[^}]*state_user: manager\.required\(\)/);
});
