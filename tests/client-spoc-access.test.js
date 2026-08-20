/*
 * Client SPOC access model — role defaults folded with tri-state overrides.
 *
 * This is the file that decides whether someone sees another company's
 * commercials, so the cases below are the ones worth being certain about:
 * a missing row must fail CLOSED, an override of 0 must REVOKE a grant the
 * role gives, and Home must survive any misconfiguration.
 *
 * foldGrants is pure, so no pool is needed. installFakePool is still used for
 * the resolveAccess cases, which do query.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const SELECT_ACCESS = /^\s*SELECT spoc_role/i;

// Routes are fixed when the fake is installed, so the access lookup dispatches
// through this mutable box: an array is returned as rows, the string 'MISSING'
// throws the ER_NO_SUCH_TABLE (1146) an un-migrated environment would raise.
let accessRows = [];
const fake = installFakePool([
  [SELECT_ACCESS, () => {
    if (accessRows === 'MISSING') throw Object.assign(new Error('no such table'), { errno: 1146 });
    return accessRows;
  }],
]);
const access = require('../services/client-access.service');

after(() => fake.restore());

const grantsOf = (row) => access.foldGrants(row).grants;

/*
 * ROLLOUT POSTURE. An unconfigured SPOC resolves to the "No Role" pseudo-role,
 * not to a real one, and what that GRANTS is governed by UNASSIGNED_FAILS_OPEN
 * in the service. These assertions are written against that constant rather
 * than against a hard-coded surface list, so flipping the posture to
 * least-privilege after the role sweep keeps them honest instead of turning
 * them red.
 */
test('no access row resolves to No Role, per the rollout posture', () => {
  const folded = access.foldGrants(null);
  assert.equal(folded.role, 'none');
  assert.equal(folded.unassigned, true, 'the portal renders this chip in red');
  if (access.UNASSIGNED_FAILS_OPEN) {
    assert.deepEqual([...folded.grants].sort(), [...access.SURFACES].sort(),
      'while the posture is open, an unconfigured SPOC keeps every surface');
  } else {
    assert.ok(!folded.grants.includes('performance'), 'closed posture must withhold performance');
    assert.ok(!folded.grants.includes('invoicing'), 'closed posture must withhold invoicing');
  }
});

test('an unknown role id is unconfigured, not a real role', () => {
  const folded = access.foldGrants({ spoc_role: 99 });
  assert.equal(folded.role, 'none');
  assert.equal(folded.unassigned, true);
});

/*
 * The regression that hid behind Number(null) === 0. Once the unassigned role
 * took key 0 in ROLES, a MISSING row looked like a declared role and skipped
 * the fault branch entirely — which silently turned a DB fault into open
 * access. Guard the distinction directly.
 */
test('a READ FAULT never widens access, whatever the posture says', () => {
  const folded = access.foldGrants(null, { unconfigured: false });
  assert.equal(folded.role, 'store', 'a fault takes the Store SPOC floor');
  assert.ok(!folded.grants.includes('performance'));
  assert.ok(!folded.grants.includes('invoicing'));
});

test('role defaults grant the surfaces the role is for', () => {
  assert.ok(grantsOf({ spoc_role: access.ROLE_SENIOR }).includes('performance'));
  assert.ok(grantsOf({ spoc_role: access.ROLE_FINANCE }).includes('invoicing'));
  assert.ok(!grantsOf({ spoc_role: access.ROLE_FINANCE }).includes('performance'),
    'Finance is an invoicing role, not a performance one');
  assert.ok(!grantsOf({ spoc_role: access.ROLE_REGIONAL }).includes('invoicing'));
});

test('a NULL override inherits the role rather than denying', () => {
  const folded = access.foldGrants({ spoc_role: access.ROLE_SENIOR, can_view_performance: null });
  assert.ok(folded.grants.includes('performance'));
});

test('an override of 1 grants a surface the role withholds', () => {
  const folded = access.foldGrants({ spoc_role: access.ROLE_STORE, can_view_invoicing: 1 });
  assert.ok(folded.grants.includes('invoicing'), 'store SPOC + override should reach invoicing');
});

/*
 * The case a boolean-defaulting-to-0 column on tbl_client_contacts could not
 * have expressed, and the reason the access model is a side table with
 * nullable columns. The 2026-08-20 migration relies on exactly this: it seeds
 * every existing SPOC at role 3 to preserve their Invoicing access, then
 * revokes the brand-new Performance screen with can_view_performance = 0.
 */
test('an override of 0 REVOKES a surface the role grants', () => {
  const folded = access.foldGrants({ spoc_role: access.ROLE_SENIOR, can_view_performance: 0 });
  assert.ok(!folded.grants.includes('performance'), 'explicit 0 must beat the role default');
  assert.ok(folded.grants.includes('invoicing'), 'revoking one surface must not disturb another');
});

/*
 * Pins the shape the 2026-08-20 migration actually writes: role 3 with EVERY
 * override NULL. If someone re-introduces a hard-coded 0 or 1 in the seed,
 * this fails — which is the point, because a seeded literal freezes today's
 * answer into every row and defeats the role model.
 */
test('the migration seed shape grants the full role-3 surface set', () => {
  const seeded = {
    spoc_role: 3,
    can_view_performance: null, can_view_invoicing: null,
    can_approve_estimates: null, can_view_all_stores: null,
  };
  const folded = access.foldGrants(seeded);
  assert.deepEqual(
    folded.grants.slice().sort(),
    ['actions', 'completed', 'home', 'invoicing', 'open', 'performance'].sort(),
    'seeded SPOCs inherit role 3 in full — Invoicing preserved, Performance granted',
  );
  assert.equal(folded.allStores, true, 'role 3 sees the whole client');
});

