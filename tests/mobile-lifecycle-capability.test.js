const test = require('node:test');
const assert = require('node:assert/strict');

const {
  requireTechCapability,
  requireTechJobMutationCapability,
} = require('../middleware/require-tech-lifecycle-capability');
const attendanceRouter = require('../routes/mobile/attendance');

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

async function invoke(middleware, req) {
  const res = responseDouble();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

function request({ method = 'POST', path = '/', status = 'ACTIVE', capabilities = {} } = {}) {
  return {
    method,
    path,
    tech: { lifecycle: { status, capabilities } },
  };
}

test('capability guard is fail-closed when auth has no matching lifecycle permission', async () => {
  const guard = requireTechCapability('markAttendance');
  const denied = await invoke(guard, request({
    status: 'PAUSED',
    capabilities: { markAttendance: false },
  }));
  assert.equal(denied.nextCalled, false);
  assert.equal(denied.res.statusCode, 403);
  assert.equal(denied.res.body.details.code, 'TECH_LIFECYCLE_CAPABILITY_REQUIRED');
  assert.equal(denied.res.body.details.capability, 'markAttendance');

  const missing = await invoke(guard, { method: 'POST', path: '/attendance', tech: {} });
  assert.equal(missing.nextCalled, false);
  assert.equal(missing.res.statusCode, 403);

  const allowed = await invoke(guard, request({
    capabilities: { markAttendance: true },
  }));
  assert.equal(allowed.nextCalled, true);
  assert.equal(allowed.res.statusCode, null);
});

test('job boundary separates offer decisions from already-assigned mutations', async () => {
  const paused = {
    receiveNewJobs: false,
    mutateAssignedJobs: true,
  };
  const accept = await invoke(requireTechJobMutationCapability, request({
    path: '/jobs/44/accept',
    status: 'PAUSED',
    capabilities: paused,
  }));
  assert.equal(accept.nextCalled, false, 'accept must require new-work permission');
  assert.equal(accept.res.body.details.capability, 'receiveNewJobs');

  const reject = await invoke(requireTechJobMutationCapability, request({
    path: '/jobs/44/reject',
    status: 'PAUSED',
    capabilities: paused,
  }));
  assert.equal(reject.nextCalled, true, 'PAUSED can relinquish already-assigned work');

  for (const path of [
    '/jobs/44/checkin',
    '/jobs/44/quotation',
    '/jobs/44/location',
  ]) {
    const result = await invoke(requireTechJobMutationCapability, request({
      path,
      status: 'PAUSED',
      capabilities: paused,
    }));
    assert.equal(result.nextCalled, true, `${path} must preserve assigned work`);
  }

  const inactive = await invoke(requireTechJobMutationCapability, request({
    path: '/jobs/44/checkin',
    status: 'INACTIVE',
    capabilities: { receiveNewJobs: false, mutateAssignedJobs: false },
  }));
  assert.equal(inactive.nextCalled, false);
  assert.equal(inactive.res.body.details.capability, 'mutateAssignedJobs');

  const inactiveReject = await invoke(requireTechJobMutationCapability, request({
    path: '/jobs/44/reject',
    status: 'INACTIVE',
    capabilities: { receiveNewJobs: false, mutateAssignedJobs: false },
  }));
  assert.equal(inactiveReject.nextCalled, false);
  assert.deepEqual(
    inactiveReject.res.body.details.capabilities,
    ['receiveNewJobs', 'mutateAssignedJobs'],
  );

  const read = await invoke(requireTechJobMutationCapability, request({
    method: 'GET',
    path: '/jobs/44',
    status: 'INACTIVE',
    capabilities: {},
  }));
  assert.equal(read.nextCalled, true, 'job reads remain available');

  const unrelatedWrite = await invoke(requireTechJobMutationCapability, request({
    path: '/withdraw',
    status: 'INACTIVE',
    capabilities: {},
  }));
  assert.equal(unrelatedWrite.nextCalled, true, 'earnings/profile writes are not job-gated');
});

test('every attendance and leave mutation mounts the markAttendance guard', () => {
  for (const path of ['/attendance', '/leave', '/leave/unmark']) {
    const layer = attendanceRouter.stack.find((entry) => (
      entry.route
      && entry.route.path === path
      && entry.route.methods.post
    ));
    assert.ok(layer, `POST ${path} must be mounted`);
    const guard = layer.route.stack.find((entry) => (
      entry.handle?._techCapability === 'markAttendance'
    ));
    assert.ok(guard, `POST ${path} must require markAttendance`);
  }
});
