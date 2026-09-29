/*
 * The AI Aadhaar check ON RECORD, and the identity save that now needs one
 * (owner, 2026-09-29). services/aadhaar-ai-check.service.js +
 * services/mobile-identity.service.js, against an in-memory stand-in for the
 * two tables involved — no database, no network.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const aiCheck = require('../services/aadhaar-ai-check.service');
const identity = require('../services/mobile-identity.service');
const profileCompletion = require('../services/profile-completion.service');
const aadhaarUniqueness = require('../utils/aadhaar-uniqueness');
const { readMigration } = require('./helpers/migration-file');
const { EXPECTED } = require('../scripts/schema-verify')._internals;

const { TABLE, COLUMNS } = aiCheck._internals;
const EFR = 8379;
const FRONT = Buffer.from('front-jpeg-bytes');
const BACK = Buffer.from('back-jpeg-bytes');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

beforeEach(() => {
  aiCheck._internals.resetProbeForTests();
  aadhaarUniqueness._internals.resetActiveAadhaarColumnProbeForTests();
});

/** In-memory tbl_easyfixer_aadhaar_ai_check + just enough of the identity save. */
function fakeDb({ installed = true } = {}) {
  const checks = [];
  const events = [];
  const conn = {
    async beginTransaction() { events.push('begin'); },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); },
    release() {},
    async query(sql, params = []) {
      const text = String(sql);
      events.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
      if (/information_schema\.columns/i.test(text) && params.includes(TABLE)) {
        return [installed ? COLUMNS.map((c) => ({ c })) : [], []];
      }
      if (/information_schema\.columns/i.test(text)) return [[], []];
      if (/^\s*INSERT INTO tbl_easyfixer_aadhaar_ai_check/i.test(text)) {
        const [efr_id, status, verdict, reason, aadhaar_last4, name_score, discrepancies, input_fingerprint, created_at] = params;
        const row = { id: checks.length + 1, efr_id, status, verdict, reason, aadhaar_last4, name_score, discrepancies, input_fingerprint, created_at, submitted_at: null, params };
        checks.push(row);
        return [{ insertId: row.id }, []];
      }
      if (/FROM tbl_easyfixer_aadhaar_ai_check\s+WHERE efr_id = \?\s+ORDER BY is_current/i.test(text)) {
        const [fp, efrId] = params;
        const mine = checks.filter((c) => c.efr_id === efrId)
          .map((c) => ({ id: c.id, verdict: c.verdict, is_current: c.input_fingerprint === fp ? 1 : 0 }))
          .sort((a, b) => (b.is_current - a.is_current) || (b.id - a.id));
        return [mine.slice(0, 1), []];
      }
      if (/^\s*UPDATE tbl_easyfixer_aadhaar_ai_check SET submitted_at/i.test(text)) {
        const row = checks.find((c) => c.id === params[1]);
        if (row) row.submitted_at = params[0];
        return [{ affectedRows: row ? 1 : 0 }, []];
      }
      if (/submitted_at IS NOT NULL/i.test(text)) {
        const mine = checks.filter((c) => c.efr_id === params[0] && c.submitted_at).sort((a, b) => b.id - a.id);
        return [mine.slice(0, 1), []];
      }
      if (/GET_LOCK/i.test(text)) return [[{ acquired: 1 }], []];
      if (/RELEASE_LOCK/i.test(text)) return [[{ released: 1 }], []];
      if (/SELECT 1 AS conflict/i.test(text)) return [[], []];
      if (/identity_review FROM tbl_easyfixer/i.test(text)) return [[{ identity_review: null }], []];
      if (/^\s*UPDATE tbl_easyfixer\b/i.test(text)) return [{ affectedRows: 1 }, []];
      if (/^\s*SELECT efr_doc_id/i.test(text)) return [[], []];
      if (/^\s*INSERT INTO tbl_easyfixer_document/i.test(text)) return [{ affectedRows: 1 }, []];
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  return { checks, events, conn, query: conn.query, getConnection: async () => conn };
}

const matchedOcr = (extracted = {}) => ({
  available: true,
  extracted: { name: 'Ramesh Kumar', dob: '1990-04-17', aadhaarNumber: '234567890123', ...extracted },
  nameMatch: { matched: true, score: 1, expected: 'Ramesh Kumar', found: 'Ramesh Kumar' },
});

const typed = { name: 'Ramesh Kumar', aadhaarNumber: '234567890123', dob: '1990-04-17' };

function saveBody(overrides = {}) {
  return {
    name: 'Ramesh Kumar',
    aadhaarNumber: '234567890123',
    dob: '1990-04-17',
    docs: { aadhaarFront: 'MobileUploads/f', aadhaarBack: 'MobileUploads/b' },
    aadhaarPhotoDigests: { front: md5(FRONT), back: md5(BACK) },
    ...overrides,
  };
}

