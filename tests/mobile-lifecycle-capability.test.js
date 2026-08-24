const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * The INACTIVE open-job tests below exercise the REAL mobile auth projection
 * (services/tech-auth.service.js findById → req.tech.lifecycle), so the shared
 * db singleton is faked before the services capture it. Order matters: the
 * information_schema probe and the open_jobs COUNT must be matched before the
 * broad tbl_easyfixer route.
 */
let openJobCount = 0;
let trainingOverdue = false;
let jobStatusFixture = null;
let openJobQueries = [];
const fake = installFakePool([
  [/FROM information_schema\.columns/i, [{ column_count: 6, history_count: 1 }]],
  [/COUNT\(\*\) AS open_jobs/i, (sql, params) => {
    openJobQueries.push({ sql, params });
    // With a fixture status set, answer like the real `job_status IN (…)`
    // would: the technician has exactly ONE job, at that status, and it counts
    // only if the query actually asks for that status.
    if (jobStatusFixture != null) {
      const [, ...statuses] = params.map(Number);
      return [{ open_jobs: statuses.includes(Number(jobStatusFixture)) ? 1 : 0 }];
    }
    if (openJobCount < 0) throw new Error('ER_LOCK_WAIT_TIMEOUT: lock wait timeout exceeded');
    return [{ open_jobs: openJobCount }];
  }],
  // Overdue training is a separate, fail-OPEN overlay that withdraws the SAME
  // three capabilities the open-job overlay grants. Inert unless a test arms it
  // — see 'overdue training still wins over the open-job overlay' below.
  [/FROM easyfixer_courses/i, () => [{ n: trainingOverdue ? 1 : 0 }]],
  [/FROM tbl_easyfixer\b/i, [{
    efr_id: 501,
    efr_name: 'Test Technician',
    efr_no: null,
    efr_email: null,
    efr_cityId: 1,
    efr_service_category: null,
    // Deactivated: the lifecycle transition projects efr_status = 0.
    efr_status: 0,
    is_technician_verified: 1,
    efr_manager_id: 0,
    user_id: 9001,
    insert_date: '2026-01-01 10:00:00',
    update_date: '2026-08-01 10:00:00',
    lifecycle_status: 'INACTIVE',
    lifecycle_reason_code: 'OPS_DEACTIVATION',
    lifecycle_reason: 'Deactivated by Ops',
    lifecycle_changed_at: '2026-08-01 10:00:00',
    lifecycle_source: 'CRM',
    lifecycle_version: 4,
  }]],
]);

const {
  requireTechCapability,
  requireTechJobMutationCapability,
} = require('../middleware/require-tech-lifecycle-capability');
const attendanceRouter = require('../routes/mobile/attendance');
const techAuth = require('../services/tech-auth.service');
const easyfixerLifecycle = require('../services/easyfixer-lifecycle.service');

after(() => fake.restore());

/** Resolve req.tech exactly as the mobile auth middleware does. */
async function techRequest(openJobs, { overdue = false } = {}) {
  openJobCount = openJobs;
  trainingOverdue = overdue;
  jobStatusFixture = null;
  openJobQueries = [];
  easyfixerLifecycle._internals.resetSchemaProbeForTests();
  return techAuth.findById(501);
}