/*
 * The escape hatch the seed leaves open. Performance is granted to everyone by
 * default now, so the ONLY way to withhold it from one person is an explicit
 * revoke — which is exactly what a tri-state override is for.
 */
test('a single SPOC can still be denied Performance without touching anyone else', () => {
  const folded = access.foldGrants({ spoc_role: 3, can_view_performance: 0 });
  assert.ok(!folded.grants.includes('performance'), 'explicit 0 must beat the role grant');
  assert.ok(folded.grants.includes('invoicing'), 'and must not disturb any other surface');
});

test('Home survives an override row that revokes everything else', () => {
  const folded = access.foldGrants({
    spoc_role: access.ROLE_STORE,
    can_view_performance: 0, can_view_invoicing: 0, can_approve_estimates: 0,
  });
  assert.ok(folded.grants.includes('home'), 'a misconfigured row must not lock a SPOC out of the portal');
});

test('all-stores scope follows the role but an override still wins both ways', () => {
  assert.equal(access.foldGrants({ spoc_role: access.ROLE_STORE }).allStores, false);
  assert.equal(access.foldGrants({ spoc_role: access.ROLE_SENIOR }).allStores, true);
  assert.equal(access.foldGrants({ spoc_role: access.ROLE_STORE, can_view_all_stores: 1 }).allStores, true);
  assert.equal(access.foldGrants({ spoc_role: access.ROLE_SENIOR, can_view_all_stores: 0 }).allStores, false);
});

test('accessFromSpoc reads the columns findSpocById joins on, and a null role means no row', () => {
  const withRow = access.accessFromSpoc({ id: 1, spoc_role: access.ROLE_FINANCE });
  assert.ok(withRow.grants.includes('invoicing'));
  const noRow = access.accessFromSpoc({ id: 1, spoc_role: null });
  assert.equal(noRow.role, 'none', 'a LEFT JOIN miss is unconfigured, not a stale role');
  assert.equal(noRow.unassigned, true);
});

test('resolveAccess reads the row when there is one', async () => {
  fake.reset();
  accessRows = [{ spoc_role: access.ROLE_FINANCE, can_view_performance: null, can_view_invoicing: null, can_approve_estimates: null, can_view_all_stores: null }];
  const folded = await access.resolveAccess(4242);
  assert.equal(folded.role, 'finance');
  assert.ok(folded.grants.includes('invoicing'));
  assert.equal(fake.calls.length, 1, 'one lookup, no follow-up read');
});

test('resolveAccess returns least privilege when the table is missing', async () => {
  fake.reset();
  accessRows = 'MISSING';
  const folded = await access.resolveAccess(4242);
  assert.equal(folded.role, 'store');
  assert.ok(!folded.grants.includes('invoicing'), 'a failed lookup must never open a surface');
  accessRows = [];
});

/*
 * The deploy-window case. Between shipping this code and running the
 * 2026-08-20 migration the access table does not exist, and findSpocById
 * stamps access_model_available = 0. Treating that as "no row" would strip
 * Invoices from every SPOC in production for the length of that window.
 */
test('a missing access TABLE keeps the surfaces SPOCs already had', () => {
  const folded = access.accessFromSpoc({ id: 1, access_model_available: 0 });
  assert.ok(folded.grants.includes('invoicing'),
    'deploying before the migration must not remove Invoices from anyone');
  assert.ok(folded.grants.includes('open'));
  assert.equal(folded.preAccessModel, true, 'the payload should say why it is shaped this way');
});

test('the compatibility mode still withholds the brand-new surface', () => {
  const folded = access.accessFromSpoc({ id: 1, access_model_available: 0 });
  assert.ok(!folded.grants.includes('performance'),
    'Performance did not exist before the access model and must stay closed');
  assert.equal(folded.allStores, false,
    'the reporting-hierarchy filter must keep applying exactly as it does today');
});

test('a missing ROW on a migrated environment is UNCONFIGURED, not a role', () => {
  /*
   * access_model_available = 1 with spoc_role null: the access model exists and
   * this SPOC is not in it. That used to mean least privilege. During the
   * rollout it means "No Role" — surfaced in red so it reads as a gap to close
   * from CRM → Manage Clients → Contacts, rather than as a silent lockout of
   * someone who was working yesterday.
   */
  const folded = access.accessFromSpoc({ id: 1, access_model_available: 1, spoc_role: null });
  assert.equal(folded.role, 'none');
  assert.equal(folded.unassigned, true);
  if (access.UNASSIGNED_FAILS_OPEN) {
    assert.ok(folded.grants.includes('invoicing'));
    assert.ok(folded.grants.includes('performance'));
  } else {
    assert.ok(!folded.grants.includes('invoicing'));
    assert.ok(!folded.grants.includes('performance'));
  }
});

test('requireGrant lets a holder through and 403s everyone else', () => {
  const guard = access.requireGrant('performance');

  let nexted = false;
  guard({ access: access.foldGrants({ spoc_role: access.ROLE_SENIOR }) }, {}, () => { nexted = true; });
  assert.equal(nexted, true, 'a senior leader holds performance');

  let status = null; let body = null;
  // modernError writes res.locals.logHint before responding, so the stub needs it.
  const res = { locals: {}, status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  guard({ spoc: { id: 7 }, access: access.foldGrants({ spoc_role: access.ROLE_STORE }) }, res, () => {
    assert.fail('store SPOC must not reach performance');
  });
  assert.equal(status, 403);
  assert.match(JSON.stringify(body), /can_view_performance/,
    'the error should name the flag an administrator would set');
});
