/*
 * Employee Productivity: who may open it, and whose data they get.
 *
 * The report used to be strict Admin-only (role_id == 2). It is now open to
 * Admins AND reporting managers — and a reporting manager sees ONLY their own
 * team.
 *
 * The scope is enforced on the SERVER, in router-level middleware, and that is
 * the whole point of these tests. The FE hides the Reporting Manager dropdown
 * for a manager, but reportingManagerId is still just a request field: hiding a
 * control does not stop anyone sending the value. If the override ever moves
 * into a per-handler check, the next endpoint added to this file inherits
 * nothing and one manager can read another's numbers.
 *
 * Source-level, because the property being protected is WHERE the override
 * lives — a fixture would pass just as happily against eight separate checks
 * that a ninth route forgets.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/*
 * The gate moved. It was written inline in admin-dashboard.js, and the report
 * an operator actually opens from the QuickSight page — employee-productivity —
 * was left gated on its per-report action key alone, so a reporting manager
 * without that grant saw "No Reports Available". One definition now lives in
 * middleware, and BOTH routers mount it; these assertions follow it there.
 */
const GATE = fs.readFileSync(
  path.join(__dirname, '..', 'middleware/quicksight-admin-or-rm.js'), 'utf8',
);
const ROUTE = GATE;
const MOUNTS = ['routes/admin/quicksight/admin-dashboard.js',
                'routes/admin/quicksight/employee-productivity.js']
  .map((rel) => [rel, fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')]);
const SERVICE = fs.readFileSync(
  path.join(__dirname, '..', 'services/quicksight/quicksight-admin-dashboard.service.js'), 'utf8',
);

test('the gate admits Admins AND reporting managers, and nobody else', () => {
  assert.match(ROUTE, /function adminOrReportingManager\(reportKey\)/,
    'the gate is a factory now — it takes the per-report key');
  assert.match(ROUTE, /role_id === ADMIN_ROLE_ID/, 'Admin still passes on role');
  assert.match(ROUTE, /await isReportingManager\(req\.user\.user_id\)/,
    'a reporting manager passes on the RELATION, not on a role');
  assert.match(ROUTE, /403, 'Access Denied\. Only Admin can view this page\.'/,
    'everyone else is still refused');
  for (const [rel, src] of MOUNTS) {
    assert.match(src, /router\.use\(adminOrReportingManager\('isQuickSight\w+View'\)\)/,
      `${rel} must mount the shared gate — the bug was one router having it and the other not`);
  }
  assert.match(ROUTE, /perms\.includes\(reportKey\)/,
    'mounted for the WHOLE router — a new route must not opt in by hand');
});

test('a non-Admin cannot choose whose team they see — the id is overwritten', () => {
  /*
   * The override reads req.user, never the request body, so a manager sending
   * someone else's id gets their own back. This is the one test that would
   * fail if the scope were ever left to the client.
   */
  const mw = ROUTE.slice(ROUTE.indexOf('function forceOwnHierarchy('));
  const body = mw.slice(0, mw.indexOf('\n}\n') + 3);
  assert.match(body, /if \(req\.qsIsAdmin\) return next\(\);/, 'Admins keep their choice');
  // Allows the null-guard the shared middleware adds; what matters is the
  // SOURCE — req.user — never anything the caller sent.
  assert.match(body, /const own = Number\(req\.user(?: && req\.user)?\.user_id\) \|\| 0;/,
    'the value comes from the SESSION');
  assert.equal(/reportingManagerId\s*=\s*(?:req\.(?:body|query)|Number\(req\.(?:body|query))/.test(body), false,
    'the override must never read the id back off the request it is overriding');
  assert.match(body, /req\.body\.reportingManagerId = own/);
  assert.match(body, /req\.query\.reportingManagerId = String\(own\)/,
    'GET routes carry it in the query, so both have to be pinned');
});

test('the override is router-level, ahead of every handler', () => {
  /*
   * Locate the middleware by its OWN signature, not by a line inside it.
   * `if (req.qsIsAdmin) return next();` appears twice — once in the gate that
   * SETS the flag and once in the scope override that reads it — so an indexOf
   * on that line finds the wrong one and the assertion measures nothing.
   */
  for (const [rel, src] of MOUNTS) {
    const gate = src.indexOf("router.use(adminOrReportingManager(");
    const scope = src.indexOf('router.use(forceOwnHierarchy)');
    const firstRoute = src.search(/router\.(get|post)\(/);
    assert.ok(gate > -1, `${rel} mounts the gate`);
    assert.ok(scope > gate, `${rel}: scope must run AFTER the gate that sets qsIsAdmin`);
    assert.ok(firstRoute === -1 || scope < firstRoute,
      `${rel}: scope must be mounted before the first route that could read the field`);
  }
});

test('/access reports the REAL role, not a hardcoded true', () => {
  // /access lives on the report router, not on the shared gate.
  const ad = MOUNTS.find(([rel]) => rel.endsWith('admin-dashboard.js'))[1];
  assert.match(ad, /isAdmin: Boolean\(req\.qsIsAdmin\)/);
  assert.equal(/isAdmin: true/.test(ad.replace(/\/\*[\s\S]*?\*\//g, '')), false,
    'the old hardcoded value was honest only while the router was Admin-only');
});

test('"reporting manager" is defined ONCE, the same way the dropdown defines it', () => {
  /*
   * verticalManagers() builds the dropdown; isReportingManager() guards the
   * door. Both ask: is there an active user_type_id = 5 whom somebody names in
   * reporting_manager. Two definitions would drift, and the drift would be an
   * access-control bug — someone in the list who cannot open the report, or the
   * reverse.
   */
  const fn = SERVICE.slice(SERVICE.indexOf('async function isReportingManager('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /M\.user_type_id = 5/);
  assert.match(body, /M\.user_status = 1/);
  assert.match(body, /TU\.reporting_manager != 0/);
  assert.match(body, /LIMIT 1/, 'existence check, not a list');
  // Cheap guards before the query.
  assert.match(body, /if \(id <= 0\) return false;/);
});
