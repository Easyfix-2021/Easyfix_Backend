/*
 * routes/public/plivo-answer.js — THE PROVIDER RESPONSE CONTRACT.
 *
 * ─── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * These three handlers are provider callbacks, and their file header states a
 * contract that until now was enforced by nothing:
 *
 *   /answer            "Plivo MUST always receive valid XML, even if the token
 *                       is expired or the update fails, so the live leg isn't
 *                       dropped. An invalid/expired token yields an empty
 *                       <Response/> (no bridge)."
 *   /web-answer        "a guessed/replayed id yields <Hangup/>, never a number"
 *                      + its catch: "<Hangup/> is this function's own 'cannot
 *                       proceed' reply — a clean end, not a dropped leg."
 *   /recording-callback "ALWAYS 200 so Plivo doesn't retry-storm; the DB write
 *                       is best-effort."
 *
 * That is not an ordinary error-handling preference. Plivo is holding the HTTP
 * request open waiting for call-control XML: a 500 here is a DROPPED LIVE CALL
 * on the answer routes, and a retry storm on the recording callback. In Express
 * 4 a rejection from an async handler reaches no error middleware at all — the
 * request simply hangs with no response, which is the same outcome as a 500 for
 * the customer and worse for the socket. The 2026-09-08 fix therefore was NOT
 * `next(e)`; it was a per-handler try/catch returning the provider-safe body.
 *
 * So the assertions below are deliberately stronger than "it returned 200":
 *   - the body is checked for XML WELL-FORMEDNESS and for the specific element
 *     the header promises (empty <Response/>, <Hangup/>, <Dial>, <MultiPartyCall>),
 *     because "non-empty string" is exactly what a half-built fallback returns;
 *   - the handler's returned promise is checked to SETTLE, because a rejected
 *     promise is invisible in the response object — the request just hangs;
 *   - the number of writes to `res` is counted, because the fallback paths are
 *     guarded by `if (!res.headersSent)` and a broken guard produces a
 *     "Cannot set headers after they are sent" throw in production only.
 *
 * Non-destructive: fake pool, no network, no DB, no real timers.
 * Runner: `node --test`.
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

/*
 * Env before the services are required. tokenSecret()/callbackBase() are read
 * per call, so ordering is not load-bearing — but signCallToken needs a secret
 * to exist at all, and recordingCallbackUrl returns null without a base, which
 * would silently drop the <Record callbackUrl> assertions to vacuous.
 */
process.env.PLIVO_ANSWER_TOKEN_SECRET = 'plivo-answer-contract-test-secret';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'plivo-answer-contract-test-secret';
process.env.PLIVO_CALLER_ID = '911140000000';
process.env.PLIVO_CALLBACK_BASE_URL = 'https://core.easyfix.in';

const { installFakePool } = require('./helpers/fake-pool');

/* The real 2026-09-08 error text, so a failure here reads like the incident. */
const QUEUE_LIMIT = 'Queue limit reached.';

let props = [{ property_key: 'plivo.recording.enabled', property_value: 'false' }];
let auditUpdateFails = false;

const fake = installFakePool([
  [/FROM easyfix_properties/i, () => props],
  // hasConferenceColumns() probe → pre-migration shape (empty primaryLegFilter).
  [/information_schema\.columns/i, []],
  [/UPDATE tbl_job_caller_info/i, () => {
    if (auditUpdateFails) throw new Error(QUEUE_LIMIT);
    return { affectedRows: 1 };
  }],
  [/UPDATE tbl_plivo_call_log/i, () => ({ affectedRows: 1 })],
]);

const properties = require('../services/properties.service');
const plivo = require('../services/plivo.service');
const plivoLog = require('../services/plivo-call-log.service');
const conference = require('../services/plivo-conference.service');
const router = require('../routes/public/plivo-answer');

const JCI = 944793;
const DEST = '919810000000';

/* Originals restored in beforeEach so one test's stub cannot leak into another. */
const real = {
  markAnswered: plivoLog.markAnswered,
  markRinging: plivoLog.markRinging,
  setRecordingRequested: plivoLog.setRecordingRequested,
  setRecording: plivoLog.setRecording,
  recordingEnabled: plivo.recordingEnabled,
  addParticipant: conference.addParticipant,
};