const errorCode = (code) => (error) => {
  assert.equal(error.status, 422);
  assert.equal(error.details?.code, code);
  return true;
};

test('a check is recorded with the masked last 4, the verdict and a fingerprint — never the full number', async () => {
  const db = fakeDb();
  const out = await aiCheck.recordCheck(EFR, { ocr: matchedOcr(), typed, front: FRONT, back: BACK }, { database: db });
  assert.deepEqual(out, { id: 1, status: 'matched', verdict: 'verified' });
  const [row] = db.checks;
  assert.equal(row.aadhaar_last4, '0123');
  assert.match(row.input_fingerprint, /^[a-f0-9]{64}$/);
  for (const value of row.params) {
    assert.doesNotMatch(String(value), /234567890123|\d{12}/, 'no parameter may carry a full Aadhaar number');
  }
});

test('a number / DOB disagreement is a mismatch whose discrepancies are masked', async () => {
  const db = fakeDb();
  await aiCheck.recordCheck(EFR, {
    ocr: matchedOcr({ aadhaarNumber: '987654321098', dob: '1991-01-01' }),
    typed,
    front: FRONT,
    back: BACK,
  }, { database: db });
  const [row] = db.checks;
  assert.equal(row.verdict, 'mismatch');
  assert.deepEqual(JSON.parse(row.discrepancies), [
    { field: 'aadhaarNumber', expected: 'XXXX XXXX 0123', found: 'XXXX XXXX 1098' },
    { field: 'dob', expected: '1990-04-17', found: '1991-01-01' },
  ]);
});

test('the verdict table: matched → verified, name mismatch → mismatch, no name / no read → not_run', () => {
  const { evaluate } = aiCheck._internals;
  assert.equal(evaluate(matchedOcr(), typed).verdict, 'verified');
  const nameMismatch = evaluate({ ...matchedOcr(), nameMatch: { matched: false, score: 0.2, expected: 'Ramesh Kumar', found: 'Suresh Rao' } }, typed);
  assert.equal(nameMismatch.verdict, 'mismatch');
  assert.deepEqual(nameMismatch.discrepancies[0], { field: 'name', expected: 'Ramesh Kumar', found: 'Suresh Rao' });
  const unmatched = evaluate({ ...matchedOcr(), nameMatch: null }, {});
  assert.deepEqual([unmatched.status, unmatched.verdict, unmatched.reason], ['unmatched', 'not_run', 'name_not_compared']);
  const unavailable = evaluate({ available: false, extracted: null, nameMatch: null, reason: 'not_configured' }, typed);
  assert.deepEqual([unavailable.status, unavailable.verdict, unavailable.reason], ['unavailable', 'not_run', 'not_configured']);
});

test('an identity save with NO check on record is refused', async () => {
  const db = fakeDb();
  await assert.rejects(
    identity.saveIdentityDetails(EFR, saveBody(), { database: db }),
    errorCode('AADHAAR_AI_CHECK_REQUIRED'),
  );
  assert.ok(!db.events.some((e) => /^UPDATE tbl_easyfixer SET/i.test(e)), 'nothing is written');
  assert.ok(!db.events.includes('begin'), 'refused before any transaction');
});

test('an identity save WITHOUT both photo digests is refused', async () => {
  const db = fakeDb();
  await aiCheck.recordCheck(EFR, { ocr: matchedOcr(), typed, front: FRONT, back: BACK }, { database: db });
  await assert.rejects(
    identity.saveIdentityDetails(EFR, saveBody({ aadhaarPhotoDigests: undefined }), { database: db }),
    errorCode('AADHAAR_PHOTOS_REQUIRED'),
  );
  await assert.rejects(
    identity.saveIdentityDetails(EFR, saveBody({ docs: { aadhaarFront: 'MobileUploads/f' } }), { database: db }),
    errorCode('AADHAAR_PHOTOS_REQUIRED'),
  );
});

test('an identity save matching a recorded check is accepted and stamps that check submitted', async () => {
  const db = fakeDb();
  await aiCheck.recordCheck(EFR, { ocr: matchedOcr(), typed, front: FRONT, back: BACK }, { database: db });
  const out = await identity.saveIdentityDetails(EFR, saveBody(), { database: db });
  assert.equal(out.updated, true);
  assert.equal(out.aiVerdict, 'verified');
  assert.ok(db.checks[0].submitted_at instanceof Date);
  const latest = await aiCheck.latestSubmitted(EFR, { database: db });
  assert.equal(latest.verdict, 'verified');
  assert.equal(latest.masked_number, 'XXXX XXXX 0123');
});

