'use strict';

/*
 * services/plivo-conference.service.js — the Plivo Multi-Party Call (MPC) path.
 *
 * ─── WHY THESE TESTS EXIST ────────────────────────────────────────────────
 *
 * Every ops call now starts as a 1-participant conference, because Plivo
 * cannot promote a live <Dial> into one. That makes the MPC wire shapes
 * load-bearing for 100% of ops calls — and NOT ONE OF THEM HAS BEEN SEEN ON A
 * LIVE ACCOUNT. They come from documentation. The service concentrates every
 * assumption in one clearly-marked block precisely so it can be pinned here.
 *
 * So these tests read the ACTUAL Plivo request off the wire — URL, method,
 * auth header, parsed JSON body — with globalThis.fetch stubbed, and the
 * ACTUAL SQL off a fake pool. They drive the real exported functions. Nothing
 * is re-implemented; if the shape in the service changes, a test fails.
 *
 * The five things worth failing a build over:
 *
 *   1. THE DATA MODEL. A conference participant is a tbl_plivo_call_log ROW
 *      sharing the operator's job_caller_info_id — not a row in a parallel
 *      participant table, and NOT an extra tbl_job_caller_info audit row. If
 *      an extra audit row ever appears, every call-count report on the platform
 *      silently inflates, so that is asserted directly.
 *   2. THE COST GUARD THAT REMAINS. The three `plivo.conference.max.*`
 *      properties are GONE and Plivo's own defaults are the provider ceiling.
 *      What must still hold: endMpcOnExit on the operator's XML, no
 *      maxDuration/maxParticipants emitted anywhere, and a conference Plivo
 *      still reports as running after a 2xx DELETE NOT being marked ended
 *      (marking it ended hides the exact leak the teardown exists to stop).
 *   3. stayAlone. Plivo's default REMOVES a participant left alone, and our
 *      operator is alone for the second between entering the room and the
 *      receiver being added. With the default, every ops call breaks.
 *   4. MASKING. The customer's mobile is masked for staff. The leg projection
 *      must never select a whole number — asserted against the SQL itself, so
 *      a future `SELECT *` fails here rather than in production.
 *   5. FAIL-LOUD, NOT SILENT-DEGRADE. A non-2xx must mark the leg failed and
 *      report the status AND body upward; an unrecognised 2xx body must fall
 *      back to READING the room back rather than shrugging.
 *
 * Non-destructive: fake pool, no real DB, no provider call (globalThis.fetch
 * is stubbed for the whole file). Runner: `npm test` / `node --test`.
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// ── Env the service reads at CALL time (never at require time).
process.env.PLIVO_AUTH_ID = 'MATEST0000000000TEST';
process.env.PLIVO_AUTH_TOKEN = 'testtoken';
process.env.PLIVO_CALLER_ID = '918041234567';
process.env.PLIVO_CALLBACK_BASE_URL = 'https://core.example.in';
process.env.PLIVO_ANSWER_TOKEN_SECRET = 'conference-test-secret';
// QA redirect vars must be clear or resolveCallLegs-style overrides confuse the
// dialled digits these tests assert on.
delete process.env.PLIVO_CALL_FROM;
delete process.env.PLIVO_CALL_TO;
delete process.env.PLIVO_CALLING_CUSTOM_NUMBER;

/* ─────────────────────────── mutable fake DB ───────────────────────────── */

/*
 * easyfix_properties rows.
 *
 * `plivo.calling.enabled` is THE switch — there is no conference flag, and a
 * test that had to set one would be a design failure.
 *
 * ⚠ NOTE WHAT IS ABSENT: plivo.conference.max.duration.sec / .max.participants
 * / .max.concurrent. The owner deleted all three. `ring.timeout.sec` is here
 * and is deliberately NOT one of them — it bounds a RINGING PHONE, not a
 * running room, and every dialler needs one.
 */
let props = [
  { property_key: 'plivo.calling.enabled', property_value: 'true' },
  { property_key: 'plivo.conference.ring.timeout.sec', property_value: '45' },
];

let conferenceRow = null;      // the row loadConferenceRow() returns
let legRows = [];              // the legs listConferenceLegs() returns
let legControlRow = null;      // the row removeParticipant() loads
let legInsertResult = { insertId: 9101, affectedRows: 1 };  // affectedRows 0 = the duplicate guard won

