/*
 * POST /api/mobile/kyc/aadhaar-ocr under an Idempotency-Key.
 *
 * The route carries THREE payload parts — front image, back image, and the
 * typed "name as per Aadhaar" — but the idempotency layer runs before Multer,
 * so it can only ever fingerprint method + URL + an empty body + ONE content
 * digest. Two thirds of the payload therefore sat outside the fingerprint, and
 * a same-key retry with a corrected name (or a re-shot back image) replayed the
 * stale extraction instead of re-reading the card.
 *
 * The endpoint persists nothing — it is a pure extraction read — so the key is
 * now refused outright. What is asserted here is the OUTCOME, not the wording:
 * a changed name or a changed back image must never be answered from a response
 * stored for a different payload. Unkeyed calls must stay untouched.
 *
 * The real middleware/idempotency.js runs against a fake ledger (no DB); Sophy
 * is stubbed at the module boundary (no network, no key).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');

const idempotency = require('../middleware/idempotency');
const logger = require('../logger');
const sophy = require('../services/sophy.service');

const originalChatVision = sophy.chatVision;
const originalKey = process.env.SOPHY_API_KEY_AADHAAR_OCR;

// ── fake ledger — one row per (actor, key), same CAS contract as MySQL ──
let ledger = new Map();
const rowKey = (p) => `${p[0]}|${p[1]}|${p[2]}`;
const database = {
  async query(sql, params) {
    const text = String(sql);
    if (/^\s*INSERT INTO tbl_idempotency_key/i.test(text)) {
      if (ledger.has(rowKey(params))) {
        const error = new Error('duplicate');
        error.code = 'ER_DUP_ENTRY';
        throw error;
      }
      ledger.set(rowKey(params), {
        request_fingerprint: params[5],
        state: 'in_flight',
        response_status: null,
        response_json: null,
        retry_after_seconds: 300,
        leaseToken: params[6],
      });
      return [{ affectedRows: 1 }, []];
    }
    if (/^\s*SELECT request_fingerprint/i.test(text)) return [[ledger.get(rowKey(params))], []];
    if (/state = 'done'/i.test(text)) {
      const id = `${params[2]}|${params[3]}|${params[4]}`;
      const row = ledger.get(id);
      if (!row || row.leaseToken !== params.at(-1)) return [{ affectedRows: 0 }, []];
      ledger.set(id, {
        ...row,
        response_status: params[0],
        response_json: params[1],
        state: 'done',
        retry_after_seconds: 0,
      });
      return [{ affectedRows: 1 }, []];
    }
    if (/^\s*DELETE FROM tbl_idempotency_key/i.test(text)) {
      ledger.delete(rowKey(params));
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`unexpected SQL: ${text}`);
  },
};

let visionCalls = [];
let server;
let baseUrl;

before(async () => {
  process.env.SOPHY_API_KEY_AADHAAR_OCR = 'mw_live_test';
  sophy.chatVision = async (args) => {
    visionCalls.push(args);
    return JSON.stringify({
      name: 'Ramesh Kumar', dob: null, aadhaarNumber: null,
      gender: null, fatherName: null, address: null,
    });
  };
  const app = express();
  app.use((req, _res, next) => { req.tech = { efr_id: 8379 }; next(); });
  app.use(idempotency({ database }));
  // eslint-disable-next-line global-require
  app.use('/kyc', require('../routes/mobile/kyc'));
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

beforeEach(() => { visionCalls = []; ledger = new Map(); });

const FRONT = Buffer.from('front-aadhaar-jpeg-bytes');
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

// The app's real shape: the digest it can compute before upload covers the
// single file the old code pointed the verifier at — the FRONT image.
async function post({ front = FRONT, back = Buffer.from('back-bytes'), name, key } = {}) {
  const form = new FormData();
  form.append('front', new Blob([front], { type: 'image/jpeg' }), 'front.jpg');
  form.append('back', new Blob([back], { type: 'image/jpeg' }), 'back.jpg');
  if (name !== undefined) form.append('name', name);
  const headers = key
    ? { 'idempotency-key': key, 'idempotency-content-digest': md5(front) }
    : {};
  const res = await fetch(`${baseUrl}/kyc/aadhaar-ocr`, { method: 'POST', body: form, headers });
  return { status: res.status, replay: res.headers.get('idempotent-replay'), body: await res.json() };
}

test('a corrected name under the same key is never answered from the stored response', async () => {
  const first = await post({ key: 'aadhaar-ocr-1', name: 'Ramesh Kumar' });
  const corrected = await post({ key: 'aadhaar-ocr-1', name: 'Ramesh Kumaar' });

  assert.notEqual(
    corrected.body?.data?.nameMatch?.expected,
    'Ramesh Kumar',
    'the corrected name was answered from the response stored for the previous name',
  );
  assert.notEqual(corrected.status, 200, 'a payload that changed must not read as a fresh success');
  assert.equal(first.status, 400);
  assert.equal(first.body.details.code, 'IDEMPOTENCY_NOT_SUPPORTED');
  assert.equal(visionCalls.length, 0, 'a keyed request never reaches the model');
});

test('a re-shot back image under the same key is never answered from the stored response', async () => {
  await post({ key: 'aadhaar-ocr-2', name: 'Ramesh Kumar', back: Buffer.from('blurry-back') });
  const reshot = await post({ key: 'aadhaar-ocr-2', name: 'Ramesh Kumar', back: Buffer.from('sharp-back') });

  // A replay of the REFUSAL is fine — a replay of an EXTRACTION is the bug.
  assert.equal(reshot.body?.data?.available, undefined, 'a stored extraction was replayed for changed bytes');
  assert.notEqual(reshot.status, 200, 'a different back image must not read as a fresh success');
  assert.equal(visionCalls.length, 0);
});

test('unkeyed requests still extract, every time, with the name that was sent', async () => {
  const first = await post({ name: 'Ramesh Kumar' });
  const second = await post({ name: 'Ramesh Kumaar' });

  assert.equal(first.status, 200);
  assert.equal(first.body.data.nameMatch.expected, 'Ramesh Kumar');
  assert.equal(second.status, 200);
  assert.equal(second.body.data.nameMatch.expected, 'Ramesh Kumaar');
  assert.equal(visionCalls.length, 2, 'each unkeyed call re-reads the card');
  assert.equal(ledger.size, 0, 'nothing was reserved for an unkeyed request');
});

test('the PAN OCR route still accepts a key — its single file IS the whole payload', async () => {
  const pan = Buffer.from('pan-card-jpeg-bytes');
  const form = new FormData();
  form.append('file', new Blob([pan], { type: 'image/jpeg' }), 'pan.jpg');
  const res = await fetch(`${baseUrl}/kyc/pan-ocr`, {
    method: 'POST',
    body: form,
    headers: { 'idempotency-key': 'pan-ocr-1', 'idempotency-content-digest': md5(pan) },
  });
  const body = await res.json();
  // No SUREPASS key in the test env, so the service answers 503 — the point is
  // that the request got PAST the idempotency + digest gates, unlike
  // aadhaar-ocr, whose single-file digest genuinely covers its whole payload.
  assert.notEqual(body?.details?.code, 'IDEMPOTENCY_NOT_SUPPORTED');
  assert.equal(res.status, 503);
});

test('every upload rejection logs BOTH a cause and a message, and never a filename', async () => {
  const originalWarn = logger.warn;
  const warned = [];
  logger.warn = (line) => { warned.push(String(line)); };
  try {
    // Multer's own rejection: a code AND a fixed message.
    const oversize = new FormData();
    oversize.append('front', new Blob([Buffer.alloc(11 * 1024 * 1024)], { type: 'image/jpeg' }), 'front.jpg');
    await fetch(`${baseUrl}/kyc/aadhaar-ocr`, { method: 'POST', body: oversize });

    // fileFilter rejection: a plain Error, no code.
    const wrongType = new FormData();
    wrongType.append('front', new Blob([Buffer.from('%PDF-')], { type: 'application/pdf' }), 'ramesh-aadhaar-scan.pdf');
    await fetch(`${baseUrl}/kyc/aadhaar-ocr`, { method: 'POST', body: wrongType });

    const lines = warned.filter((l) => l.includes('upload rejected'));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /LIMIT_FILE_SIZE/);
    assert.match(lines[0], /File too large/, 'a coded rejection still has to say what happened');
    assert.match(lines[1], /Only image files are accepted/);
    for (const line of lines) {
      assert.doesNotMatch(line, /undefined/, 'the rejection log must never read "undefined"');
      assert.doesNotMatch(line, /ramesh|\.pdf/i, 'a caller-supplied filename is PII — never log it');
    }
  } finally {
    logger.warn = originalWarn;
  }
});
