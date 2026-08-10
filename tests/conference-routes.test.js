'use strict';

/*
 * routes/admin/conferences.js — the ops conference REST surface.
 *
 * ─── WHY THESE TESTS EXIST ────────────────────────────────────────────────
 *
 * tests/plivo-conference-service.test.js pins the PROVIDER half — the Plivo
 * MPC wire shapes and the teardown. This file pins the half that decides WHO
 * MAY DIAL WHOM, which is where the privacy model actually lives.
 *
 * There is no "cost cap" half any more. The three `plivo.conference.max.*`
 * properties were deleted by the owner, so this file asserts the ABSENCE of a
 * limit surface (no `limits` block, no cap refusal) alongside the guards that
 * remain: endMpcOnExit on the operator's leg, and the reaper.
 *
 * The customer's mobile is masked for staff. That guarantee survives only
 * because of two independent rules, and a test that checks one and not the
 * other proves nothing:
 *
 *   1. REFUSING FREE TEXT stops an operator TYPING a number. The participant
 *      schema accepts identifiers; the single number-shaped key
 *      (`customNumber`) is format-checked, mutually exclusive with every
 *      roster key, and behind its own permission.
 *   2. SCOPING TO THE JOB stops an operator ENUMERATING ids. A syntactically
 *      perfect `efrId` belonging to some other job's technician must be
 *      refused, because otherwise the roster is decoration and any valid id
 *      is dialable.
 *
 * Drop either and the endpoint becomes a way to place a call to anyone in the
 * database from a company line. So: both are tested, and so is the third
 * mechanism — that no response ever carries an unmasked number, asserted
 * against a DB fixture that DELIBERATELY contains one.
 *
 * Faithfulness: the REAL router is mounted, so the middleware chain under test
 * is the shipped one — requireAction, validate, the conditional rate limiter,
 * the handlers. Only what routes/admin/index.js would have attached (req.user)
 * is injected by a stand-in. RBAC resolves through the real
 * services/role.service against the fake pool, so a wrong action key fails
 * here exactly as it would in production.
 *
 * Non-destructive: fake pool, no real DB, globalThis.fetch stubbed for the
 * whole file so no provider is ever called. Runner: `npm test` / `node --test`.
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// Env the conference service reads at CALL time.
process.env.PLIVO_AUTH_ID = 'MATEST0000000000TEST';
process.env.PLIVO_AUTH_TOKEN = 'testtoken';
process.env.PLIVO_CALLER_ID = '918041234567';
process.env.PLIVO_CALLBACK_BASE_URL = 'https://core.example.in';
process.env.PLIVO_ANSWER_TOKEN_SECRET = 'conference-route-test-secret';
delete process.env.PLIVO_CALL_FROM;
delete process.env.PLIVO_CALL_TO;
delete process.env.PLIVO_CALLING_CUSTOM_NUMBER;

/* ───────────────────── the numbers under test ──────────────────────────── */

// Real digits live ONLY in fixtures. Every assertion about the wire checks
// either that these were dialled (server-side resolution worked) or that they
// never appear in a response body (masking held).
const CUSTOMER_MOBILE = '9812345678';
const CUSTOMER_ALT    = '9823456789';
const TECH_MOBILE     = '9834567890';
const SPOC_MOBILE     = '9845678901';
const CONTACT_MOBILE  = '9856789012';
const OPERATOR_MOBILE = '9867890123';
const CUSTOM_MOBILE   = '9810012345';
const ALL_REAL_NUMBERS = [
  CUSTOMER_MOBILE, CUSTOMER_ALT, TECH_MOBILE, SPOC_MOBILE, CONTACT_MOBILE,
  OPERATOR_MOBILE, CUSTOM_MOBILE,
];

/*
 * What actually goes on the wire and into dialled_number: the service runs
 * every destination through plivo.normaliseIndianPhone(), which prefixes 91.
 * The masking scan below still keys on the BARE ten digits, which is stricter
 * — the bare form is a substring of the prefixed one, so a leak of either is
 * caught, while a test written against the prefixed form alone would miss a
 * response that leaked the ten digits on their own.
 */
const dialled = (n) => `91${n}`;

const JOB_ID = 482491;
const CONF_ID = 77;
const TECH_ID = 4471;
const CONTACT_ID = 991;
// A technician who exists but is NOT on this job. The off-job probe.
const OTHER_TECH_ID = 5599;

/* ───────────────────────── mutable fake DB ─────────────────────────────── */

