/*
 * Conference recording — the MPC's OWN recording, started on answer.
 *
 * History these tests guard:
 *  - 2026-08-17 (job #528792): conference calls were never recorded at all.
 *    Fixed with a <Record recordSession> element before <MultiPartyCall> —
 *    which recorded from the OPERATOR's join, so every recording opened with
 *    ringback + room noise.
 *  - 2026-09-24 (c6d163a, reverted e24bb19): "start on answer" via the CALL
 *    Record API on the operator's leg. A leg inside an MPC 2xx's that call and
 *    records NOTHING — 36/36 Prod calls lost. Tests stubbed the documented
 *    reply, so they passed.
 *  - 2026-09-30: `record="true" recordMinMemberCount="2"` on <MultiPartyCall>
 *    — Plivo starts the room recording when the 2nd member joins. Documented
 *    on the MPC XML reference; proven only by a real QA call (these string
 *    assertions cannot prove Plivo records — they pin the shape we send).
 *
 * Pure string assertions — no DB, no network, no Plivo.
 *
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const conference = require('../services/plivo-conference.service');

const NAME = 'efxconf1234abcd';
const CB = 'https://api.example.com/api/public/plivo/recording-callback?t=eyJhbGciOiJIUzI1NiJ9.abc.def';
const mpcOf = (x) => x.match(/<MultiPartyCall [^>]*>/)[0];

test('no recordingCallbackUrl → no recording of any kind', () => {
  const xml = conference.operatorAnswerXml(NAME, { confId: 7 });
  assert.equal(/<Record/.test(xml), false);
  assert.equal(/\brecord/i.test(mpcOf(xml)), false, 'no record* attribute when recording is off');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<Response><MultiPartyCall /);
});

test('with a callback URL → the MPC records itself, starting at the 2nd member', () => {
  const xml = conference.operatorAnswerXml(NAME, { confId: 7, recordingCallbackUrl: CB });
  const tag = mpcOf(xml);
  assert.match(tag, /\brecord="true"/);
  assert.match(tag, /\brecordMinMemberCount="2"/,
    'THE fix: 1 (the default) starts at operator join = ringback in every recording');
  assert.match(tag, /\brecordFileFormat="mp3"/);
  assert.match(tag, /\brecordingCallbackMethod="POST"/, 'the recording-callback handler reads req.body');
});

test('no <Record> element — it started at operator join, not answer', () => {
  const xml = conference.operatorAnswerXml(NAME, { confId: 7, recordingCallbackUrl: CB });
  assert.equal(/<Record\b/.test(xml), false);
  assert.match(xml, /<Response><MultiPartyCall /);
});

test('the callback URL is XML-attribute-escaped', () => {
  const nasty = 'https://x.test/cb?t=a&b=1&c="2"';
  const xml = conference.operatorAnswerXml(NAME, { confId: 7, recordingCallbackUrl: nasty });
  assert.match(xml, /recordingCallbackUrl="[^"]*&amp;b=1&amp;c=&quot;2&quot;"/,
    'a raw & would make the XML unparseable and Plivo would reject the whole answer');
  assert.equal(xml.includes('c="2"'), false, 'the bare quote must not close the attribute');
});

test('recording does not disturb the cost guards on the MPC element', () => {
  const plain = mpcOf(conference.operatorAnswerXml(NAME, { confId: 7 }));
  const rec = mpcOf(conference.operatorAnswerXml(NAME, { confId: 7, recordingCallbackUrl: CB }));
  const strip = (t) => t.replace(/ record[A-Za-z]*="[^"]*"/g, '');
  assert.equal(strip(rec), plain, 'recording only ADDS record* attributes');
  assert.match(rec, /stayAlone="true"/);
  assert.match(rec, /endMpcOnExit="true"/);
});
