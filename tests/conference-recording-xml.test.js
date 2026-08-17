/*
 * Conference recording — the <Record> element in the MPC answer XML.
 *
 * THE BUG (job #528792, 2026-08-17). Conference calls were never recorded.
 * operatorAnswerXml() emitted <MultiPartyCall> alone, and the service's own
 * UNVERIFIED checklist said "we do not call Record" — so every conference leg
 * carried a NULL recording_url while the Call History UI still rendered a Play
 * button. Five legs on that job, five blank URLs.
 *
 * WHY AN ELEMENT AND NOT AN ATTRIBUTE, which is what these tests really guard.
 * This codebase already paid for that mistake: `<Dial record="true">` is not a
 * real Plivo attribute, it was ignored SILENTLY, and recording_url was NULL for
 * months (see buildAnswerXml in plivo.service.js). The failure mode is the
 * dangerous kind — no error, no log, a 2xx, and no audio. So the assertions
 * below check the SHAPE of the XML, not just that recording "is enabled":
 * a <Record> element must exist, and `record=` must NOT appear as an attribute
 * of MultiPartyCall. A future refactor that "simplifies" the element into an
 * attribute would restore the silent bug, and only this file would notice.
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

test('no recordingCallbackUrl → byte-for-byte the previous XML', () => {
  /*
   * The additive guarantee. Recording follows plivo.recordingEnabled(), so when
   * ops have it off — and for any caller not yet passing the option — the XML
   * must be exactly what it was before this feature existed.
   */
  const xml = conference.operatorAnswerXml(NAME, { confId: 7 });

  assert.equal(/<Record/.test(xml), false, 'no Record element when recording is off');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<Response><MultiPartyCall /,
    'MultiPartyCall still opens the Response directly');
});

test('with a callback URL → a <Record> ELEMENT before <MultiPartyCall>', () => {
  const xml = conference.operatorAnswerXml(NAME, { confId: 7, recordingCallbackUrl: CB });

  assert.match(xml, /<Response><Record[^>]*\/><MultiPartyCall /,
    'Record must come FIRST — it is background/non-blocking, so the room still starts');
  assert.match(xml, /recordSession="true"/, 'record the whole session, not a prompt');
  assert.match(xml, /fileFormat="mp3"/);
  assert.match(xml, /recordChannelType="stereo"/,
    'stereo — the same 2-channel format transcription/call-analytics already expects');
  assert.match(xml, /callbackMethod="POST"/, 'the recording-callback handler reads req.body');
});

test('record is NEVER an attribute of MultiPartyCall — that is the old silent bug', () => {
  const xml = conference.operatorAnswerXml(NAME, { confId: 7, recordingCallbackUrl: CB });
  const mpcTag = xml.match(/<MultiPartyCall [^>]*>/)[0];

  assert.equal(/\brecord\s*=/.test(mpcTag), false,
    'a `record="true"` attribute is what Plivo silently ignored on <Dial> for months; '
    + 'recording must be requested by the <Record> element');
  assert.equal(/\brecordingCallbackUrl\s*=/i.test(mpcTag), false,
    'nor does the callback belong on the MPC element');
});

test('no startOnDialAnswer — there is no <Dial> here for it to key on', () => {
  /*
   * The bridge path uses it to skip ring-time dead air. A conference has no
   * B-leg dial, so the flag has nothing to trigger on; recording begins with
   * the operator's session and the participants who join later are inside it —
   * which is the whole point.
   */
  const xml = conference.operatorAnswerXml(NAME, { confId: 7, recordingCallbackUrl: CB });
  assert.equal(/startOnDialAnswer/.test(xml), false);
});

test('the callback URL is XML-attribute-escaped', () => {
  const nasty = 'https://x.test/cb?t=a&b=1&c="2"';
  const xml = conference.operatorAnswerXml(NAME, { confId: 7, recordingCallbackUrl: nasty });

  assert.match(xml, /callbackUrl="[^"]*&amp;b=1&amp;c=&quot;2&quot;"/,
    'a raw & would make the XML unparseable and Plivo would reject the whole answer');
  assert.equal(xml.includes('c="2"'), false, 'the bare quote must not close the attribute');
});

test('recording does not disturb the cost guards on the MPC element', () => {
  /*
   * endMpcOnExit and stayAlone are the two attributes this feature must never
   * perturb: the first is the primary spend guard, the second keeps a lone
   * operator from being dropped. Adding a sibling element should be inert for
   * both — assert it rather than assume it.
   */
  const plain = conference.operatorAnswerXml(NAME, { confId: 7 });
  const rec = conference.operatorAnswerXml(NAME, { confId: 7, recordingCallbackUrl: CB });

  const mpcOf = (x) => x.match(/<MultiPartyCall [^>]*>/)[0];
  assert.equal(mpcOf(rec), mpcOf(plain),
    'the MultiPartyCall tag must be identical with and without recording');
  assert.match(mpcOf(rec), /stayAlone="true"/);
  assert.match(mpcOf(rec), /endMpcOnExit="true"/);
});