const scenario = {
  user: null,
  actions: [],          // action_name rows role_menu_action returns
  conference: null,
  participants: [],
  // The duplicate guard, modelled the way the DB expresses it: the
  // INSERT … WHERE NOT EXISTS affects zero rows. There is no participant cap
  // and no concurrency cap to model — both were deleted with the cost knobs.
  duplicateLeg: false,
  job: null,
  contacts: [],
};

function freshUser(over = {}) {
  return {
    user_id: 12,
    user_name: 'Ops Tester',
    user_role: 2,             // Admin — the owner-or-admin authZ path
    mobile_no: OPERATOR_MOBILE,
    ...over,
  };
}

function freshJob(over = {}) {
  return {
    job_id: JOB_ID,
    job_status: 1,
    fk_client_id: 55,
    fk_customer_id: 3001,
    fk_easyfixter_id: TECH_ID,
    additional_name: 'Neighbour',
    additional_number: CUSTOMER_ALT,
    client_spoc: SPOC_MOBILE,
    client_spoc_name: 'Client SPOC',
    customer_name: 'Test Customer',
    customer_mob_no: CUSTOMER_MOBILE,
    efr_first_name: 'Ravi',
    efr_last_name: 'Kumar',
    efr_no: TECH_MOBILE,
    ...over,
  };
}

function freshConference(over = {}) {
  return {
    id: CONF_ID,
    job_id: JOB_ID,
    friendly_name: 'efxctestconf01',
    mpc_uuid: null,
    provider: 'plivo',
    started_by_user_id: 12,
    job_caller_info_id: 5001,
    job_status_snap: 1,
    job_efr_id_snap: TECH_ID,
    status: 'live',
    // No participant_count / peak_participants / max_participants /
    // max_duration_sec: the counters and the caps are gone. The live count is
    // DERIVED by the service from the legs it loads.
    started_on: '2026-08-04 15:00:00',
    ended_on: null,
    duration: null,
    billed_leg_seconds: null,
    end_reason: null,
    error: null,
    created_on: '2026-08-04 14:59:50',
    updated_on: null,
    ...over,
  };
}

/*
 * A PARTICIPANT IS A CALL LEG — a tbl_plivo_call_log row, projected through
 * services/plivo-call-log.service.js::LEG_PUBLIC_COLUMNS, which aliases the
 * columns back into the participant vocabulary the route already speaks
 * (target_kind / display_name / member_id / joined_at / …). So `status` here is
 * that table's own vocabulary: 'answered', never 'joined'.
 *
 * `number_prefix` is what the projection really selects —
 * LEFT(RIGHT(dialed_number, 10), 4) — and maskLeg() rebuilds `masked_number`
 * from it. The fixture carries the prefix, not a pre-masked string, so the test
 * exercises the production masking rather than a value handed to it.
 *
 * ⚠ `dialed_number` IS DELIBERATELY PRESENT, and it is the point of the masking
 * test. The real projection does not select it, but the fake pool does not
 * execute SQL — so the fixture hands the route a row that DOES contain a real
 * number. If a DTO ever degrades to `{ ...row }`, the number reaches the
 * response and the scan below fails. A fixture without it would prove nothing.
 */
function operatorParticipant(over = {}) {
  return {
    id: 9100,
    conference_id: CONF_ID,
    job_caller_info_id: 5001,
    job_id: JOB_ID,
    target_kind: 'operator',
    target_id: 12,
    display_name: 'Ops Tester',
    dialed_number: OPERATOR_MOBILE,
    number_prefix: '9867',
    participant_uuid: 'pu-operator',
    member_id: 'm-operator',
    status: 'answered',
    hangup_cause: null,
    added_by_user_id: 12,
    joined_at: '2026-08-04 15:00:05',
    left_at: null,
    duration: null,
    created_on: '2026-08-04 14:59:55',
    ...over,
  };
}

function customerParticipant(over = {}) {
  return operatorParticipant({
    id: 9101,
    target_kind: 'customer',
    target_id: JOB_ID,
    display_name: 'Test Customer',
    dialed_number: CUSTOMER_MOBILE,
    number_prefix: '9812',
    participant_uuid: 'pu-customer',
    member_id: 'm-customer',
    ...over,
  });
}

/*
 * ⚠ NOTE WHAT IS ABSENT: the three plivo.conference.max.* cost knobs. The owner
 * deleted them, so Plivo's own defaults are the provider ceiling. Only the ring
 * timeout remains, and it is a DIALLER setting (how long an unanswered
 * participant rings), not a spend cap.
 */
let props = [
  { property_key: 'plivo.calling.enabled', property_value: 'true' },
  { property_key: 'plivo.conference.ring.timeout.sec', property_value: '45' },
];

