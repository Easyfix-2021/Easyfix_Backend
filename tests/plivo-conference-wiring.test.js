/*
 * THE SEAM — does a click-to-call actually become a conference?
 *
 * Everything else about this feature can be perfect and the feature still does
 * nothing, because the whole thing turns on ONE decision made at ONE moment:
 * what the answer_url returns when the operator picks up.
 *
 * Plivo has no API to promote a live <Dial> into a conference — they are
 * different objects. So if that callback returns <Dial>, the call can never gain
 * a third party, no matter how complete the conference service, routes, webhook
 * and UI are. The build landed with the service exporting operatorAnswerXml()
 * and NOTHING calling it: `grep` found it referenced only inside a comment.
 * Every piece existed; the join did not.
 *
 * These tests pin the two links in that chain:
 *   1. the conference rides the CALL TOKEN out to Plivo, and
 *   2. it survives the round-trip back so the answer route can branch on it.
 *
 * Non-destructive: globalThis.fetch is stubbed, no DB, no network.
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * `plivo.calling.enabled` is THE switch — there is no conference flag. The
 * properties service reads it from easyfix_properties, so the fake pool has to
 * be installed BEFORE the service is required or the gate reads unset and every
 * call comes back suppressed.
 */
installFakePool([
  [/FROM easyfix_properties/i, () => ([
    { property_key: 'plivo.calling.enabled', property_value: 'true' },
  ])],
]);

const propsSvc = require('../services/properties.service');
const plivo = require('../services/plivo.service');
const conference = require('../services/plivo-conference.service');

const { before } = require('node:test');
before(async () => { await propsSvc.flushCache(); });

const SECRET = process.env.PLIVO_ANSWER_TOKEN_SECRET || process.env.JWT_SECRET || 'test-secret';