/** Same, but the technician's ONE job sits at `jobStatus`. */
async function techWithJobAtStatus(jobStatus) {
  openJobQueries = [];
  trainingOverdue = false;
  jobStatusFixture = jobStatus;
  easyfixerLifecycle._internals.resetSchemaProbeForTests();
  const tech = await techAuth.findById(501);
  jobStatusFixture = null;
  return tech;
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

test('overdue training cannot bypass the offer-reject mutation gate', async () => {
  const result = await invoke(requireTechJobMutationCapability, {
    method: 'POST',
    path: '/jobs/44/reject',
    tech: {
      lifecycle: {
        status: 'ACTIVE',
        trainingOverdue: true,
        capabilities: {
          receiveNewJobs: false,
          mutateAssignedJobs: false,
          claimMoney: true,
        },
      },
    },
  });

  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.res.body.details.code, 'TECH_LIFECYCLE_CAPABILITY_REQUIRED');
  assert.deepEqual(
    result.res.body.details.capabilities,
    ['receiveNewJobs', 'mutateAssignedJobs'],
  );
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


/*
 * ── INACTIVE KEEPS WORK IN HAND ─────────────────────────────────────────────
 *
 * End-to-end through the real mobile projection: findById is what populates
 * req.tech.lifecycle, and the guards below are the same ones the /mobile/jobs
 * and /mobile/attendance routers mount. No app release is involved — the app
 * already routes into the operational app on continueAssignedJobs and gates
 * offers separately on receiveNewJobs (see the RN app's lifecycle policy).
 */
test('deactivated technician with open jobs can finish them but gets no new ones', async () => {
  const tech = await techRequest(2);

  assert.equal(tech.lifecycle.status, 'INACTIVE', 'status is untouched — only capabilities overlay');
  assert.equal(tech.lifecycle.openJobs, 2);
  assert.equal(tech.lifecycle.capabilities.continueAssignedJobs, true);
  assert.equal(tech.lifecycle.capabilities.mutateAssignedJobs, true);
  assert.equal(tech.lifecycle.capabilities.markAttendance, true);
  assert.equal(tech.lifecycle.capabilities.receiveNewJobs, false);
  assert.equal(openJobQueries.length, 1, 'exactly one bounded COUNT per auth resolution');

  for (const path of ['/jobs/44/checkin', '/jobs/44/checkout', '/jobs/44/location']) {
    const allowed = await invoke(requireTechJobMutationCapability, {
      method: 'POST', path, tech,
    });
    assert.equal(allowed.nextCalled, true, `${path} must stay reachable`);
  }

  const attendance = await invoke(requireTechCapability('markAttendance'), {
    method: 'POST', path: '/attendance', tech,
  });
  assert.equal(attendance.nextCalled, true, 'attendance for the day already committed to');

  const accept = await invoke(requireTechJobMutationCapability, {
    method: 'POST', path: '/jobs/99/accept', tech,
  });
  assert.equal(accept.nextCalled, false, 'NEW work stays blocked');
  assert.equal(accept.res.body.details.capability, 'receiveNewJobs');
});

test('the last open job closing returns the technician to the inactive screen', async () => {
  const tech = await techRequest(0);

  assert.equal(tech.lifecycle.status, 'INACTIVE');
  assert.equal(tech.lifecycle.openJobs, undefined);
  assert.equal(tech.lifecycle.capabilities.continueAssignedJobs, false);
  assert.equal(tech.lifecycle.capabilities.mutateAssignedJobs, false);
  assert.equal(tech.lifecycle.capabilities.markAttendance, false);
  assert.equal(tech.lifecycle.capabilities.receiveNewJobs, false);

  const checkin = await invoke(requireTechJobMutationCapability, {
    method: 'POST', path: '/jobs/44/checkin', tech,
  });
  assert.equal(checkin.nextCalled, false);
  assert.equal(checkin.res.body.details.capability, 'mutateAssignedJobs');
});

test('a failing open-job count leaves the technician locked out, not opened up', async () => {
  const tech = await techRequest(-1); // sentinel: the COUNT throws

  assert.equal(tech.lifecycle.capabilities.continueAssignedJobs, false);
  assert.equal(tech.lifecycle.capabilities.mutateAssignedJobs, false);
  assert.equal(tech.lifecycle.capabilities.markAttendance, false);
  assert.equal(tech.lifecycle.capabilities.receiveNewJobs, false);

  const checkin = await invoke(requireTechJobMutationCapability, {
    method: 'POST', path: '/jobs/44/checkin', tech,
  });
  assert.equal(checkin.nextCalled, false);
});


/*
 * ── THE STATUSES THAT USED TO STRAND ────────────────────────────────────────
 *
 * GET /api/mobile/jobs applies NO status filter, so the app lists a job on
 * fulfilment hold (21), one waiting on an estimate decision (15) and one owed a
 * revisit (10) exactly like a scheduled one. When "open" was the dashboard
 * counter's (1, 2, 20), a deactivated technician SAW those jobs and every
 * mutation 403'd. These walk the real auth projection + the real guards.
 */
test('a deactivated technician is not stranded by an on-hold / estimate-pending / revisit job', async () => {
  for (const [jobStatus, what] of [
    [21, 'fulfilment hold (routes/admin/jobs.js PUT /jobs/:id/hold)'],
    [10, 'hold released back to a revisit (POST /jobs/:id/hold/release)'],
    [15, 'estimate sent for approval by the technician themselves'],
  ]) {
    const tech = await techWithJobAtStatus(jobStatus);

    assert.equal(tech.lifecycle.status, 'INACTIVE', `${what}: status untouched`);
    assert.equal(tech.lifecycle.openJobs, 1, `${what}: the job the app still shows must count`);
    assert.equal(tech.lifecycle.capabilities.continueAssignedJobs, true, what);
    assert.equal(tech.lifecycle.capabilities.mutateAssignedJobs, true, what);
    assert.equal(tech.lifecycle.capabilities.markAttendance, true, what);
    assert.equal(tech.lifecycle.capabilities.receiveNewJobs, false, `${what}: NEW work still blocked`);

    for (const path of ['/jobs/44/checkin', '/jobs/44/checkout', '/jobs/44/location']) {
      const allowed = await invoke(requireTechJobMutationCapability, {
        method: 'POST', path, tech,
      });
      assert.equal(allowed.nextCalled, true, `${what}: ${path} must stay reachable`);
    }

    const attendance = await invoke(requireTechCapability('markAttendance'), {
      method: 'POST', path: '/attendance', tech,
    });
    assert.equal(attendance.nextCalled, true, `${what}: attendance must stay reachable`);

    const accept = await invoke(requireTechJobMutationCapability, {
      method: 'POST', path: '/jobs/99/accept', tech,
    });
    assert.equal(accept.nextCalled, false, `${what}: NEW work stays blocked`);
  }
});

test('a completed or cancelled job does not keep the inactive screen open', async () => {
  for (const jobStatus of [3, 5, 6, 7, 0, 9]) {
    const tech = await techWithJobAtStatus(jobStatus);
    assert.equal(tech.lifecycle.openJobs, undefined, `job_status ${jobStatus} grants nothing`);
    assert.equal(tech.lifecycle.capabilities.mutateAssignedJobs, false, `job_status ${jobStatus}`);
    assert.equal(tech.lifecycle.capabilities.markAttendance, false, `job_status ${jobStatus}`);
  }
});

/*
 * ── THE TWO OVERLAYS MEET ───────────────────────────────────────────────────
 *
 * findById layers TWO independent overlays onto the same three capabilities,
 * and they pull in OPPOSITE directions: the open-job overlay GRANTS
 * continue/mutate/markAttendance to a deactivated technician who still owes
 * someone a visit, while the overdue-training overlay WITHDRAWS exactly those
 * three until the training is done. Order is therefore load-bearing — training
 * is applied second so the restriction wins — and until now it was asserted
 * only by a comment. Swap the two blocks in services/tech-auth.service.js and
 * every other test in this file still passes.
 *
 * Training is the deliberate winner: the open-job overlay exists so a customer
 * is not stranded, but an untrained technician turning up is the risk the
 * training deadline was created to stop.
 */
test('overdue training still wins over the open-job overlay', async () => {
  const tech = await techRequest(2, { overdue: true });

  assert.equal(tech.lifecycle.status, 'INACTIVE');
  assert.equal(tech.lifecycle.trainingOverdue, true);
  assert.equal(tech.lifecycle.openJobs, 2, 'the grant still happened — it is then overridden');

  assert.equal(tech.lifecycle.capabilities.continueAssignedJobs, false);
  assert.equal(tech.lifecycle.capabilities.mutateAssignedJobs, false);
  assert.equal(tech.lifecycle.capabilities.markAttendance, false);
  assert.equal(tech.lifecycle.capabilities.receiveNewJobs, false);

  const checkin = await invoke(requireTechJobMutationCapability, {
    method: 'POST', path: '/jobs/44/checkin', tech,
  });
  assert.equal(checkin.nextCalled, false, 'an untrained technician does not check in');
  assert.equal(checkin.res.body.details.capability, 'mutateAssignedJobs');

  const attendance = await invoke(requireTechCapability('markAttendance'), {
    method: 'POST', path: '/attendance', tech,
  });
  assert.equal(attendance.nextCalled, false, 'attendance is withdrawn with the rest');
});
