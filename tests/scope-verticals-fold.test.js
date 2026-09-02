'use strict';
/*
 * foldVerticalsIntoClients — the verticals→clients fold in lib/scope.js.
 *
 * The fold exists for the query plan (a `cl.vertical_id` predicate flips
 * MySQL's join order off the tbl_job PK and forces a temp table + filesort for
 * a 50-row page; see the docblock on the function). But the thing that can
 * actually hurt someone is not the plan — it is the SET. Every test below is
 * about the set: the fold must be an intersection, so it can only ever narrow
 * what a scoped operator can see, and the two ways to get that wrong are
 * letting NULL-vertical clients in and turning an empty intersection into
 * "all".
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { foldVerticalsIntoClients, buildRequestScopeWithHierarchy } = require('../lib/scope');

// vertical 2 → clients 10, 11, 12 · vertical 3 → client 20.
// Client 99 is deliberately absent: it stands for the 194 production rows with
// vertical_id NULL, which the loader's WHERE excludes.
const CLIENT_ROWS = [
  { client_id: 10, vertical_id: 2 },
  { client_id: 11, vertical_id: 2 },
  { client_id: 12, vertical_id: 2 },
  { client_id: 20, vertical_id: 3 },
];

const seen = [];
const fakePool = {
  async query(sql) { seen.push(sql); return [CLIENT_ROWS]; },
};
const throwingPool = {
  async query() { throw Object.assign(new Error("Unknown column 'vertical_id'"), { code: 'ER_BAD_FIELD_ERROR' }); },
};

const allow = (ids) => ({ mode: 'allow', ids, placeholders: ids.map(() => '?').join(',') });
const ALL = { mode: 'all', ids: [], placeholders: '' };
const NONE = { mode: 'none', ids: [], placeholders: '' };

/*
 * MUST RUN FIRST. loadClientsByVertical caches for 60s at module scope, so any
 * successful load in an earlier test would serve this one from cache and the
 * throwing pool would never be consulted.
 */
test('a missing tbl_client.vertical_id FAILS OPEN — no fold, scope untouched', async () => {
  const folded = await foldVerticalsIntoClients(throwingPool, ALL, allow([2]));
  assert.equal(folded, null,
    'returning a fold here would apply a restriction derived from a column that does not exist');
});

test('clients "allow" is INTERSECTED, never widened', async () => {
  // 11 is in the vertical and survives; 20 is in another vertical and is
  // dropped; 99 (no vertical row at all) is dropped.
  const folded = await foldVerticalsIntoClients(fakePool, allow([11, 20, 99]), allow([2]));
  assert.deepEqual(folded.ids, [11]);
  assert.equal(folded.mode, 'allow');
  assert.equal(folded.placeholders, '?');
});

test('the fold can only NARROW — every id it emits was already in scope', async () => {
  const own = allow([10, 11, 12, 20]);
  const folded = await foldVerticalsIntoClients(fakePool, own, allow([2, 3]));
  for (const id of folded.ids) assert.ok(own.ids.includes(id), `${id} was not in the caller's own list`);
});

test('clients "all" becomes the derived list, and NULL-vertical clients stay out', async () => {
  const folded = await foldVerticalsIntoClients(fakePool, ALL, allow([2]));
  assert.deepEqual(folded.ids, [10, 11, 12]);
  assert.ok(!folded.ids.includes(99), 'a client with no vertical must not enter a vertical-scoped view');
  assert.ok(
    seen.some((s) => /WHERE\s+vertical_id\s+IS\s+NOT\s+NULL/i.test(s)),
    'the loader must exclude NULL vertical_id — that is what `cl.vertical_id IN (…)` did'
  );
});

test('an empty intersection is "none" (1=0), NOT "all"', async () => {
  // The one mistake that hands a user every job in the database.
  const folded = await foldVerticalsIntoClients(fakePool, allow([20]), allow([2]));
  assert.equal(folded.mode, 'none');
  assert.deepEqual(folded.ids, []);
});

test('clients "none" is left alone so the existing 1=0 still fires', async () => {
  assert.equal(await foldVerticalsIntoClients(fakePool, NONE, allow([2])), null);
});

