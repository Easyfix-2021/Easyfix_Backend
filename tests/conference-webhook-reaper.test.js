'use strict';

/*
 * routes/webhook/plivo-conference.js + services/conference-reaper-cron.js —
 * the two halves of "we find out what actually happened to a conference".
 *
 * ─── WHY THESE TESTS EXIST ────────────────────────────────────────────────
 *
 * Every ops call is now a Plivo Multi-Party Call, and there is deliberately NO
 * feature flag — so both of these run on 100% of ops calls from day one. And
 * neither has ever seen a live Plivo account:
 *
 *   • The WEBHOOK parses a callback payload whose field names and event names
 *     came from documentation. The realistic failure is not a crash, it is
 *     SILENCE: an unrecognised event that we 200 and forget, leaving ops
 *     staring at a participant stuck on "connecting" forever. So the
 *     unparseable path is tested as hard as the happy path — it must log the
 *     payload's KEY PATHS (keys, never values: the payload carries a customer's
 *     mobile) and still answer 200.
 *   • The REAPER is the money guard, and MORE so since the owner deleted the
 *     three `plivo.conference.max.*` cost knobs: with no cap of our own sent to
 *     Plivo, the guards are endMpcOnExit on the operator's leg (primary) and
 *     this sweep (backstop). Its ceiling is now an INTERNAL constant — a LEAK
 *     DETECTOR, deliberately not a property, because a safety net ops can
 *     configure is one that will eventually be configured to zero.
 *
 *     Its windows are also the place the IST/UTC trap bites. A cutoff must be
 *     computed in the clock the COLUMN was written in, and the two tables this
 *     sweep touches do NOT share one: tbl_job_conference is app-written (IST
 *     wall clock) and needs a JS Date, while tbl_plivo_call_log is NOW()-written
 *     and needs NOW() arithmetic. Get either backwards and the sweep matches
 *     NOTHING, reaps NOTHING, and the leak goes undetected while everything
 *     looks healthy. That is a test, not a comment.
 *
 * Faithfulness: the REAL express router is mounted and driven over HTTP, the
 * REAL cron service runs, and both talk to a fake pool + a stubbed
 * globalThis.fetch. Assertions read the actual SQL and the actual Plivo request
 * off the wire. Nothing is re-implemented.
 *
 * Non-destructive: no DB, no provider call, no HTTP beyond 127.0.0.1.
 * Runner: `npm test` / `node --test`.
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

// ── Env, set before the service is required (BASE is read at module load).
process.env.PLIVO_BASE_URL = 'https://plivo.test/v1';
process.env.PLIVO_AUTH_ID = 'MATEST0000000000TEST';
process.env.PLIVO_AUTH_TOKEN = 'testtoken';
process.env.PLIVO_CALLER_ID = '918041234567';
process.env.PLIVO_CALLBACK_BASE_URL = 'https://core.example.in';
process.env.PLIVO_ANSWER_TOKEN_SECRET = 'conference-webhook-test-secret';

/* ────────────────────────────── fixtures ───────────────────────────────── */

const CONF_ID = 77;
const CONF_NAME = 'efxctestconf01';

// A customer number that must NEVER appear in a log line or a response.
const CUSTOMER_E164 = '919812345678';

/*
 * ⚠ NOTE WHAT IS ABSENT: the three plivo.conference.max.* cost knobs. The owner
 * deleted them; Plivo's own defaults are the provider ceiling now. Only the
 * ring timeout remains, and it is a DIALLER setting (how long an unanswered
 * participant rings), not a spend cap — the reaper's two grace windows are
 * derived from it.
 */
let props = [
  { property_key: 'plivo.calling.enabled', property_value: 'true' },
  { property_key: 'plivo.conference.ring.timeout.sec', property_value: '45' },
];

// The room. No max_* snapshots and no participant counter — the live count is
// derived from the legs in tbl_plivo_call_log.
function conference(over = {}) {
  return {
    id: CONF_ID,
    job_id: 482491,
    friendly_name: CONF_NAME,
    mpc_uuid: null,
    provider: 'plivo',
    started_by_user_id: 12,
    job_caller_info_id: 5001,
    job_status_snap: 3,
    job_efr_id_snap: 4471,
    status: 'live',
    started_on: new Date(Date.now() - 60_000),
    ended_on: null,
    duration: null,
    billed_leg_seconds: null,
    end_reason: null,
    error: null,
    created_on: new Date(Date.now() - 65_000),
    updated_on: null,
    ...over,
  };
}

// The reaper's leak-detector ceiling, restated here so the tests below fail if
// services/conference-reaper-cron.js quietly changes it.
const CEILING_SEC = 6 * 60 * 60;

/*
 * A LEG, as tbl_plivo_call_log stores it and as
 * services/plivo-call-log.service.js::findConferenceLeg projects it: the
 * participant vocabulary is preserved by SQL alias (member_id, participant_uuid,
 * target_kind), the number is already MASKED, and the status is this table's own
 * ('initiated', not 'dialling').
 *
 * `dialed_number` (one 'l' — the column's real spelling) is carried so the
 * digits-tail probe has something to match. Nothing derived from it may reach a
 * log line, which is exactly what the privacy test below asserts.
 */
