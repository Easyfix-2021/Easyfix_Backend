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
  identityRow = { efr_no: '9013877370', user_id: 8379, linked_user_id: 8379 },
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
      if (/SELECT e\.efr_no, e\.user_id, u\.user_id AS linked_user_id/i.test(sql)) {
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
  assert.deepEqual(createUser.params, ['9013877370', 19]);

  const link = queries.find((event) => /SET user_id = \?, update_date = NOW\(\)/i.test(event.sql));
  assert.ok(link, 'new user must be linked back to the locked easyfixer row');
  assert.deepEqual(link.params, [9001, 11179, null]);

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
    event.type === 'query' && /SET user_id = \?, update_date = NOW\(\)/i.test(event.sql)
  ));
  assert.deepEqual(link.params, [9001, 11179, 7777]);
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
