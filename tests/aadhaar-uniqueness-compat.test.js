const { test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const lifecycle = require('../services/easyfixer-lifecycle.service');
const easyfixer = require('../services/easyfixer.service');
const verification = require('../services/easyfixer-verification.service');
const {
  isAadhaarUniqueViolation,
  mapAadhaarUniqueViolation,
} = require('../utils/aadhaar-uniqueness');

function duplicateAadhaarError() {
  const error = new Error(
    "Duplicate entry '123456789012' for key 'uq_easyfixer_active_aadhaar'",
  );
  error.code = 'ER_DUP_ENTRY';
  return error;
}

function assertSafeConflict(error) {
  return (
    error.status === 409
    && error.details?.code === 'AADHAAR_ALREADY_REGISTERED'
    && !error.message.includes('123456789012')
    && !String(error.stack || '').includes('123456789012')
  );
}

async function withStubs(stubs, run) {
  const originals = {
    query: db.pool.query,
    getConnection: db.pool.getConnection,
    hasLifecycleSchema: lifecycle.hasLifecycleSchema,
  };
  db.pool.query = stubs.query || originals.query;
  db.pool.getConnection = stubs.getConnection || originals.getConnection;
  lifecycle.hasLifecycleSchema = stubs.hasLifecycleSchema || originals.hasLifecycleSchema;
  try {
    return await run();
  } finally {
    db.pool.query = originals.query;
    db.pool.getConnection = originals.getConnection;
    lifecycle.hasLifecycleSchema = originals.hasLifecycleSchema;
  }
}

test('shared classifier maps only the active-Aadhaar constraint and removes the raw value', () => {
  const raw = duplicateAadhaarError();
  assert.equal(isAadhaarUniqueViolation(raw), true);
  assert.ok(assertSafeConflict(mapAadhaarUniqueViolation(raw)));

  const unrelated = new Error("Duplicate entry 'other' for key 'some_other_unique'");
  unrelated.code = 'ER_DUP_ENTRY';
  assert.equal(isAadhaarUniqueViolation(unrelated), false);
  assert.equal(mapAadhaarUniqueViolation(unrelated), unrelated);
});

test('generic CRM create returns a redacted Aadhaar conflict and still releases its lock', async () => {
  const events = [];
  const conn = {
    async query(sql) {
      const text = String(sql);
      if (/GET_LOCK/i.test(text)) return [[{ got: 1 }], []];
      if (/SELECT efr_id, efr_name/i.test(text)) return [[], []];
      if (/INSERT INTO tbl_easyfixer/i.test(text)) throw duplicateAadhaarError();
      if (/RELEASE_LOCK/i.test(text)) { events.push('release'); return [[{ released: 1 }], []]; }
      throw new Error(`unexpected SQL: ${text}`);
    },
    release() { events.push('connection-release'); },
  };

  await assert.rejects(
    withStubs({
      hasLifecycleSchema: async () => false,
      getConnection: async () => conn,
    }, () => easyfixer.create({
      efr_name: 'Ramesh',
      efr_no: '9999999999',
      adhaar_card_number: '123456789012',
    }, { user_id: 7 })),
    assertSafeConflict,
  );
  assert.deepEqual(events, ['release', 'connection-release']);
});

test('generic CRM update returns the same redacted Aadhaar conflict', async () => {
  let queryCount = 0;
  await assert.rejects(
    withStubs({
      hasLifecycleSchema: async () => false,
      query: async (sql) => {
        queryCount += 1;
        if (/SELECT[\s\S]+FROM tbl_easyfixer e/i.test(String(sql))) {
          return [[{ efr_id: 73, efr_status: 1 }], []];
        }
        if (/UPDATE tbl_easyfixer SET/i.test(String(sql))) throw duplicateAadhaarError();
        throw new Error(`unexpected SQL: ${String(sql)}`);
      },
    }, () => easyfixer.update(
      73,
      { adhaar_card_number: '123456789012' },
      { user_id: 7 },
    )),
    assertSafeConflict,
  );
  assert.equal(queryCount, 2);
});

test('CRM verification identity save returns the same redacted Aadhaar conflict', async () => {
  await assert.rejects(
    withStubs({
      hasLifecycleSchema: async () => false,
      query: async (sql) => {
        if (/UPDATE tbl_easyfixer SET/i.test(String(sql))) throw duplicateAadhaarError();
        throw new Error(`unexpected SQL: ${String(sql)}`);
      },
    }, () => verification.saveIdentity(73, {
      verification_status: 1,
      adhaar_card_number: '123456789012',
    }, { user_id: 7 })),
    assertSafeConflict,
  );
});