const fake = installFakePool([
  [/FROM easyfix_properties/i, () => props],

  // ── RBAC resolves through the REAL services/role.service ──
  [/FROM tbl_role/i, () => [{ role_id: 2, role_name: 'Admin', role_desc: 'Admin', role_status: 1, menu_ids: '1,2,3' }]],
  [/SELECT user_role FROM tbl_user/i, () => [{ user_role: scenario.user ? scenario.user.user_role : 2 }]],
  [/FROM role_menu_action/i, () => scenario.actions.map((a) => ({ action_name: a }))],

  // ── the roster reads (routes/admin/conferences.js) ──
  [/FROM tbl_job j/i, () => (scenario.job ? [scenario.job] : [])],
  [/FROM tbl_client_contacts/i, () => scenario.contacts],

  // The conference-column probe in plivo-call-log.service. Present ⇒ post-migration.
  [/information_schema\.columns/i, () => [{ 1: 1 }]],

  // ── the ROOM (tbl_job_conference) ──
  [/INSERT INTO tbl_job_conference\s/i, () => ({ insertId: CONF_ID })],
  [/FROM tbl_job_conference WHERE id = \?/i, () => (scenario.conference ? [scenario.conference] : [])],
  [/FROM tbl_job_conference WHERE friendly_name = \?/i, () => (scenario.conference ? [scenario.conference] : [])],

  /*
   * ── the LEGS (tbl_plivo_call_log) ──
   *
   * insertConferenceLeg is an INSERT … SELECT … WHERE NOT EXISTS, so its
   * DUPLICATE GUARD is expressed as affectedRows: one statement, no race. The
   * scenario flag therefore models the guard the way the database does —
   * `duplicateLeg` makes the insert affect zero rows, exactly as a second
   * simultaneous click would.
   */
  [/INSERT INTO tbl_plivo_call_log/i, () =>
    (scenario.duplicateLeg ? { insertId: 0, affectedRows: 0 } : { insertId: 9202, affectedRows: 1 })],

  // Narrower probe first: removeParticipant's loadConferenceLegForControl.
  [/FROM tbl_plivo_call_log\s+WHERE id = \? AND conference_id = \?/i,
    (_sql, params) => scenario.participants.filter((p) => Number(p.id) === Number(params[0]))],
  // getConferenceLeg — the row echoed back after a successful add.
  [/FROM tbl_plivo_call_log WHERE id = \? LIMIT 1/i,
    () => [customerParticipant({ id: 9202, status: 'initiated', joined_at: null })]],
  [/FROM tbl_plivo_call_log WHERE conference_id = \? ORDER BY/i, () => scenario.participants],

  [/^UPDATE /i, () => ({ affectedRows: 1 })],
]);

/* ────────────────────────────── fetch stub ─────────────────────────────── */

let wire = [];
let nextResponses = [];
const realFetch = globalThis.fetch;

function reply(status, body) {
  return { status, body: typeof body === 'string' ? body : JSON.stringify(body ?? {}) };
}

// The router talks to Plivo only through the service; anything captured here
// is a leg that would have been BILLED. Several tests assert wire.length === 0.
const plivoFetch = async (url, init = {}) => {
  wire.push({
    url: String(url),
    method: init.method,
    body: init.body ? JSON.parse(init.body) : null,
  });
  const r = nextResponses.shift() || reply(201, { api_id: 'a1', member_id: 'm-new', call_uuid: 'cu-new' });
  return { status: r.status, async text() { return r.body; } };
};

/* ───────────────────────── app under test ──────────────────────────────── */

const express = require('express');
const properties = require('../services/properties.service');
const { invalidatePermissionsCache } = require('../services/role.service');
const conferencesRouter = require('../routes/admin/conferences');

let server;
let baseUrl;

before(async () => {
  await properties.preload();

  const app = express();
  app.use(express.json());
  // Stand-in for routes/admin/index.js. requireAuth/role/maskMobile are that
  // router's job, not this one's — and deliberately NOT mounted here, so the
  // masking assertions below prove the DTOs mask on their own rather than
  // leaning on the middleware safety net.
  app.use((req, _res, next) => { req.user = { ...scenario.user }; next(); });
  app.use('/conferences', conferencesRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(500).json({ success: false, error: String(err && err.message) }); });

  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Installed only AFTER the app is listening, so the http requests the tests
  // make below still use the real fetch. Node's fetch is used for both the
  // test client and the provider client, so the stub has to discriminate.
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(baseUrl)) return realFetch(url, init);
    return plivoFetch(url, init);
  };
});

after(() => {
  globalThis.fetch = realFetch;
  if (server) server.close();
  fake.restore();
});

