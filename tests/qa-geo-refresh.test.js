/*
 * QA location-tables refresh (services/qa-geo-refresh.service.js).
 *
 * Fake connections only — nothing connects to a database, nothing is copied.
 * Each fake records every statement (plus BEGIN/COMMIT/ROLLBACK/END) in order,
 * so the tests assert on the exact sequence QA would have received.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Outcome email + its recipient lookup would reach SMTP / the properties table.
const emailSvc = require('../services/email.service');
const properties = require('../services/properties.service');
const sent = [];
emailSvc.send = async (m) => { sent.push(m); return { delivered: true }; };
properties.getAllProperties = async () => ({});
properties.parseEmailAllowlist = () => ['ops@example.test'];

const geo = require('../services/qa-geo-refresh.service');

const GOOD_ENV = {
  ENVIRONMENT: 'qa',
  PROD_SLAVE_DB_HOST: '10.30.3.73', PROD_SLAVE_DB_PORT: '3306',
  PROD_SLAVE_DB_USER: 'easyfix_ro', PROD_SLAVE_DB_PASSWORD: 'x', PROD_SLAVE_DB_NAME: 'easyfix',
  DB_HOST: '10.30.2.30', DB_PORT: '3306', DB_USER: 'easyfix_qa', DB_PASSWORD: 'x', DB_NAME: 'easyfix',
  QA_DB_REFRESH_HOST: '',
};
async function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries({ ...GOOD_ENV, ...overrides })) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// handler(sql, params) → rows (or throws). Unmatched → [].
function fakeConn(handler = () => []) {
  const log = [];
  const rec = (s) => { log.push(s); };
  return {
    log,
    query: async (sql, params) => { rec(sql); return [await handler(sql, params) ?? [], []]; },
    beginTransaction: async () => rec('BEGIN'),
    commit: async () => rec('COMMIT'),
    rollback: async () => rec('ROLLBACK'),
    end: async () => rec('END'),
  };
}

const col = (name, extra = '', colKey = '') => ({ name, extra, colKey });
const plansFor = (tables) => tables.map((t) => ({ table: t, pk: 'id', columns: ['id', 'name'] }));

beforeEach(() => { sent.length = 0; });

// ─── Guards ────────────────────────────────────────────────────────────────

test('GUARD: refuses a non-qa ENVIRONMENT before opening any connection', async () => {
  let connects = 0;
  const r = await withEnv({ ENVIRONMENT: 'production' },
    () => geo.runQaGeoRefresh({ connect: async () => { connects += 1; return fakeConn(); } }));
  assert.equal(r.ok, false);
  assert.match(r.error, /ENVIRONMENT/);
  assert.equal(connects, 0);
  assert.match(sent[0].subject, /FAILED/);
});

test('GUARD: refuses when source and target are the same server', async () => {
  let connects = 0;
  const r = await withEnv({ DB_HOST: GOOD_ENV.PROD_SLAVE_DB_HOST },
    () => geo.runQaGeoRefresh({ connect: async () => { connects += 1; return fakeConn(); } }));
  assert.equal(r.ok, false);
  assert.match(r.error, /same server/);
  assert.equal(connects, 0);
});

// ─── Column intersection ───────────────────────────────────────────────────

test('planTable copies only the non-generated intersection, in replica order', () => {
  const src = [
    col('pincode_id', 'auto_increment', 'PRI'), col('pincode'), col('prod_only'),
    col('city_id'), col('v', 'VIRTUAL GENERATED'), col('created_on', 'DEFAULT_GENERATED'),
  ];
  const dst = [
    col('pincode_id', 'auto_increment', 'PRI'), col('city_id'), col('pincode'),
    col('created_by_type'), col('coords_geocoded_at'), col('v', 'STORED GENERATED'), col('created_on', 'DEFAULT_GENERATED'),
  ];
  assert.deepEqual(geo.planTable('tbl_pincode', src, dst), {
    table: 'tbl_pincode', pk: 'pincode_id', columns: ['pincode_id', 'pincode', 'city_id', 'created_on'],
  });
});

test('planTable refuses a missing table or a composite primary key', () => {
  assert.throws(() => geo.planTable('tbl_city', [], [col('id', '', 'PRI')]), /replica/);
  assert.throws(() => geo.planTable('tbl_city', [col('a', '', 'PRI'), col('b', '', 'PRI')], [col('a'), col('b')]), /single-column/);
});

// ─── Keyset batching ───────────────────────────────────────────────────────

test('readBatches reads every row across multiple keyset batches', async () => {
  const ids = [3, 7, 9, 12, 20];
  const conn = fakeConn((sql, params) => {
    const [after, limit] = /WHERE/.test(sql) ? params : [-Infinity, params[0]];
    return ids.filter((i) => i > after).slice(0, limit).map((id) => ({ id, name: `n${id}` }));
  });
  const batches = [];
  for await (const rows of geo.readBatches(conn, { table: 'tbl_city', pk: 'id', columns: ['id', 'name'] }, 2)) {
    batches.push(rows.map((r) => r.id));
  }
  assert.deepEqual(batches, [[3, 7], [9, 12], [20]]);
  assert.equal(conn.log.length, 3);
  assert.match(conn.log[0], /^SELECT `id`, `name` FROM `tbl_city` ORDER BY `id` LIMIT \?$/);
  assert.match(conn.log[1], /WHERE `id` > \? ORDER BY `id` LIMIT \?$/);
});

// ─── Preflight floor ───────────────────────────────────────────────────────

const OK_COUNTS = { tbl_state: 36, tbl_city: 900, tbl_zone_master: 25, tbl_pincode: 22000, tbl_zone_pincode_mapping: 155000 };

test('checkCounts refuses a thin tbl_pincode and any empty table', () => {
  assert.doesNotThrow(() => geo.checkCounts(OK_COUNTS, 'x'));
  assert.throws(() => geo.checkCounts({ ...OK_COUNTS, tbl_pincode: geo.MIN_SOURCE_PINCODES - 1 }, 'x'), /floor/);
  assert.throws(() => geo.checkCounts({ ...OK_COUNTS, tbl_zone_master: 0 }, 'x'), /0 rows in tbl_zone_master/);
});

test('preflight refusal on the replica never sends QA a DELETE', async () => {
  const cols = [col('id', '', 'PRI'), col('name')];
  const source = fakeConn((sql) => {
    if (/information_schema/.test(sql)) return cols;
    if (/COUNT\(\*\) AS n FROM `tbl_pincode`/.test(sql)) return [{ n: 11 }];
    if (/COUNT/.test(sql)) return [{ n: 50 }];
    return [];
  });
  const target = fakeConn((sql) => (/information_schema/.test(sql) ? cols : []));
  const conns = [source, target];
  const r = await withEnv({}, () => geo.runQaGeoRefresh({ connect: async () => conns.shift() }));
  assert.equal(r.ok, false);
  assert.match(r.error, /floor/);
  assert.ok(!target.log.some((s) => /DELETE|INSERT|FOREIGN_KEY/.test(s)), target.log.join('\n'));
  assert.equal(target.log.at(-1), 'END');
  assert.match(source.log.find((s) => /START TRANSACTION/.test(s)), /CONSISTENT SNAPSHOT, READ ONLY/);
});

// ─── Delete / insert order ─────────────────────────────────────────────────

function sourceWith(counts) {
  return fakeConn((sql, params) => {
    const table = /FROM `(\w+)`/.exec(sql)[1];
    const after = /WHERE/.test(sql) ? params[0] : 0;
    const n = counts[table];
    const out = [];
    for (let id = after + 1; id <= n && out.length < params.at(-1); id += 1) out.push({ id, name: `${table}-${id}` });
    return out;
  });
}

test('copyTables deletes children-first, inserts parents-first, in one transaction', async () => {
  const target = fakeConn();
  const counts = { ...OK_COUNTS, tbl_pincode: geo.MIN_SOURCE_PINCODES, tbl_zone_pincode_mapping: 3 };
  const copied = await geo.copyTables(sourceWith(counts), target, plansFor(geo.TABLES));
  assert.deepEqual(copied, counts);

  const log = target.log;
  assert.equal(log[0], 'SET FOREIGN_KEY_CHECKS = 0');
  assert.equal(log[1], 'BEGIN');
  const deletes = log.filter((s) => s.startsWith('DELETE')).map((s) => /`(\w+)`/.exec(s)[1]);
  assert.deepEqual(deletes, [...geo.TABLES].reverse());
  const firstInsertOf = (t) => log.findIndex((s) => s.startsWith(`INSERT INTO \`${t}\``));
  const inserts = geo.TABLES.map(firstInsertOf);
  assert.deepEqual([...inserts].sort((a, b) => a - b), inserts, 'inserts are parents-first');
  assert.ok(Math.max(...log.map((s, i) => (s.startsWith('DELETE') ? i : -1))) < inserts[0], 'all deletes precede inserts');
  assert.match(log.find((s) => s.startsWith('INSERT')), /^INSERT INTO `tbl_state` \(`id`, `name`\) VALUES \?$/);
  assert.deepEqual(log.slice(-2), ['COMMIT', 'SET FOREIGN_KEY_CHECKS = 1']);
});

// ─── Rollback ──────────────────────────────────────────────────────────────

test('a failing insert rolls back, never commits, and restores FOREIGN_KEY_CHECKS = 1', async () => {
  const target = fakeConn((sql) => {
    if (sql.startsWith('INSERT INTO `tbl_pincode`')) throw new Error('Data too long for column');
    return [];
  });
  await assert.rejects(geo.copyTables(sourceWith(OK_COUNTS), target, plansFor(geo.TABLES)), /Data too long/);
  assert.ok(!target.log.includes('COMMIT'));
  assert.deepEqual(target.log.slice(-2), ['ROLLBACK', 'SET FOREIGN_KEY_CHECKS = 1']);
});

test('a copy that reads 0 rows for a table rolls back instead of committing', async () => {
  const target = fakeConn();
  await assert.rejects(
    geo.copyTables(sourceWith({ ...OK_COUNTS, tbl_city: 0 }), target, plansFor(geo.TABLES)),
    /0 rows in tbl_city/,
  );
  assert.deepEqual(target.log.slice(-2), ['ROLLBACK', 'SET FOREIGN_KEY_CHECKS = 1']);
});

// ─── Dangling report ───────────────────────────────────────────────────────

test('danglingReport query shapes and exact serviceable-PIN count', async () => {
  const conn = fakeConn((sql) => {
    if (/FROM tbl_easyfixer/.test(sql)) return [{ n: 4 }];
    if (/FROM tbl_client/.test(sql)) return [{ n: 2 }];
    if (/FROM tbl_pincode/.test(sql)) return [{ pincode: '110001' }, { pincode: 122001 }];
    if (/FROM tbl_efr_serviceable_pincodes/.test(sql)) return [{ pincodes: '110001, 999999,122001' }, { pincodes: '999999,888888' }];
    return [];
  });
  assert.deepEqual(await geo.danglingReport(conn), {
    easyfixerCityMissing: 4, clientCityMissing: 2, serviceablePincodesMissing: 2,
  });
  assert.match(conn.log[0], /tbl_easyfixer e WHERE e\.efr_cityId IS NOT NULL AND e\.efr_cityId <> 0 AND NOT EXISTS \(SELECT 1 FROM tbl_city c WHERE c\.city_id = e\.efr_cityId\)/);
  assert.match(conn.log[1], /tbl_client cl WHERE .*NOT EXISTS \(SELECT 1 FROM tbl_city c WHERE c\.city_id = cl\.client_city_id\)/);
  assert.ok(conn.log.every((s) => /^SELECT/.test(s)), 'report is read-only');
});

// ─── End to end with fakes ─────────────────────────────────────────────────

test('happy path returns per-table counts + dangling and emails success', async () => {
  const cols = [col('id', '', 'PRI'), col('name')];
  const counts = { ...OK_COUNTS, tbl_pincode: geo.MIN_SOURCE_PINCODES, tbl_zone_pincode_mapping: 3 };
  const inner = sourceWith(counts);
  const source = fakeConn((sql, params) => {
    if (/information_schema/.test(sql)) return cols;
    if (/COUNT\(\*\)/.test(sql)) return [{ n: counts[/`(\w+)`/.exec(sql)[1]] }];
    if (/^SELECT `id`/.test(sql)) return inner.query(sql, params).then(([rows]) => rows);
    return [];
  });
  const target = fakeConn((sql) => {
    if (/information_schema/.test(sql)) return cols;
    if (/COUNT\(\*\) AS n/.test(sql)) return [{ n: 0 }];
    return [];
  });
  const conns = [source, target];
  const r = await withEnv({}, () => geo.runQaGeoRefresh({ connect: async () => conns.shift() }));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.tables, counts);
  assert.deepEqual(r.dangling, { easyfixerCityMissing: 0, clientCityMissing: 0, serviceablePincodesMissing: 0 });
  assert.equal(typeof r.durationMs, 'number');
  assert.equal(source.log.at(-1), 'END');
  assert.equal(target.log.at(-1), 'END');
  assert.match(sent[0].subject, /refreshed/);
});
