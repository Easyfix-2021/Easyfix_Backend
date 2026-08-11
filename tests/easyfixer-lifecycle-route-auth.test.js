const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../routes/admin/easyfixers');

function lifecyclePutActionGuard() {
  const layer = router.stack.find((entry) => (
    entry.route
    && entry.route.path === '/:id/lifecycle-status'
    && entry.route.methods.put
  ));
  assert.ok(layer, 'lifecycle PUT route must be mounted');

  const guard = layer.route.stack.find((entry) => entry.name === 'actionGuard');
  assert.ok(guard, 'lifecycle PUT route must include an action permission guard');
  return guard.handle;
}

function routeActionGuard(path, method) {
  const layer = router.stack.find((entry) => (
    entry.route
    && entry.route.path === path
    && entry.route.methods[method]
  ));
  assert.ok(layer, `${method.toUpperCase()} ${path} route must be mounted`);

  const guard = layer.route.stack.find((entry) => entry.name === 'actionGuard');
  assert.ok(guard, `${method.toUpperCase()} ${path} must include an action permission guard`);
  return guard.handle;
}

function lifecyclePutScheduledGuard() {
  const layer = router.stack.find((entry) => (
    entry.route
    && entry.route.path === '/:id/lifecycle-status'
    && entry.route.methods.put
  ));
  assert.ok(layer, 'lifecycle PUT route must be mounted');

  const guard = layer.route.stack.find((entry) => (
    entry.name === 'requireScheduledLifecyclePermission'
  ));
  assert.ok(guard, 'lifecycle PUT route must include the scheduled-status permission guard');
  return guard.handle;
}

function responseDouble() {
  return {
    locals: {},
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('lifecycle PUT requires the exact isEdit CRM action permission', async () => {
  const guard = lifecyclePutActionGuard();

  const denied = responseDouble();
  let deniedNext = false;
  await guard({
    user: { user_id: 7, permissions: { actionPermissions: [] } },
  }, denied, () => { deniedNext = true; });
  assert.equal(deniedNext, false);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.error, 'Missing permission: isEdit');

  const allowed = responseDouble();
  let allowedNext = false;
  await guard({
    user: { user_id: 7, permissions: { actionPermissions: ['isEdit'] } },
  }, allowed, () => { allowedNext = true; });
  assert.equal(allowedNext, true);
  assert.equal(allowed.statusCode, null);
});

test('generic create, edit, and binary status mutations require canonical CRM actions', async () => {
  const cases = [
    { path: '/', method: 'post', permission: 'isAddNew' },
    { path: '/:id', method: 'put', permission: 'isEdit' },
    { path: '/:id/status', method: 'patch', permission: 'isEdit' },
  ];

  for (const { path, method, permission } of cases) {
    const guard = routeActionGuard(path, method);
    const denied = responseDouble();
    let deniedNext = false;
    await guard({
      user: { user_id: 7, permissions: { actionPermissions: [] } },
    }, denied, () => { deniedNext = true; });
    assert.equal(deniedNext, false, `${method.toUpperCase()} ${path} must reject`);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.error, `Missing permission: ${permission}`);

    const allowed = responseDouble();
    let allowedNext = false;
    await guard({
      user: { user_id: 7, permissions: { actionPermissions: [permission] } },
    }, allowed, () => { allowedNext = true; });
    assert.equal(allowedNext, true, `${method.toUpperCase()} ${path} must allow`);
    assert.equal(allowed.statusCode, null);
  }
});

test('scheduled lifecycle states additionally require isEasyfixerTempInactive', async () => {
  const guard = lifecyclePutScheduledGuard();
  const request = (body, permissions = ['isEdit']) => ({
    body,
    user: { user_id: 7, permissions: { actionPermissions: permissions } },
  });

  const plainPaused = responseDouble();
  let plainPausedNext = false;
  await guard(request({ status: 'PAUSED' }), plainPaused, () => { plainPausedNext = true; });
  assert.equal(plainPausedNext, true);

  for (const body of [
    { status: 'PAUSED', until: '2026-09-01' },
    { status: 'SUSPENDED', until: '2026-09-01' },
  ]) {
    const denied = responseDouble();
    let deniedNext = false;
    await guard(request(body), denied, () => { deniedNext = true; });
    assert.equal(deniedNext, false);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.error, 'Missing permission: isEasyfixerTempInactive');
  }

  const allowed = responseDouble();
  let allowedNext = false;
  await guard(request(
    { status: 'SUSPENDED', until: '2026-09-01' },
    ['isEdit', 'isEasyfixerTempInactive'],
  ), allowed, () => { allowedNext = true; });
  assert.equal(allowedNext, true);
  assert.equal(allowed.statusCode, null);
});