function participant(over = {}) {
  return {
    id: 9101,
    conference_id: CONF_ID,
    status: 'initiated',
    member_id: null,
    participant_uuid: null,
    // What the SQL actually projects: LEFT(RIGHT(dialed_number, 10), 4). The
    // service's maskLeg() rebuilds masked_number from THIS, so the fixture must
    // carry the prefix rather than a pre-masked string — otherwise the test
    // would be asserting against a value the production code never computes.
    number_prefix: '9812',
    target_kind: 'customer',
    dialed_number: CUSTOMER_E164,
    ...over,
  };
}

/*
 * Mutable scenario the fake pool reads. `conferencesById` is keyed so the
 * reaper's per-row loadConferenceRow() gets the right row for each id.
 */
let conferencesById = {};
let participants = [];
let creatingRows = [];
let stuckLegRows = [];

/* ──────────────────────────────── fake DB ──────────────────────────────── */

/*
 * ORDER MATTERS — first regex wins. The narrow probes are listed before the
 * broad ones. Note that legs and rooms now live in DIFFERENT tables
 * (tbl_plivo_call_log vs tbl_job_conference), so the old hazard of a bare
 * `tbl_job_conference` route swallowing a `…_participant` one is gone with the
 * table it came from.
 */
const fake = installFakePool([
  [/FROM easyfix_properties/i, () => props],

  // The conference-column probe in plivo-call-log.service. Present ⇒ post-migration.
  [/information_schema\.columns/i, () => [{ 1: 1 }]],

  /*
   * ── reaper pass C — the stuck-leg join.
   *
   * Legs live in tbl_plivo_call_log now, so this join is
   * `tbl_plivo_call_log pcl JOIN tbl_job_conference c`. The route is unchanged
   * because the JOIN clause is what identifies it either way.
   */
  [/JOIN tbl_job_conference c ON/i, () => stuckLegRows],

  // The dry run's leg count, and the leg list getConference() loads.
  [/SELECT COUNT\(\*\) AS n FROM tbl_plivo_call_log/i, () => [{ n: stuckLegRows.length }]],
  [/FROM tbl_plivo_call_log WHERE conference_id = \? ORDER BY/i, () => []],

  /*
   * ── webhook LEG probes, on tbl_plivo_call_log.
   *
   * The webhook no longer writes any leg SQL of its own: it calls
   * conf.legs.findConferenceLeg / markConferenceLegStatus / closeConferenceLegs,
   * and these three routes are that service's three probes, most-specific first
   * (conference_member_id → call_uuid → dialled-digits tail). The assertions in
   * sections 1–3 are about BEHAVIOUR — which row was matched, what was written,
   * what was NOT logged — so they read the same as they did against the deleted
   * participant table.
   */
  [/WHERE conference_id = \? AND conference_member_id = \?/i, (_s, p) =>
    participants.filter((x) => x.conference_id === p[0] && x.member_id === p[1]).slice(0, 1)],
  [/WHERE conference_id = \? AND call_uuid = \?/i, (_s, p) =>
    participants.filter((x) => x.conference_id === p[0] && x.participant_uuid === p[1]).slice(0, 1)],
  [/RIGHT\(dialed_number, 10\) = \?/i, (_s, p) =>
    participants
      .filter((x) => x.conference_id === p[0]
        && String(x.dialed_number || '').slice(-10) === p[1]
        && ['initiated', 'ringing', 'answered'].includes(x.status))
      .slice(0, 1)],

  // ── reaper pass B — rows stranded in 'creating'
  [/WHERE status = 'creating' AND created_on < \?/i, () => creatingRows],

  /*
   * ── reaper pass A — listStaleConferences().
   *
   * The fake APPLIES THE REAL PREDICATE using the REAL params the service
   * computed, which is the whole point of this route: params[3] is the cutoff
   * the reaper derived from reaperCeilingSec(). Fixture timestamps are JS Dates
   * on both sides so the comparison is instant-vs-instant. (In production both
   * sides are IST wall clock — the column literally, the param because mysql2
   * formats a Date in the connection's +05:30 timezone. The thing under test is
   * that the cutoff is an app-side Date at all.)
   */
  [/FROM tbl_job_conference\s+WHERE status IN/i, (_s, p) => {
    const cutoff = p[3];
    const limit = p[4];
    return Object.values(conferencesById)
      .filter((c) => ['creating', 'live', 'ending'].includes(c.status))
      .filter((c) => new Date(c.started_on || c.created_on) < cutoff)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
  }],

  [/FROM tbl_job_conference WHERE friendly_name = \?/i, (_s, p) =>
    Object.values(conferencesById).filter((c) => c.friendly_name === p[0]).slice(0, 1)],
  [/FROM tbl_job_conference WHERE id = \?/i, (_s, p) =>
    (conferencesById[p[0]] ? [conferencesById[p[0]]] : [])],

  [/SELECT COUNT\(\*\) AS n FROM tbl_job_conference/i, () => [{ n: 0 }]],

  [/^\s*UPDATE /i, () => ({ affectedRows: 1 })],
]);

/* ───────────────────────────── fetch stub ──────────────────────────────── */

/*
 * ONE stub for two jobs: it must intercept Plivo but PASS THROUGH the test's
 * own requests to the local express server. Routing on the Plivo base host is
 * what keeps those two apart.
 */
let wire = [];
let plivoHandler = () => ({ status: 200, body: '{}' });
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.includes('plivo.test')) return realFetch(url, init);
  wire.push({ url: u, method: init.method, body: init.body ? JSON.parse(init.body) : null });
  const r = plivoHandler(u, init) || { status: 200, body: '{}' };
  return { status: r.status, async text() { return r.body; } };
};

