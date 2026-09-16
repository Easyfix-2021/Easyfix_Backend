const test = require('node:test');
const assert = require('node:assert/strict');

const registrationProfile = require('../services/technician-registration-profile.service');

const PIN_ROW = {
  pincode: '110001',
  city_id: 12,
  city_name: 'New Delhi',
  district: 'New Delhi',
  state_name: 'Delhi',
};

function transactionDb({
  pincodeRow = PIN_ROW,
  // efr_pin_no null = a technician with no home pincode yet, which is when
  // verify-otp is allowed to write one. Tests that want the write-once branch
  // override it.
  identityRow = { efr_no: '9013877370', user_id: 8379, linked_user_id: 8379, efr_pin_no: null },
} = {}) {
  const events = [];
  const conn = {
    async beginTransaction() { events.push({ type: 'begin' }); },
    async commit() { events.push({ type: 'commit' }); },
    async rollback() { events.push({ type: 'rollback' }); },
    release() { events.push({ type: 'release' }); },
    async query(sql, params) {
      events.push({ type: 'query', sql: String(sql), params });
      if (/FROM tbl_pincode p/i.test(sql)) return [pincodeRow ? [pincodeRow] : [], []];
      // Matched on the JOIN's alias, not the column list: pinning the exact
      // SELECT made this fixture fail with "object is not iterable" the moment a
      // column was added, which reads as a service bug rather than a stale fixture.
      if (/AS linked_user_id[\s\S]*FOR UPDATE/i.test(sql)) {
        return [identityRow ? [identityRow] : [], []];
      }
      if (/INSERT INTO tbl_user/i.test(sql)) return [{ insertId: 9001, affectedRows: 1 }, []];
      if (/UPDATE tbl_easyfixer_app/i.test(sql)) return [{ affectedRows: 0 }, []];
      return [{ affectedRows: 1 }, []];
    },
  };
  return {
    events,
    conn,
    getConnection: async () => conn,
  };
}

test('registration pincode resolution is exactly one indexed catalogue join', async () => {
  const calls = [];
  const runner = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return [[PIN_ROW], []];
    },
  };

  const location = await registrationProfile.resolvePincode('110001', runner);
  assert.deepEqual(location, {
    pincode: '110001',
    cityId: 12,
    city: 'New Delhi',
    district: 'New Delhi',
    state: 'Delhi',
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE p\.pincode = \?/i);
  assert.deepEqual(calls[0].params, ['110001']);
  assert.doesNotMatch(calls[0].sql, /COUNT|FIND_IN_SET|tbl_easyfixer/i,
    'pre-login lookup must not compute technician or zone availability');
});

test('verified profile atomically updates both location stores and first-touch metadata', async () => {
  const db = transactionDb();
  const result = await registrationProfile.persistVerifiedProfile(11179, {
    homePincode: '110001',
    referralSource: 'Existing EasyFix technician',
    language: 'English',
  }, db);

  assert.equal(result.location.city, 'New Delhi');
  assert.equal(result.language, 'English');
  const queries = db.events.filter((event) => event.type === 'query');
  assert.ok(queries.some((event) => /UPDATE tbl_easyfixer SET efr_pin_no = \?, efr_cityId = \?/i.test(event.sql)));
  assert.ok(queries.some((event) => /UPDATE tbl_user SET pin_code = \?, city = \?, state = \?/i.test(event.sql)));
  const attribution = queries.find((event) => /INSERT INTO tbl_easyfixer_registration_attribution/i.test(event.sql));
  assert.ok(attribution, 'referral must use the additive attribution table');
  assert.match(attribution.sql, /ON DUPLICATE KEY UPDATE referral_source = referral_source/i,
    'a repeat login must not overwrite the original referral');
  // db.js pool binds a Date as the IST wall clock; SQL NOW() takes the DB
  // session's own (SYSTEM) zone. captured_at is DATETIME (2026-09-16).
  assert.doesNotMatch(attribution.sql, /NOW\(\)/, 'captured_at must not be SQL NOW()');
  assert.ok(attribution.params[2] instanceof Date, 'captured_at is the third bound value');
  assert.ok(queries.some((event) => /UPDATE tbl_easyfixer_app SET language = \?/i.test(event.sql)),
    'language must use the canonical tbl_easyfixer_app writer');
  assert.equal(queries.some((event) => /INSERT INTO tbl_user/i.test(event.sql)), false,
    'a valid existing user link must be preserved without another user row');
  assert.deepEqual(
    db.events.filter((event) => ['begin', 'commit', 'rollback', 'release'].includes(event.type)).map((event) => event.type),
    ['begin', 'commit', 'release'],
  );
});