test('a mismatch or not-run check still lets the identity be SUBMITTED, flagged for review', async () => {
  const db = fakeDb();
  await aiCheck.recordCheck(EFR, {
    ocr: { available: false, extracted: null, nameMatch: null, reason: 'unreadable' },
    typed,
    front: FRONT,
    back: BACK,
  }, { database: db });
  const out = await identity.saveIdentityDetails(EFR, saveBody(), { database: db });
  assert.equal(out.aiVerdict, 'not_run');
});

test('a STALE check — any input changed after it ran — is refused', async () => {
  const cases = {
    dob: saveBody({ dob: '1990-04-18' }),
    name: saveBody({ name: 'Ramesh K' }),
    number: saveBody({ aadhaarNumber: '234567890124' }),
    photo: saveBody({ aadhaarPhotoDigests: { front: md5(Buffer.from('retaken')), back: md5(BACK) } }),
  };
  for (const [what, body] of Object.entries(cases)) {
    aiCheck._internals.resetProbeForTests();
    const db = fakeDb();
    await aiCheck.recordCheck(EFR, { ocr: matchedOcr(), typed, front: FRONT, back: BACK }, { database: db });
    await assert.rejects(
      identity.saveIdentityDetails(EFR, body, { database: db }),
      errorCode('AADHAAR_AI_CHECK_STALE'),
      `changed ${what} must void the check`,
    );
  }
});

test('fields the card FILLED IN (blank when checked) do not make the check stale', async () => {
  const db = fakeDb();
  // Typed nothing but the name: the app adopts the card's number and DOB, then saves them.
  await aiCheck.recordCheck(EFR, {
    ocr: matchedOcr(),
    typed: { name: 'Ramesh Kumar', aadhaarNumber: '', dob: '' },
    front: FRONT,
    back: BACK,
  }, { database: db });
  const out = await identity.saveIdentityDetails(EFR, saveBody(), { database: db });
  assert.equal(out.aiVerdict, 'verified');
});

test('a check never crosses technicians', async () => {
  const db = fakeDb();
  await aiCheck.recordCheck(4242, { ocr: matchedOcr(), typed, front: FRONT, back: BACK }, { database: db });
  await assert.rejects(
    identity.saveIdentityDetails(EFR, saveBody(), { database: db }),
    errorCode('AADHAAR_AI_CHECK_REQUIRED'),
  );
});

test('PAN-only saves never need a check', async () => {
  const db = fakeDb();
  const out = await identity.saveIdentityDetails(EFR, { panNumber: 'ABCDE1234F' }, { database: db });
  assert.equal(out.updated, true);
  assert.equal(out.aiVerdict, undefined);
});

test('existing rows are unaffected: identity completeness never looks at the check table', () => {
  // A technician who saved identity before this change, with no check on record.
  const legacy = profileCompletion.fromRow({
    adhaar_card_number: '234567890123', efr_profile_img: 'EFRDoc1.jpg', dob_present: 1,
  });
  assert.equal(legacy.identityComplete, true);
  const sql = profileCompletion.sqlPredicates().identityComplete;
  assert.doesNotMatch(sql, new RegExp(TABLE));
});

test('with the table absent: no record, no enforcement, one warning path — never a 500', async () => {
  const db = fakeDb({ installed: false });
  assert.equal(
    await aiCheck.recordCheck(EFR, { ocr: matchedOcr(), typed, front: FRONT, back: BACK }, { database: db }),
    null,
  );
  assert.equal(db.checks.length, 0);
  const out = await identity.saveIdentityDetails(EFR, saveBody({ aadhaarPhotoDigests: undefined }), { database: db });
  assert.equal(out.updated, true);
  assert.equal(await aiCheck.latestSubmitted(EFR, { database: db }), null);
});

test('the migration is one idempotent CREATE TABLE IF NOT EXISTS whose columns match EXPECTED and the probe', () => {
  const sql = readMigration('2026-09-29-01-aadhaar-ai-check.sql');
  const statements = sql.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /^CREATE TABLE IF NOT EXISTS tbl_easyfixer_aadhaar_ai_check \(/);
  // Executable SQL only (comments stripped): additive, no @-variables/PREPARE, no MariaDB-only ADD COLUMN IF NOT EXISTS.
  assert.doesNotMatch(statements.join('\n'), /\bALTER\b|\bDROP\b|\bDELETE\b|\bPREPARE\b|@\w+|ADD COLUMN IF NOT EXISTS/i);
  const declared = [...statements[0].matchAll(/^\s{2}([a-z0-9_]+)\s+(?:INT|VARCHAR|CHAR|DECIMAL|TEXT|DATETIME)/gim)].map((m) => m[1]);
  assert.deepEqual(declared, [...COLUMNS]);
  assert.deepEqual(EXPECTED[TABLE], [...COLUMNS]);
});