function freshConference(over = {}) {
  return {
    id: 77,
    job_id: 482491,
    friendly_name: 'efxctestconf01',
    mpc_uuid: null,
    provider: 'plivo',
    started_by_user_id: 12,
    job_caller_info_id: 5001,
    job_status_snap: 3,
    job_efr_id_snap: 4471,
    status: 'live',
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

// A leg as the MASKED projection returns it: `number_prefix`, never a whole
// number. maskLeg() in the call-log service turns it into 9812••••••.
function legRow(over = {}) {
  return {
    id: 9101,
    conference_id: 77,
    job_caller_info_id: 5001,
    job_id: 482491,
    target_kind: 'customer',
    target_id: 900,
    display_name: 'Asha Rao',
    number_prefix: '9812',
    member_id: '31',
    participant_uuid: 'cu-1',
    added_by_user_id: 12,
    status: 'answered',
    hangup_cause: null,
    created_on: '2026-08-04 15:00:02',
    joined_at: '2026-08-04 15:00:09',
    left_at: null,
    duration: null,
    ...over,
  };
}

const fake = installFakePool([
  [/FROM easyfix_properties/i, () => props],

  // The conference-column probe in plivo-call-log.service. Present ⇒ the
  // primary-leg filter and the conference writes are live, as post-migration.
  [/information_schema\.columns/i, () => [{ 1: 1 }]],

  [/INSERT INTO tbl_plivo_call_log/i, () => legInsertResult],
  [/INSERT INTO tbl_job_conference\s/i, () => ({ insertId: 77 })],

  // ORDER MATTERS: the id+conference_id probe (loadConferenceLegForControl) is
  // narrower than the plain id probe (getConferenceLeg).
  [/FROM tbl_plivo_call_log\s+WHERE id = \? AND conference_id/i, () => (legControlRow ? [legControlRow] : [])],
  [/FROM tbl_plivo_call_log WHERE id = \? LIMIT 1/i, () => (legRows.length ? [legRows[0]] : [])],
  [/FROM tbl_plivo_call_log WHERE conference_id = \? ORDER BY/i, () => legRows],

  [/FROM tbl_job_conference WHERE id = \?/i, () => (conferenceRow ? [conferenceRow] : [])],
  [/FROM tbl_job_conference WHERE friendly_name = \?/i, () => (conferenceRow ? [conferenceRow] : [])],
  [/FROM tbl_job_conference\s+WHERE status IN/i, () => [freshConference({ status: 'live' })]],

  [/^\s*UPDATE /i, () => ({ affectedRows: 1 })],
]);

/* ────────────────────────────── fetch stub ─────────────────────────────── */

// Every Plivo call this file makes is captured here; `nextResponses` is a
// queue so a test can script a POST-then-GET sequence (add-participant
// followed by the read-back, DELETE followed by the verify).
let wire = [];
let nextResponses = [];
const realFetch = globalThis.fetch;

function reply(status, body) {
  return { status, body: typeof body === 'string' ? body : JSON.stringify(body ?? {}) };
}

globalThis.fetch = async (url, init = {}) => {
  wire.push({
    url: String(url),
    method: init.method,
    auth: init.headers && init.headers.Authorization,
    contentType: init.headers && init.headers['Content-Type'],
    body: init.body ? JSON.parse(init.body) : null,
  });
  const r = nextResponses.shift() || reply(200, {});
  return {
    status: r.status,
    async text() { return r.body; },
  };
};

/* ──────────────────────────── module under test ─────────────────────────── */

// The service takes an INJECTED pool. installFakePool() swapped the methods on
// the shared db singleton (which properties.service and plivo-call-log.service
// captured by destructuring), so handing that same object to the service routes
// everything through one fake.
const dbPool = require('../db').pool;

const properties = require('../services/properties.service');
const conf = require('../services/plivo-conference.service');

before(async () => { await properties.preload(); });
after(() => { globalThis.fetch = realFetch; fake.restore(); });

beforeEach(() => {
  wire = [];
  nextResponses = [];
  fake.reset();
  conferenceRow = freshConference();
  legRows = [];
  legControlRow = null;
  legInsertResult = { insertId: 9101, affectedRows: 1 };
});

const sqlOf = (re) => fake.calls.filter((c) => re.test(c.sql));
const oneSql = (re) => {
  const hits = sqlOf(re);
  assert.ok(hits.length >= 1, `expected a statement matching ${re}\nsaw:\n` + fake.calls.map((c) => c.sql.replace(/\s+/g, ' ').slice(0, 120)).join('\n'));
  return hits[0];
};

/* ═══════════════════════════ the gate ═══════════════════════════════════ */

test('conferenceEnabled() IS plivo.calling.enabled — there is no conference flag', async () => {
  assert.equal(conf.conferenceEnabled(), true);

  // Flip the ONLY switch and the whole feature goes with it. If this ever needs
  // a second key to be true, the no-new-flag decision has been broken.
  props = props.map((p) => (p.property_key === 'plivo.calling.enabled' ? { ...p, property_value: 'false' } : p));
  await properties.flushCache();
  assert.equal(conf.conferenceEnabled(), false);

  const r = await conf.createConference({ jobId: 1, startedByUserId: 12 }, dbPool);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'disabled');
  assert.equal(wire.length, 0, 'a disabled provider must not be dialled');

  props = props.map((p) => (p.property_key === 'plivo.calling.enabled' ? { ...p, property_value: 'true' } : p));
  await properties.flushCache();
  assert.equal(conf.conferenceEnabled(), true);
});

/* ══════════════ THE LIMITS THE OWNER DELETED, PINNED AS ABSENT ══════════ */

/*
 * These three properties, the helpers that read them and the two columns that
 * snapshotted them are GONE. Removing them does NOT mean "unlimited" — it means
 * PLIVO'S OWN DEFAULTS APPLY, which is the right place for a provider ceiling.
 * This test exists so a well-meaning "let's just add a small cap" patch has to
 * argue with a failing build rather than slip through.
 */
test('the three cost-knob helpers no longer exist, and nothing reads their properties', async () => {
  for (const gone of ['maxDurationSec', 'maxParticipants', 'maxConcurrent', 'reaperCeilingSec']) {
    assert.equal(conf[gone], undefined, `${gone}() was removed with the limits it read`);
  }

  // ringTimeoutSec SURVIVES and is not one of them: it bounds a ringing phone,
  // not a running room.
  assert.equal(typeof conf.ringTimeoutSec, 'function');
  assert.equal(conf.ringTimeoutSec(), 45);

  // And a full add path must never ask for a deleted key. properties.service
  // resolves from its cache, so this checks the SERVICE's own reads.
  const { getProperty } = require('../services/properties.service');
  for (const key of ['plivo.conference.max.duration.sec', 'plivo.conference.max.participants', 'plivo.conference.max.concurrent']) {
    assert.equal(getProperty(key), undefined, `${key} must not be seeded any more`);
  }
});

/* ═════════════════════════ create (DB only) ═════════════════════════════ */

test('createConference writes a creating row + a URL-safe name, and calls Plivo NOT AT ALL', async () => {
  const r = await conf.createConference(
    { jobId: 482491, startedByUserId: 12, jobCallerInfoId: 5001, jobStatusSnap: 3, jobEfrIdSnap: 4471 },
    dbPool,
  );

  assert.equal(r.ok, true);
  assert.equal(r.conferenceId, 77);

  // The MPC does not exist until the operator's answer XML runs. Anything that
  // dialled here would be billing before an operator was even on the line.
  assert.equal(wire.length, 0, 'createConference must not touch the provider');

  // The name is the API key for every later MPC call — it goes into a URL path
  // segment, so it must survive one without escaping.
  assert.match(r.friendlyName, /^[a-z0-9]+$/, 'friendly_name must be lowercase alphanumerics only');
  assert.ok(r.friendlyName.length <= 32, 'friendly_name must stay short');
  assert.notEqual(r.friendlyName, conf.newFriendlyName(), 'names must be unique per conference');

  const ins = oneSql(/INSERT INTO tbl_job_conference\s/i);
  assert.match(ins.sql, /'creating'/, "a new conference starts in 'creating', not 'live'");
  assert.deepEqual(ins.params.slice(0, 6), [482491, r.friendlyName, 12, 5001, 3, 4471]);
  assert.ok(ins.params[6] instanceof Date, 'created_on is an app-side Date (IST via the pool TZ), never NOW()');

  // The limit snapshots went with the limits.
  assert.doesNotMatch(ins.sql, /max_duration_sec|max_participants/, 'no cap is sent to Plivo, so there is nothing to snapshot');
  assert.doesNotMatch(ins.sql, /participant_count|peak_participants/, 'the live count is DERIVED from the legs, never stored');
});

/*
 * The concurrency cap is gone with the other two knobs. It used to be the only
 * thing between a stuck UI and N conferences billing at once; that job now
 * belongs to endMpcOnExit and the reaper, neither of which ops can misconfigure.
 */
test('createConference no longer counts live conferences — the concurrency cap was deleted', async () => {
  const r = await conf.createConference({ jobId: 1, startedByUserId: 12 }, dbPool);

  assert.equal(r.ok, true, 'there is no cap left to refuse against');
  assert.equal(sqlOf(/SELECT COUNT\(\*\) AS live/i).length, 0, 'and no COUNT is issued to enforce one');
});

/*
 * THE HEADLINE OF THE ONE-TABLE DECISION. The operator's leg is already a
 * tbl_plivo_call_log row, written by the click-to-call path. Writing another
 * one here would double-count the operator on every single ops call.
 */
test('createConference writes NO participant row — it adopts the operator’s existing call-log leg', async () => {
  const r = await conf.createConference(
    { jobId: 7, startedByUserId: 12, jobCallerInfoId: 5001, operatorNumber: '9876543210', operatorName: 'Asha (Ops)' },
    dbPool,
  );
  assert.equal(r.ok, true);

  assert.equal(sqlOf(/INSERT INTO tbl_plivo_call_log/i).length, 0,
    'the operator already has a call-log row; a second would double-count every call');

  const adopt = oneSql(/UPDATE tbl_plivo_call_log[\s\S]*participant_role = 'operator'/i);
  assert.match(adopt.sql, /WHERE job_caller_info_id = \? AND conference_id IS NULL/i,
    'idempotent by construction — after the first run there is no unattached row left to adopt');
  assert.deepEqual(adopt.params, [77, 5001]);
});

/*
 * THE COUNT INVARIANT, asserted at its source. A conference is ONE call that
 * gained people. If this service ever inserts into tbl_job_caller_info, every
 * existing call-count report (QuickSight Call Tracking, the Click To Call tab,
 * per-user call volume) silently inflates by the number of participants.
 */
test('nothing in the conference path ever writes tbl_job_caller_info', async () => {
  await conf.createConference({ jobId: 7, startedByUserId: 12, jobCallerInfoId: 5001 }, dbPool);
  nextResponses = [reply(202, { member_id: '31', call_uuid: 'cu-1' })];
  await conf.addParticipant(
    { conferenceId: 77, toNumber: '9812345678', targetKind: 'technician', targetId: 4471, addedByUserId: 12 },
    dbPool,
  );
  assert.equal(sqlOf(/INSERT INTO tbl_job_caller_info/i).length, 0,
    'ONE audit row per CALL — a conference must never inflate the call count');
});

/* ═══════════════════ the operator leg's call-control XML ════════════════ */

test('operatorAnswerXml carries the survival attributes, and NO limits', () => {
  const xml = conf.operatorAnswerXml('efxctestconf01', { confId: 77 });

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<Response><MultiPartyCall /, 'the operator enters an MPC, NOT a <Dial>');
  assert.doesNotMatch(xml, /<Dial/, 'a <Dial> here can never be promoted to a conference');
  assert.match(xml, />efxctestconf01<\/MultiPartyCall>/, 'the MPC name is the element text content');

  // ── The cost guard that REMAINS. Not a number, so nobody can tune it to zero.
  assert.match(xml, /endMpcOnExit="true"/, 'the operator leaving ends the room — the primary guard');
  // ── The ones the owner removed: absent means PLIVO'S DEFAULTS apply.
  assert.doesNotMatch(xml, /maxDuration=/, "the provider's own default is the ceiling now");
  assert.doesNotMatch(xml, /maxParticipants=/, 'same — we do not bound the room, Plivo does');

  // ── The one most likely to bite: Plivo REMOVES a participant left alone by
  // default, and the operator is alone until the receiver is added.
  assert.match(xml, /stayAlone="true"/, 'without this the lone operator is dropped instantly');

  // ── Callbacks, escaped. The `t` is the webhook authorisation.
  assert.match(xml, /statusCallbackUrl="https:\/\/core\.example\.in\/api\/webhook\/plivo-conference\/status\?t=[^"]+"/);
  // An unparseable <Response> makes Plivo hang the call up SILENTLY, so a raw
  // `&` smuggled in by a callback URL is a "connects then dies" bug, not an
  // error anyone would see.
  assert.doesNotMatch(xml, /&(?!amp;|quot;|lt;|gt;|#)/, 'every ampersand must be XML-escaped');
});

test('the status-callback token is a conference token and nothing else can be replayed as one', () => {
  const t = conf.signConferenceToken({ confId: 77, friendlyName: 'efxctestconf01' });
  const claims = conf.verifyConferenceToken(t);
  assert.equal(claims.confId, 77);
  assert.equal(claims.conf, 'efxctestconf01');
  assert.equal(claims.kind, 'conf');
  assert.equal(conf.verifyConferenceToken('not-a-token'), null);
});

/* ══════════════════════ add participant — the roster ════════════════════ */

test('addParticipant POSTs the documented MPC shape — ring_timeout yes, max_* no', async () => {
  nextResponses = [reply(202, { api_id: 'abc', call_uuid: 'cu-1', member_id: '31', message: 'call fired' })];

  const r = await conf.addParticipant(
    { conferenceId: 77, toNumber: '9812345678', targetKind: 'technician', targetId: 4471, addedByUserId: 12, displayName: 'Ravi Kumar' },
    dbPool,
  );
  assert.equal(r.ok, true, JSON.stringify(r));

  assert.equal(wire.length, 1, 'exactly one provider call — no read-back needed when the shape is recognised');
  const req = wire[0];
  assert.equal(req.method, 'POST');
  assert.equal(
    req.url,
    'https://api.plivo.com/v1/Account/MATEST0000000000TEST/MultiPartyCall/name_efxctestconf01/Participant/',
    'the `name_` prefix and the Participant/ segment are the two documented path quirks',
  );
  assert.ok(String(req.auth).startsWith('Basic '), 'HTTP Basic, same as every other Plivo call');
  assert.equal(req.contentType, 'application/json');

  assert.equal(req.body.role, 'agent', 'a technician is an agent, not the customer');
  assert.equal(req.body.from, '918041234567');
  assert.equal(req.body.to, '919812345678');
  assert.equal(req.body.end_mpc_on_exit, false, 'ONLY the operator may end the room by leaving');
  assert.equal(req.body.stay_alone, true);
  assert.equal(req.body.ring_timeout, 45, 'a dialler setting, and the only one that survived');

  // The deleted limits must not reappear on the wire either.
  assert.equal('max_duration' in req.body, false, "Plivo's own default bounds the leg now");
  assert.equal('max_participants' in req.body, false, 'same — we send no cap of our own');

  assert.match(req.body.status_callback_url, /\/api\/webhook\/plivo-conference\/status\?t=/);
  assert.equal(req.body.status_callback_events, conf.STATUS_CALLBACK_EVENTS);

  // Insert-first: the leg row exists BEFORE the leg is dialled.
  const ins = oneSql(/INSERT INTO tbl_plivo_call_log/i);
  assert.ok(fake.calls.indexOf(ins) >= 0);
  assert.match(ins.sql, /conference_id, participant_role, participant_target_id, job_caller_info_id/,
    'a participant leg is a CALL-LOG row carrying the room and the role');
  assert.ok(ins.params.includes('technician'), 'participant_role is the per-leg label every call surface shows');
  assert.ok(ins.params.includes(4471), 'participant_target_id — the roster identity behind the role');
  assert.ok(ins.params.includes('919812345678'));
  assert.ok(ins.params.includes('initiated'), "the leg starts in THIS TABLE'S vocabulary, not a conference-only one");

  // The 2xx is not the end state: the ids are stamped from the parsed body.
  const stamp = oneSql(/SET conference_member_id = COALESCE/i);
  assert.deepEqual(stamp.params.slice(0, 2), ['31', 'cu-1']);
  assert.equal(r.memberId, '31');
});

/*
 * DECISION 2, ASSERTED ON THE WIRE INTO THE DATABASE: an added leg carries the
 * SAME job_caller_info_id as the operator's. That single fact is what makes a
 * 3-party conference read as ONE call wherever a count is shown and as THREE
 * legs wherever per-leg detail is shown.
 */
test('an added leg shares the operator’s job_caller_info_id — one call, N legs', async () => {
  nextResponses = [reply(202, { member_id: '31', call_uuid: 'cu-1' })];
  await conf.addParticipant(
    { conferenceId: 77, toNumber: '9812345678', targetKind: 'technician', targetId: 4471, addedByUserId: 12 },
    dbPool,
  );

  const ins = oneSql(/INSERT INTO tbl_plivo_call_log/i);
  assert.equal(ins.params[0], 77, 'conference_id');
  assert.equal(ins.params[3], 5001, 'job_caller_info_id — the SAME row the operator leg is audited under');
  assert.equal(ins.params[4], 482491, 'job_id, so the per-job call history picks the leg up');
});

test('a CUSTOMER target gets the customer role, and the customer role is what Plivo is told', async () => {
  nextResponses = [reply(202, { member_id: '32', call_uuid: 'cu-2' })];
  const r = await conf.addParticipant(
    { conferenceId: 77, toNumber: '9812345678', targetKind: 'customer', targetId: 900, addedByUserId: 12 },
    dbPool,
  );
  assert.equal(r.ok, true);
  assert.equal(wire[0].body.role, 'customer');
});

/* ══════════════════ add participant — the custom number ═════════════════ */

test('a custom number is audited by its DIGITS, because the digits are the only record of what happened', async () => {
  nextResponses = [reply(202, { member_id: '40', call_uuid: 'cu-3' })];

  const r = await conf.addParticipant(
    { conferenceId: 77, toNumber: '9810012345', targetKind: 'custom', targetId: null, addedByUserId: 12 },
    dbPool,
  );
  assert.equal(r.ok, true);

  const ins = oneSql(/INSERT INTO tbl_plivo_call_log/i);
  assert.ok(ins.params.includes('custom'), 'participant_role');
  assert.equal(ins.params[2], null, 'participant_target_id is null — there is no roster row behind it');
  assert.ok(ins.params.includes('919810012345'), 'dialed_number IS the audit record for a custom add');
  assert.ok(ins.params.includes(12), 'caller_user_id — who dialled arbitrary digits from a company line');
  assert.equal(wire[0].body.role, 'agent', 'an arbitrary number is never assumed to be the customer');
});

test('an unparseable destination is refused before any row is written or leg dialled', async () => {
  const r = await conf.addParticipant(
    { conferenceId: 77, toNumber: '12345', targetKind: 'custom', addedByUserId: 12 },
    dbPool,
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid_number');
  assert.equal(wire.length, 0);
  assert.equal(sqlOf(/INSERT INTO tbl_plivo_call_log/i).length, 0);
});

/* ═════════════ add participant — unverified-shape resilience ════════════ */

test('the OTHER documented response shape (calls[]) is parsed too', async () => {
  nextResponses = [reply(202, { api_id: 'x', calls: [{ to: '919812345678', from: '918041234567', call_uuid: 'cu-9', member_id: '55' }], request_uuid: 'ru-1' })];

  const r = await conf.addParticipant(
    { conferenceId: 77, toNumber: '9812345678', targetKind: 'job_spoc', targetId: 3, addedByUserId: 12 },
    dbPool,
  );
  assert.equal(r.ok, true);
  assert.equal(r.memberId, '55');
  assert.equal(r.callUuid, 'cu-9');
  assert.equal(wire.length, 1, 'a recognised shape needs no read-back');
});

/*
 * ⚠ THESE TWO TESTS WERE REWRITTEN, AND WHY MATTERS MORE THAN WHAT THEY ASSERT.
 *
 * Both used to fixture a Plivo participant as `{ to: '919812345678', … }` and
 * assert we recovered our leg by matching that number. Plivo's List Participants
 * response is documented as objects of EXACTLY:
 *
 *     { call_uuid, coach_mode, hold, member_id, mpc_uuid, mute, role }
 *
 * There is no `to`, no `number`, no `destination`. So the number match could
 * never fire against a real response — "Remove From Call" 409'd on
 * member_id_unknown for every leg whose add-response omitted the id, forever.
 *
 * The tests did not catch that. They CAUSED it to survive: they were written
 * from the same guess as the code, so the fixture supplied the very field the
 * production API withholds, and two green tests certified a path that had never
 * once worked. A fixture is an assertion about someone else's API — invent a
 * field in one and you have written a test that can only pass.
 *
 * The shapes below are copied from Plivo's published response example, not
 * inferred. Correlation is now on call_uuid, the only identifier both sides
 * genuinely hold.
 */
test('a 2xx that carries a call_uuid but NO member_id recovers the id by reading the room back', async () => {
  nextResponses = [
    // Recognised shape, incomplete: Plivo told us which call, not which member.
    reply(202, { api_id: 'x', call_uuid: 'cu-back', message: 'ok' }),
    // The read-back, in Plivo's documented Participant shape — note: no `to`.
    reply(200, { objects: [{ call_uuid: 'cu-back', member_id: '77', mpc_uuid: 'mpc-1', role: 'agent', mute: false, hold: false }] }),
  ];

  const r = await conf.addParticipant(
    { conferenceId: 77, toNumber: '9812345678', targetKind: 'client_contact', targetId: 8, addedByUserId: 12 },
    dbPool,
  );

  assert.equal(r.ok, true, 'the leg IS dialling — an incomplete body is not a failure');
  assert.equal(wire.length, 2, 'the service reads the participant list back');
  assert.equal(wire[1].method, 'GET');
  assert.equal(
    wire[1].url,
    'https://api.plivo.com/v1/Account/MATEST0000000000TEST/MultiPartyCall/name_efxctestconf01/Participant/',
  );
  assert.equal(r.memberId, '77', 'member_id recovered by observation, not inference');
});

test('a body with NEITHER identifier does not read back — there is nothing to correlate on', async () => {
  // A shape neither doc rendering predicted, and with no call_uuid there is no
  // honest way to tell our leg from anyone else's in that room. Guessing here is
  // how you kick the wrong participant. We wait for ParticipantJoin or for
  // reconcileParticipants() instead — and we say so in the log.
  nextResponses = [reply(202, { api_id: 'x', message: 'ok', something_new: true })];

  const r = await conf.addParticipant(
    { conferenceId: 77, toNumber: '9812345678', targetKind: 'client_contact', targetId: 8, addedByUserId: 12 },
    dbPool,
  );

  assert.equal(r.ok, true, 'the leg IS dialling — an unknown body is not a failure');
  assert.equal(wire.length, 1, 'no read-back: a list we cannot match ourselves in is a wasted call');
  assert.equal(r.memberId, null, 'and no invented id — null is the truthful answer');
});

/* ══════════════════ add participant — refusals and failures ═════════════ */

test('a non-2xx marks the leg failed with the status AND body, and never throws', async () => {
  nextResponses = [reply(400, { error: 'violates_media_anchoring' })];

  const r = await conf.addParticipant(
    { conferenceId: 77, toNumber: '9812345678', targetKind: 'technician', targetId: 4471, addedByUserId: 12 },
    dbPool,
  );

  assert.equal(r.ok, false);
  assert.equal(r.code, 'provider_error');
  assert.equal(r.httpStatus, 400, 'the caller can see the status');
  assert.match(r.body, /violates_media_anchoring/, 'and the body — a wrong wire shape must be diagnosable from one log line');

  // The row is STAMPED, not deleted: "we tried and Plivo refused" is the fact
  // worth keeping. The breadcrumb goes in hangup_cause, where every other
  // terminal reason on this table lives; the full body is in the log.
  const upd = oneSql(/UPDATE tbl_plivo_call_log[\s\S]*hangup_cause = COALESCE/i);
  assert.ok(upd.params.includes('failed'), 'the leg lands in the call-log failure status');
  assert.match(String(upd.params[1]), /http=400/);
});

/*
 * The duplicate guard is NOT one of the deleted limits — it is a correctness
 * guard. Two clicks on "add the technician" must cost ONE billed leg. It is a
 * single statement (INSERT … WHERE NOT EXISTS) precisely so the two clicks race
 * inside the database rather than in application code, and the loser sees
 * affectedRows = 0.
 */
test('a duplicate add is refused WITHOUT dialling — the guard is worth a billed leg', async () => {
  legInsertResult = { insertId: 0, affectedRows: 0 };   // the NOT EXISTS matched

  const r = await conf.addParticipant(
    { conferenceId: 77, toNumber: '9812345678', targetKind: 'technician', targetId: 4471, addedByUserId: 12 },
    dbPool,
  );

  assert.equal(r.ok, false);
  assert.equal(r.code, 'duplicate');
  assert.equal(wire.length, 0, 'the second click must cost nothing');

  const ins = oneSql(/INSERT INTO tbl_plivo_call_log/i);
  assert.match(ins.sql, /WHERE NOT EXISTS/i, 'the guard is IN the insert, so two concurrent clicks cannot both win');
  assert.match(ins.sql, /x\.participant_role = \?/i,
    'keyed on the TARGET ROLE plus the digits — not the digits alone, which would falsely dedupe a QA run where several targets share one test number');
});

/*
 * There is no participant cap any more. The old branch refused at 6 with our
 * own message; Plivo's own default is the ceiling now. Nothing about a fifth,
 * sixth or seventh add may be refused by us.
 */
test('there is no participant cap — the service refuses no add on grounds of size', async () => {
  nextResponses = [reply(202, { member_id: '99', call_uuid: 'cu-99' })];
  legRows = Array.from({ length: 9 }, (_, i) => legRow({ id: 9200 + i, status: 'answered' }));

  const r = await conf.addParticipant(
    { conferenceId: 77, toNumber: '9812345678', targetKind: 'technician', targetId: 4471, addedByUserId: 12 },
    dbPool,
  );

  assert.equal(r.ok, true, 'a full-looking room is not a refusal we get to make');
  assert.equal(sqlOf(/SELECT COUNT\(\*\) AS n FROM tbl_plivo_call_log/i).length, 0,
    'and no capacity COUNT is issued — there is nothing to compare it against');
});

test('an ended conference cannot grow a new leg', async () => {
  conferenceRow = freshConference({ status: 'ended' });

  const r = await conf.addParticipant(
    { conferenceId: 77, toNumber: '9812345678', targetKind: 'technician', targetId: 4471, addedByUserId: 12 },
    dbPool,
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'conference_not_live');
  assert.equal(wire.length, 0);
});

/* ═══════════════════════════ remove a leg ═══════════════════════════════ */

test('removeParticipant DELETEs the member and closes the call-log leg', async () => {
  legControlRow = { id: 9101, conference_id: 77, member_id: '31', dialed_number: '919812345678', number_prefix: '9812', status: 'answered', target_kind: 'technician' };
  nextResponses = [reply(204, '')];

  const r = await conf.removeParticipant({ conferenceId: 77, participantId: 9101 }, dbPool);

  assert.equal(r.ok, true);
  assert.equal(wire[0].method, 'DELETE');
  assert.equal(
    wire[0].url,
    'https://api.plivo.com/v1/Account/MATEST0000000000TEST/MultiPartyCall/name_efxctestconf01/Participant/31/',
  );
  const upd = oneSql(/^\s*UPDATE tbl_plivo_call_log SET status = \?/i);
  assert.ok(upd.params.includes('completed'), 'a dropped leg is a COMPLETED call leg, in this table’s own vocabulary');
  assert.ok(upd.params.includes('removed_by_operator'), 'and the reason is recorded where every other hangup reason lives');
});

test('a 404 on the kick means the member is already gone — success, not a retry loop', async () => {
  legControlRow = { id: 9101, conference_id: 77, member_id: '31', dialed_number: '919812345678', number_prefix: '9812', status: 'answered', target_kind: 'technician' };
  nextResponses = [reply(404, { error: 'not found' })];

  const r = await conf.removeParticipant({ conferenceId: 77, participantId: 9101 }, dbPool);
  assert.equal(r.ok, true);
  assert.equal(r.alreadyGone, true);
  assert.equal(sqlOf(/^\s*UPDATE tbl_plivo_call_log SET status = \?/i).length, 1);
});

test('a leg with no member_id is looked up on Plivo BY CALL UUID before giving up', async () => {
  legControlRow = { id: 9101, conference_id: 77, member_id: null, dialed_number: '919812345678', number_prefix: '9812', status: 'ringing', target_kind: 'technician' };
  // getConferenceLeg() reads the PLAIN-id probe, which the harness feeds from
  // legRows — a separate fixture from legControlRow (the id+conference_id probe
  // loadConferenceLegForControl uses). The uuid lives only on this one.
  legRows = [legRow({ member_id: null, status: 'ringing' })];
  nextResponses = [
    // The read-back, in Plivo's documented Participant shape. `cu-1` is the
    // participant_uuid legRow() carries — that, not the dialled number, is what
    // correlates.
    reply(200, { objects: [{ call_uuid: 'cu-1', member_id: '88', mpc_uuid: 'mpc-1', role: 'agent', mute: false, hold: false }] }),
    reply(204, ''), // the kick
  ];

  const r = await conf.removeParticipant({ conferenceId: 77, participantId: 9101 }, dbPool);

  assert.equal(r.ok, true);
  assert.equal(wire[0].method, 'GET');
  assert.match(wire[1].url, /\/Participant\/88\/$/, 'the id was observed, not invented');
});

test('a leg Plivo does not report is NOT kicked by guesswork', async () => {
  // The other half of the same rule: when the read-back holds no leg with our
  // call_uuid, the honest answer is "cannot drop yet", not "drop whoever is
  // first in the list". This is the assertion whose absence let a fabricated
  // `to` field look like a working correlation for as long as it did.
  legControlRow = { id: 9101, conference_id: 77, member_id: null, dialed_number: '919812345678', number_prefix: '9812', status: 'ringing', target_kind: 'technician' };
  legRows = [legRow({ member_id: null, status: 'ringing' })];   // participant_uuid 'cu-1'
  nextResponses = [
    reply(200, { objects: [{ call_uuid: 'someone-else', member_id: '99', mpc_uuid: 'mpc-1', role: 'customer', mute: false, hold: false }] }),
  ];

  const r = await conf.removeParticipant({ conferenceId: 77, participantId: 9101 }, dbPool);

  assert.equal(r.ok, false);
  assert.equal(r.code, 'member_id_unknown');
  assert.equal(wire.length, 1, 'no DELETE was issued — nobody else gets kicked in our place');
});

/* ═════════════════════════ end the conference ═══════════════════════════ */

test('endConference DELETEs the MPC and then READS IT BACK before believing the 204', async () => {
  nextResponses = [
    reply(204, ''),                                   // the DELETE
    reply(404, { error: 'not found' }),               // the verify — gone means gone
  ];

  const r = await conf.endConference({ conferenceId: 77, reason: 'operator' }, dbPool);

  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.equal(wire[0].method, 'DELETE');
  assert.equal(
    wire[0].url,
    'https://api.plivo.com/v1/Account/MATEST0000000000TEST/MultiPartyCall/name_efxctestconf01/',
  );
  assert.equal(wire[1].method, 'GET', 'a 2xx acknowledgement is not an end state');

  const upd = oneSql(/SET status = 'ended'/i);
  assert.ok(upd.params.includes('operator'), 'end_reason is recorded');

  // The legs go with the room, in the call log's own terminal status.
  const close = oneSql(/UPDATE tbl_plivo_call_log[\s\S]*WHERE conference_id = \?/i);
  assert.ok(close.params.includes('completed'));
});

test('a conference Plivo STILL reports after a 2xx DELETE is left live for the reaper — never marked ended', async () => {
  // The cost-leak failure mode. Marking this ended would stop the reaper
  // retrying and hide the exact leak the teardown exists to stop.
  nextResponses = [
    reply(204, ''),
    reply(200, { mpc_uuid: 'mpc-1', status: 'Active' }),
  ];

  const r = await conf.endConference({ conferenceId: 77, reason: 'reaper' }, dbPool);

  assert.equal(r.ok, false);
  assert.equal(sqlOf(/SET status = 'ended'/i).length, 0, 'a conference that is still running must not be recorded as ended');
  assert.equal(sqlOf(/SET status = 'live', error/i).length, 1, 'it goes back to live so the next sweep retries it');
});

test('an already-ended conference is a no-op, not an error', async () => {
  conferenceRow = freshConference({ status: 'ended' });
  const r = await conf.endConference({ conferenceId: 77, reason: 'operator' }, dbPool);
  assert.equal(r.ok, true);
  assert.equal(r.alreadyEnded, true);
  assert.equal(wire.length, 0);
});

/* ═════════════════════════ masking (non-negotiable) ═════════════════════ */

test('getConference returns MASKED numbers, and the SQL itself never selects a whole one', async () => {
  legRows = [legRow()];

  const r = await conf.getConference(77, dbPool);

  assert.equal(r.ok, true);
  assert.equal(r.live, true);
  assert.equal(r.participants[0].masked_number, '9812••••••');
  assert.equal(r.participants[0].dialed_number, undefined, 'the raw number never reaches a response');
  assert.equal(r.participants[0].receiver_number, undefined, 'nor the other column that holds one');
  assert.equal(r.participants[0].number_prefix, undefined, 'the four digits are consumed, not forwarded');
  assert.equal(r.participants[0].role, 'customer', 'the Plivo role is derived from the target kind, never stored twice');

  /*
   * Asserted against the STATEMENT, not just the row. Only the first FOUR
   * digits may leave the database — as an expression, never as a column — so a
   * future `SELECT *` or a "just add dialed_number, it's easier" patch fails
   * here rather than leaking the customer's mobile to every operator.
   */
  const sel = oneSql(/FROM tbl_plivo_call_log WHERE conference_id = \? ORDER BY/i);
  /*
   * Asserted structurally rather than as one literal string. The projection now
   * wraps the prefix in a CASE (the operator's leg gets NULL — the only number
   * on its row is the CUSTOMER's, see LEG_PUBLIC_COLUMNS), so a fixed
   * `LEFT(…) AS number_prefix` match would fail for a change that is entirely
   * safe. What must hold is the PROPERTY, not the spelling: every single
   * mention of dialed_number is wrapped in LEFT(RIGHT(…), 4), so no path
   * through this SELECT can emit more than four digits.
   */
  assert.match(sel.sql, /AS number_prefix/, 'the prefix is still projected');
  const mentions = (sel.sql.match(/dialed_number/g) || []).length;
  const wrapped = (sel.sql.match(/LEFT\(RIGHT\(dialed_number, 10\), 4\)/g) || []).length;
  assert.ok(mentions > 0, 'the prefix must still come from dialed_number');
  assert.equal(wrapped, mentions,
    `every dialed_number must be wrapped in LEFT(RIGHT(…), 4) — ${mentions} mention(s), ${wrapped} wrapped`);
  assert.doesNotMatch(sel.sql, /SELECT \*/, 'no star-select on a table holding real numbers');
  assert.doesNotMatch(sel.sql, /,\s*dialed_number\b/, 'dialed_number must never be projected as a column');
  assert.doesNotMatch(sel.sql, /\breceiver_number\b/, 'nor receiver_number');

  const confSel = oneSql(/FROM tbl_job_conference WHERE id = \?/i);
  assert.doesNotMatch(confSel.sql, /SELECT \*/);
});

/*
 * participant_count is DERIVED from the legs just loaded, not stored. A counter
 * column that four writers incremented and decremented is a counter that ends
 * up disagreeing with the rows it counts; counting rows we are already
 * returning cannot.
 */
test('participant_count is derived from the legs, and counts only the ones still on the call', async () => {
  legRows = [
    legRow({ id: 1, status: 'answered' }),
    legRow({ id: 2, status: 'ringing' }),
    legRow({ id: 3, status: 'completed' }),   // hung up — not on the call
    legRow({ id: 4, status: 'no_answer' }),   // never joined
  ];

  const r = await conf.getConference(77, dbPool);
  assert.equal(r.conference.participant_count, 2);
  assert.equal(sqlOf(/participant_count/i).length, 0, 'nothing reads or writes a stored counter');
});

/* ═════════════════════════ the reaper's query ═══════════════════════════ */

test('listStaleConferences REFUSES without a ceiling rather than inventing one', async () => {
  /*
   * The ceiling used to come from plivo.conference.max.duration.sec. That
   * property is gone and the only ceiling left is the leak-detector constant in
   * services/conference-reaper-cron.js. A default here would quietly re-create a
   * second, competing ceiling — the exact drift the removal was meant to end.
   */
  for (const bad of [{}, { olderThanSec: 0 }, { olderThanSec: 'soon' }, { olderThanSec: -5 }]) {
    const r = await conf.listStaleConferences(bad, dbPool);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.code, 'no_ceiling');
  }
  assert.equal(sqlOf(/FROM tbl_job_conference\s+WHERE status IN/i).length, 0, 'and it never reaches a query');
});

test('listStaleConferences sweeps creating AND live, from COALESCE(started_on, created_on), bounded', async () => {
  const CEILING = 6 * 60 * 60;    // the reaper's leak-detector constant
  const r = await conf.listStaleConferences({ olderThanSec: CEILING, limit: 50 }, dbPool);

  assert.equal(r.ok, true);
  assert.equal(r.ceilingSec, CEILING, "the caller's ceiling is used verbatim — the service has none of its own");

  const q = oneSql(/FROM tbl_job_conference\s+WHERE status IN/i);
  assert.match(q.sql, /COALESCE\(started_on, created_on\)/, "a 'creating' row has no started_on and is the MOST likely leak");
  assert.match(q.sql, /LIMIT \?/, 'a sweep can never fan out unboundedly');
  assert.deepEqual(q.params.slice(0, 3), ['creating', 'live', 'ending']);
  assert.equal(q.params[4], 50);

  /*
   * The cutoff is a JS Date, NOT `NOW() - INTERVAL n SECOND` — because
   * tbl_job_conference columns are APP-WRITTEN (new Date() + the pool's +05:30
   * session timezone) and hold the IST wall clock, while NOW() is the DB
   * server's zone. Comparing the two would skew by hours.
   * (The LEG sweep does the exact opposite, and is equally right — see
   * tests/conference-webhook-reaper.test.js. The clock a comparison uses must
   * be the clock the COLUMN was written in.)
   */
  assert.doesNotMatch(q.sql, /NOW\(\)/, 'the reaper must not depend on the DB server clock zone here');
  assert.ok(q.params[3] instanceof Date, 'the cutoff is computed app-side');
  const skewMs = Math.abs((Date.now() - CEILING * 1000) - q.params[3].getTime());
  assert.ok(skewMs < 5000, `cutoff should be ~${CEILING}s ago, was off by ${skewMs}ms`);

  const capped = await conf.listStaleConferences({ olderThanSec: CEILING, limit: 100000 }, dbPool);
  assert.equal(capped.ok, true);
  assert.equal(sqlOf(/FROM tbl_job_conference\s+WHERE status IN/i).pop().params[4], 200, 'the limit is clamped');
});

/* ═══════════════════ the leg vocabulary is the TABLE's ══════════════════ */

/*
 * A conference leg is stored in tbl_plivo_call_log's OWN status vocabulary, not
 * a conference-only one. That is the whole reason decision 2 works: GET
 * /api/admin/calls, the per-job call-history tooltip and the Call Info modal
 * already read these values, so they render a conference leg without knowing
 * conferences exist. Storing 'joined'/'left' here would have made every one of
 * those surfaces show a status it has never heard of.
 */
test('the leg statuses are this table’s own — initiated / ringing / answered, never joined/dialling', () => {
  assert.deepEqual(conf.ACTIVE_PARTICIPANT_STATUSES, ['initiated', 'ringing', 'answered']);
  assert.equal(conf.LEG_STATUS.DIALLING, 'initiated');
  assert.equal(conf.LEG_STATUS.JOINED, 'answered');
  assert.equal(conf.LEG_STATUS.LEFT, 'completed');
  assert.equal(conf.LEG_STATUS.NO_ANSWER, 'no_answer');
  assert.equal(conf.LEG_STATUS.FAILED, 'failed');
});

/* ═══════════ reconcileParticipants — the webhook-free recovery ═══════════
 *
 * These exist because production showed the shape the first version got wrong.
 * A web call that failed at signalling left our row in 'creating' with a room
 * Plivo had never heard of, and reconcile happily asked for that room's roster
 * every ten seconds forever — a guaranteed 404, logged at WARN, behind a panel
 * that meanwhile claimed a live call with nobody on it.
 *
 * Distinct conference ids per test on purpose: the throttle is a module-level
 * Map keyed by id, so two tests sharing 77 would have the second one silently
 * short-circuit and pass without exercising anything.
 */

test('an ABSENT room whose legs are all terminal is retired, and its roster is never requested', async () => {
  conferenceRow = freshConference({ id: 8801, status: 'creating' });
  legRows = [legRow({ id: 8811, status: conf.LEG_STATUS.FAILED, member_id: null, participant_uuid: null })];
  nextResponses = [reply(404, { error: 'multi party call with name efxctestconf01 not found' })];

  const r = await conf.reconcileParticipants(8801, dbPool);

  assert.equal(r.ok, true);
  assert.equal(r.code, 'never_materialised');
  assert.equal(wire.length, 1, 'ONE provider call — a room that 404s has no roster to ask for');
  const upd = oneSql(/UPDATE tbl_job_conference/i);
  assert.match(upd.sql, /status = 'ended'/, 'the row stops claiming a live call');
  assert.equal(upd.params.includes('never_materialised'), true, 'and says why, so this is greppable later');
});

test('an ABSENT room with a leg still active is left ALONE — 404 can also mean not yet', async () => {
  // The MPC is materialised by the operator's answer XML, so between placing
  // the call and Plivo executing that XML the room legitimately does not exist.
  // Retiring here would tear down a call that was about to connect.
  conferenceRow = freshConference({ id: 8802, status: 'creating' });
  legRows = [legRow({ id: 8812, status: conf.LEG_STATUS.DIALLING, member_id: null, participant_uuid: null })];
  nextResponses = [reply(404, { error: 'not found' })];

  const r = await conf.reconcileParticipants(8802, dbPool);

  assert.equal(r.ok, true);
  assert.equal(r.code, 'room_absent');
  assert.equal(r.changed, 0);
  assert.equal(sqlOf(/UPDATE tbl_job_conference/i).length, 0, 'nothing was retired');
});

test('an ABSENT room with NO legs at all is left alone while it is young', async () => {
  // Only reachable when the leg write itself failed. There is no terminal leg
  // to judge by, so age is the only guard left — and a brand-new row must not
  // be retired out from under a browser that is still dialling.
  conferenceRow = freshConference({
    id: 8803,
    status: 'creating',
    created_on: new Date(Date.now() - 2000),   // 2s old
  });
  legRows = [];
  nextResponses = [reply(404, { error: 'not found' })];

  const r = await conf.reconcileParticipants(8803, dbPool);

  assert.equal(r.code, 'room_absent');
  assert.equal(sqlOf(/UPDATE tbl_job_conference/i).length, 0);
});

test('a RUNNING room promotes a dialling leg Plivo reports as present', async () => {
  conferenceRow = freshConference({ id: 8804, status: 'live' });
  legRows = [legRow({ id: 8814, status: conf.LEG_STATUS.DIALLING, member_id: null, participant_uuid: 'cu-live' })];
  nextResponses = [
    reply(200, { status: 'active', mpc_uuid: 'mpc-live' }),
    // Plivo's documented Participant shape — no `to`, correlation is call_uuid.
    reply(200, { objects: [{ call_uuid: 'cu-live', member_id: '404', mpc_uuid: 'mpc-live', role: 'agent', mute: false, hold: false }] }),
  ];

  const r = await conf.reconcileParticipants(8804, dbPool);

  assert.equal(r.ok, true);
  assert.equal(r.changed, 1, 'the leg moved without any webhook arriving — the whole point');
  const upd = oneSql(/UPDATE tbl_plivo_call_log/i);
  assert.equal(upd.params.includes('answered'), true);
  assert.equal(upd.params.includes('404'), true, 'and the member id lands, which un-breaks Remove From Call');
});

/*
 * ── The ringing-leg race ──
 *
 * listParticipants returns who is IN the room, not who is being dialled toward
 * it. Reconciliation closed anything absent from that list, so a leg that was
 * merely still RINGING was stamped "Left" within seconds — visible in the panel
 * as a participant marked gone while their phone was audibly ringing, and again
 * while they were mid-conversation. It only spared legs that answered before the
 * first reconcile, which disguised a race as a custom-number bug.
 */
test('a still-RINGING leg absent from the roster is NOT marked Left', async () => {
  conferenceRow = freshConference({ id: 8805, status: 'live' });
  legRows = [legRow({
    id: 8815,
    status: conf.LEG_STATUS.RINGING,
    participant_uuid: 'cu-ringing',
    member_id: null,
    created_on: new Date(),          // dialled just now — still ringing
  })];
  nextResponses = [
    reply(200, { status: 'active', mpc_uuid: 'mpc-live' }),
    reply(200, { objects: [] }),     // nobody has JOINED yet — the normal case
  ];

  const r = await conf.reconcileParticipants(8805, dbPool);

  assert.equal(r.ok, true);
  assert.equal(r.changed, 0, 'absence from the roster is not an exit for someone who never entered');
  assert.equal(sqlOf(/UPDATE tbl_plivo_call_log/i).length, 0);
});

test('a leg that has rung PAST the ring timeout is closed as no_answer, not as Left', async () => {
  conferenceRow = freshConference({ id: 8806, status: 'live' });
  legRows = [legRow({
    id: 8816,
    status: conf.LEG_STATUS.RINGING,
    participant_uuid: 'cu-stale',
    member_id: null,
    created_on: new Date(Date.now() - 120000),   // 2 min: well past 45s + grace
  })];
  nextResponses = [
    reply(200, { status: 'active', mpc_uuid: 'mpc-live' }),
    reply(200, { objects: [] }),
  ];

  const r = await conf.reconcileParticipants(8806, dbPool);

  assert.equal(r.changed, 1, 'a leg cannot ring forever — but it ends as what it was');
  const upd = oneSql(/UPDATE tbl_plivo_call_log/i);
  assert.equal(upd.params.includes('no_answer'), true, 'no_answer, because they never picked up');
  assert.equal(upd.params.includes('completed'), false, '"Left" would claim they were once in the room');
});

test('a JOINED leg that Plivo no longer reports IS marked Left — the case that still works', async () => {
  conferenceRow = freshConference({ id: 8807, status: 'live' });
  legRows = [legRow({ id: 8817, status: conf.LEG_STATUS.JOINED, participant_uuid: 'cu-gone', member_id: '55' })];
  nextResponses = [
    reply(200, { status: 'active', mpc_uuid: 'mpc-live' }),
    reply(200, { objects: [] }),     // they were here; now they are not
  ];

  const r = await conf.reconcileParticipants(8807, dbPool);

  assert.equal(r.changed, 1);
  const upd = oneSql(/UPDATE tbl_plivo_call_log/i);
  assert.equal(upd.params.includes('completed'), true, 'observed in the room, then absent = they left');
});
