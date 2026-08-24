const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const identity = require('../services/mobile-identity.service');
const registration = require('../services/mobile-registration.service');
const lifecycle = require('../services/easyfixer-lifecycle.service');
const aadhaarUniqueness = require('../utils/aadhaar-uniqueness');

const originalFinalize = lifecycle.finalizeMobileRegistrationGate1;

afterEach(() => {
  lifecycle.finalizeMobileRegistrationGate1 = originalFinalize;
  // The generated-column probe caches per process; clear it so each test picks
  // its own schema shape rather than inheriting the previous test's.
  aadhaarUniqueness._internals.resetActiveAadhaarColumnProbeForTests();
});

/**
 * `conflict` — another technician already holds the number (the duplicate guard
 * must reject before the UPDATE runs).
 * `generatedColumn` — whether tbl_easyfixer.active_aadhaar_unique exists, which
 * selects which of the two equivalent guard queries is issued.
 * `failLock` — GET_LOCK returns 0 (contention on the same Aadhaar value).
 */
function identityDb({
  failUpdate = null,
  conflict = false,
  panConflict = false,
  generatedColumn = false,
  failLock = null,
} = {}) {
  const events = [];
  const conn = {
    async beginTransaction() { events.push({ type: 'begin' }); },
    async commit() { events.push({ type: 'commit' }); },
    async rollback() { events.push({ type: 'rollback' }); },
    release() { events.push({ type: 'release' }); },
    async query(sql, params) {
      const text = String(sql);
      events.push({ type: 'query', sql: text, params });
      if (/GET_LOCK/i.test(text)) {
        const key = String(params?.[0] || '');
        const denied = failLock && key.startsWith(failLock);
        return [[{ acquired: denied ? 0 : 1 }], []];
      }
      if (/information_schema\.columns/i.test(text)) {
        return [generatedColumn ? [{ 1: 1 }] : [], []];
      }
      if (/SELECT 1 AS conflict/i.test(text)) {
        const duplicate = /pan_card_number/i.test(text) ? panConflict : conflict;
        return [[duplicate ? { conflict: 1 } : null].filter(Boolean), []];
      }
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

const guardQueries = (database) => database.events.filter((event) => (
  event.type === 'query' && /SELECT 1 AS conflict/i.test(event.sql)
));
const lockNames = (database) => database.events
  .filter((event) => event.type === 'query' && /GET_LOCK/i.test(event.sql))
  .map((event) => String(event.params?.[0] || ''));

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
  // Still NOT a 409 — only the authoritative constraint maps to that. But the
  // raw mysql2 error is no longer rethrown verbatim: its message embeds the
  // rejected value, and logger.js renders every key with no redaction, so an
  // identity-writing statement must never let one escape. Client behaviour is
  // unchanged (a 500); only the log line loses the Aadhaar.
  const duplicateError = new Error("Duplicate entry '123456789012' for key 'some_other_unique'");
  duplicateError.code = 'ER_DUP_ENTRY';
  const database = identityDb({ failUpdate: duplicateError });

  await assert.rejects(
    identity.saveIdentityDetails(8379, { aadhaarNumber: '123456789012' }, { database }),
    (error) => (
      error.status === undefined
      && error.code === 'ER_DUP_ENTRY'
      && !error.message.includes('123456789012')
    ),
  );
});

test('rejects a duplicate Aadhaar before the UPDATE, without the DB index', async () => {
  // The production reality this guard exists for: uq_easyfixer_active_aadhaar
  // does not exist, so nothing downstream would have caught this.
  const database = identityDb({ conflict: true });

  await assert.rejects(
    identity.saveIdentityDetails(8379, { aadhaarNumber: '123456789012' }, { database }),
    (error) => (
      error.status === 409
      && error.details?.code === 'AADHAAR_ALREADY_REGISTERED'
      && !error.message.includes('123456789012')
    ),
  );

  assert.equal(
    database.events.some((event) => event.type === 'query' && /^\s*UPDATE tbl_easyfixer/i.test(event.sql)),
    false,
    'the write must never be attempted once a conflict is known',
  );
  assert.ok(database.events.some((event) => event.type === 'rollback'));
});

test('the duplicate guard matches the generated column semantics', async () => {
  const database = identityDb({ generatedColumn: false });
  await identity.saveIdentityDetails(8379, { aadhaarNumber: ' 123456789012 ' }, { database });

  const [guard] = guardQueries(database);
  assert.ok(guard, 'the guard query must run');
  // Soft-deleted rows do not reserve a number; TRIM/blank handled exactly as the
  // generated column does; self-exclusion by efr_id. Never widened to PAN.
  assert.match(guard.sql, /NOT \(efr_status <=> 3\)/i);
  assert.match(guard.sql, /NULLIF\(TRIM\(adhaar_card_number\), ''\) = \?/i);
  assert.match(guard.sql, /efr_id <> \?/i);
  assert.doesNotMatch(guard.sql, /pan_card_number/i);
  assert.deepEqual(guard.params, ['123456789012', 8379], 'value is trimmed, self excluded');
});

test('PAN guard normalizes case, ignores deleted rows, and excludes the current technician', async () => {
  const database = identityDb();
  await identity.saveIdentityDetails(8379, { panNumber: ' abcde1234f ' }, { database });

  const guard = guardQueries(database).find((event) => /pan_card_number/i.test(event.sql));
  assert.ok(guard, 'the PAN conflict read must run before the write');
  assert.match(guard.sql, /NOT \(efr_status <=> 3\)/i);
  assert.match(guard.sql, /NULLIF\(UPPER\(TRIM\(pan_card_number\)\), ''\) = \?/i);
  assert.match(guard.sql, /efr_id <> \?/i);
  assert.deepEqual(guard.params, ['ABCDE1234F', 8379]);

  const update = database.events.find((event) => (
    event.type === 'query' && /^\s*UPDATE tbl_easyfixer/i.test(event.sql)
  ));
  assert.equal(update.params[2], 'ABCDE1234F');
});

test('rejects a duplicate PAN before UPDATE without exposing the PAN', async () => {
  const database = identityDb({ panConflict: true });

  await assert.rejects(
    identity.saveIdentityDetails(8379, { panNumber: 'ABCDE1234F' }, { database }),
    (error) => (
      error.status === 409
      && error.code === 'PAN_ALREADY_REGISTERED'
      && error.details?.code === 'PAN_ALREADY_REGISTERED'
      && !error.message.includes('ABCDE1234F')
      && !String(error.stack || '').includes('ABCDE1234F')
    ),
  );

  assert.equal(
    database.events.some((event) => event.type === 'query' && /^\s*UPDATE tbl_easyfixer/i.test(event.sql)),
    false,
  );
  assert.ok(database.events.some((event) => event.type === 'rollback'));
});

test('maps an authoritative PAN UNIQUE race to the same redacted 409', async () => {
  const duplicateError = new Error(
    "Duplicate entry 'ABCDE1234F' for key 'uq_easyfixer_active_pan'",
  );
  duplicateError.code = 'ER_DUP_ENTRY';
  const database = identityDb({ failUpdate: duplicateError });

  await assert.rejects(
    identity.saveIdentityDetails(8379, { panNumber: 'ABCDE1234F' }, { database }),
    (error) => (
      error.status === 409
      && error.code === 'PAN_ALREADY_REGISTERED'
      && !error.message.includes('ABCDE1234F')
      && !String(error.stack || '').includes('ABCDE1234F')
    ),
  );
});

test('scrubs unknown duplicate-key errors from PAN-bearing writes', async () => {
  const duplicateError = new Error(
    "Duplicate entry 'ABCDE1234F' for key 'some_other_unique'",
  );
  duplicateError.code = 'ER_DUP_ENTRY';
  const database = identityDb({ failUpdate: duplicateError });

  await assert.rejects(
    identity.saveIdentityDetails(8379, { panNumber: 'ABCDE1234F' }, { database }),
    (error) => (
      error.status === undefined
      && error.code === 'ER_DUP_ENTRY'
      && !error.message.includes('ABCDE1234F')
      && !String(error.stack || '').includes('ABCDE1234F')
    ),
  );
});

test('same PAN submissions share a redacted value lock across technician ids', async () => {
  const first = identityDb();
  const second = identityDb();
  await identity.saveIdentityDetails(8379, { panNumber: 'abcde1234f' }, { database: first });
  await identity.saveIdentityDetails(9912, { panNumber: 'ABCDE1234F' }, { database: second });

  const firstLocks = lockNames(first);
  const secondLocks = lockNames(second);
  assert.match(firstLocks[0], /^efr_pan:[0-9a-f]{32}$/);
  assert.equal(firstLocks[0], secondLocks[0], 'case variants must contend on the same value lock');
  assert.equal(firstLocks[0].includes('ABCDE1234F'), false);
  assert.equal(firstLocks[1], 'efr_doc:8379');
  assert.equal(secondLocks[1], 'efr_doc:9912');
});

test('multi-field identity saves acquire Aadhaar then PAN then entity locks', async () => {
  const database = identityDb();
  await identity.saveIdentityDetails(8379, {
    aadhaarNumber: '123456789012',
    panNumber: 'ABCDE1234F',
  }, { database });

  const locks = lockNames(database);
  assert.match(locks[0], /^efr_aadhaar:[0-9a-f]{32}$/);
  assert.match(locks[1], /^efr_pan:[0-9a-f]{32}$/);
  assert.equal(locks[2], 'efr_doc:8379');
});

test('prefers the generated column when the migration has landed', async () => {
  const database = identityDb({ generatedColumn: true });
  await identity.saveIdentityDetails(8379, { aadhaarNumber: '123456789012' }, { database });

  const [guard] = guardQueries(database);
  assert.match(guard.sql, /active_aadhaar_unique = \?/i);
  assert.doesNotMatch(guard.sql, /NULLIF/i);
});

test('serialises on the Aadhaar VALUE, not just the technician row', async () => {
  const database = identityDb();
  await identity.saveIdentityDetails(8379, { aadhaarNumber: '123456789012' }, { database });

  const locks = lockNames(database);
  // Coarse value lock BEFORE the fine per-row lock: that ordering is what makes
  // the two named locks totally ordered and therefore deadlock-free.
  assert.equal(locks.length, 2);
  assert.match(locks[0], /^efr_aadhaar:[0-9a-f]{32}$/, 'value lock is a salted digest');
  assert.equal(locks[1], 'efr_doc:8379');
  assert.equal(
    locks[0].includes('123456789012'),
    false,
    'the Aadhaar value must never appear in a lock name — they are visible in SHOW PROCESSLIST',
  );
});

test('a doc-only save takes no value lock and runs no duplicate query', async () => {
  // Without the blank gates every doc-only save would hash the empty string to
  // one lock name and serialise the endpoint globally.
  const database = identityDb();
  await identity.saveIdentityDetails(8379, { docs: { pan: 'kyc/pan-key' } }, { database });

  assert.deepEqual(lockNames(database), ['efr_doc:8379']);
  assert.equal(guardQueries(database).length, 0);
});

test('PAN value-lock contention surfaces as the generic in-progress 409', async () => {
  const database = identityDb({ failLock: 'efr_pan:' });

  await assert.rejects(
    identity.saveIdentityDetails(8379, { panNumber: 'ABCDE1234F' }, { database }),
    (error) => error.status === 409 && error.details?.code === 'IDENTITY_UPDATE_IN_PROGRESS',
  );
});

test('value-lock contention surfaces as the generic in-progress 409', async () => {
  // Deliberately indistinguishable from the row-lock message: a distinct "that
  // Aadhaar is busy" reply would be a timing oracle.
  const database = identityDb({ failLock: 'efr_aadhaar:' });

  await assert.rejects(
    identity.saveIdentityDetails(8379, { aadhaarNumber: '123456789012' }, { database }),
    (error) => error.status === 409 && error.details?.code === 'IDENTITY_UPDATE_IN_PROGRESS',
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
        aadhaar_back_doc_id: 43,
        pan_doc_id: 42,
        dl_doc_id: 44,
        aadhaar_doc_key: 'MobileUploads/8379_1_front',
        aadhaar_back_doc_key: 'MobileUploads/8379_1_back',
        pan_doc_key: 'MobileUploads/8379_1_pan',
        dl_doc_key: 'MobileUploads/8379_1_dl',
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
    aadhaarBackDocId: 43,
    panDocId: 42,
    drivingLicenceDocId: 44,
    // S3 is unconfigured in the test process, so an S3-shaped key has no local
    // file behind it — null, never a fabricated link. Presigned variants are
    // covered in tests/mobile-identity-doc-urls.test.js.
    aadhaarFrontUrl: null,
    aadhaarBackUrl: null,
    panUrl: null,
    drivingLicenceUrl: null,
    isVerified: true,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [8379, 8379]);
  assert.match(calls[0].sql, /WHERE e\.efr_id = \?/i);
  assert.match(calls[0].sql, /WHERE efr_id = \?/i);
});

test('the prefill read selects EVERY doc type the save writes — 14 and 12 were written but never read', async () => {
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return [[{ identity_verified: 0 }], []];
    },
  };

  await identity.getIdentityDetails(8379, { database });

  const { sql } = calls[0];
  // Both halves matter: the id restores the app's document reference, the key
  // is what a URL can be minted from.
  assert.match(sql, /efr_doc_type_id = 14 THEN efr_doc_id END\) AS aadhaar_back_doc_id/i);
  assert.match(sql, /efr_doc_type_id = 14 THEN efr_document_name END\) AS aadhaar_back_doc_key/i);
  // Type 12 (Driving Licence) had the identical write-without-read gap.
  assert.match(sql, /efr_doc_type_id = 12 THEN efr_doc_id END\) AS dl_doc_id/i);
  assert.match(sql, /efr_doc_type_id = 12 THEN efr_document_name END\) AS dl_doc_key/i);
  for (const docType of [13, 3, 12]) {
    assert.match(
      sql,
      new RegExp(`efr_doc_type_id = ${docType} THEN efr_document_name END`, 'i'),
      `doc type ${docType} must also return its key`,
    );
  }
});