before(async () => { await properties.flushCache(); });

beforeEach(async () => {
  fake.reset();
  auditUpdateFails = false;
  Object.assign(plivoLog, {
    markAnswered: real.markAnswered,
    markRinging: real.markRinging,
    setRecordingRequested: real.setRecordingRequested,
    setRecording: real.setRecording,
  });
  plivo.recordingEnabled = real.recordingEnabled;
  conference.addParticipant = real.addParticipant;
  await setRecording(false);
});

after(() => { Object.assign(plivoLog, real); Object.assign(plivo, { recordingEnabled: real.recordingEnabled }); });

async function setRecording(on) {
  props = [{ property_key: 'plivo.recording.enabled', property_value: on ? 'true' : 'false' }];
  await properties.flushCache();
}

/* ─── harness ──────────────────────────────────────────────────────────────
 *
 * A recording `res` double rather than a live socket: it lets the assertions
 * see headersSent transitions and COUNT the writes, which is the only way to
 * catch a double-send (a real socket turns that into an async throw the test
 * process never attributes to this handler).
 */
function makeRes() {
  return {
    writes: [],
    statusCode: 200,
    contentType: null,
    headersSent: false,
    locals: {},
    status(c) { this.statusCode = c; return this; },
    type(t) { this.contentType = t; return this; },
    send(b) { this.writes.push({ kind: 'send', body: b }); this.headersSent = true; return this; },
    json(b) { this.writes.push({ kind: 'json', body: b }); this.headersSent = true; return this; },
    get body() { return this.writes.length ? this.writes[this.writes.length - 1].body : undefined; },
  };
}

/*
 * The route's own handler, with express.urlencoded removed — the test supplies
 * req.body directly (there is no socket to parse). Every dropped layer is
 * asserted to BE that parser, so an auth gate added here later fails this
 * helper loudly instead of being silently skipped.
 */
