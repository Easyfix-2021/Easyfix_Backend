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
function install({ hasCols = true, states = { 1: null, 2: 5, 3: 5, 4: 5 }, inactive = [4], handler = () => null } = {}) {
  const off = new Set(inactive);
  const row = (id) => ({ state_id: id, state_name: 'State ' + id, state_user: states[id], state_status: off.has(id) ? 0 : 1 });
  const calls = [];
  const conn = { committed: false, rolledBack: false, released: false };
  const answer = async (sql, params, via) => {
    const text = String(sql);
    calls.push({ sql: text, params, via });
    const own = await handler(text, params);
    if (own) return [own, []];
    if (/SHOW COLUMNS FROM tbl_state/i.test(text)) return [hasCols ? [{ Field: 'state_user' }] : [], []];
    if (/FROM tbl_user WHERE user_id = \?/i.test(text)) return [[USERS[params[0]]].filter(Boolean), []];
    if (/SELECT state_id, state_name, state_status FROM tbl_state WHERE state_id IN/i.test(text)) {
      return [params.filter((id) => id in states).map(row), []];
    }
    if (/SELECT state_id, state_name, state_status FROM tbl_state WHERE state_id = \? FOR UPDATE/i.test(text)) {
      return [params[0] in states ? [row(params[0])] : [], []];
    }
    if (/SELECT state_id, state_name, state_user, state_status FROM tbl_state/i.test(text)) {
      return [params[0] in states ? [row(params[0])] : [], []];
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

/* ─── 2026-09-22: active states only ─────────────────────────────────── */

test('assignManager · refuses an INACTIVE state and writes nothing', async () => {
  const { calls, conn, state } = install();
  await assert.rejects(state.assignManager([2, 4], 7, 42), (e) => e.status === 422 && /Inactive state/.test(e.message));
  assert.equal(stateUpdates(calls).length + cityUpdates(calls).length, 0);
  assert.ok(conn.rolledBack);
});

test('updateState · a manager change on an inactive state is refused; a rename is not', async () => {
  const a = install();
  await assert.rejects(a.state.updateState(4, { state_user: 7 }, 42), (e) => e.status === 422);
  assert.equal(cityUpdates(a.calls).length, 0);
  const b = install();
  await b.state.updateState(4, { state_name: 'Renamed' }, 42);
  assert.equal(stateUpdates(b.calls).length, 1);
});

test('resyncState · refuses an inactive state', async () => {
  const { calls, state } = install();
  await assert.rejects(state.resyncState(4, 42), (e) => e.status === 422);
  assert.equal(cityUpdates(calls).length, 0);
});

test('assertActiveStates · names every inactive id it finds, ignores active and unknown ones', async () => {
  const { state } = install({
    handler: (t, p) => (/FROM tbl_state WHERE state_id IN \(\?\) AND state_status = 0/i.test(t)
      ? p[0].filter((id) => id === 40).map((id) => ({ state_id: id, state_name: 'Orisa' })) : null),
  });
  await assert.rejects(state.assertActiveStates([26, 40, 999]), (e) => e.status === 422 && /Orisa/.test(e.message));
  await state.assertActiveStates([26, 999]);
  await state.assertActiveStates([]);
});

/*
 * A stub tbl_state with an old duplicate kept INACTIVE: 26 Odisha active, 40
 * "Orisa" inactive; 27 Puducherry active, 42 "Pondicherry" inactive. Answers
 * the resolver's by-name read the way MySQL would: LOWER/TRIM, the IN list,
 * and the ORDER BY (active first, then exact raw name, then normalised name).
 */
function installStates({ status = true } = {}) {
  const rows = [
    { state_id: 26, state_name: 'Odisha', state_status: 1 },
    { state_id: 40, state_name: 'Orisa', state_status: 0 },
    { state_id: 27, state_name: 'Puducherry', state_status: 1 },
    { state_id: 42, state_name: 'Pondicherry', state_status: 0 },
    { state_id: 15, state_name: 'Jammu & Kashmir', state_status: 1 },
  ];
  return install({
    handler: (t, p) => {
      if (/SHOW COLUMNS FROM tbl_state LIKE/i.test(t)) return status ? [{ Field: p[0] }] : [];
      if (/FROM tbl_state WHERE LOWER\(TRIM\(state_name\)\) IN \(\?, \?, \?\)/i.test(t)) {
        const [raw, given, official] = p;
        const lc = (r) => r.state_name.trim().toLowerCase();
        const hits = rows.filter((r) => [raw, given, official].includes(lc(r)));
        hits.sort((a, b) => (status ? b.state_status - a.state_status : 0)
          || (lc(b) === raw) - (lc(a) === raw) || (lc(b) === given) - (lc(a) === given) || a.state_id - b.state_id);
        return hits.slice(0, 1);
      }
      return null;
    },
  });
}

for (const [given, id] of [
  ['Odisha', 26], ['  odisha ', 26], ['Orissa', 26], ['Orisa', 26], ['ORISA', 26],
  ['Pondicherry', 27], ['Puducherry', 27], ['Jammu & Kashmir', 15],
]) {
  test(`resolveStateByName · "${given}" → the ACTIVE state ${id}`, async () => {
    const { state } = installStates();
    assert.equal((await state.resolveStateByName(given)).state_id, id);
  });
}

test('resolveStateByName · an unknown name is null, never a guess', async () => {
  const { state } = installStates();
  assert.equal(await state.resolveStateByName('Atlantis'), null);
  assert.equal(await state.resolveStateByName(''), null);
});

test('resolveStateByName · before the migration the exact stored name still wins', async () => {
  const { state } = installStates({ status: false });
  assert.equal((await state.resolveStateByName('Orisa')).state_id, 40);
  assert.equal((await state.resolveStateByName('Orissa')).state_id, 26);
});

test('normaliseStateName · & and punctuation fold, so "Jammu & Kashmir" matches "Jammu and Kashmir"', () => {
  const { state } = install();
  assert.equal(state.normaliseStateName(' Jammu  &  Kashmir. '), 'jammu and kashmir');
});

test('stateNameVariants · active names plus aliases; inactive rows never offered', async () => {
  const { state } = install({
    handler: (t) => (/SELECT state_id, state_name, state_status FROM tbl_state$/i.test(t.trim()) ? [
      { state_id: 26, state_name: 'Odisha', state_status: 1 },
      { state_id: 40, state_name: 'Orisa', state_status: 0 },
    ] : null),
  });
  const v = await state.stateNameVariants();
  assert.ok(v.every((x) => x.state_id === 26), 'every variant points at the active row');
  assert.ok(v.some((x) => x.name === 'Odisha') && v.some((x) => x.name === 'orissa') && v.some((x) => x.name === 'orisa'));
});

test('state_type · refused with a 400 when not State/UT, and a 503 before the column exists', async () => {
  const typed = install();
  await assert.rejects(typed.state.updateState(2, { state_type: 'Province' }, 42), (e) => e.status === 400);
  const untyped = install({ handler: (t, p) => (/SHOW COLUMNS FROM tbl_state LIKE/i.test(t) && p[0] === 'state_type' ? [] : null) });
  await assert.rejects(untyped.state.updateState(2, { state_type: 'UT' }, 42), (e) => e.status === 503);
});

test('state_type · written on update when the column exists', async () => {
  const { calls, state } = install();
  await state.updateState(2, { state_type: 'UT' }, 42);
  assert.match(stateUpdates(calls)[0].sql, /state_type = \?/);
});

test('lookup states · the dropdown offers ACTIVE states only, with their type', async () => {
  const { calls } = install();
  delete require.cache[require.resolve(path.join(ROOT, 'services/lookup.service'))];
  await require(path.join(ROOT, 'services/lookup.service')).states();
  const q = calls.find((c) => /FROM tbl_state/i.test(c.sql) && /ORDER BY state_name/i.test(c.sql));
  assert.match(q.sql, /WHERE state_status = 1/);
  assert.match(q.sql, /state_type/);
});

test('migration · every state starts with manager 121, and nothing is moved or merged', () => {
  // Via the helper, so the test survives the file moving to migrations/executed/.
  const sql = require('./helpers/migration-file').readMigration('2026-09-21-state-zonal-manager.sql')
    .replace(/^\s*--.*$/gm, '');
  assert.match(sql, /ADD COLUMN state_user INT NULL DEFAULT 121/);
  assert.doesNotMatch(sql, /UPDATE tbl_city/i, 'the migration must not touch cities');
  assert.doesNotMatch(sql, /DELETE /i);
});