test('verticals all / none / empty are no-ops', async () => {
  assert.equal(await foldVerticalsIntoClients(fakePool, ALL, ALL), null);
  assert.equal(await foldVerticalsIntoClients(fakePool, ALL, NONE), null);
  assert.equal(await foldVerticalsIntoClients(fakePool, ALL, { mode: 'allow', ids: [], placeholders: '' }), null);
});

test('buildRequestScopeWithHierarchy folds at its single exit and clears verticals', async () => {
  /*
   * The end-to-end shape the 13 downstream call sites depend on: once
   * `verticals` reads 'all', every `cl.vertical_id IN (…)` branch stops firing
   * and the restriction rides on `j.fk_client_id` instead. If this assertion
   * ever flips back to 'allow' while `clients` is also folded, the restriction
   * is applied TWICE — harmless for correctness, but the temp+filesort returns.
   */
  const req = {
    userRole: { role_name: 'Project Manager' },
    user: {
      user_id: 7785,
      manage_clients: '10,11,20',
      manage_cities: '0',
      manage_states: '0',
      manage_verticals: '2',
    },
  };
  const scope = await buildRequestScopeWithHierarchy(req, fakePool);
  assert.deepEqual(scope.clients.ids, [10, 11]);
  assert.equal(scope.verticals.mode, 'all');
  assert.equal(scope.cities.mode, 'all', 'manage_cities="0" must stay wildcard');
});

test('Admin still bypasses scope entirely — the fold must not resurrect one', async () => {
  const req = { userRole: { role_name: 'Admin' }, user: { user_id: 1, manage_verticals: '2' } };
  assert.equal(await buildRequestScopeWithHierarchy(req, fakePool), undefined);
});

/*
 * ── THE GUARD HALF ─────────────────────────────────────────────────────────
 *
 * The tests above are about the row SET. These are about by-id REACHABILITY,
 * which the fold silently changed and which no row-set test can see.
 *
 * assertEntityInScope treats a dimension whose value is null ON THE ENTITY as
 * in-scope (`if (id == null) return true`). That is how a vertical-scoped
 * operator reaches a client whose vertical_id IS NULL today: the vertical check
 * is skipped, and the clients dimension was 'all'. Folding replaces 'all' with
 * an explicit list derived from tbl_client.vertical_id — which by construction
 * cannot contain a NULL-vertical client — so the same GET would start 404ing.
 * Measured on QA: 3 of 32 vertical-scoped users, 194 clients each.
 *
 * So the pre-fold dimensions ride along as entityClients / entityVerticals and
 * the guard reads those. Row filtering narrows; reachability does not move.
 */
const { assertEntityInScope } = require('../lib/scope');

// A vertical-scoped operator: manage_clients '0' (→ all), manage_verticals '2'.
const foldedReq = () => ({
  userRole: { role_name: 'Project Manager' },
  scope: {
    clients:         allow([10, 11, 12]),   // folded, for row filtering
    entityClients:   ALL,                   // pre-fold, for guards
    verticals:       ALL,                   // cleared so no cl.vertical_id SQL
    entityVerticals: allow([2]),            // pre-fold, for guards
    cities: ALL, states: ALL,
  },
});

test('after a fold, a NULL-vertical client is STILL reachable by id', () => {
  // client 99 has vertical_id NULL: absent from the folded list, and the
  // entity's own vertical_id is null so the vertical check is skipped.
  const g = assertEntityInScope(foldedReq(), { client_id: 99, vertical_id: null });
  assert.equal(g.ok, true, 'the fold must not remove by-id reachability it never intended to');
});

test('after a fold, a client in ANOTHER vertical is still refused by id', () => {
  // 20 is vertical 3; this operator is scoped to vertical 2. entityVerticals
  // carries the real restriction, so the guard still bites.
  const g = assertEntityInScope(foldedReq(), { client_id: 20, vertical_id: 3 });
  assert.equal(g.ok, false, 'clearing verticals for SQL must not clear it for guards');
  assert.match(g.reason, /vertical/);
});

test('with no fold, the guard reads the live dimensions unchanged', () => {
  const req = {
    userRole: { role_name: 'Project Manager' },
    scope: { clients: allow([10]), verticals: allow([2]), cities: ALL, states: ALL },
  };
  assert.equal(assertEntityInScope(req, { client_id: 10, vertical_id: 2 }).ok, true);
  assert.equal(assertEntityInScope(req, { client_id: 11, vertical_id: 2 }).ok, false,
    'absent entityClients must fall back to clients, not skip the check');
});
