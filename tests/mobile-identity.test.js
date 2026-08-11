const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const identity = require('../services/mobile-identity.service');
const registration = require('../services/mobile-registration.service');
const lifecycle = require('../services/easyfixer-lifecycle.service');

const originalFinalize = lifecycle.finalizeMobileRegistrationGate1;

afterEach(() => {
  lifecycle.finalizeMobileRegistrationGate1 = originalFinalize;
});

function identityDb({ failUpdate = null } = {}) {
  const events = [];
  const conn = {
    async beginTransaction() { events.push({ type: 'begin' }); },
    async commit() { events.push({ type: 'commit' }); },
    async rollback() { events.push({ type: 'rollback' }); },
    release() { events.push({ type: 'release' }); },
    async query(sql, params) {
      const text = String(sql);
      events.push({ type: 'query', sql: text, params });
      if (/GET_LOCK/i.test(text)) return [[{ acquired: 1 }], []];
      if (/^\s*UPDATE tbl_easyfixer/i.test(text)) {
        if (failUpdate) throw failUpdate;
        return [{ affectedRows: 1 }, []];
      }
      if (/^\s*SELECT efr_doc_id/i.test(text)) return [[], []];
      if (/^\s*INSERT INTO tbl_easyfixer_document/i.test(text)) return [{ affectedRows: 1 }, []];
      if (/RELEASE_LOCK/i.test(text)) return [[{ released: 1 }], []];
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  return { events, conn, getConnection: async () => conn };
}

test('atomically persists optional name with identity fields and documents before finalization', async () => {
  const database = identityDb();
  lifecycle.finalizeMobileRegistrationGate1 = async (efrId) => {
    database.events.push({ type: 'finalize', efrId });
    return lifecycle._internals.resolveGate1Finalization(
      'REGISTRATION_INCOMPLETE',
      { personal_submitted: 1, adhaar_card_number: '123456789012', efr_profile_img: '' },
    );
  };
  const result = await identity.saveIdentityDetails(8379, {
    name: 'Ramesh Kumar',
    aadhaarNumber: '123456789012',
    panNumber: 'abcde1234f',
    dob: '01/01/1990',
    docs: { aadhaarFront: 'kyc/front-key' },
  }, {
    database,
    finalize: registration.finalizeGate1AfterSave,
  });

  assert.deepEqual(result, {
    updated: true,
    finalization: {
      finalized: false,
      schemaInstalled: true,
      lifecycle: null,
      pending: true,
      missing: ['profile_image'],
    },
  });
  const update = database.events.find((event) => (
    event.type === 'query' && /^\s*UPDATE tbl_easyfixer/i.test(event.sql)
  ));
  assert.ok(update);
  assert.match(update.sql, /efr_name\s+= COALESCE/i);
  assert.match(update.sql, /adhaar_card_number\s+= COALESCE/i);
  assert.deepEqual(update.params.slice(0, 4), [
    'Ramesh Kumar', '123456789012', 'ABCDE1234F', null,
  ]);
  assert.deepEqual(
    database.events
      .filter((event) => ['begin', 'commit', 'rollback', 'release', 'finalize'].includes(event.type))
      .map((event) => event.type),
    ['begin', 'commit', 'release', 'finalize'],
  );
});

test('identity save stays successful when post-commit Gate-1 finalization is deferred', async () => {
  const database = identityDb();
  const transient = new Error('database unavailable');
  transient.status = 503;
  lifecycle.finalizeMobileRegistrationGate1 = async () => { throw transient; };

  const result = await identity.saveIdentityDetails(8379, {
    aadhaarNumber: '123456789012',
  }, {
    database,
    finalize: registration.finalizeGate1AfterSave,
  });

  assert.equal(result.updated, true);
  assert.equal(result.finalization.pending, true);
  assert.equal(result.finalization.errorCode, 'REGISTRATION_FINALIZATION_DEFERRED');
  assert.deepEqual(
    database.events
      .filter((event) => ['begin', 'commit', 'rollback', 'release'].includes(event.type))
      .map((event) => event.type),
    ['begin', 'commit', 'release'],
  );
});

test('maps the authoritative UNIQUE race to the same redacted 409', async () => {
  const duplicateError = new Error("Duplicate entry '123456789012' for key 'uq_easyfixer_active_aadhaar'");
  duplicateError.code = 'ER_DUP_ENTRY';
  const database = identityDb({ failUpdate: duplicateError });

  await assert.rejects(
    identity.saveIdentityDetails(8379, { aadhaarNumber: '123456789012' }, { database }),
    (error) => (
      error.status === 409
      && error.details?.code === 'AADHAAR_ALREADY_REGISTERED'
      && !error.message.includes('123456789012')
    ),
  );
  assert.ok(database.events.some((event) => event.type === 'rollback'));
});

test('does not mislabel an unrelated duplicate-key error as an Aadhaar conflict', async () => {
  const duplicateError = new Error("Duplicate entry 'other' for key 'some_other_unique'");
  duplicateError.code = 'ER_DUP_ENTRY';
  const database = identityDb({ failUpdate: duplicateError });

  await assert.rejects(
    identity.saveIdentityDetails(8379, { aadhaarNumber: '123456789012' }, { database }),
    (error) => error === duplicateError,
  );
});

test('reads identity prefill in one technician-scoped aggregate query', async () => {
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return [[{
        name: 'Ramesh Kumar',
        aadhaar_number: '123456789012',
        pan_number: 'ABCDE1234F',
        dob: '1990-01-01',
        identity_verified: 1,
        aadhaar_doc_id: 41,
        pan_doc_id: 42,
      }], []];
    },
  };

  const result = await identity.getIdentityDetails(8379, { database });

  assert.deepEqual(result, {
    aadhaarNumber: '123456789012',
    panNumber: 'ABCDE1234F',
    name: 'Ramesh Kumar',
    dob: '1990-01-01',
    aadhaarDocId: 41,
    panDocId: 42,
    isVerified: true,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [8379, 8379]);
  assert.match(calls[0].sql, /WHERE e\.efr_id = \?/i);
  assert.match(calls[0].sql, /WHERE efr_id = \?/i);
});
