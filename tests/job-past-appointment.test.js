/*
 * ROUTE-LEVEL tests for the past-appointment gate on /api/admin/jobs.
 *
 * What it protects (both reported from the field on job #520415):
 *   1. Rescheduling a job INTO a moment that has already gone (rescheduled at
 *      12:44 onto a 09:00 slot the same day).
 *   2. Offering a job whose promised slot has already passed — the offer is
 *      stale the instant it is sent.
 *
 * The cases that MUST keep working are as load-bearing as the blocks:
 *   - a body `requestedDateTime` overrides the stored one, so fixing the time
 *     in the SAME call is always allowed (both routes accept a schedule edit);
 *   - a DATE-ONLY appointment is judged by date, never coerced to 00:00 — today
 *     with no promised time is not "past";
 *   - /assign is deliberately NOT gated: reassigning a running-late job (tech
 *     no-show at 09:00, swap at 12:44) is a legitimate ops recovery.
 *
 * Fixtures are RELATIVE to now — a hardcoded date would rot into a false red.
 * No DB: fake-pool answers the reads and stops at the first write, so a request
 * that gets past the gate surfaces as 599 (see the terminal handler).
 *
 * Runner: `node --test`.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/* IST wall-clock 'YYYY-MM-DD HH:MM' offset by `days` (fractional allowed). */
function istPlus(days) {
  const ist = new Date(Date.now() + (5 * 60 + 30) * 60 * 1000 + days * 86_400_000);
  return ist.toISOString().slice(0, 16).replace('T', ' ');
}
const FUTURE   = istPlus(1);
const PAST     = istPlus(-1);
const TODAY    = istPlus(0).slice(0, 10);
const YESTERDAY = istPlus(-1).slice(0, 10);

const scenario = { appointment: `${FUTURE}:00` };

function jobRow() {
  return {
    job_id: 42,
    job_status: 0,                 // BOOKED — the offer/reschedule surface
    fk_client_id: 5, city_id: 11, vertical_id: 3,
    fk_easyfixter_id: null, fk_customer_id: 3,
    requested_date_time: scenario.appointment,
    booking_cut_off_time_slot: null, otp: null,
    remarks: null, custom_property: null,
  };
}

const fake = installFakePool(
  [
    [/INFORMATION_SCHEMA/i, () => [{ n: 3 }]],
    [/WHERE\s+j\.job_id\s*=\s*\?\s*LIMIT\s+1/i, () => [jobRow()]],
    [/FROM\s+tbl_job\s+WHERE\s+job_id\s*=\s*\?/i, () => [jobRow()]],
    /*
     * offerToTechnicians' active+verified check. Without it the service 400s
     * with "technician(s) not verified" — a DOWNSTREAM 400 that would be
     * indistinguishable from the gate's, quietly turning the pass-through
     * tests green for the wrong reason.
     */
    [/FROM\s+tbl_easyfixer\s+e\s+WHERE\s+e\.efr_id\s+IN/i, () => [
      { efr_id: 7, efr_status: 1, is_technician_verified: 1, efr_manager_id: null },
      { efr_id: 8, efr_status: 1, is_technician_verified: 1, efr_manager_id: null },
    ]],
  ],
  { stopOn: /^\s*(UPDATE|INSERT|DELETE)\s/i },
);

const express = require('express');
const jobsRouter = require('../routes/admin/jobs');

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  // Stand-in for routes/admin/index.js. Full scope + unrestricted stages, so
  // the ONLY thing that can reject a request here is the appointment gate.
  app.use((req, _res, next) => {
    req.user = { user_id: 77, user_name: 'Appointment Tester' };
    req.userRole = { role_name: 'Executive Supply' };
    req.scope = {
      clients:   { mode: 'all', ids: [], placeholders: '' },
      cities:    { mode: 'all', ids: [], placeholders: '' },
      states:    { mode: 'all', ids: [], placeholders: '' },
      verticals: { mode: 'all', ids: [], placeholders: '' },
    };
    req.allowedStages = { mode: 'all', stages: [] };
    next();
  });
  app.use('/jobs', jobsRouter);
  // 599 = reached the fake-pool write sentinel, i.e. the gate let it through.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err && err.__stop ? 599 : 500).json({ stopped: !!(err && err.__stop) });
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  scenario.appointment = `${FUTURE}:00`;
});

