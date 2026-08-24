/*
 * POST /api/mobile/kyc/aadhaar-ocr — the wire contract.
 *
 * Sophy is stubbed at the module boundary (services/mobile-kyc.service.js calls
 * `sophy.chatVision(...)`, so replacing the export is enough): no network, no
 * DB, no key. What is asserted here is the SOFT-DEGRADE discipline — an absent
 * key or an unusable model reply must answer 200 with available:false and a
 * null nameMatch, never a fabricated extraction and never a 500 — plus the 400s
 * that a genuinely bad request must still get.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const sophy = require('../services/sophy.service');

const originalChatVision = sophy.chatVision;
const originalKey = process.env.SOPHY_API_KEY_AADHAAR_OCR;

let visionCalls = [];
let visionReply = null;
let server;
let baseUrl;

before(async () => {
  sophy.chatVision = async (args) => { visionCalls.push(args); return visionReply; };
  // eslint-disable-next-line global-require
  const router = require('../routes/mobile/kyc');
  const app = express();
  app.use((req, _res, next) => { req.tech = { efr_id: 8379 }; next(); });
  app.use('/kyc', router);
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  sophy.chatVision = originalChatVision;
  if (originalKey === undefined) delete process.env.SOPHY_API_KEY_AADHAAR_OCR;
  else process.env.SOPHY_API_KEY_AADHAAR_OCR = originalKey;
  if (server) await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => { visionCalls = []; visionReply = null; });

function image(bytes = 'jpeg-bytes') {
  return new Blob([Buffer.from(bytes)], { type: 'image/jpeg' });
}

async function post({ front = image(), back = image('back-bytes'), name } = {}) {
  const form = new FormData();
  if (front) form.append('front', front, 'front.jpg');
  if (back) form.append('back', back, 'back.jpg');
  if (name !== undefined) form.append('name', name);
  const res = await fetch(`${baseUrl}/kyc/aadhaar-ocr`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}

test('a missing image is a 400, not a degraded 200', async () => {
  process.env.SOPHY_API_KEY_AADHAAR_OCR = 'mw_live_test';
  const noBack = await post({ back: null });
  assert.equal(noBack.status, 400);
  assert.equal(noBack.body.success, false);
  assert.match(noBack.body.error, /required/i);

  const noFront = await post({ front: null });
  assert.equal(noFront.status, 400);
  assert.equal(visionCalls.length, 0, 'a bad request never reaches the model');
});

test('an oversize image is a 400 before anything is sent upstream', async () => {
  process.env.SOPHY_API_KEY_AADHAAR_OCR = 'mw_live_test';
  const big = new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: 'image/jpeg' });
  const out = await post({ front: big });
  assert.equal(out.status, 400);
  // Anchored on the whole phrase: a bare /5 MB/ false-passes on the "5 MB"
  // inside "1.25 MB", so it would keep passing however the cap moved.
  assert.match(out.body.error, /must be 1\.25 MB or smaller$/);
  assert.equal(visionCalls.length, 0);
});

test('no API key degrades to 200 available:false with a null nameMatch', async () => {
  delete process.env.SOPHY_API_KEY_AADHAAR_OCR;
  const out = await post({ name: 'Ramesh Kumar' });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, {
    success: true,
    data: { available: false, extracted: null, nameMatch: null },
  });
  assert.equal(visionCalls.length, 0, 'no key ⇒ the gateway is never called');
});

test('a malformed model reply degrades to available:false, never a fake match', async () => {
  process.env.SOPHY_API_KEY_AADHAAR_OCR = 'mw_live_test';
  visionReply = 'I am sorry, I cannot read identity documents.';
  const prose = await post({ name: 'Ramesh Kumar' });
  assert.equal(prose.status, 200);
  assert.deepEqual(prose.body.data, { available: false, extracted: null, nameMatch: null });

  visionReply = null; // gateway/transport failure
  const nulled = await post({ name: 'Ramesh Kumar' });
  assert.deepEqual(nulled.body.data, { available: false, extracted: null, nameMatch: null });

  visionReply = '{"name":null,"dob":null,"aadhaarNumber":null,"gender":null,"fatherName":null,"address":null}';
  const empty = await post({ name: 'Ramesh Kumar' });
  assert.deepEqual(empty.body.data, { available: false, extracted: null, nameMatch: null });
});

test('a usable reply is coerced field by field and the typed name is compared', async () => {
  process.env.SOPHY_API_KEY_AADHAAR_OCR = 'mw_live_test';
  visionReply = '```json\n{"name":"Kumar Ramesh","dob":"1990-02-30","aadhaarNumber":"1234 5678 9012",'
    + '"gender":"Male","fatherName":"Suresh Kumar","address":"12 Main Road, Delhi"}\n```';
  const out = await post({ name: 'Mr. Ramesh Kumar' });
  assert.equal(out.status, 200);
  assert.equal(out.body.data.available, true);
  assert.deepEqual(out.body.data.extracted, {
    name: 'Kumar Ramesh',
    dob: null, // 30 Feb is not a date — dropped, never passed through
    aadhaarNumber: '123456789012',
    gender: 'M',
    fatherName: 'Suresh Kumar',
    address: '12 Main Road, Delhi',
  });
  assert.deepEqual(out.body.data.nameMatch, {
    matched: true, score: 1, expected: 'Mr. Ramesh Kumar', found: 'Kumar Ramesh',
  });

  // Both images actually rode along, base64'd, with their mime type.
  assert.equal(visionCalls.length, 1);
  assert.equal(visionCalls[0].images.length, 2);
  assert.ok(visionCalls[0].images.every((i) => i.mimeType === 'image/jpeg' && i.base64.length > 0));
});

test('no typed name means no verdict, and a different person is not a match', async () => {
  process.env.SOPHY_API_KEY_AADHAAR_OCR = 'mw_live_test';
  visionReply = '{"name":"Ramesh Kumar","dob":null,"aadhaarNumber":null,"gender":null,"fatherName":null,"address":null}';
  const anonymous = await post();
  assert.equal(anonymous.body.data.available, true);
  assert.equal(anonymous.body.data.nameMatch, null);

  const wrong = await post({ name: 'Suresh Verma' });
  assert.equal(wrong.body.data.nameMatch.matched, false);
  assert.ok(wrong.body.data.nameMatch.score < 0.5);
});

/*
 * A name the model could NOT read is an ABSENT comparison, not a failed one.
 * Reporting {matched:false, found:null} is indistinguishable on the wire from a
 * genuine mismatch, and the app renders it as one — telling a technician who
 * typed their name correctly that it disagrees with their Aadhaar.
 */