beforeEach(() => {
  wire = [];
  nextResponses = [];
  fake.reset();
  invalidatePermissionsCache();
  scenario.user = freshUser();
  scenario.actions = ['isClickToCall'];   // the SAME key that gates calling — there is no conference-specific grant
  scenario.conference = freshConference();
  scenario.participants = [operatorParticipant()];
  scenario.duplicateLeg = false;
  scenario.job = freshJob();
  scenario.contacts = [{ id: CONTACT_ID, contact_name: 'Client Manager', contact_no: CONTACT_MOBILE }];
});

/* ──────────────────────────── helpers ──────────────────────────────────── */

async function req(method, path, body) {
  const init = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await realFetch(`${baseUrl}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}
const post = (path, body) => req('POST', path, body);
const get = (path) => req('GET', path);
const del = (path) => req('DELETE', path);

// A participant leg is a tbl_plivo_call_log row. `wire.length === 0` proves no
// money was spent; this proves no row was written either.
const wroteParticipant = () => fake.calls.some((c) => /INSERT INTO tbl_plivo_call_log/i.test(c.sql));
const legInsert = () => fake.calls.find((c) => /INSERT INTO tbl_plivo_call_log/i.test(c.sql));

// The whole-response leak scan. Serialises the body and looks for any real
// number anywhere in it, at any depth, under any key.
function assertNoUnmaskedNumbers(body) {
  const text = JSON.stringify(body);
  for (const n of ALL_REAL_NUMBERS) {
    assert.ok(!text.includes(n), `response leaked the unmasked number ${n}\n${text}`);
  }
}

/* ═══════════════ 1. THE SCHEMA — refusing free text ═════════════════════ */

test('a custom number sent on the ROSTER arm is refused — the two arms are mutually exclusive', async () => {
  const res = await post(`/conferences/${CONF_ID}/participants`, {
    jobId: JOB_ID,
    customNumber: CUSTOM_MOBILE,
  });

  assert.equal(res.status, 400, 'jobId + customNumber must not validate');
  assert.equal(res.body.success, false);
  assert.equal(res.body.error, 'Validation failed');
  // Nothing may have happened: no row, no leg, no money.
  assert.equal(wroteParticipant(), false, 'a rejected body must not reach an INSERT');
  assert.equal(wire.length, 0, 'a rejected body must not dial');
});

test('a badly formatted custom number is refused at the validator, not the UI', async () => {
  scenario.actions = ['isClickToCall'];

  // Every shape INDIAN_MOBILE_REGEX exists to reject, including the one that
  // matters most: a MASKED number handed straight back to us. `customNumber`
  // is not in utils/mask-mobile.js's MOBILE_FIELDS, so reject-masked-mobile
  // would not catch it — the regex has to.
  const bad = ['1234567890', '5812345678', '98123456', '98123456789', '+919812345678', '9812•••••', 'abcdefghij', ''];
  for (const customNumber of bad) {
    const res = await post(`/conferences/${CONF_ID}/participants`, { customNumber });
    assert.equal(res.status, 400, `"${customNumber}" must be rejected`);
    assert.equal(wire.length, 0, `"${customNumber}" must not dial`);
  }
  assert.equal(wroteParticipant(), false);
});

test('an empty body, and two roster targets at once, are both refused', async () => {
  const empty = await post(`/conferences/${CONF_ID}/participants`, {});
  assert.equal(empty.status, 400);

  const two = await post(`/conferences/${CONF_ID}/participants`, { efrId: TECH_ID, spocJobId: JOB_ID });
  assert.equal(two.status, 400, 'exactly one target, never two');

  assert.equal(wire.length, 0);
  assert.equal(wroteParticipant(), false);
});

/* ═══════════ 2. THE ROSTER — refusing id enumeration ════════════════════ */

test('an off-job technician id is refused — a valid id is not a dialable id', async () => {
  // OTHER_TECH_ID is a perfectly well-formed efr id. It is simply not the
  // technician on THIS job. If this passes, the roster is decoration and the
  // endpoint dials anyone in tbl_easyfixer.
  const res = await post(`/conferences/${CONF_ID}/participants`, { efrId: OTHER_TECH_ID });

  assert.equal(res.status, 400, 'off-job target must be 400');
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /not on this job/i);
  // 400 and not 404, and the message names no id: "not on this job" and
  // "does not exist" must be indistinguishable, or this is an id oracle.
  assert.ok(!String(res.body.error).includes(String(OTHER_TECH_ID)), 'the refusal must not echo the probed id');
  assert.equal(wroteParticipant(), false, 'an off-job target must not reach an INSERT');
  assert.equal(wire.length, 0, 'an off-job target must not dial');
});

test('an off-job client contact and a foreign job id are refused too', async () => {
  const contact = await post(`/conferences/${CONF_ID}/participants`, { reportingContactId: 424242 });
  assert.equal(contact.status, 400);
  assert.match(contact.body.error, /not on this job/i);

  // A DIFFERENT job's id, sent to a conference anchored on JOB_ID. The roster
  // is derived from the CONFERENCE's job, never from the request's.
  const foreignJob = await post(`/conferences/${CONF_ID}/participants`, { jobId: 999999 });
  assert.equal(foreignJob.status, 400);
  assert.match(foreignJob.body.error, /not on this job/i);

  const foreignSpoc = await post(`/conferences/${CONF_ID}/participants`, { spocJobId: 999999 });
  assert.equal(foreignSpoc.status, 400);

  assert.equal(wire.length, 0);
  assert.equal(wroteParticipant(), false);
});

test('a job-less conference has an EMPTY roster — only a custom number can be added', async () => {
  scenario.conference = freshConference({ job_id: null });

  const res = await post(`/conferences/${CONF_ID}/participants`, { jobId: JOB_ID });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not linked to a job/i);
  assert.equal(wire.length, 0);
});

test('the useAlt arm resolves the alternate, and is a DISTINCT target from the customer', async () => {
  const res = await post(`/conferences/${CONF_ID}/participants`, { jobId: JOB_ID, useAlt: true });
  assert.equal(res.status, 200);

  // The server resolved the digits. The browser sent an identifier.
  assert.equal(wire.length, 1);
  assert.equal(wire[0].body.to, dialled(CUSTOMER_ALT), 'useAlt must dial tbl_job.additional_number');

  const ins = legInsert();
  assert.ok(ins.params.includes('customer_alt'), "the alternate is its own participant_role, so it can't collide with the customer's dedupe key");
});

/* ══════════════ 3. SERVER-SIDE RESOLUTION — the roster arm ══════════════ */

test('a roster add sends an IDENTIFIER and the SERVER supplies the digits', async () => {
  const res = await post(`/conferences/${CONF_ID}/participants`, { efrId: TECH_ID });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.participantId, 9202);

  assert.equal(wire.length, 1, 'exactly one leg dialled');
  assert.equal(wire[0].method, 'POST');
  assert.match(wire[0].url, /\/MultiPartyCall\/name_efxctestconf01\/Participant\/$/);
  assert.equal(wire[0].body.to, dialled(TECH_MOBILE), 'the technician on THIS job, resolved server-side');
  assert.equal(wire[0].body.from, process.env.PLIVO_CALLER_ID);

  /*
   * ⚠ NO CAP TRAVELS ON THE LEG, and its absence is an owner decision rather
   * than an omission: PLIVO'S OWN DEFAULTS APPLY, which is where a provider
   * ceiling belongs. What does travel is end_mpc_on_exit=false (only the
   * OPERATOR's leg ends the room) and a ring_timeout, which bounds a RINGING
   * phone rather than a running conference — every dialler needs one.
   */
  assert.equal(wire[0].body.max_duration, undefined, 'no duration cap is sent — Plivo\'s default applies');
  assert.equal(wire[0].body.max_participants, undefined, 'and no participant cap either');
  assert.equal(wire[0].body.end_mpc_on_exit, false, 'only the OPERATOR ends the room');
  assert.equal(wire[0].body.ring_timeout, 45, 'the one dialler setting that survived');

  // …and the response says nothing about the digits it just dialled.
  assertNoUnmaskedNumbers(res.body);
});

test('the SPOC arm dials tbl_job.client_spoc for THIS job', async () => {
  const res = await post(`/conferences/${CONF_ID}/participants`, { spocJobId: JOB_ID });
  assert.equal(res.status, 200);
  assert.equal(wire[0].body.to, dialled(SPOC_MOBILE));
  assertNoUnmaskedNumbers(res.body);
});

test('a client contact of THIS job\'s client is dialable', async () => {
  const res = await post(`/conferences/${CONF_ID}/participants`, { reportingContactId: CONTACT_ID });
  assert.equal(res.status, 200);
  assert.equal(wire[0].body.to, dialled(CONTACT_MOBILE));
  assertNoUnmaskedNumbers(res.body);
});

/* ══════════ 4. THE CUSTOM ARM — no extra permission, but still limited ══ */

/*
 * There is deliberately NO conference-specific permission. Per the owner:
 * "either no call access or any type of call access". `isClickToCall` gates
 * calling and therefore gates conferencing, including the custom-number arm.
 *
 * This test exists to pin that OPEN state on purpose, so re-gating it later is a
 * visible decision rather than an accident — and so nobody reads the missing
 * check as an oversight. What still constrains the arm is asserted below: the
 * number format, the rate limit, and the audit of actor + digits.
 */
test('the custom-number arm needs NO extra permission — calling access IS conference access', async () => {
  scenario.actions = ['isClickToCall'];

  const res = await post(`/conferences/${CONF_ID}/participants`, { customNumber: CUSTOM_MOBILE });

  assert.equal(res.status, 200, 'holding isClickToCall is sufficient');
  assert.equal(wire.length, 1, 'and it really dials');
  assert.equal(wroteParticipant(), true);
});

test('no call permission at all still refuses — the ONE gate must actually gate', async () => {
  scenario.actions = [];

  const res = await post(`/conferences/${CONF_ID}/participants`, { customNumber: CUSTOM_MOBILE });

  assert.equal(res.status, 403);
  assert.equal(wire.length, 0, 'nothing dialled');
  assert.equal(wroteParticipant(), false);
});

test('…and dials with it, recording the actor and the digits on the row', async () => {
  scenario.actions = ['isClickToCall'];

  const res = await post(`/conferences/${CONF_ID}/participants`, {
    customNumber: CUSTOM_MOBILE,
    displayName: 'Landlord',
  });

  assert.equal(res.status, 200);
  assert.equal(wire.length, 1);
  assert.equal(wire[0].body.to, dialled(CUSTOM_MOBILE));

  // The audit. For a roster add the target id is the record of what happened;
  // for a custom add the DIGITS are the only record, so both they and the
  // actor must be on the row — written BEFORE the leg was dialled.
  const ins = legInsert();
  assert.ok(ins, 'the leg row is written insert-first');
  assert.ok(ins.params.includes('custom'), 'participant_role = custom');
  assert.ok(ins.params.includes(dialled(CUSTOM_MOBILE)), 'dialed_number records exactly what was dialled');
  assert.ok(ins.params.includes(12), 'caller_user_id records who did it');

  assertNoUnmaskedNumbers(res.body);
});

test('a neither-arm caller cannot reach any conference route at all', async () => {
  scenario.actions = [];   // holds neither key

  assert.equal((await get(`/conferences/${CONF_ID}`)).status, 403);
  assert.equal((await post('/conferences', { jobId: JOB_ID })).status, 403);
  assert.equal((await post(`/conferences/${CONF_ID}/participants`, { efrId: TECH_ID })).status, 403);
  assert.equal((await post(`/conferences/${CONF_ID}/end`, {})).status, 403);
  assert.equal(wire.length, 0);
});

/* ═══════════ 5. MASKING — no unmasked number in any response ════════════ */

test('GET /:id returns the live panel with MASKED numbers only', async () => {
  scenario.participants = [operatorParticipant(), customerParticipant()];

  const res = await get(`/conferences/${CONF_ID}`);
  assert.equal(res.status, 200);

  // The scan that matters: the participant fixtures CARRY dialled_number, so a
  // DTO that spread the row would fail right here.
  assertNoUnmaskedNumbers(res.body);

  // …and prove the assertion is not vacuous — masked forms ARE present, so the
  // panel is still usable for recognition.
  const text = JSON.stringify(res.body);
  assert.ok(text.includes('9812••••••'), 'the masked form is what the operator sees');
  assert.ok(text.includes('9834••••••'), 'the roster carries masked numbers for recognition');

  // The provider handles stay server-side too — the browser has no business
  // addressing our Plivo account.
  assert.ok(!text.includes('efxctestconf01'), 'friendly_name is a provider handle, not FE state');
  assert.ok(!text.includes('m-operator'), 'member_id is a provider handle');
  assert.ok(!text.includes('dialed_number'), 'the column name must not even appear');

  const roster = res.body.data.roster;
  assert.equal(roster.length, 5, 'customer, alternate, technician, job SPOC, one client contact');
  const kinds = roster.map((r) => r.target_kind);
  assert.deepEqual(kinds, ['customer', 'customer_alt', 'technician', 'job_spoc', 'client_contact']);

  // Each row carries the exact body to POST, so the picker cannot mis-map keys.
  const alt = roster.find((r) => r.target_kind === 'customer_alt');
  assert.deepEqual(alt.request, { jobId: JOB_ID, useAlt: true });
  const tech = roster.find((r) => r.target_kind === 'technician');
  assert.deepEqual(tech.request, { efrId: TECH_ID });

  // Someone already in the room is flagged, so the picker greys them out
  // instead of racing a duplicate add.
  const cust = roster.find((r) => r.target_kind === 'customer');
  assert.equal(cust.on_call, true);
  assert.equal(cust.participant_id, 9101);
  assert.equal(tech.on_call, false);
});

test('POST / (start) and the add response are masked the same way', async () => {
  const start = await post('/conferences', { jobId: JOB_ID });
  assert.equal(start.status, 200);
  assert.equal(start.body.data.conferenceId, CONF_ID);
  assert.equal(wire.length, 0, 'starting a conference is DB-only — the MPC does not exist until the operator answers');
  assertNoUnmaskedNumbers(start.body);

  const add = await post(`/conferences/${CONF_ID}/participants`, { jobId: JOB_ID });
  assert.equal(add.status, 200);
  assertNoUnmaskedNumbers(add.body);
});

/* ══════════════════ 6. AuthZ, state and lifecycle ═══════════════════════ */

test('a non-owner non-Admin cannot read or touch someone else\'s conference', async () => {
  scenario.user = freshUser({ user_id: 99, user_role: 3 }); // Executive Supply, not the starter

  assert.equal((await get(`/conferences/${CONF_ID}`)).status, 403);
  assert.equal((await post(`/conferences/${CONF_ID}/participants`, { efrId: TECH_ID })).status, 403);
  assert.equal((await post(`/conferences/${CONF_ID}/end`, {})).status, 403);
  assert.equal((await del(`/conferences/${CONF_ID}/participants/9101`)).status, 403);
  assert.equal(wire.length, 0);
});

test('an ended conference cannot gain a leg', async () => {
  scenario.conference = freshConference({ status: 'ended', ended_on: '2026-08-04 15:20:00' });

  const res = await post(`/conferences/${CONF_ID}/participants`, { efrId: TECH_ID });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /already ended/i);
  assert.equal(wire.length, 0);
});

test('the operator\'s own leg cannot be dropped — that is what End Call is for', async () => {
  const res = await del(`/conferences/${CONF_ID}/participants/9100`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /End Call/i);
  assert.equal(wire.length, 0, 'a refused drop must not reach Plivo');
});

test('dropping a real participant kicks exactly that member and nothing else', async () => {
  scenario.participants = [operatorParticipant(), customerParticipant()];
  nextResponses = [reply(204, '')];

  const res = await del(`/conferences/${CONF_ID}/participants/9101`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.removed, true);

  assert.equal(wire.length, 1);
  assert.equal(wire[0].method, 'DELETE');
  assert.match(wire[0].url, /\/Participant\/m-customer\/$/, 'the member id is the path segment, not the call uuid');
  assertNoUnmaskedNumbers(res.body);
});

test('end ends the room, and a provider that still reports it is NOT reported as ended', async () => {
  // DELETE 204, then the read-back still finds the room running. The service
  // leaves the row live for the reaper; the route must not tell the operator
  // it stopped, because legs are still billing.
  nextResponses = [reply(204, ''), reply(200, { mpc_uuid: 'mpc-1', status: 'active' })];

  const res = await post(`/conferences/${CONF_ID}/end`, {});
  assert.equal(res.status, 502, 'an unverified teardown is a failure, not a success');
  assert.equal(res.body.success, false);
});

test('…and a verified teardown reports ended', async () => {
  nextResponses = [reply(204, ''), reply(404, 'not found')];

  const res = await post(`/conferences/${CONF_ID}/end`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.data.ended, true);
  assert.equal(res.body.data.verified, true);
});

test('a duplicate add is a clean 409 and never a second BILLED leg', async () => {
  // The INSERT … WHERE NOT EXISTS affects zero rows — the guard is one
  // statement, so two simultaneous clicks cost one leg, not two.
  scenario.duplicateLeg = true;

  const res = await post(`/conferences/${CONF_ID}/participants`, { jobId: JOB_ID });
  assert.equal(res.status, 409);
  assert.equal(wire.length, 0, 'the duplicate guard fires BEFORE Plivo is called');
});

/*
 * ⚠ THE TWO CAP TESTS THAT USED TO LIVE HERE ARE DELETED ON PURPOSE.
 *
 * They asserted a 400 at max_participants and a 429 at max_concurrent. The
 * owner removed all three `plivo.conference.max.*` knobs, so those refusals no
 * longer exist and a test for them would pin behaviour nobody wants. This is
 * the replacement, and it asserts the opposite: adding an Nth party is ordinary.
 *
 * Removing the caps does NOT mean unlimited. Plivo's own account defaults are
 * the provider ceiling; endMpcOnExit on the operator's leg is the product one
 * (tests/conference-webhook-reaper.test.js pins the reaper behind both).
 */
test('there is no participant cap and no concurrency cap — an extra party is added like any other', async () => {
  scenario.participants = [
    operatorParticipant(),
    customerParticipant(),
    customerParticipant({ id: 9102, target_kind: 'technician', target_id: TECH_ID, number_prefix: '9834' }),
    customerParticipant({ id: 9103, target_kind: 'job_spoc', target_id: JOB_ID, number_prefix: '9845' }),
  ];

  const res = await post(`/conferences/${CONF_ID}/participants`, { reportingContactId: CONTACT_ID });
  assert.equal(res.status, 200, 'a fifth party is not a cap violation — there is no cap');
  assert.equal(wire.length, 1);

  // …and starting a conference is never refused for concurrency either.
  const start = await post('/conferences', { jobId: JOB_ID });
  assert.equal(start.status, 200);
});

test('no endpoint publishes a `limits` block — there is no ceiling for the FE to enforce', async () => {
  const start = await post('/conferences', { jobId: JOB_ID });
  assert.equal(start.status, 200);
  assert.equal(start.body.data.limits, undefined, 'POST / must not advertise caps that do not exist');

  const live = await get(`/conferences/${CONF_ID}`);
  assert.equal(live.status, 200);
  assert.equal(live.body.data.limits, undefined, 'nor GET /:id');
  // The conference DTO must not carry them either — a null max_participants
  // reads as "unlimited", which is a different (and wrong) claim from "the
  // provider's default applies".
  for (const k of ['max_participants', 'max_duration_sec', 'peak_participants']) {
    assert.ok(!(k in live.body.data.conference), `${k} must be gone from the conference DTO`);
  }
  assert.equal(typeof live.body.data.conference.participant_count, 'number',
    'the live count survives — it is DERIVED from the legs, not a stored counter');
});

test('a provider refusal is 502 and the leg is marked failed — never a silent success', async () => {
  nextResponses = [reply(400, { error: 'invalid destination' })];

  const res = await post(`/conferences/${CONF_ID}/participants`, { efrId: TECH_ID });
  assert.equal(res.status, 502);
  assert.equal(res.body.success, false);
  assert.equal(res.body.details.providerStatus, 400, 'the provider status is surfaced, not swallowed');

  // The leg row is stamped, not deleted: "we tried to dial this person and
  // Plivo refused" is the interesting fact, and the row already records who
  // asked for it.
  const failed = fake.calls.find((c) =>
    /UPDATE tbl_plivo_call_log/i.test(c.sql) && Array.isArray(c.params) && c.params.includes('failed'));
  assert.ok(failed, 'the leg row records that we tried and Plivo refused');
});

test('an invalid conference id is a 400, never a lookup', async () => {
  for (const bad of ['0', '-1', 'abc']) {
    const res = await get(`/conferences/${bad}`);
    assert.equal(res.status, 400, `"${bad}" must not reach a query`);
  }
});

/* ═══════════════ 7. THE RATE LIMIT — custom arm only ════════════════════ */

/*
 * Last in the file ON PURPOSE, and on a dedicated user id.
 *
 * The limiter is module-scope (it has to be — a per-request limiter closes
 * over a fresh Map and caps nothing) and its window is 60s, so a consumed
 * budget persists for the rest of the run. Keying on user_id means this test
 * cannot starve the earlier ones, and running it last means they cannot
 * starve it.
 */
test('the custom-number arm is capped per operator; roster adds are not charged against it', async () => {
  scenario.user = freshUser({ user_id: 4242 });
  scenario.conference = freshConference({ started_by_user_id: 4242 });
  scenario.actions = ['isClickToCall'];

  // Roster adds first — as many as we like. /api/admin/* is rate-limit-exempt
  // and these dial only people already on the job, so they must NOT consume
  // the arbitrary-number budget.
  for (let i = 0; i < 8; i++) {
    const r = await post(`/conferences/${CONF_ID}/participants`, { efrId: TECH_ID });
    assert.equal(r.status, 200, `roster add #${i + 1} must not be rate limited`);
  }

  // Then the custom arm: five through, the sixth refused.
  for (let i = 0; i < 5; i++) {
    const r = await post(`/conferences/${CONF_ID}/participants`, { customNumber: CUSTOM_MOBILE });
    assert.equal(r.status, 200, `custom add #${i + 1} should be within the cap`);
  }

  const legsBefore = wire.length;
  const capped = await post(`/conferences/${CONF_ID}/participants`, { customNumber: CUSTOM_MOBILE });
  assert.equal(capped.status, 429, 'the 6th custom number in the window is refused');
  assert.equal(wire.length, legsBefore, 'a rate-limited request must not dial');
});