async function send(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const wroteAnything = () => fake.calls.some((c) => /^\s*(UPDATE|INSERT|DELETE)\s/i.test(c.sql));

const rescheduleBody = (when) => ({ requestedDateTime: when, reasonId: 12, remarks: 'slot moved' });

// ── Reschedule ───────────────────────────────────────────────────────

test('reschedule INTO the past is refused 400 and never writes', async () => {
  const res = await send('PATCH', '/jobs/42/reschedule', rescheduleBody(PAST.replace(' ', 'T')));
  assert.equal(res.status, 400);
  assert.match(String(res.body?.error ?? ''), /already passed/i);
  assert.equal(wroteAnything(), false);
});

test('reschedule to a future slot passes the gate', async () => {
  const res = await send('PATCH', '/jobs/42/reschedule', rescheduleBody(FUTURE.replace(' ', 'T')));
  assert.notEqual(res.status, 400);
  assert.equal(res.status, 599, 'should reach the service-layer write');
});

test('reschedule to a date-only value is judged by DATE, not coerced to 00:00', async () => {
  // Today with no promised time must NOT count as past…
  const today = await send('PATCH', '/jobs/42/reschedule', rescheduleBody(TODAY));
  assert.notEqual(today.status, 400, 'today (no time) is still actionable');
  // …but yesterday is unambiguously gone.
  const past = await send('PATCH', '/jobs/42/reschedule', rescheduleBody(YESTERDAY));
  assert.equal(past.status, 400);
});

// ── Offer ────────────────────────────────────────────────────────────

test('offering a job whose appointment already passed is refused 400', async () => {
  scenario.appointment = `${PAST}:00`;
  const res = await send('POST', '/jobs/42/offer', { easyfixerIds: [7, 8] });
  assert.equal(res.status, 400);
  assert.match(String(res.body?.error ?? ''), /Reschedule/i);
  assert.equal(wroteAnything(), false, 'no offer rows may be created');
});

test('offering a job whose appointment is still ahead passes the gate', async () => {
  const res = await send('POST', '/jobs/42/offer', { easyfixerIds: [7, 8] });
  assert.notEqual(res.status, 400);
});

/*
 * The escape hatch. Both routes accept an inline schedule edit, so an operator
 * who supplies a FUTURE requestedDateTime is fixing the very problem the gate
 * exists for — refusing that would make a stale job unrecoverable in one step.
 */
test('a future requestedDateTime in the body unblocks an otherwise-stale offer', async () => {
  scenario.appointment = `${PAST}:00`;              // stored slot is gone
  const res = await send('POST', '/jobs/42/offer', {
    easyfixerIds: [7, 8],
    requestedDateTime: FUTURE.replace(' ', 'T'),    // …but this call moves it
  });
  assert.notEqual(res.status, 400, 'the body override is the effective appointment');
});

test('a PAST requestedDateTime in the body does not sneak past a valid stored slot', async () => {
  scenario.appointment = `${FUTURE}:00`;            // stored slot is fine…
  const res = await send('POST', '/jobs/42/offer', {
    easyfixerIds: [7, 8],
    requestedDateTime: PAST.replace(' ', 'T'),      // …but this call moves it backwards
  });
  assert.equal(res.status, 400);
});

// ── Deliberately NOT gated ───────────────────────────────────────────

test('assign/reassign stays OPEN on a past appointment (late-job recovery)', async () => {
  scenario.appointment = `${PAST}:00`;
  const res = await send('PATCH', '/jobs/42/assign', { easyfixerId: 7 });
  assert.notEqual(res.status, 400, 'ops must still be able to swap a tech on a running-late job');
});
