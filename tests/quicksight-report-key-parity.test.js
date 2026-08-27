const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/*
 * Three lists have to agree, and nothing made them:
 *
 *   1. the backend routers   — routes/admin/quicksight/*.js, which gate on a
 *                              per-report action key;
 *   2. the seed migration    — what actually exists in menu_action, and
 *                              therefore what Manage Roles can grant;
 *   3. the CRM registry      — the report cards, gated on the same keys.
 *
 * When they drift the failure is SILENT and role-shaped: the report works for
 * Admin (who is granted everything by the seed) and is ungrantable to anyone
 * else, because the key Manage Roles would need does not exist. That is how a
 * Project Manager with a team ended up on "No Reports Available" while the
 * report itself was fine.
 *
 * This file owns 1 and 2. The CRM registry lives in the other repo, so its keys
 * are asserted from the migration's side: every key a router gates on must be
 * seeded, and every key seeded must belong to a router. A report added without
 * its seed fails here rather than in production three weeks later.
 */

const ROOT = path.join(__dirname, '..');
const ROUTER_DIR = path.join(ROOT, 'routes', 'admin', 'quicksight');

// Comments stripped: several routers name their key in a header block, and a
// scanner that counted those would pass a file whose actual guard was removed.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, '');

function routerKeys() {
  const found = new Map(); // key -> [files]
  for (const f of fs.readdirSync(ROUTER_DIR).filter((n) => n.endsWith('.js'))) {
    const src = stripComments(fs.readFileSync(path.join(ROUTER_DIR, f), 'utf8'));
    for (const m of src.matchAll(/'(isQuickSight\w+View)'/g)) {
      if (!found.has(m[1])) found.set(m[1], []);
      found.get(m[1]).push(f);
    }
  }
  return found;
}

function seededKeys() {
  const dir = path.join(ROOT, 'migrations');
  const all = [
    ...fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => path.join(dir, f)),
    ...fs.readdirSync(path.join(dir, 'executed')).filter((f) => f.endsWith('.sql'))
      .map((f) => path.join(dir, 'executed', f)),
  ];
  const keys = new Set();
  for (const f of all) {
    const sql = fs.readFileSync(f, 'utf8');
    // Only INSERTs into menu_action create a key. A rename/re-home UPDATE that
    // merely mentions the pattern does not, so match the quoted literal in an
    // INSERT..SELECT, not every occurrence in the file.
    if (!/INSERT INTO menu_action/i.test(sql)) continue;
    for (const m of sql.matchAll(/'(isQuickSight\w+View)'/g)) keys.add(m[1]);
  }
  return keys;
}

test('every key a QuickSight router gates on is seeded somewhere', () => {
  const routers = routerKeys();
  const seeded = seededKeys();
  const missing = [...routers.keys()].filter((k) => !seeded.has(k))
    .map((k) => `${k} (gated in ${routers.get(k).join(', ')})`);
  assert.deepEqual(missing, [],
    'these keys gate a live report but no migration creates them, so Manage '
    + 'Roles cannot grant the report to anyone — it silently works for Admin only');
});

test('every seeded QuickSight key belongs to a router', () => {
  const routers = routerKeys();
  const seeded = seededKeys();
  const orphans = [...seeded].filter((k) => !routers.has(k));
  assert.deepEqual(orphans, [],
    'these keys are grantable in Manage Roles but gate nothing — an operator '
    + 'can tick a permission that does not do anything');
});

test('the two relation-gated reports do not rely on their key alone', () => {
  /*
   * Employee Productivity and the Floor-Discipline Admin Dashboard are open to
   * reporting managers, and "has people reporting to them" is a RELATION that
   * no action key can express. Both must mount the shared gate; gating on the
   * per-report key alone is what produced the reported bug.
   */
  for (const f of ['employee-productivity.js', 'admin-dashboard.js']) {
    const src = stripComments(fs.readFileSync(path.join(ROUTER_DIR, f), 'utf8'));
    assert.match(src, /adminOrReportingManager\('isQuickSight\w+View'\)/,
      `${f} must mount the shared admin-or-reporting-manager gate`);
    assert.match(src, /router\.use\(forceOwnHierarchy\)/,
      `${f} must pin non-Admins to their own hierarchy SERVER-side`);
    assert.equal(/requireQuickSight\('isQuickSight\w+View'\)/.test(src), false,
      `${f} must not ALSO gate on the per-report key alone — that is the check `
      + 'that locked reporting managers out');
  }
});
