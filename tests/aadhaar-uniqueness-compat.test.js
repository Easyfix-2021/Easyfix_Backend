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

/*
 * The application-level duplicate guard (utils/aadhaar-uniqueness) runs its own
 * statements on a PINNED connection: a value GET_LOCK, the generated-column
 * probe, the conflict SELECT, and the matching RELEASE_LOCK. These tests are
 * about the ER_DUP_ENTRY redaction contract, not the guard, so answer those
 * four uniformly with "no conflict" and let everything else fall through to the
 * test's own stub. Returning BOTH `acquired` and `got` covers the two lock
 * result shapes in use (the guard reads `acquired`; easyfixer.create reads `got`).
 */
function answerGuardSql(text) {
  if (/GET_LOCK/i.test(text)) return [[{ acquired: 1, got: 1 }], []];
  if (/RELEASE_LOCK/i.test(text)) return [[{ released: 1 }], []];
  if (/information_schema\.columns/i.test(text)) return [[], []];
  if (/SELECT 1 AS conflict/i.test(text)) return [[], []];
  return null;
}

/** A pinned connection that satisfies the guard and delegates the rest. */
function guardAwareConnection(queryStub, events = []) {
  return {
    async query(sql, params) {
      const answered = answerGuardSql(String(sql));
      if (answered) return answered;
      return queryStub(sql, params);
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() { events.push('connection-release'); },
  };
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
    async query(sql, params) {
      const text = String(sql);
      const lockName = String(params?.[0] || '');
      if (/GET_LOCK/i.test(text)) return [[{ acquired: 1, got: 1 }], []];
      if (/information_schema\.columns/i.test(text)) return [[], []];
      if (/SELECT 1 AS conflict/i.test(text)) return [[], []];
      if (/SELECT efr_id, efr_name/i.test(text)) return [[], []];
      if (/INSERT INTO tbl_easyfixer/i.test(text)) throw duplicateAadhaarError();
      if (/RELEASE_LOCK/i.test(text)) {
        // The Aadhaar value lock now shares this connection with the efr_no
        // lock. Record each separately so the ordering assertion proves BOTH
        // are released, fine-to-coarse, before the connection goes back.
        events.push(lockName.startsWith('efr_aadhaar:') ? 'release-value' : 'release');
        return [[{ released: 1 }], []];
      }
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
  // Both named locks are released before the connection returns to the pool.
  // The value lock unwinds first because the guard's own `finally` is nested
  // inside create()'s. That is safe: deadlock-freedom depends on ACQUISITION
  // order (coarse value lock before fine efr_no lock, both before any InnoDB
  // lock), never on the order they are dropped.
  assert.deepEqual(events, ['release-value', 'release', 'connection-release']);
});

test('generic CRM update returns the same redacted Aadhaar conflict', async () => {
  let queryCount = 0;
  const poolQuery = async (sql) => {
    queryCount += 1;
    if (/SELECT[\s\S]+FROM tbl_easyfixer e/i.test(String(sql))) {
      return [[{ efr_id: 73, efr_status: 1 }], []];
    }
    if (/UPDATE tbl_easyfixer SET/i.test(String(sql))) throw duplicateAadhaarError();
    throw new Error(`unexpected SQL: ${String(sql)}`);
  };
  await assert.rejects(
    withStubs({
      hasLifecycleSchema: async () => false,
      query: poolQuery,
      // update() now pins its own connection for the value lock. The guard's
      // statements run THERE, so pool.query still sees exactly two calls.
      getConnection: async () => guardAwareConnection(async (sql) => {
        throw new Error(`unexpected pinned SQL: ${String(sql)}`);
      }),
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
      // saveIdentity now pins a connection for the value lock before dispatching
      // to any of its three branches; the write itself still goes via pool.
      getConnection: async () => guardAwareConnection(async (sql) => {
        throw new Error(`unexpected pinned SQL: ${String(sql)}`);
      }),
    }, () => verification.saveIdentity(73, {
      verification_status: 1,
      adhaar_card_number: '123456789012',
    }, { user_id: 7 })),
    assertSafeConflict,
  );
});