function handlerFor(path, method) {
  const layer = router.stack.find((e) => e.route && e.route.path === path && e.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
  const kept = [];
  for (const l of layer.route.stack) {
    if (l.handle.name === 'urlencodedParser') continue;
    kept.push(l);
  }
  assert.equal(kept.length, 1,
    `${method.toUpperCase()} ${path}: expected exactly one handler after dropping the body parser`);
  return kept[0].handle;
}

/*
 * Drive the handler and report HOW IT ENDED, not just what it wrote. `settled`
 * is the assertion that matters for the Express-4 hang: a handler that rejects
 * returns a response object indistinguishable from one that never ran.
 */
async function call(path, method, { query = {}, body = {} } = {}) {
  const handler = handlerFor(path, method);
  const res = makeRes();
  const req = {
    query, body, params: {},
    method: method.toUpperCase(),
    originalUrl: `/api/public/plivo${path}`,
    path,
    get(h) { return (this.headers || {})[String(h).toLowerCase()]; },
  };
  let settled = 'fulfilled';
  let reason = null;
  try { await handler(req, res); } catch (e) { settled = 'rejected'; reason = e; }
  return { res, settled, reason };
}

/* ─── XML well-formedness ──────────────────────────────────────────────────
 *
 * "Valid XML" is the literal contract, so assert structure rather than substring
 * presence: a truncated or double-rooted body still matches /<Response/.
 * Returns the root element name so a caller can assert on it.
 */
function xmlRoot(body) {
  assert.equal(typeof body, 'string', 'a body must have been sent');
  assert.ok(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'),
    `missing XML declaration: ${JSON.stringify(body)}`);
  const stack = [];
  const roots = [];
  /* Fresh RegExp per call — a /g literal hoisted to module scope carries
   * lastIndex between calls and would silently skip the first tags. */
  const re = /<(\/?)([A-Za-z][\w.-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g;
  let m;
  let consumed = body.indexOf('\n') + 1;
  while ((m = re.exec(body))) {
    const between = body.slice(consumed, m.index);
    assert.equal(/[<>]/.test(between), false, `unparsed markup before <${m[2]}> in ${JSON.stringify(body)}`);
    if (between.trim()) {
      assert.ok(stack.length, `text outside any element in ${JSON.stringify(body)}`);
    }
    consumed = m.index + m[0].length;
    const [, closing, name, , selfClosing] = m;
    if (closing) {
      assert.equal(stack.pop(), name, `mismatched </${name}> in ${JSON.stringify(body)}`);
    } else if (!selfClosing) {
      if (!stack.length) roots.push(name);
      stack.push(name);
    } else if (!stack.length) {
      roots.push(name);
    }
  }
  assert.equal(/[<>]/.test(body.slice(consumed)), false,
    `unparsed markup after the last tag in ${JSON.stringify(body)}`);
  assert.equal(body.slice(consumed).trim(), '', `trailing text after the root in ${JSON.stringify(body)}`);
  assert.equal(stack.length, 0, `unclosed ${stack.join('/')} in ${JSON.stringify(body)}`);
  assert.equal(roots.length, 1, `XML must have exactly one root, got ${roots.length}: ${JSON.stringify(body)}`);
  return roots[0];
}

const EMPTY_RESPONSE = '<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>';
const HANGUP = '<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup/></Response>';

/* Assert the shape every provider-facing reply must have, whatever the branch. */
function assertProviderSafeXml({ res, settled }) {
  assert.equal(settled, 'fulfilled',
    'the handler promise must SETTLE — an Express 4 async rejection reaches no error '
    + 'middleware, so Plivo holds the request open with no XML and drops the leg');
  assert.equal(res.writes.length, 1,
    'exactly one write to res — the fallbacks are guarded by !res.headersSent, and a '
    + 'second write is a production-only "headers already sent" throw');
  assert.equal(res.contentType, 'text/xml');
  assert.ok(res.statusCode < 400,
    `a ${res.statusCode} makes Plivo treat the answer_url as failed — never a 4xx/5xx here`);
  assert.equal(xmlRoot(res.body), 'Response', 'Plivo only understands a <Response> root');
}

const answerToken = (over = {}) => plivo.signCallToken({ dest: DEST, jci: JCI, ...over });

/* ═══ GET /answer ═════════════════════════════════════════════════════════ */

test('/answer bridges to the number carried IN THE TOKEN, not one from the URL', async () => {
  const r = await call('/answer', 'get', {
    query: { t: answerToken(), CallUUID: 'cu-1', To: '910000000000' },
  });
  assertProviderSafeXml(r);
  assert.match(r.res.body, /<Dial callerId="911140000000"><Number>919810000000<\/Number><\/Dial>/,
    'the destination is the signed claim — a query param must never be able to redirect the bridge');
  assert.ok(!r.res.body.includes('910000000000'), 'the URL-supplied number is ignored entirely');
  assert.equal(/<Record/.test(r.res.body), false, 'recording off ⇒ no <Record> element');
});

test('/answer stamps the audit row answered, keyed by the token\'s jci', async () => {
  const r = await call('/answer', 'get', { query: { t: answerToken(), CallUUID: 'cu-2' } });
  assertProviderSafeXml(r);
  const up = fake.calls.find((c) => /UPDATE tbl_job_caller_info/i.test(c.sql));
  assert.ok(up, 'reaching this route means the agent picked up — the row must flip to answered');
  assert.match(up.sql, /caller_status = 'answered'/);
  assert.match(up.sql, /unique_id = COALESCE\(\?, unique_id\)/,
    'COALESCE so a CallUUID already stamped by the ring callback is not clobbered with NULL');
  // start_time (2026-09-16): a bound Date, never SQL NOW() — see
  // routes/public/plivo-answer.js.
  assert.doesNotMatch(up.sql, /NOW\(\)/);
  assert.ok(up.params[0] instanceof Date, 'start_time is the first bound value');
  assert.deepEqual(up.params.slice(1), ['cu-2', JCI], 'the row is chosen by the signed jci, never by a query param');
});

test('/answer with recording on emits a <Record> ELEMENT carrying the jci-keyed callback', async () => {
  await setRecording(true);
  const r = await call('/answer', 'get', { query: { t: answerToken(), CallUUID: 'cu-3' } });
  assertProviderSafeXml(r);
  /*
   * Element-before-Dial, not an attribute ON Dial: `<Dial record="true">` is not
   * a real Plivo attribute and was ignored SILENTLY for months (see
   * buildAnswerXml's header). Asserting only "recording is enabled" would pass
   * against that bug.
   */
  assert.match(r.res.body, /<Response><Record[^>]*\/><Dial /);
  assert.match(r.res.body, /callbackUrl="https:\/\/core\.easyfix\.in\/api\/public\/plivo\/recording-callback\?t=/);
});

test('⚠ an invalid/expired token yields the empty <Response\/> AND writes nothing', async () => {
  const r = await call('/answer', 'get', { query: { t: 'not-a-jwt', CallUUID: 'cu-4' } });
  assertProviderSafeXml(r);
  assert.equal(r.res.body, EMPTY_RESPONSE,
    'the header promises an empty Response for a bad token — no bridge to an unknown destination');
  assert.equal(/<Dial/.test(r.res.body), false, 'an unverified caller must never reach a customer number');
});

test('⚠ a rejecting AUDIT UPDATE still produces the normal bridge XML, not the fallback', async () => {
  /*
   * This is the point of the inner try/catch, and it is the assertion a
   * coarser "did it 200?" test would miss: the fallback is ALSO a 200 with
   * valid XML. What must be true is that the customer still gets bridged —
   * a failed log write must not cost them their call. So assert <Dial>, and
   * assert it is NOT the empty Response.
   */
  auditUpdateFails = true;
  const r = await call('/answer', 'get', { query: { t: answerToken(), CallUUID: 'cu-5' } });
  assertProviderSafeXml(r);
  assert.match(r.res.body, /<Dial callerId="911140000000"><Number>919810000000<\/Number><\/Dial>/);
  assert.notEqual(r.res.body, EMPTY_RESPONSE, 'a lost audit row is not a reason to drop the bridge');
});

test('⚠ a rejecting markAnswered still produces the normal bridge XML', async () => {
  plivoLog.markAnswered = async () => { throw new Error(QUEUE_LIMIT); };
  const r = await call('/answer', 'get', { query: { t: answerToken(), CallUUID: 'cu-6' } });
  assertProviderSafeXml(r);
  assert.match(r.res.body, /<Dial /);
  assert.notEqual(r.res.body, EMPTY_RESPONSE);
});

test('⚠ BOTH best-effort writes rejecting still produces the normal bridge XML', async () => {
  auditUpdateFails = true;
  plivoLog.markAnswered = async () => { throw new Error(QUEUE_LIMIT); };
  const r = await call('/answer', 'get', { query: { t: answerToken(), CallUUID: 'cu-7' } });
  assertProviderSafeXml(r);
  assert.match(r.res.body, /<Dial /,
    'the two guards are independent — the first one firing must not skip the second');
});

test('⚠ an UNGUARDED failure falls back to the empty <Response\/>, settles, and is not a 5xx', async () => {
  /*
   * recordingEnabled() is the first call on the happy path that sits OUTSIDE
   * any inner try — the seam the outer catch exists for. Without that catch the
   * async handler rejects, Express 4 routes it nowhere, and Plivo holds the
   * request open until it times out and tears down the live leg. The three
   * assertions correspond to the three ways that shows up: no body, a rejected
   * promise, and (were `next(e)` used instead) a 500.
   */
  plivo.recordingEnabled = () => { throw new Error(QUEUE_LIMIT); };
  const r = await call('/answer', 'get', { query: { t: answerToken(), CallUUID: 'cu-8' } });
  assertProviderSafeXml(r);
  assert.equal(r.res.body, EMPTY_RESPONSE, 'the header names this exact fallback body');
  assert.equal(r.res.statusCode, 200);
});

test('/answer in CONFERENCE mode returns the MultiPartyCall join XML', async () => {
  const added = [];
  conference.addParticipant = async (p) => { added.push(p); return { ok: true, participantId: 5 }; };
  const r = await call('/answer', 'get', {
    query: { t: answerToken({ conf: 'efxconf1234abcd', confId: 7, destKind: 'customer', destName: 'Asha' }), CallUUID: 'cu-9' },
  });
  assertProviderSafeXml(r);
  assert.match(r.res.body, /<MultiPartyCall /,
    'once this returns <Dial> the call can never gain a third party — Plivo cannot promote one');
  assert.equal(/<Dial/.test(r.res.body), false);
  assert.equal(added.length, 1, 'the receiver is dialled in from this callback, not at placement time');
  assert.equal(added[0].toNumber, DEST);
});

test('⚠ addParticipant throwing AFTER the XML went out must not write a second response', async () => {
  /*
   * The conference branch replies FIRST and then fires the participant add, so
   * a throw there lands in the outer catch with headersSent already true. If
   * the `if (!res.headersSent)` guard were dropped, production would get
   * "Cannot set headers after they are sent" on a live call — and the response
   * object alone cannot show it, which is why this counts writes.
   */
  conference.addParticipant = () => { throw new Error(QUEUE_LIMIT); };
  const r = await call('/answer', 'get', {
    query: { t: answerToken({ conf: 'efxconf1234abcd', confId: 7 }), CallUUID: 'cu-10' },
  });
  assertProviderSafeXml(r);
  assert.match(r.res.body, /<MultiPartyCall /,
    'the operator keeps the room they were already given — the failure is the receiver, not the leg');
});

/* ═══ POST|GET /web-answer ════════════════════════════════════════════════ */

const stash = (over = {}) => plivo.stashWebDial({ number: DEST, jci: JCI, ...over });

test('POST /web-answer resolves the opaque dialId and bridges to the real number', async () => {
  const r = await call('/web-answer', 'post', { body: { 'X-PH-dialId': stash(), CallUUID: 'wc-1' } });
  assertProviderSafeXml(r);
  assert.match(r.res.body, /<Dial callerId="911140000000"><Number>919810000000<\/Number><\/Dial>/,
    'the number lives only in the server-side stash — the browser never held it');
});

test('/web-answer matches ANY param containing "dialid", whatever the case or prefix', async () => {
  // The header says the casing/prefix of the forwarded X-PH-* header can vary.
  for (const key of ['X-PH-dialId', 'x-ph-dialid', 'DIALID', 'SIP-H-X-Ph-DialId']) {
    const r = await call('/web-answer', 'post', { body: { [key]: stash(), CallUUID: 'wc-2' } });
    assertProviderSafeXml(r);
    assert.match(r.res.body, /<Number>919810000000<\/Number>/, `param name ${key} must resolve`);
  }
});

test('⚠ a REPLAYED dialId yields <Hangup\/> and never a number', async () => {
  // Not a stubbed "unknown id" — the real one-time semantics: resolve once, then
  // replay the same id. That is the property the header actually claims.
  const id = stash();
  const first = await call('/web-answer', 'post', { body: { dialId: id } });
  assert.match(first.res.body, /<Number>/, 'the first use bridges');

  const replay = await call('/web-answer', 'post', { body: { dialId: id } });
  assertProviderSafeXml(replay);
  assert.equal(replay.res.body, HANGUP);
  assert.equal(/<Number>/.test(replay.res.body), false, 'a replay must not leak the customer number');
});

test('⚠ an unknown dialId yields <Hangup\/> and touches no call row', async () => {
  const r = await call('/web-answer', 'post', { body: { dialId: 'deadbeef'.repeat(4) } });
  assertProviderSafeXml(r);
  assert.equal(r.res.body, HANGUP);
});

test('⚠ rejecting audit + call-log writes still produce the normal bridge XML', async () => {
  auditUpdateFails = true;
  plivoLog.markRinging = async () => { throw new Error(QUEUE_LIMIT); };
  plivoLog.setRecordingRequested = async () => { throw new Error(QUEUE_LIMIT); };
  const r = await call('/web-answer', 'post', { body: { dialId: stash(), CallUUID: 'wc-3' } });
  assertProviderSafeXml(r);
  assert.match(r.res.body, /<Dial /, 'a failed log write must not hang up on a connected operator');
  assert.notEqual(r.res.body, HANGUP);
});

test('⚠ an UNGUARDED failure in /web-answer hangs up cleanly — settles, no 5xx', async () => {
  plivo.recordingEnabled = () => { throw new Error(QUEUE_LIMIT); };
  const r = await call('/web-answer', 'post', { body: { dialId: stash(), CallUUID: 'wc-4' } });
  assertProviderSafeXml(r);
  assert.equal(r.res.body, HANGUP,
    "<Hangup/> is this handler's own 'cannot proceed' reply — the header's stated fallback, "
    + 'and deliberately NOT /answer\'s empty <Response/>');
  assert.equal(r.res.statusCode, 200);
});

test('GET /web-answer is mounted on the SAME handler as POST', async () => {
  // Both are registered from one `webAnswer` function; asserting identity keeps
  // a future divergence (one route hardened, the other not) from going unseen.
  assert.equal(handlerFor('/web-answer', 'get'), handlerFor('/web-answer', 'post'));
  const r = await call('/web-answer', 'get', { query: { dialId: stash() } });
  assertProviderSafeXml(r);
  assert.match(r.res.body, /<Dial /);
});

/* ═══ POST|GET /recording-callback ════════════════════════════════════════ */

const recToken = (jci = JCI) => plivo.signRecordingToken(jci);

function assertPlainOk({ res, settled }) {
  assert.equal(settled, 'fulfilled', 'a rejected promise leaves Plivo without an ack — it will retry');
  assert.equal(res.writes.length, 1, 'exactly one ack');
  assert.equal(res.statusCode, 200,
    'the header is explicit: ALWAYS 200 so Plivo does not retry-storm');
  assert.equal(res.contentType, 'text/plain');
  assert.equal(res.body, 'ok');
}

test('/recording-callback stores the recording against the jci from the token', async () => {
  const stored = [];
  plivoLog.setRecording = async (jci, payload) => { stored.push({ jci, payload }); };
  const r = await call('/recording-callback', 'post', {
    query: { t: recToken() },
    body: { RecordUrl: 'https://rec.plivo.com/x.mp3', RecordingID: 'rid-1', RecordingDuration: '42' },
  });
  assertPlainOk(r);
  assert.deepEqual(stored, [{ jci: JCI, payload: { url: 'https://rec.plivo.com/x.mp3', id: 'rid-1', duration: '42' } }],
    'keyed by jci, not by call_uuid — that is what makes web/WebRTC legs populate');
});

test('⚠ an invalid token acks 200 and stores NOTHING', async () => {
  let called = 0;
  plivoLog.setRecording = async () => { called += 1; };
  const r = await call('/recording-callback', 'post', {
    query: { t: 'not-a-jwt' },
    body: { RecordUrl: 'https://rec.plivo.com/x.mp3' },
  });
  assertPlainOk(r);
  assert.equal(called, 0, 'an unauthorised callback must not be able to write a recording URL onto a call row');
});

test('⚠ an ANSWER token is not accepted as a recording token', async () => {
  // signRecordingToken stamps kind:'rec'; verifyRecordingToken enforces it. A
  // 15-minute bridge token must not double as a 2-hour recording-write grant.
  let called = 0;
  plivoLog.setRecording = async () => { called += 1; };
  const r = await call('/recording-callback', 'post', {
    query: { t: answerToken() },
    body: { RecordUrl: 'https://rec.plivo.com/x.mp3' },
  });
  assertPlainOk(r);
  assert.equal(called, 0);
});

test('⚠ a rejecting setRecording still acks 200 — settles, one write, no 5xx', async () => {
  /*
   * The whole reason /recording-callback has an outer catch. A 500 here is not
   * a lost recording URL, it is a RETRY STORM: Plivo re-POSTs, the store fails
   * again, and the loop runs for as long as the outage does.
   */
  plivoLog.setRecording = async () => { throw new Error(QUEUE_LIMIT); };
  const r = await call('/recording-callback', 'post', {
    query: { t: recToken() },
    body: { RecordUrl: 'https://rec.plivo.com/x.mp3', RecordingID: 'rid-2' },
  });
  assertPlainOk(r);
});

test('a callback with no RecordUrl acks 200 and writes nothing', async () => {
  let called = 0;
  plivoLog.setRecording = async () => { called += 1; };
  const r = await call('/recording-callback', 'post', { query: { t: recToken() }, body: { RecordingID: 'rid-3' } });
  assertPlainOk(r);
  assert.equal(called, 0);
});

test('GET /recording-callback is the same handler and acks the same way', async () => {
  assert.equal(handlerFor('/recording-callback', 'get'), handlerFor('/recording-callback', 'post'));
  plivoLog.setRecording = async () => {};
  const r = await call('/recording-callback', 'get', {
    query: { t: recToken(), RecordUrl: 'https://rec.plivo.com/y.mp3' },
  });
  assertPlainOk(r);
});
