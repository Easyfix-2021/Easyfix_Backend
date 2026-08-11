const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const lifecycle = require('../services/easyfixer-lifecycle.service');
const easyfixer = require('../services/easyfixer.service');

async function withStubs(stubs, run) {
  const originals = {
    query: db.pool.query,
    getConnection: db.pool.getConnection,
    hasLifecycleSchema: lifecycle.hasLifecycleSchema,
    transition: lifecycle.transition,
  };
  Object.assign(db.pool, {
    query: stubs.query || originals.query,
    getConnection: stubs.getConnection || originals.getConnection,
  });
  lifecycle.hasLifecycleSchema = stubs.hasLifecycleSchema || originals.hasLifecycleSchema;
  lifecycle.transition = stubs.transition || originals.transition;
  try {
    return await run();
  } finally {
    db.pool.query = originals.query;
    db.pool.getConnection = originals.getConnection;
    lifecycle.hasLifecycleSchema = originals.hasLifecycleSchema;
    lifecycle.transition = originals.transition;
  }
}

function detailRow(overrides = {}) {
  return {
    efr_id: 73,
    efr_status: 1,
    efr_manager_id: 91,
    is_technician_verified: 1,
    ...overrides,
  };
}

test('manager input always uses the lifecycle row lock even when the stale detail read matches', async () => {
  let transitionCalls = 0;
  let resolvedTarget = null;
  let updateSql = null;

  await withStubs({
    hasLifecycleSchema: async () => true,
    query: async (sql) => {
      assert.match(String(sql), /SELECT\s+e\.\*/);
      // This pre-lock read matches the requested manager. A concurrent writer
      // has unmapped the locked row by the time transition() runs below.
      return [[detailRow({ efr_manager_id: 91 })], []];
    },
    transition: async (_id, input) => {
      transitionCalls += 1;
      const lockedRow = detailRow({ efr_manager_id: null });
      resolvedTarget = input._resolveStatus(lockedRow, { status: 'ACTIVE' });
      await input._beforeUpdate({
        query: async (sql) => { updateSql = String(sql); },
      });
      return { changed: true };
    },
  }, async () => {
    await easyfixer.update(73, { efr_manager_id: 91 }, { user_id: 7 });
  });

  assert.equal(transitionCalls, 1);
  assert.equal(resolvedTarget, 'UNDER_MASTER');
  assert.match(updateSql, /efr_manager_id = \?/);
});

test('generic edit cannot revert a concurrent verification decision', async () => {
  await assert.rejects(
    withStubs({
      hasLifecycleSchema: async () => true,
      query: async () => [[detailRow({ is_technician_verified: 0 })], []],
      transition: async (_id, input) => {
        // The form read false, but verification completed before its update
        // acquired the lifecycle lock. The locked truth must win.
        input._resolveStatus(
          detailRow({ is_technician_verified: 1 }),
          { status: 'ACTIVE' },
        );
      },
    }, () => easyfixer.update(
      73,
      { efr_name: 'Stale form', is_technician_verified: false },
      { user_id: 7 },
    )),
    (error) => error.status === 409 && /verification activation flow/.test(error.message),
  );
});

test('unchanged false verification echo is accepted but never written by generic update', async () => {
  let updateSql = null;
  await withStubs({
    hasLifecycleSchema: async () => true,
    query: async () => [[detailRow({ is_technician_verified: null })], []],
    transition: async (_id, input) => {
      const locked = detailRow({ is_technician_verified: null });
      assert.equal(input._resolveStatus(locked, { status: 'REGISTRATION_INCOMPLETE' }), 'REGISTRATION_INCOMPLETE');
      await input._beforeUpdate({
        query: async (sql) => { updateSql = String(sql); },
      });
      return { changed: false };
    },
  }, () => easyfixer.update(
    73,
    { efr_name: 'Safe edit', is_technician_verified: false },
    { user_id: 7 },
  ));

  assert.match(updateSql, /efr_name = \?/);
  assert.doesNotMatch(updateSql, /is_technician_verified/);
});

test('generic create rejects verified technicians and omits an echoed false flag', async () => {
  let connectionRequested = false;
  await assert.rejects(
    withStubs({
      hasLifecycleSchema: async () => true,
      getConnection: async () => {
        connectionRequested = true;
        throw new Error('must not acquire a connection');
      },
    }, () => easyfixer.create({
      efr_name: 'Unsafe create',
      efr_no: '9999999999',
      is_technician_verified: true,
    }, { user_id: 7 })),
    (error) => error.status === 409 && /verification activation flow/.test(error.message),
  );
  assert.equal(connectionRequested, false);

  let insertSql = null;
  const conn = {
    async query(sql) {
      const text = String(sql);
      if (/GET_LOCK/.test(text)) return [[{ got: 1 }], []];
      if (/SELECT efr_id, efr_name/.test(text)) return [[], []];
      if (/INSERT INTO tbl_easyfixer/.test(text)) {
        insertSql = text;
        return [{ insertId: 74 }, []];
      }
      if (/RELEASE_LOCK/.test(text)) return [[{ released: 1 }], []];
      throw new Error(`unexpected connection query: ${text}`);
    },
    release() {},
  };

  await withStubs({
    hasLifecycleSchema: async () => true,
    getConnection: async () => conn,
    query: async () => [[detailRow({ efr_id: 74, is_technician_verified: null })], []],
  }, () => easyfixer.create({
    efr_name: 'Safe create',
    efr_no: '9999999998',
    is_technician_verified: false,
  }, { user_id: 7 }));

  assert.match(insertSql, /INSERT INTO tbl_easyfixer/);
  assert.doesNotMatch(insertSql, /is_technician_verified/);
});
