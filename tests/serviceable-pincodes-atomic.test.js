const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pool } = require('../db');
const verification = require('../services/easyfixer-verification.service');

const originalGetConnection = pool.getConnection;

function connection({ resolved = ['110001', '110062'] } = {}) {
  const events = [];
  const conn = {
    async beginTransaction() { events.push({ type: 'begin' }); },
    async commit() { events.push({ type: 'commit' }); },
    async rollback() { events.push({ type: 'rollback' }); },
    release() { events.push({ type: 'release' }); },
    async query(sql, params) {
      events.push({ type: 'query', sql: String(sql), params });
      if (/^\s*SELECT (?:DISTINCT )?pincode FROM tbl_pincode/i.test(sql)) {
        return [resolved.map((pincode) => ({ pincode })), []];
      }
      return [{ affectedRows: 1 }, []];
    },
  };
  return { conn, events };
}

afterEach(() => { pool.getConnection = originalGetConnection; });

test('standalone replacement commits catalogue resolution, CSV write and activation together', async () => {
  const db = connection();
  pool.getConnection = async () => db.conn;

  const result = await verification.replaceServiceablePincodes(
    8379,
    ['110001', '110062'],
    null,
  );

  assert.deepEqual(result, { updated: 2 });
  assert.deepEqual(
    db.events
      .filter((event) => ['begin', 'commit', 'rollback', 'release'].includes(event.type))
      .map((event) => event.type),
    ['begin', 'commit', 'release'],
  );
  const writes = db.events.filter((event) => event.type === 'query').map((event) => event.sql);
  assert.ok(writes.some((sql) => /INSERT INTO tbl_efr_serviceable_pincodes/i.test(sql)));
  assert.ok(writes.some((sql) => /UPDATE tbl_pincode SET pincode_status = 1/i.test(sql)));
  const lookup = db.events.find((event) => /^\s*SELECT DISTINCT pincode FROM tbl_pincode/i.test(event.sql));
  assert.match(lookup.sql, /WHERE pincode_id IN/i, 'legacy CRM/default callers retain ID semantics');
  assert.doesNotMatch(lookup.sql, /\bOR\b/i);
});

test('standalone replacement rolls back instead of clearing when no pincode resolves', async () => {
  const db = connection({ resolved: [] });
  pool.getConnection = async () => db.conn;

  await assert.rejects(
    verification.replaceServiceablePincodes(8379, ['999999'], null),
    /No valid pincodes resolved/i,
  );
  assert.deepEqual(
    db.events
      .filter((event) => ['begin', 'commit', 'rollback', 'release'].includes(event.type))
      .map((event) => event.type),
    ['begin', 'rollback', 'release'],
  );
});

test('an externally supplied transaction is reused without begin, commit, or release', async () => {
  const db = connection({ resolved: ['110001'] });
  await verification.replaceServiceablePincodes(
    8379,
    ['110001'],
    { user_id: 77 },
    db.conn,
  );

  assert.equal(
    db.events.some((event) => ['begin', 'commit', 'rollback', 'release'].includes(event.type)),
    false,
  );
  const upsert = db.events.find((event) => (
    event.type === 'query' && /INSERT INTO tbl_efr_serviceable_pincodes/i.test(event.sql)
  ));
  assert.deepEqual(upsert.params, [8379, '110001', 77, 77]);
});

test('explicit value representation never collides with an unrelated numeric pincode id', async () => {
  const db = connection({ resolved: ['110001'] });
  await verification.replaceServiceablePincodes(
    8379,
    ['110001'],
    null,
    db.conn,
    { representation: 'value' },
  );

  const lookup = db.events.find((event) => /^\s*SELECT DISTINCT pincode FROM tbl_pincode/i.test(event.sql));
  assert.match(lookup.sql, /WHERE pincode IN/i);
  assert.doesNotMatch(lookup.sql, /pincode_id|\bOR\b/i);
  assert.deepEqual(lookup.params, ['110001']);

  const activation = db.events.find((event) => /UPDATE tbl_pincode SET pincode_status = 1/i.test(event.sql));
  assert.match(activation.sql, /WHERE pincode IN/i);
  assert.doesNotMatch(activation.sql, /pincode_id|\bOR\b/i);
  assert.deepEqual(activation.params, ['110001']);
});

test('mobile edit-profile route explicitly selects value representation', () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, '../routes/mobile/profile-extra.js'),
    'utf8',
  );
  assert.match(
    routeSource,
    /replaceServiceablePincodes\([\s\S]*?\{ representation: 'value' \}[\s\S]*?\);/,
  );
});