test('an unreadable name yields no verdict, not a mismatch', async () => {
  process.env.SOPHY_API_KEY_AADHAAR_OCR = 'mw_live_test';
  // Front glare-washed, back legible: the model read the address and nothing else.
  visionReply = '{"name":null,"dob":null,"aadhaarNumber":null,"gender":null,'
    + '"fatherName":null,"address":"12 Main Rd"}';
  const out = await post({ name: 'Ramesh Kumar' });
  assert.equal(out.status, 200);
  assert.equal(out.body.data.available, true);
  assert.equal(out.body.data.extracted.name, null);
  assert.equal(
    out.body.data.nameMatch, null,
    'a name that was never READ must not be reported as a name that MISMATCHED',
  );
});

/*
 * The prompt says "Use null for ANY field you cannot read confidently".
 * An unrecognised gender string must be dropped like every other unreadable
 * field — not coerced to 'O', which would both invent a value the card never
 * printed and keep an otherwise-empty extraction alive (validateExtraction
 * needs only ONE non-null field).
 */
test('an unrecognised gender is dropped, not manufactured into O', async () => {
  process.env.SOPHY_API_KEY_AADHAAR_OCR = 'mw_live_test';
  visionReply = '{"gender":"unknown"}';
  const only = await post({ name: 'Ramesh Kumar' });
  assert.equal(only.status, 200);
  assert.deepEqual(
    only.body.data, { available: false, extracted: null, nameMatch: null },
    'one unreadable field is not an extraction',
  );

  // ...and it does not sneak in beside a field that WAS legible.
  visionReply = '{"gender":"not printed","address":"12 Main Rd"}';
  const beside = await post({ name: 'Ramesh Kumar' });
  assert.equal(beside.body.data.available, true);
  assert.equal(beside.body.data.extracted.gender, null);
  assert.equal(beside.body.data.extracted.address, '12 Main Rd');
});

// The other half of the same rule: a card that really prints a third gender
// still reads as 'O'. Dropping the unreadable must not drop the legible.
test('a genuine third-gender card still reads as O', async () => {
  process.env.SOPHY_API_KEY_AADHAAR_OCR = 'mw_live_test';
  for (const printed of ['O', 'Other', 'Transgender', 'T']) {
    visionReply = JSON.stringify({ gender: printed });
    // eslint-disable-next-line no-await-in-loop
    const out = await post();
    assert.equal(out.body.data.available, true, `gender "${printed}" is legible`);
    assert.equal(out.body.data.extracted.gender, 'O', `gender "${printed}" → O`);
  }
  for (const [printed, code] of [['male', 'M'], ['FEMALE', 'F'], [' Male ', 'M']]) {
    visionReply = JSON.stringify({ gender: printed });
    // eslint-disable-next-line no-await-in-loop
    const out = await post();
    assert.equal(out.body.data.extracted.gender, code, `gender "${printed}" → ${code}`);
  }
});
