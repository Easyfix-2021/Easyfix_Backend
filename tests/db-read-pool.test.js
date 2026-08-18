/*
 * The read pool must be an OPTIMISATION, never a DEPENDENCY.
 *
 * Two failure modes are pinned here, and they pull in opposite directions:
 *
 *   1. A replica outage must not blank the reports — reads fall back to the
 *      primary rather than throwing.
 *   2. A silent no-op is just as bad — if everything quietly falls back, the
 *      change moves no load while looking perfectly healthy. The counters are
 *      the only thing that distinguishes "unreachable" from "serving
 *      everything", because both leave a working application.
 *
 * Nothing is wired into a flow yet, so these test the layer directly.
 */
const test = require('node:test');
const assert = require('node:assert');

const OLD_ENV = { ...process.env };

/** Load db-read fresh with the given env — module state is per-instance. */
function loadWith(env) {
  for (const k of Object.keys(require.cache)) {
    if (/db-read\.js$|[/\\]db\.js$/.test(k)) delete require.cache[k];
  }
  Object.assign(process.env, env);
  const db = require('../db');
  const mod = require('../db-read');
  return { mod, db };
}

test.afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in OLD_ENV)) delete process.env[k];
  Object.assign(process.env, OLD_ENV);
});

test('with no DB_READ_HOST, reads go to the primary and nothing pretends otherwise', async () => {
  delete process.env.DB_READ_HOST;
  const { mod, db } = loadWith({});
  let asked = 0;
  db.pool.query = async () => { asked += 1; return [[{ ok: 1 }], []]; };

  const [rows] = await mod.readQuery('SELECT 1');
  assert.deepEqual(rows, [{ ok: 1 }]);
  assert.equal(asked, 1, 'the primary served it');

  const stats = mod.getReadPoolStats();
  assert.equal(stats.configured, false);
  assert.match(stats.note, /all reads use the primary/i);
});

test('a CONNECTION failure falls back to the primary and is counted', async () => {
  const { mod, db } = loadWith({ DB_READ_HOST: '10.0.0.1' });
  const err = new Error('connect ECONNREFUSED'); err.code = 'ECONNREFUSED';
  mod.readPool.query = async () => { throw err; };
  let primaryServed = 0;
  db.pool.query = async () => { primaryServed += 1; return [[{ ok: 1 }], []]; };

  const [rows] = await mod.readQuery('SELECT 1');
  assert.deepEqual(rows, [{ ok: 1 }], 'the caller still gets its data');
  assert.equal(primaryServed, 1);

  const s = mod.getReadPoolStats();
  assert.equal(s.fallbacks, 1);
  assert.equal(s.lastFallbackCode, 'ECONNREFUSED');
  assert.equal(s.reads.primary, 1);
  assert.equal(s.reads.replica, 0);
});

test('a genuine SQL error is NOT retried on the primary', async () => {
  // The whole safety property. Re-running a broken query on the primary fails
  // twice and doubles the load we are trying to shed.
  const { mod, db } = loadWith({ DB_READ_HOST: '10.0.0.1' });
  const err = new Error("Unknown column 'nope'"); err.code = 'ER_BAD_FIELD_ERROR';
  mod.readPool.query = async () => { throw err; };
  let primaryTouched = false;
  db.pool.query = async () => { primaryTouched = true; return [[], []]; };

  await assert.rejects(() => mod.readQuery('SELECT nope'), /Unknown column/);
  assert.equal(primaryTouched, false, 'the primary must never see a broken query twice');
  assert.equal(mod.getReadPoolStats().fallbacks, 0, 'a SQL error is not a fallback');
});

test('the breaker opens after repeated failures so a dead replica is not a latency tax', async () => {
  // Without this, every read pays the connect timeout before falling back —
  // making an outage SLOWER than having no replica at all.
  const { mod, db } = loadWith({ DB_READ_HOST: '10.0.0.1', DB_READ_BREAKER_THRESHOLD: '3' });
  const err = new Error('timeout'); err.code = 'ETIMEDOUT';
  let replicaAttempts = 0;
  mod.readPool.query = async () => { replicaAttempts += 1; throw err; };
  db.pool.query = async () => [[{ ok: 1 }], []];

  for (let i = 0; i < 3; i += 1) await mod.readQuery('SELECT 1');
  assert.equal(replicaAttempts, 3);
  assert.equal(mod.getReadPoolStats().breaker, 'open');

  // Further reads skip the replica entirely.
  for (let i = 0; i < 5; i += 1) await mod.readQuery('SELECT 1');
  assert.equal(replicaAttempts, 3, 'no further connect attempts while the breaker is open');
  assert.equal(mod.getReadPoolStats().reads.primary, 8);
});

