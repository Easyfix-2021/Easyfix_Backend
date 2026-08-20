const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * Route-level permission contract for the LMS action tool.
 *
 * The spec's rule for a state manager is "his city only — he cannot create or
 * push content". That has to be true of the ENDPOINT, not of a hidden button:
 * a hidden button is a UI preference, and anyone can post to a URL.
 *
 * These tests exercise the real router stack rather than issuing HTTP, which
 * is the house pattern (see easyfixer-lifecycle-route-auth.test.js). The
 * permission key is recovered from the guard's own 403 body — requireAction
 * closes over the key and reports it as "Missing permission: <key>", so the
 * assertion reads the same string an operator would see.
 */

const fake = installFakePool([[/.*/, []]]);
const router = require('../routes/admin/lms-action');

after(() => fake.restore());

function responseDouble() {
  const res = { statusCode: 200, body: null, locals: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function layerFor(method, path) {
  return router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
}

/** Run a route's actionGuard with a user holding NO grants, and read the key it demands. */
async function demandedKey(method, path) {
  const layer = layerFor(method, path);
  assert.ok(layer, `${method.toUpperCase()} ${path} must exist`);
  const guard = layer.route.stack.find((h) => h.name === 'actionGuard');
  assert.ok(guard, `${method.toUpperCase()} ${path} must carry an action guard`);
  const res = responseDouble();
  await guard.handle(
    { user: { user_id: 1, permissions: { actionPermissions: [] } } },
    res,
    () => { throw new Error('guard passed a user with no grants'); },
  );
  assert.equal(res.statusCode, 403);
  return String(res.body.error).replace('Missing permission: ', '');
}

const EXPECTED = [
  ['get', '/action/home', 'isLmsAction'],
  ['get', '/action/pending', 'isLmsAction'],
  // The export mirrors the list, so it needs exactly the list's permission —
  // no more (it would leak) and no less (it would be unreachable).
  ['get', '/action/pending/export.xlsx', 'isLmsAction'],
  ['get', '/field/my-city', 'isLmsAction'],
  ['post', '/chase/nudge', 'isLmsAction'],
  ['post', '/chase/mark-chased', 'isLmsAction'],
  // Moving work to the field is a different privilege from doing it yourself.
  ['post', '/action/handoff/preview', 'isLmsChaseHandoff'],
  ['post', '/action/handoff', 'isLmsChaseHandoff'],
  // "Push now" CREATES assignments — the authoring key, not the chase key.
  // This is the endpoint the spec's "cannot push content" actually turns on.
  ['post', '/action/client-push', 'isLmsManage'],
];

for (const [method, path, key] of EXPECTED) {
  test(`${method.toUpperCase()} ${path} demands ${key}`, async () => {
    assert.equal(await demandedKey(method, path), key);
  });
}

test('EVERY route on this router is gated — none is reachable ungated', () => {
  const routes = router.stack.filter((l) => l.route);
  assert.equal(routes.length, EXPECTED.length,
    'a new route was added without a permission assertion here');
  for (const l of routes) {
    const guard = l.route.stack.find((h) => h.name === 'actionGuard');
    assert.ok(guard, `${l.route.path} has no action guard`);
  }
});

test('a state manager (isLmsAction only) cannot push or hand off', async () => {
  const stateManager = { user: { user_id: 2, permissions: { actionPermissions: ['isLmsAction'] } } };
  for (const path of ['/action/client-push', '/action/handoff']) {
    const guard = layerFor('post', path).route.stack.find((h) => h.name === 'actionGuard');
    const res = responseDouble();
    let passed = false;
    await guard.handle(stateManager, res, () => { passed = true; });
    assert.equal(passed, false, `${path} must not accept a chase-only grant`);
    assert.equal(res.statusCode, 403);
  }
});

test('a state manager CAN read his city and chase', async () => {
  const stateManager = { user: { user_id: 2, permissions: { actionPermissions: ['isLmsAction'] } } };
  for (const [method, path] of [['get', '/field/my-city'], ['post', '/chase/nudge'], ['get', '/action/pending']]) {
    const guard = layerFor(method, path).route.stack.find((h) => h.name === 'actionGuard');
    let passed = false;
    await guard.handle(stateManager, responseDouble(), () => { passed = true; });
    assert.equal(passed, true, `${path} must be open to a chase-only grant`);
  }
});