test('verified Home PIN atomically repairs a missing legacy tbl_user link', async () => {
  const db = transactionDb({
    identityRow: { efr_no: '9013877370', user_id: null, linked_user_id: null },
  });

  await registrationProfile.persistVerifiedProfile(11179, {
    homePincode: '110001',
  }, db);

  const queries = db.events.filter((event) => event.type === 'query');
  const createUser = queries.find((event) => /INSERT INTO tbl_user/i.test(event.sql));
  assert.ok(createUser, 'missing link must create the shared canonical user row');
  // tbl_user.insert_date is TIMESTAMP, converted the same as a DATETIME
  // column (2026-09-16): a bound Date, never SQL NOW().
  assert.doesNotMatch(createUser.sql, /NOW\(\)/, 'insert_date must not be SQL NOW()');
  assert.ok(createUser.params[2] instanceof Date, 'insert_date is the third bound value');
  assert.deepEqual(createUser.params.slice(0, 2), ['9013877370', 19]);

  const link = queries.find((event) => /SET user_id = \?, update_date = \?/i.test(event.sql));
  assert.ok(link, 'new user must be linked back to the locked easyfixer row');
  // db.js pool binds a Date as the IST wall clock; SQL NOW() takes the DB
  // session's own (SYSTEM) zone. tbl_easyfixer.update_date is TIMESTAMP,
  // converted the same as a DATETIME column (2026-09-16).
  assert.doesNotMatch(link.sql, /NOW\(\)/, 'update_date must not be SQL NOW()');
  assert.ok(link.params[1] instanceof Date, 'update_date is the second bound value');
  assert.deepEqual([link.params[0], ...link.params.slice(2)], [9001, 11179, null]);

  const userLocation = queries.find((event) => /UPDATE tbl_user SET pin_code/i.test(event.sql));
  assert.equal(userLocation.params[3], 9001, 'location must target the repaired user row');
  assert.deepEqual(
    db.events
      .filter((event) => ['begin', 'commit', 'rollback', 'release'].includes(event.type))
      .map((event) => event.type),
    ['begin', 'commit', 'release'],
  );
});

test('a dangling legacy user id is replaced in the same repair transaction', async () => {
  const db = transactionDb({
    identityRow: { efr_no: '9013877370', user_id: 7777, linked_user_id: null },
  });

  await registrationProfile.persistVerifiedProfile(11179, { homePincode: '110001' }, db);
  const link = db.events.find((event) => (
    event.type === 'query' && /SET user_id = \?, update_date = \?/i.test(event.sql)
  ));
  assert.ok(link.params[1] instanceof Date, 'update_date is the second bound value');
  assert.deepEqual([link.params[0], ...link.params.slice(2)], [9001, 11179, 7777]);
});

test('unknown pincode rolls back before either legacy profile table is changed', async () => {
  const db = transactionDb({ pincodeRow: null });
  await assert.rejects(
    registrationProfile.persistVerifiedProfile(11179, { homePincode: '999999' }, db),
    (err) => err.status === 422,
  );

  const sql = db.events.filter((event) => event.type === 'query').map((event) => event.sql).join('\n');
  assert.doesNotMatch(sql, /UPDATE tbl_easyfixer SET/i);
  assert.doesNotMatch(sql, /UPDATE tbl_user SET/i);
  assert.deepEqual(
    db.events.filter((event) => ['begin', 'commit', 'rollback', 'release'].includes(event.type)).map((event) => event.type),
    ['begin', 'rollback', 'release'],
  );
});

test('legacy clients with no registration metadata allocate no connection and perform no write', async () => {
  const result = await registrationProfile.persistVerifiedProfile(11179, {}, {
    getConnection: async () => { throw new Error('must not acquire'); },
  });
  assert.deepEqual(result, { location: null, language: null });
});

test('a verify named-lock connection is reused and never released by profile persistence', async () => {
  const db = transactionDb();
  await registrationProfile.persistVerifiedProfile(11179, { homePincode: '110001' }, db.conn);
  assert.equal(db.events.some((event) => event.type === 'release'), false,
    'the named-lock owner must remain responsible for releasing its connection');
  assert.deepEqual(
    db.events.filter((event) => ['begin', 'commit', 'rollback'].includes(event.type)).map((event) => event.type),
    ['begin', 'commit'],
  );
});

/*
 * WRITE-ONCE, the verify-otp half. persistPersonalDetails gained this guard on
 * 2026-09-07; this hook runs on EVERY verify, so without the same guard any later
 * verification carrying a different PIN silently relocated the technician — the
 * one path that could still undo the fix in the other file.
 */
test('verify-otp never relocates a technician who already has a home pincode', async () => {
  const { events, getConnection } = transactionDb({
    identityRow: { efr_no: '9013877370', user_id: 8379, linked_user_id: 8379, efr_pin_no: '560001' },
  });

  await registrationProfile.persistVerifiedProfile(4242, { homePincode: '110001' }, { getConnection });

  const located = events.filter((e) => /SET efr_pin_no|SET pin_code/i.test(e.sql));
  assert.deepEqual(located, [],
    'a stored home pincode must survive a verify carrying a different one');
});

test('verify-otp still backfills when the stored home is empty, and when it is unchanged', async () => {
  for (const stored of [null, '', '110001']) {
    const { events, getConnection } = transactionDb({
      identityRow: { efr_no: '9013877370', user_id: 8379, linked_user_id: 8379, efr_pin_no: stored },
    });

    await registrationProfile.persistVerifiedProfile(4242, { homePincode: '110001' }, { getConnection });

    const located = events.filter((e) => /SET efr_pin_no|SET pin_code/i.test(e.sql));
    assert.equal(located.length, 2,
      `stored=${JSON.stringify(stored)} must still write both location stores — `
      + 're-sending the same PIN is how a row with efr_cityId 0 gets repaired');
  }
});