test('a healthy replica serves reads, and the counter proves it', async () => {
  // This is the counter that answers "is the replica ever actually consumed?".
  const { mod, db } = loadWith({ DB_READ_HOST: '10.0.0.1' });
  mod.readPool.query = async () => [[{ ok: 1 }], []];
  db.pool.query = async () => { throw new Error('primary must not be touched'); };

  for (let i = 0; i < 4; i += 1) await mod.readQuery('SELECT 1');
  const s = mod.getReadPoolStats();
  assert.equal(s.reads.replica, 4);
  assert.equal(s.reads.primary, 0);
  assert.equal(s.fallbacks, 0);
  assert.equal(s.breaker, 'closed');
});

test('recovery closes the breaker and replica reads resume', async () => {
  const { mod, db } = loadWith({
    DB_READ_HOST: '10.0.0.1', DB_READ_BREAKER_THRESHOLD: '2', DB_READ_BREAKER_COOLDOWN_MS: '0',
  });
  const err = new Error('down'); err.code = 'ECONNREFUSED';
  let failing = true;
  mod.readPool.query = async () => { if (failing) throw err; return [[{ ok: 1 }], []]; };
  db.pool.query = async () => [[{ ok: 'primary' }], []];

  await mod.readQuery('SELECT 1');
  await mod.readQuery('SELECT 1');
  assert.ok(['open', 'half-open'].includes(mod.getReadPoolStats().breaker));

  failing = false;                       // cooldown is 0, so the next read probes
  const [rows] = await mod.readQuery('SELECT 1');
  assert.deepEqual(rows, [{ ok: 1 }], 'served by the replica again');
  assert.equal(mod.getReadPoolStats().breaker, 'closed');
});

test('identify() flags a replica that is really the primary under another name', async () => {
  // The silent no-op: reachable, correct, and shedding zero load.
  const { mod, db } = loadWith({ DB_READ_HOST: 'primary-alias' });
  mod.readPool.query = async () => [[{ serverId: 1, hostname: 'db-1', readOnly: 0 }], []];
  db.pool.query = async () => [[{ serverId: 1 }], []];

  const id = await mod.identify();
  assert.equal(id.distinctFromPrimary, false, 'same server_id must be reported, not hidden');
  assert.equal(mod.getReadPoolStats().distinctFromPrimary, false);
});

test('identify() confirms a genuinely separate server', async () => {
  const { mod, db } = loadWith({ DB_READ_HOST: '10.0.0.1' });
  mod.readPool.query = async () => [[{ serverId: 2, hostname: 'db-replica', readOnly: 1 }], []];
  db.pool.query = async () => [[{ serverId: 1 }], []];

  const id = await mod.identify();
  assert.equal(id.distinctFromPrimary, true);
  assert.equal(id.readOnly, 1);
});

test('verifyReadPool never throws, however broken the replica is', async () => {
  // Refusing to boot would reintroduce exactly the dependency this avoids.
  const { mod } = loadWith({ DB_READ_HOST: '10.0.0.1' });
  mod.readPool.query = async () => { const e = new Error('nope'); e.code = 'ENOTFOUND'; throw e; };
  assert.equal(await mod.verifyReadPool(), false, 'reports failure, does not throw');
});

test('connection-failure classification is narrow and deliberate', () => {
  const { mod } = loadWith({});
  for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST', 'ER_CON_COUNT_ERROR']) {
    assert.equal(mod.isConnectionFailure({ code }), true, `${code} should fall back`);
  }
  for (const code of ['ER_BAD_FIELD_ERROR', 'ER_PARSE_ERROR', 'ER_NO_SUCH_TABLE', 'ER_DUP_ENTRY']) {
    assert.equal(mod.isConnectionFailure({ code }), false, `${code} must NOT fall back`);
  }
  assert.equal(mod.isConnectionFailure({ fatal: true }), true, 'a fatal driver error falls back');
});