/* Capture the body Plivo would have received, without sending anything. */
function withPlivoCapture(fn) {
  const originalFetch = globalThis.fetch;
  const env = {};
  for (const k of ['PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN', 'PLIVO_CALLER_ID',
    'PLIVO_CALLBACK_BASE_URL', 'PLIVO_ANSWER_TOKEN_SECRET', 'JWT_SECRET']) env[k] = process.env[k];
  process.env.PLIVO_AUTH_ID = 'auth-id-test';
  process.env.PLIVO_AUTH_TOKEN = 'auth-token-test';
  process.env.PLIVO_CALLER_ID = '911140000000';
  process.env.PLIVO_CALLBACK_BASE_URL = 'https://core.easyfix.in';
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret';

  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
    return {
      ok: true, status: 201,
      headers: { get: () => null },
      text: async () => JSON.stringify({ request_uuid: ['req-uuid-1'], message: 'call fired' }),
      json: async () => ({ request_uuid: ['req-uuid-1'], message: 'call fired' }),
    };
  };

  return Promise.resolve(fn(sent)).finally(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

/* Pull the `t` token out of an answer_url and decode it. */
function claimsFromAnswerUrl(answerUrl) {
  const t = new URL(answerUrl).searchParams.get('t');
  assert.ok(t, 'the answer_url must carry a signed token');
  return jwt.verify(t, process.env.PLIVO_ANSWER_TOKEN_SECRET || process.env.JWT_SECRET || SECRET);
}

// ─── link 1: the conference reaches Plivo on the call token ───────────────

test('a conference call signs the conference into the answer_url token', () => withPlivoCapture(async (sent) => {
  const res = await plivo.clickToCall({
    from: '9810000001', to: '9820000002', jobCallerInfoId: 4242,
    conferenceName: 'efxc1abcd2345', conferenceId: 77,
    receiverKind: 'customer', receiverName: 'Asha Rao',
  });
  assert.equal(res.delivered, true);

  const call = sent.find((s) => /\/Call\/$/.test(s.url));
  assert.ok(call, 'a call was placed');

  const claims = claimsFromAnswerUrl(call.body.answer_url);
  assert.equal(claims.conf, 'efxc1abcd2345', 'the friendly name — the answer route branches on this');
  assert.equal(claims.confId, 77);
  assert.equal(claims.destKind, 'customer', 'so the participant row records WHO, not just digits');
  assert.equal(claims.destName, 'Asha Rao');
  assert.equal(claims.jci, 4242, 'the existing audit link is unchanged');
}));

test('a NON-conference call is byte-for-byte the classic bridge', () => withPlivoCapture(async (sent) => {
  /*
   * The fallback path is not a nice-to-have: createConference is fail-soft, so
   * any call whose conference could not be minted (Plivo disabled, concurrency
   * ceiling, DB error) comes through here. It must behave exactly as it did
   * before this feature existed.
   */
  await plivo.clickToCall({ from: '9810000001', to: '9820000002', jobCallerInfoId: 4243 });
  const call = sent.find((s) => /\/Call\/$/.test(s.url));
  const claims = claimsFromAnswerUrl(call.body.answer_url);

  assert.equal(claims.conf, undefined, 'no conference claim at all — not null, absent');
  assert.equal(claims.confId, undefined);
  assert.equal(claims.dest, '919820000002', 'the destination still rides the token for <Dial>');
  assert.equal(claims.jci, 4243);
}));

test('the operator leg still rings the AGENT, never the receiver', () => withPlivoCapture(async (sent) => {
  // Conference mode changes what happens AFTER the agent answers. It must not
  // change who is dialled first — dialling the customer before a human is on
  // the line would ring them for a call nobody picked up.
  await plivo.clickToCall({
    from: '9810000001', to: '9820000002', jobCallerInfoId: 4244,
    conferenceName: 'efxc9zzz0000', conferenceId: 78,
  });
  const call = sent.find((s) => /\/Call\/$/.test(s.url));
  assert.equal(call.body.to, '919810000001', 'the AGENT leg');
  assert.notEqual(call.body.to, '919820000002', 'never the receiver');
}));

// ─── link 2: the answer XML actually joins a room ─────────────────────────

test('operatorAnswerXml joins the MPC rather than dialling anyone', () => {
  const xml = conference.operatorAnswerXml('efxc1abcd2345', { confId: 77 });
  assert.match(xml, /<MultiPartyCall/, 'the element that makes a conference a conference');
  assert.match(xml, /efxc1abcd2345<\/MultiPartyCall>/, 'the room name is the element body');
  assert.equal(/<Dial/.test(xml), false,
    'a <Dial> here is the bug this whole feature exists to avoid — it cannot be upgraded later');
  assert.match(xml, /<Response>/);
});

/*
 * THE COST GUARD, AFTER THE OWNER REMOVED THE CONFIGURABLE LIMITS.
 *
 * This test used to assert maxDuration="\d+" alongside endMpcOnExit. The owner
 * deleted the three `plivo.conference.max.*` properties and, with them, the
 * maxDuration / maxParticipants attributes on this element. That is NOT "the
 * ceiling vanished": with the attributes absent, PLIVO'S OWN DEFAULTS APPLY,
 * which is where a provider ceiling belongs. Duplicating it here meant two
 * numbers that could drift and a spend cap ops never asked to own.
 *
 * So the test is INVERTED rather than deleted, and it is now the thing that
 * stops the attributes creeping back in a later "let's just cap it" patch:
 *   • endMpcOnExit="true" MUST remain — the operator hanging up ends the room
 *     is now the PRIMARY guard, and unlike a number it cannot be tuned to zero;
 *   • neither maxDuration nor maxParticipants may be emitted.
 * The third line of defence (a room nobody hung up) is the reaper's internal
 * leak-detector constant, pinned in tests/conference-webhook-reaper.test.js.
 */
test('operatorAnswerXml carries the cost guard that REMAINS, and emits no limits', () => {
  const xml = conference.operatorAnswerXml('efxc1abcd2345', { confId: 77 });
  assert.match(xml, /endMpcOnExit="true"/, 'the operator leaving ends the room — the primary guard');
  assert.doesNotMatch(xml, /maxDuration=/, "removed on purpose: Plivo's own default is the provider ceiling");
  assert.doesNotMatch(xml, /maxParticipants=/, 'same — the provider bounds the room, we do not');
});

test('operatorAnswerXml works with no options — the one-arg call must not break', () => {
  const xml = conference.operatorAnswerXml('efxc1abcd2345');
  assert.match(xml, /efxc1abcd2345<\/MultiPartyCall>/);
});

// ─── the TWIN seam: web mode ──────────────────────────────────────────────
//
// There are TWO answer routes, one per voice.call.mode ('mobile' | 'web'), and
// each is an independent decision point — whatever XML it returns is what the
// call becomes for life. The first pass wired only the mobile one, so
// conferencing silently worked or didn't depending on a property nobody would
// think to associate with it. These pin the web path so the two cannot drift.

test('the web dial stash carries the conference, and the dialId still reveals nothing', () => {
  const dialId = plivo.stashWebDial({
    number: '919820000002', jci: 5150,
    conferenceName: 'efxcweb12345', conferenceId: 91,
    receiverKind: 'technician', receiverName: 'Ramesh K',
  });

  // The id crosses to the BROWSER. That is the whole reason it exists, so it
  // must leak neither the number nor the room.
  assert.match(dialId, /^[0-9a-f]{32}$/, 'an opaque hex id, not a payload');
  assert.equal(dialId.includes('9820000002'), false);
  assert.equal(dialId.includes('efxcweb12345'), false);

  const resolved = plivo.resolveWebDial(dialId);
  assert.equal(resolved.conferenceName, 'efxcweb12345', 'web-answer branches on this');
  assert.equal(resolved.conferenceId, 91);
  assert.equal(resolved.receiverKind, 'technician');
  assert.equal(resolved.receiverName, 'Ramesh K');
  assert.equal(resolved.number, '919820000002');
  assert.equal(resolved.jci, 5150);
});

test('a web dial with no conference resolves exactly as before', () => {
  const dialId = plivo.stashWebDial({ number: '919820000002', jci: 5151 });
  const resolved = plivo.resolveWebDial(dialId);
  assert.equal(resolved.conferenceName, null, 'so web-answer falls through to <Dial>');
  assert.equal(resolved.conferenceId, null);
  assert.equal(resolved.number, '919820000002');
});

test('a web dial is still ONE-TIME — the conference must not make it replayable', () => {
  // The one-time rule is what stops a guessed or replayed id re-triggering a
  // dial. Carrying a conference through the stash must not weaken it.
  const dialId = plivo.stashWebDial({
    number: '919820000002', jci: 5152, conferenceName: 'efxcweb99999', conferenceId: 92,
  });
  assert.ok(plivo.resolveWebDial(dialId), 'first resolve works');
  assert.equal(plivo.resolveWebDial(dialId), null, 'second resolve is refused');
});