/* ───────────────────────────── log capture ─────────────────────────────── */

const logger = require('../logger');
const realLog = { info: logger.info, warn: logger.warn, error: logger.error, debug: logger.debug, job: logger.job };
let logs = [];
for (const level of ['info', 'warn', 'error', 'debug', 'job']) {
  logger[level] = (a, b) => { logs.push({ level, a, b }); };
}
// Every log line this test produced, flattened to text for "must not contain".
const logText = () => logs.map((l) => JSON.stringify(l.a) + ' ' + JSON.stringify(l.b ?? '')).join('\n');

/* ─────────────────────────── modules under test ────────────────────────── */

const properties = require('../services/properties.service');
const conf = require('../services/plivo-conference.service');
const confWebhook = require('../routes/webhook/plivo-conference');
const reaper = require('../services/conference-reaper-cron');

let server;
let baseUrl;

before(async () => {
  await properties.preload();
  const app = express();
  // Exactly what server.js gives this router group. Plivo posts urlencoded.
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/webhook/plivo-conference', confWebhook);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  globalThis.fetch = realFetch;
  Object.assign(logger, realLog);
  fake.restore();
});

beforeEach(() => {
  fake.reset();
  wire = [];
  logs = [];
  plivoHandler = () => ({ status: 200, body: '{}' });
  conferencesById = { [CONF_ID]: conference() };
  participants = [participant()];
  creatingRows = [];
  stuckLegRows = [];
});

/* ────────────────────────────── helpers ────────────────────────────────── */

const token = (over = {}) => conf.signConferenceToken({ confId: CONF_ID, friendlyName: CONF_NAME, ...over });

