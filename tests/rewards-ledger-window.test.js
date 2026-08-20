/*
 * Rewards → Points Ledger: the date window.
 *
 * reward_points_ledger is APPEND-ONLY and gains ~441 rows a day, so an
 * unbounded read gets slower every day and never recovers. The CRM page now
 * opens on the current month and lets an operator widen it.
 *
 * The property these tests exist to protect is not "the filter works" — it is
 * WHERE THE DEFAULT LIVES. The page is explicit about the window it asks for;
 * the service applies only what it is given. A service-side "helpful" default
 * is exactly what took Manage Jobs Export down on 2026-08-20: an operator asked
 * for everything, silently received a subset, and nothing on screen said so.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/COUNT\(\*\)/i, [{ total: 0 }]],
  [/SELECT l\.id/i, []],
]);
const svc = require('../services/rewards.service');

/* The two statements adminLedger issues, in order. */
function statements() {
  return fake.calls.filter((c) => /reward_points_ledger/i.test(String(c.sql || '')));
}

test('NO dates → no window at all, so every other consumer still sees the whole ledger', async () => {
  fake.reset();
  await svc.adminLedger({});
  const [page] = statements();
  assert.ok(page, 'the page query must run');
  assert.equal(/created_at\s*>=/.test(page.sql), false, 'no lower bound invented');
  assert.equal(/created_at\s*</.test(page.sql), false, 'no upper bound invented');
});

test('BOTH ends → a closed window, upper bound EXCLUSIVE next-day', async () => {
  fake.reset();
  await svc.adminLedger({ from: '2026-08-01', to: '2026-08-21' });
  const [page] = statements();
  assert.match(page.sql, /l\.created_at >= DATE\(\?\)/);
  /*
   * The rows carry a TIME. A naive `created_at <= DATE(?)` would silently drop
   * everything stamped after midnight on the `to` date — i.e. all of today,
   * which is the day an operator checks first.
   */
  assert.match(page.sql, /l\.created_at < DATE\(\?\) \+ INTERVAL 1 DAY/);
  assert.ok(page.params.includes('2026-08-01') && page.params.includes('2026-08-21'));
});

test('EITHER end alone is a real request, not a malformed one', async () => {
  for (const [args, lower, upper] of [
    [{ from: '2026-08-01' }, true, false],
    [{ to: '2026-08-21' }, false, true],
  ]) {
    fake.reset();
    await svc.adminLedger(args);
    const [page] = statements();
    assert.equal(/created_at >=/.test(page.sql), lower, `lower bound for ${JSON.stringify(args)}`);
    assert.equal(/created_at </.test(page.sql), upper, `upper bound for ${JSON.stringify(args)}`);
  }
});

test('blank strings are absent, not a window on the empty string', async () => {
  // The page clears an input to '' rather than undefined; '' must not become
  // `created_at >= DATE('')`, which MySQL evaluates to NULL and matches nothing.
  fake.reset();
  await svc.adminLedger({ from: '', to: '   ' });
  const [page] = statements();
  // ⚠ Match the FILTER forms, not the bare column name: `l.created_at` is also
  // in the SELECT projection, so a bare /created_at/ would always be true and
  // this test would pass no matter what the code did.
  assert.equal(/created_at\s*>=/.test(page.sql), false, 'no lower bound from a blank');
  assert.equal(/created_at\s*</.test(page.sql), false, 'no upper bound from a blank');
});

test('DATE() wraps the PARAMETER, never the column — the index must stay usable', async () => {
  fake.reset();
  await svc.adminLedger({ from: '2026-08-01', to: '2026-08-21' });
  const [page] = statements();
  assert.equal(/DATE\(\s*l\.created_at\s*\)/.test(page.sql), false,
    'wrapping the column makes any index on created_at unusable');
});

test('COUNT and the page query carry the SAME window — a total that disagrees is worse than a slow page', async () => {
  fake.reset();
  await svc.adminLedger({ from: '2026-08-01', to: '2026-08-21' });
  const [page, count] = statements();
  assert.ok(count && /COUNT\(\*\)/i.test(count.sql), 'the count query must run');
  for (const frag of ['l.created_at >= DATE(?)', 'l.created_at < DATE(?) + INTERVAL 1 DAY']) {
    assert.ok(page.sql.includes(frag), `page carries: ${frag}`);
    assert.ok(count.sql.includes(frag), `COUNT carries: ${frag}`);
  }
  assert.deepEqual(count.params, page.params.slice(0, count.params.length),
    'and the same bound values, in the same order');
});

test('the window composes with the other filters without disturbing their bindings', async () => {
  fake.reset();
  await svc.adminLedger({ easyfixerId: 42, reasonCode: 'MANUAL', from: '2026-08-01' });
  const [page] = statements();
  assert.match(page.sql, /l\.easyfixer_id = \?/);
  assert.match(page.sql, /l\.reason_code = \?/);
  assert.match(page.sql, /l\.created_at >= DATE\(\?\)/);
  // Order matters: a shifted binding is silent and catastrophic.
  assert.deepEqual(page.params.slice(0, 3), [42, 'MANUAL', '2026-08-01']);
});

test('the date value is always BOUND, never inlined', async () => {
  fake.reset();
  await svc.adminLedger({ from: "2026-08-01' OR 1=1 --" });
  const [page] = statements();
  assert.equal(page.sql.includes('OR 1=1'), false, 'no interpolation, ever');
});