async function postForm(fields, t = token()) {
  const res = await fetch(`${baseUrl}/api/webhook/plivo-conference/status?t=${encodeURIComponent(t)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const writes = () => fake.calls.filter((c) => /^\s*(UPDATE|INSERT|DELETE)\s/i.test(c.sql));
const writesMatching = (re) => writes().filter((c) => re.test(c.sql));

/* ══════════════════════ 1. THE WEBHOOK — happy path ═════════════════════ */

test('a participant-join event marks the participant joined and lands the member id', async () => {
  const res = await postForm({
    Event: 'ParticipantJoined',
    MPCName: CONF_NAME,
    MPCUUID: 'mpc-uuid-1',
    MemberID: 'member-42',
    ParticipantCallUUID: 'leg-uuid-42',
    To: CUSTOMER_E164,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.handled, true);
  assert.equal(res.body.event, 'participant_join');

  const upd = writesMatching(/UPDATE tbl_plivo_call_log/i);
  assert.equal(upd.length, 1, 'exactly one leg write');
  /*
   * 'answered', not 'joined'. The leg lives in tbl_plivo_call_log and therefore
   * speaks THAT table's status vocabulary — which is what lets GET
   * /api/admin/calls and the per-job call-history tooltip render a conference
   * leg without knowing conferences exist.
   */
  assert.ok(upd[0].params.includes('answered'), "the leg moves to the call log's own 'answered'");
  assert.match(upd[0].sql, /answered_on = COALESCE\(answered_on, NOW\(\)\)/i,
    'and stamps when they picked up, COALESCEd so a duplicate join cannot move the clock');
  // The member id is the ONLY thing that makes a later mute/drop possible, so
  // landing it is the load-bearing half of this event. It is a DIFFERENT column
  // from call_uuid — they are different Plivo identifiers.
  assert.match(upd[0].sql, /conference_member_id = COALESCE\(\?, conference_member_id\)/i);
  assert.ok(upd[0].params.includes('member-42'), 'MemberID must be stamped');
  assert.ok(upd[0].params.includes('leg-uuid-42'), 'ParticipantCallUUID must be stamped');
  assert.ok(upd[0].params.includes(9101), 'scoped to the matched leg row');

  /*
   * THERE IS NO COUNTER, and that is the point of the one-table model. The live
   * participant count is DERIVED from these very rows, so a repeated join
   * callback cannot double-count anything — the whole class of bug where a
   * counter and the rows it counts disagree no longer has anywhere to live.
   */
  assert.equal(writesMatching(/participant_count/i).length, 0,
    'no counter exists to move — the count is derived from the legs');
});

test('the join matched the row by MemberID, and never logged the customer number', async () => {
  participants = [participant({ member_id: 'member-42' })];
  await postForm({ Event: 'ParticipantJoined', MPCName: CONF_NAME, MemberID: 'member-42', To: CUSTOMER_E164 });

  const probes = fake.calls.filter((c) => /AND conference_member_id = \?/i.test(c.sql));
  assert.equal(probes.length, 1, 'the member-id probe is tried first');

  // PRIVACY. `To` is a real mobile. It may be used to match a row; it may
  // never reach a log line. The masked form is what ops sees.
  assert.ok(!logText().includes(CUSTOMER_E164), 'the raw customer number must never be logged');
  assert.ok(!logText().includes('9812345678'), 'nor the bare 10-digit form');
  assert.ok(logText().includes('9812••••••'), 'the MASKED number is what gets logged');
});

test('a ringing event moves initiated → ringing ONLY', async () => {
  const res = await postForm({ Event: 'ParticipantCallRinging', MPCName: CONF_NAME, MemberID: 'member-42', To: CUSTOMER_E164 });
  assert.equal(res.body.event, 'participant_ringing');
  const upd = writesMatching(/UPDATE tbl_plivo_call_log/i)[0];
  assert.ok(upd.params.includes('ringing'));
  // Guarded to the ONE status it may move FROM, so a ring callback arriving
  // after the answer callback cannot pull a live leg backwards.
  assert.match(upd.sql, /WHERE id = \? AND status IN \(\?\)/i);
  assert.ok(upd.params.includes('initiated'), "the guarded FROM status, in the call log's vocabulary");
});

/* ═════════ 2. THE WEBHOOK — the events that end things ══════════════════ */

test('MPCStart promotes creating → live and stamps the mpc uuid', async () => {
  conferencesById[CONF_ID] = conference({ status: 'creating', started_on: null });
  const res = await postForm({ Event: 'MPCStart', MPCName: CONF_NAME, MPCUUID: 'mpc-uuid-9' });

  assert.equal(res.body.event, 'mpc_start');
  const upd = writesMatching(/UPDATE tbl_job_conference\b/i)[0];
  assert.match(upd.sql, /SET\s+status = 'live'/i);
  assert.ok(upd.params.includes('mpc-uuid-9'));
  // A late/duplicate start must never resurrect an ended conference.
  assert.match(upd.sql, /WHERE id = \? AND status IN \('creating', 'live'\)/i);
});

test('MPCEnd ends the conference, records the billed seconds, and closes every open leg', async () => {
  const res = await postForm({
    Event: 'MPCEnd',
    MPCName: CONF_NAME,
    MPCDuration: '412',
    MPCBilledDuration: '480',
  });

  assert.equal(res.body.event, 'mpc_end');
  const confUpd = writesMatching(/UPDATE tbl_job_conference\b/i)[0];
  assert.match(confUpd.sql, /SET\s+status = 'ended'/i);
  assert.ok(confUpd.params.includes(412), 'duration');
  assert.ok(confUpd.params.includes(480), 'billed_leg_seconds — the only cheap answer to "what did this cost"');
  // The room emptied on its own → the operator hung up (endMpcOnExit="true").
  assert.ok(confUpd.params.includes('last_left'));
  // …but a reason WE already wrote (reaper / api) must win.
  assert.match(confUpd.sql, /end_reason = COALESCE\(end_reason, \?\)/i);

  // Every leg still open goes with the room. Closed as 'completed' — the call
  // log's terminal status for a leg that ran and ended, which is what it did.
  const pUpd = writesMatching(/UPDATE tbl_plivo_call_log/i)[0];
  assert.ok(pUpd, 'the legs are closed on the call log, where legs live');
  assert.ok(pUpd.params.includes('completed'));
  assert.match(pUpd.sql, /WHERE conference_id = \? AND status IN \(\?, \?, \?\)/i,
    'only the still-active legs — an already-hung-up leg keeps its own ending');
  // And nothing zeroes a counter, because there is none.
  assert.equal(writesMatching(/participant_count/i).length, 0);
});

test('a participant hangup closes THAT leg, with its duration and cause, and frees no counter', async () => {
  participants = [participant({ status: 'answered', member_id: 'member-42' })];
  const res = await postForm({
    Event: 'ParticipantLeft', MPCName: CONF_NAME, MemberID: 'member-42',
    ParticipantDuration: '95', HangupCauseName: 'NORMAL_CLEARING',
  });

  assert.equal(res.body.status, 'completed', "the call log's terminal status, not a conference-only 'left'");
  const upd = writesMatching(/UPDATE tbl_plivo_call_log/i)[0];
  assert.ok(upd.params.includes('completed'));
  assert.ok(upd.params.includes(95), 'the leg duration Plivo reported');
  assert.ok(upd.params.includes('NORMAL_CLEARING'), 'and why it ended, in hangup_cause');
  assert.ok(upd.params.includes(9101), 'scoped to the ONE matched leg — never the whole room');
  // Guarded to the active statuses so a duplicate/late callback cannot
  // resurrect a leg that has already hung up.
  assert.match(upd.sql, /WHERE id = \? AND status IN \(\?, \?, \?\)/i);

  /*
   * There is no seat to free. The live count is derived from these rows, so
   * closing one IS the decrement — which also removes the old double-decrement
   * hazard on a repeated callback.
   */
  assert.equal(writesMatching(/participant_count/i).length, 0, 'no counter to keep in step');
});

test('a no-answer is recorded as no_answer, not as a normal hangup', async () => {
  participants = [participant({ member_id: 'member-42' })];
  const res = await postForm({
    Event: 'ParticipantCallFailed', MPCName: CONF_NAME, MemberID: 'member-42',
    HangupCauseName: 'NO_ANSWER',
  });
  assert.equal(res.body.status, 'no_answer',
    'ops must be able to tell "nobody picked up" from "they hung up"');
});

/* ══════════════ 3. THE WEBHOOK — the paths that must not write ══════════ */

/*
 * THE ONE THAT MATTERS MOST. The callback envelope was never confirmed against
 * a real Plivo payload, so "we could not parse it" is a live possibility on
 * every single event. Logging the bare fact tells you nothing; logging the KEY
 * PATHS turns the next callback into the answer. Same pattern, same reason, as
 * routes/webhook/whatsapp.js.
 */
test('an unparseable payload logs the KEY PATHS (keys only), writes nothing, and still 200s', async () => {
  const res = await postForm({
    SomethingElse: 'surprise',
    CustomerMobile: CUSTOMER_E164,
    Whatever: 'value-we-must-not-log',
  });

  assert.equal(res.status, 200, 'never a non-200 — a retry storm of payloads we equally cannot read helps nobody');
  assert.equal(res.body.handled, false);
  assert.equal(writes().length, 0, 'nothing may be written from a payload we did not understand');

  const unparseable = logs.find((l) => /UNPARSEABLE/.test(String(l.b ?? l.a ?? '')));
  assert.ok(unparseable, 'the unparseable path must log, loudly');
  assert.equal(unparseable.level, 'warn');

  const shape = unparseable.a && unparseable.a.bodyShape;
  assert.ok(shape, 'the log must carry the payload SHAPE');
  assert.deepEqual(Object.keys(shape).sort(), ['CustomerMobile', 'SomethingElse', 'Whatever']);
  assert.equal(shape.SomethingElse, 'string', 'the TYPE is logged, never the value');

  // KEYS ONLY. A callback carries a customer's mobile; this log line is not the
  // place for it — nor for any other value.
  const text = logText();
  assert.ok(!text.includes(CUSTOMER_E164), 'a value must never be logged, least of all a phone number');
  assert.ok(!text.includes('value-we-must-not-log'), 'no values at all — keys and types only');
  // And it must point at the code to widen, or the log is a dead end.
  assert.match(String(unparseable.b), /FIELD_PROBES|classifyEvent/);
});

test('an invalid token is a silent 200 no-op — no lookup, no write', async () => {
  const res = await postForm({ Event: 'ParticipantJoined', MPCName: CONF_NAME }, 'not-a-real-token');
  assert.equal(res.status, 200);
  assert.equal(writes().length, 0);
  assert.equal(fake.calls.length, 0, 'a forged token must not even reach a SELECT');
});

test('a token minted for a DIFFERENT purpose is refused', async () => {
  // The recording token is the same secret with kind:'rec'. verifyConferenceToken
  // pins kind:'conf' precisely so one cannot be replayed at the other.
  const plivo = require('../services/plivo.service');
  const res = await postForm({ Event: 'MPCEnd', MPCName: CONF_NAME }, plivo.signRecordingToken(5001));
  assert.equal(res.status, 200);
  assert.equal(writes().length, 0, 'a recording token must not end a conference');
});

test('a payload naming a DIFFERENT conference is refused loudly and writes nothing', async () => {
  const res = await postForm({ Event: 'MPCEnd', MPCName: 'efxcsomeoneelse99' });
  assert.equal(res.status, 200);
  assert.equal(res.body.handled, false);
  assert.equal(writes().length, 0, 'better to write nothing than to end the wrong conference');
  assert.ok(logs.some((l) => /NAME MISMATCH/.test(String(l.a ?? '') + String(l.b ?? ''))));
});

test("Plivo's own `name_` prefix on the conference name is tolerated", async () => {
  const res = await postForm({ Event: 'MPCEnd', MPCName: `name_${CONF_NAME}` });
  assert.equal(res.body.handled, true, 'the name_ prefix is how Plivo addresses an MPC in its own URLs');
});

test('speak/mute chatter is recognised and ignored, never treated as unparseable', async () => {
  for (const ev of ['ParticipantSpeakStarted', 'ParticipantSpeakStopped', 'MPCFloorEvent']) {
    logs = [];
    fake.reset();
    const res = await postForm({ Event: ev, MPCName: CONF_NAME });
    assert.equal(res.body.ignored, true, `${ev} must be classified, not logged as a mystery`);
    assert.equal(writes().length, 0);
    assert.ok(!logs.some((l) => /UNPARSEABLE/.test(String(l.b ?? ''))), `${ev} must not look unparseable`);
  }
});

test('an event about a leg we have no row for is reported, not silently dropped', async () => {
  participants = [];
  const res = await postForm({ Event: 'ParticipantJoined', MPCName: CONF_NAME, MemberID: 'ghost-1', To: '919000000000' });
  assert.equal(res.body.handled, false);
  assert.equal(writes().length, 0);
  // A leg we cannot match is a leg being billed that we cannot control.
  assert.ok(logs.some((l) => /no participant row matched/.test(String(l.a ?? ''))));
});

/* ═══════════════ 4. classifyEvent — the spelling we do not know ═════════ */

test('event classification is case- and punctuation-insensitive', () => {
  const { classifyEvent, EVENTS } = confWebhook.__test;
  for (const spelling of ['MPCStart', 'mpc_start', 'MPC-Start', 'mpc start']) {
    assert.equal(classifyEvent(spelling, {}), EVENTS.MPC_START, spelling);
  }
  for (const spelling of ['MPCEnd', 'mpc_end', 'MPCEnded']) {
    assert.equal(classifyEvent(spelling, {}), EVENTS.MPC_END, spelling);
  }
});

/*
 * ORDER TRAP: 'ParticipantCallNoAnswer' CONTAINS 'answer'. Probed in the wrong
 * order it classifies as a JOIN and ops is shown a leg on the call that nobody
 * ever picked up.
 */
test('NoAnswer is a failure, not a join, even though it contains "answer"', () => {
  const { classifyEvent, EVENTS } = confWebhook.__test;
  assert.equal(classifyEvent('ParticipantCallNoAnswer', {}), EVENTS.P_FAIL);
  assert.equal(classifyEvent('ParticipantCallAnswered', {}), EVENTS.P_JOIN);
});

test('a payload with no Event key at all still classifies from its status fields', () => {
  const { classifyEvent, EVENTS } = confWebhook.__test;
  assert.equal(classifyEvent(null, { MemberID: 'm1', CallStatus: 'in-progress' }), EVENTS.P_JOIN);
  assert.equal(classifyEvent(null, { MPCStatus: 'ended' }), EVENTS.MPC_END);
  assert.equal(classifyEvent(null, { Nothing: 'useful' }), null, 'and gives up honestly when it cannot');
});

/* ═══════════════════════ 5. THE REAPER — cost backstop ═════════════════ */

/*
 * The headline behaviour: a conference past the LEAK-DETECTOR ceiling is
 * force-ended; one that started recently is left completely alone.
 *
 * The ceiling used to be a property (max_duration_sec 1800 + 300s grace = 35
 * minutes). It is now an internal constant of 6 HOURS, and the change of
 * MEANING matters more than the change of number: 35 minutes was a product
 * limit dressed as a safety net — it would have cut off a genuinely long ops
 * call. Six hours cannot plausibly fire on a real conversation, so a reap now
 * means something is BROKEN (endMpcOnExit not working, MPCEnd webhook lost),
 * which is the only thing a backstop should ever mean. The 90-minute
 * conference below is therefore correctly left alone.
 */
test('the reaper force-ends a conference past the leak-detector ceiling and leaves a long-but-plausible one alone', async () => {
  const STALE = 101;
  const FRESH = 102;
  conferencesById = {
    [STALE]: conference({ id: STALE, friendly_name: 'efxcstale01', started_on: new Date(Date.now() - 7 * 60 * 60_000) }),
    // 90 minutes — long for an ops call, but a call, not a leak.
    [FRESH]: conference({ id: FRESH, friendly_name: 'efxcfresh01', started_on: new Date(Date.now() - 90 * 60_000) }),
  };
  // DELETE the room, then the read-back 404s → gone, and verified.
  plivoHandler = (url, init) => (init.method === 'DELETE'
    ? { status: 204, body: '' }
    : { status: 404, body: '{"error":"not found"}' });

  const r = await reaper.run({ limit: 25 });

  assert.equal(r.ceilingSec, CEILING_SEC, 'the internal leak-detector constant, not a property');
  assert.equal(r.scanned, 1, 'only the overrunning conference is a candidate');
  assert.equal(r.ended, 1);
  assert.equal(r.endFailed, 0);

  const deletes = wire.filter((w) => w.method === 'DELETE');
  assert.equal(deletes.length, 1, 'exactly one room torn down');
  assert.match(deletes[0].url, /MultiPartyCall\/name_efxcstale01\//);
  assert.ok(!wire.some((w) => /efxcfresh01/.test(w.url)),
    'a 90-minute call is a call — the provider must not be touched for it at all');

  assert.ok(logs.some((l) => /REAPED/.test(String(l.a ?? ''))), 'a reap is a caught cost leak — it gets logged');
});

/*
 * THE CEILING IS NOT CONFIGURABLE, AND THAT IS THE POINT.
 *
 * It is the LAST line of a three-line defence (endMpcOnExit, then Plivo's own
 * defaults, then this), and the only one of the three that a person could
 * plausibly be tempted to expose as a knob. A property is a thing someone tunes
 * at 2am during an incident; this number must survive that. If a future change
 * moves it into easyfix_properties, this test is where that shows up.
 */
test('the ceiling is an internal constant — nothing reads a property to find it', async () => {
  assert.equal(reaper.LEAK_DETECTOR_CEILING_SEC, CEILING_SEC);
  assert.equal(reaper.ceilingSec(), CEILING_SEC);

  conferencesById = {};
  fake.reset();
  await reaper.run({ limit: 25 });

  // The ONLY property the sweep may consult is the ring timeout, and only to
  // derive its two grace windows — it is a dialler setting, not a spend cap.
  const propReads = fake.calls.filter((c) => /easyfix_properties/i.test(c.sql));
  assert.equal(propReads.length, 0, 'properties are served from the preloaded cache; the sweep issues no read of its own');
  const { getProperty } = require('../services/properties.service');
  for (const k of ['plivo.conference.max.duration.sec', 'plivo.conference.max.participants', 'plivo.conference.max.concurrent']) {
    assert.equal(getProperty(k), undefined, `${k} is deleted — nothing may fall back to it`);
  }
});

/*
 * THE CLOCK TRAP, PINNED — AND IT HAS TWO CORRECT ANSWERS, NOT ONE.
 *
 * A window must be computed in the clock the COLUMN was written in. The two
 * tables this sweep touches do not share a clock:
 *
 *   • tbl_job_conference is written APP-SIDE (new Date() + the pool's +05:30
 *     session timezone), so its columns hold the IST wall clock. NOW() is the
 *     DB server's zone — comparing them skews by 5.5 hours, and on a window
 *     narrower than that the sweep matches NOTHING and silently never reaps.
 *     Passes A and B must use a JS Date.
 *   • tbl_plivo_call_log is NOW()-written throughout (its own convention since
 *     2026-06-19), so `NOW() - INTERVAL n SECOND` compares the server clock to
 *     itself and is exact by construction. Handing pass C an IST Date would
 *     introduce the very skew the first rule avoids.
 *
 * An earlier version of this test asserted "no NOW() anywhere", which was right
 * only while every conference column was app-written. Now it asserts the RULE.
 */
test('each sweep uses the clock its own table was written in', async () => {
  conferencesById = {};
  await reaper.run({ limit: 25 });

  // ── tbl_job_conference: app-side Date, no server-clock arithmetic.
  for (const re of [/FROM tbl_job_conference\s+WHERE status IN/i, /WHERE status = 'creating' AND created_on < \?/i]) {
    const c = fake.calls.find((x) => re.test(x.sql));
    assert.ok(c, `pass ran: ${re}`);
    assert.doesNotMatch(c.sql, /NOW\(\)|CURDATE\(\)|INTERVAL/i,
      'an IST column compared to the DB clock would silently never match on a UTC server');
    assert.ok(c.params.some((p) => p instanceof Date), 'its window is an app-side Date');
  }

  const sweep = fake.calls.find((c) => /FROM tbl_job_conference\s+WHERE status IN/i.test(c.sql));
  const ageSec = (Date.now() - sweep.params[3].getTime()) / 1000;
  assert.ok(Math.abs(ageSec - CEILING_SEC) < 5, `cutoff should be ~${CEILING_SEC}s ago, was ${ageSec}s`);

  // ── tbl_plivo_call_log: NOW()-relative, because that column is NOW()-written.
  const legSweep = fake.calls.find((c) => /JOIN tbl_job_conference c ON/i.test(c.sql));
  assert.ok(legSweep, 'the stuck-leg pass ran');
  assert.match(legSweep.sql, /initiated_on < NOW\(\) - INTERVAL \? SECOND/i,
    'the leg column is NOW()-written, so NOW() arithmetic compares the server clock to itself — exact');
  assert.ok(!legSweep.params.some((p) => p instanceof Date),
    'an IST Date here would re-introduce the skew the other rule exists to avoid');
  assert.equal(legSweep.params[2], 45 + 300, 'ring timeout + 5 minutes of grace');
});

test('a conference Plivo still reports as running is NOT marked ended — it stays for the next sweep', async () => {
  const STALE = 101;
  conferencesById = { [STALE]: conference({ id: STALE, friendly_name: 'efxcstale01', started_on: new Date(Date.now() - 7 * 60 * 60_000) }) };
  // Plivo accepts the DELETE but still reports the room. Declaring victory here
  // would hide the exact leak the teardown exists to stop.
  plivoHandler = (url, init) => (init.method === 'DELETE'
    ? { status: 204, body: '' }
    : { status: 200, body: JSON.stringify({ mpc_uuid: 'u1', status: 'active' }) });

  const r = await reaper.run({ limit: 25 });

  assert.equal(r.ended, 0);
  assert.equal(r.endFailed, 1);
  assert.ok(logs.some((l) => l.level === 'error' && /REAP FAILED/.test(String(l.a ?? ''))),
    'a room we could not end is money we could not stop — that is an error, not a warning');
});

/* ═══════════ 6. THE REAPER — reconciling what the webhooks missed ═══════ */

/*
 * A row stuck in 'creating' is a room we cannot describe: the MPCStart webhook
 * never arrived, so we cannot tell "the operator never answered" from "it is
 * quietly running and billing". (It used also to block every ops call by
 * consuming a maxConcurrent slot — that cap is gone, but the ambiguity, which
 * was always the real problem, is not.)
 */
test("a 'creating' row Plivo has never heard of is released, and its legs go with it", async () => {
  creatingRows = [{ id: 55, friendly_name: 'efxcstuck01', status: 'creating', created_on: new Date(Date.now() - 10 * 60_000), started_on: null }];
  plivoHandler = () => ({ status: 404, body: '{"error":"not found"}' });

  const r = await reaper.run({ limit: 25 });

  assert.equal(r.creatingReleased, 1);
  assert.equal(r.creatingPromoted, 0);

  const confUpd = writesMatching(/UPDATE tbl_job_conference\b[\s\S]*status = 'failed'/i);
  assert.ok(confUpd.length >= 1, 'the conference row is released');
  assert.match(confUpd[0].sql, /WHERE id = \? AND status = 'creating'/i);
  // 'failed', not 'ended' — nothing ever ran.
  assert.doesNotMatch(confUpd[0].sql, /participant_count/i, 'there is no counter to zero any more');

  // Its legs are closed too, so the live panel stops showing legs connecting to
  // a room that does not exist.
  const legUpd = writesMatching(/UPDATE tbl_plivo_call_log[\s\S]*WHERE conference_id = \?/i);
  assert.equal(legUpd.length, 1);
  assert.ok(legUpd[0].params.includes('failed'));
});

test("a 'creating' row Plivo says is running is promoted to live — the MPCStart webhook was lost", async () => {
  creatingRows = [{ id: 55, friendly_name: 'efxcstuck01', status: 'creating', created_on: new Date(Date.now() - 10 * 60_000), started_on: null }];
  plivoHandler = () => ({ status: 200, body: JSON.stringify({ mpc_uuid: 'mpc-live-1', status: 'active' }) });

  const r = await reaper.run({ limit: 25 });

  assert.equal(r.creatingPromoted, 1);
  assert.equal(r.creatingReleased, 0);
  const upd = writesMatching(/SET\s+status = 'live'/i)[0];
  assert.ok(upd.params.includes('mpc-live-1'));
  assert.ok(logs.some((l) => /MPCStart webhook appears to be LOST/.test(String(l.a ?? ''))));
});

test('when Plivo cannot be READ, nothing is changed — guessing "ended" would hide a live room', async () => {
  creatingRows = [{ id: 55, friendly_name: 'efxcstuck01', status: 'creating', created_on: new Date(Date.now() - 10 * 60_000), started_on: null }];
  plivoHandler = () => ({ status: 500, body: 'upstream exploded' });

  const r = await reaper.run({ limit: 25 });

  assert.equal(r.creatingUnresolved, 1);
  assert.equal(r.creatingReleased, 0);
  assert.equal(r.creatingPromoted, 0);
  assert.equal(writesMatching(/tbl_job_conference\b/i).length, 0, 'an unreadable provider changes nothing');
});

test('a leg stuck ringing on a live conference is closed as no_answer', async () => {
  stuckLegRows = [{
    id: 9101, conference_id: CONF_ID, status: 'ringing', number_prefix: '9812',
    target_kind: 'customer', conf_status: 'live', conf_ended_on: null,
  }];

  const r = await reaper.run({ limit: 25 });

  assert.equal(r.legsClosed, 1);
  const upd = writesMatching(/^\s*UPDATE tbl_plivo_call_log SET status = \?/i)[0];
  assert.ok(upd, 'the leg is closed on the call log, where legs live');
  // The transition is guarded to the two statuses it is allowed to move FROM,
  // so a real webhook arriving a second later cannot be overwritten by us.
  assert.match(upd.sql, /WHERE id = \? AND status IN \(\?, \?\)/i);
  assert.ok(upd.params.includes('no_answer'), 'ops must be able to tell "nobody picked up" from "they hung up"');
  assert.ok(upd.params.includes('initiated') && upd.params.includes('ringing'), 'the guarded FROM statuses');

  /*
   * There is no seat to free. participant_count is gone: the live count is
   * DERIVED from these very rows, so closing one IS the decrement. The whole
   * class of bug where a counter and the rows it counts disagree cannot occur.
   */
  assert.equal(writesMatching(/participant_count/i).length, 0, 'no counter to keep in step');
});

test('a leg left dangling on an ALREADY-ENDED conference is closed as completed, not no_answer', async () => {
  stuckLegRows = [{
    id: 9101, conference_id: CONF_ID, status: 'initiated', number_prefix: '9812',
    target_kind: 'technician', conf_status: 'ended', conf_ended_on: new Date(Date.now() - 30 * 60_000),
  }];

  const r = await reaper.run({ limit: 25 });

  assert.equal(r.legsClosed, 1);
  const upd = writesMatching(/^\s*UPDATE tbl_plivo_call_log SET status = \?/i)[0];
  assert.ok(upd.params.includes('completed'),
    'the leg went when the room did — that is a completed call leg, not a missed one');
  assert.ok(upd.params.includes('reaper_conference_ended'), 'and why, in the column every other hangup reason uses');
});

test('a clean sweep is silent and touches nothing', async () => {
  conferencesById = {};
  const r = await reaper.run({ limit: 25 });
  assert.deepEqual(
    { scanned: r.scanned, ended: r.ended, creatingScanned: r.creatingScanned, legsScanned: r.legsScanned },
    { scanned: 0, ended: 0, creatingScanned: 0, legsScanned: 0 },
  );
  assert.equal(writes().length, 0);
  assert.equal(wire.length, 0, 'no provider call on a clean sweep');
  assert.ok(!logs.some((l) => l.level === 'warn' || l.level === 'error'),
    'this runs every 5 minutes — a clean sweep must not add noise');
});

/* ═══════════════════ 7. THE REAPER — the ops Test button ═══════════════ */

test('the Test button with no id is a DRY RUN — it reports, and writes nothing', async () => {
  conferencesById = { 101: conference({ id: 101, friendly_name: 'efxcstale01', started_on: new Date(Date.now() - 7 * 60 * 60_000) }) };

  const r = await reaper.runTest({});

  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.ceilingSec, CEILING_SEC);
  assert.equal(r.wouldForceEnd.length, 1);
  assert.equal(r.wouldForceEnd[0].name, 'efxcstale01');
  assert.equal(writes().length, 0, 'a dry run must not write');
  assert.equal(wire.length, 0, 'a dry run must not call Plivo');
  // Ops reads this note before pressing the real button, so it has to say what
  // the ceiling MEANS — a reap is a broken thing, not a long call.
  assert.match(r.note, /LEAK DETECTOR/);
});

test('the Test button with an id force-ends that one conference', async () => {
  plivoHandler = (url, init) => (init.method === 'DELETE' ? { status: 204, body: '' } : { status: 404, body: '{}' });
  const r = await reaper.runTest({ sourceId: String(CONF_ID) });
  assert.equal(r.ok, true);
  assert.equal(r.ended, true);
  assert.ok(wire.some((w) => w.method === 'DELETE' && w.url.includes(`name_${CONF_NAME}`)));
});

test('the Test button rejects a non-numeric id rather than sweeping everything', async () => {
  const r = await reaper.runTest({ sourceId: 'all' });
  assert.equal(r.ok, false);
  assert.equal(wire.length, 0);
});
