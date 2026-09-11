/*
 * STOP ON THE QA REFRESH MUST NEVER EMPTY QA — services/qa-db-refresh.service.js.
 *
 * The job drops QA's database and restores it from a production dump. Its Stop
 * button (scheduler canceller → cancelRun) used to only kill whatever child
 * process was running. Pressed while none was — during the replica probe, while
 * verifying the dump — the run carried on into `DROP DATABASE … CREATE
 * DATABASE`, then aborted before the restore: QA left EMPTY, reported as
 * "stopped by operator". Reproduced by the 2026-09-11 review of the Stop-button
 * test, which certified this button at the scheduler level and could not see
 * inside it.
 *
 * So this drives the REAL runQaDbRefresh end to end, with every side effect
 * replaced: mysqldump/mysql are a fake execFile that records what the run
 * STARTED, the replica "probe" connects to a local listener, the maintenance
 * gate, database pool, email and properties are stubs, and dumps go to a temp
 * directory. Stop is pressed at each phase through the same progress hook the
 * Scheduled Jobs card reads. Nothing real is dumped, dropped or restored.
 *
 * The control — no Stop — must start dump, DROP and restore. Without it, "the
 * DROP never started" would pass for a harness that never reaches it.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const cp = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

const ROOT = path.join(__dirname, '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-refresh-stop-'));

let started = [];        // every tool the run started: 'dump' | 'drop' | 'restore'
let gate = [];           // maintenance.begin / maintenance.end, in order
let pressAtPhase = null; // Stop is pressed when the run reports this phase…
let pressWhile = null;   // …or while this tool is running
let svc;
let server;
const saved = { env: { ...process.env }, execFile: cp.execFile };

function fakeExecFile(bin, args, _opts, cb) {
  const kind = bin === 'mysqldump' ? 'dump' : (args.some((a) => /DROP DATABASE/.test(a)) ? 'drop' : 'restore');
  started.push(kind);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new Writable({ write(_c, _e, next) { next(); } });
  let settled = false;
  const finish = (err) => { if (!settled) { settled = true; cb(err || null); } };
  child.kill = () => setImmediate(() => finish(Object.assign(new Error('killed'), { killed: true })));
  setImmediate(() => {
    if (pressWhile === kind) svc.cancelRun();   // Stop pressed mid-tool: must kill it
    if (kind === 'dump') {
      child.stdout.end('CREATE TABLE t (id INT);\n-- Dump completed on 2026-09-11 00:31:00\n');
      setTimeout(() => finish(), 20);
    } else if (kind === 'restore') {
      child.stdin.on('finish', () => finish());
    } else {
      finish();
    }
  });
  return child;
}

function stub(rel, exports) {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

before(async () => {
  server = net.createServer((s) => s.destroy());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    ENVIRONMENT: 'qa',
    QA_DB_REFRESH_DIR: DIR, QA_DB_REFRESH_MIN_BYTES: '1', QA_DB_REFRESH_MIN_FREE_BYTES: '1', QA_DB_REFRESH_HOST: '',
    PROD_SLAVE_DB_HOST: '127.0.0.1', PROD_SLAVE_DB_PORT: String(server.address().port),
    PROD_SLAVE_DB_USER: 'ro', PROD_SLAVE_DB_PASSWORD: 'x', PROD_SLAVE_DB_NAME: 'easyfix',
    DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'qa', DB_PASSWORD: 'x', DB_NAME: 'easyfix_stop_test',
  });
  cp.execFile = fakeExecFile;      // captured by the service's destructuring at require time
  const quiet = new Proxy(function quiet() {}, { get: (_t, k) => (k === 'then' ? undefined : quiet), apply: () => quiet });
  stub('logger', quiet);
  stub('db', { pool: { query: async () => [[{ tables: 3 }], []] }, testConnection: async () => true });
  stub('services/email.service', { send: async () => ({}) });
  stub('services/properties.service', { getAllProperties: async () => ({}), parseEmailAllowlist: () => [], getProperty: () => '' });
  stub('middleware/maintenance', { begin: () => gate.push('begin'), end: () => gate.push('end'), isActive: () => false });
  stub('server/scheduler', { setJobProgress: (_id, text) => { if (text === pressAtPhase) svc.cancelRun(); } });
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'qa-db-refresh.service'))];
  svc = require('../services/qa-db-refresh.service');
});

after(() => {
  cp.execFile = saved.execFile;
  for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
  Object.assign(process.env, saved.env);
  server.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});

beforeEach(() => { started = []; gate = []; pressAtPhase = null; pressWhile = null; });

const leftovers = () => fs.readdirSync(DIR);

test('control: with no Stop the run dumps, DROPs and restores — the harness reaches the destructive step', async () => {
  const r = await svc.runQaDbRefresh();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(started, ['dump', 'drop', 'restore']);
  assert.deepEqual(gate, ['begin', 'end']);
  for (const f of leftovers()) fs.unlinkSync(path.join(DIR, f));   // the kept rollback copy
});

for (const [phase, label, expectStarted, expectGate] of [
  ['probing', 'Checking connectivity to the replica', [], []],
  ['verifying', 'Verifying the copy is complete', ['dump'], []],
  ['restoring', 'Restoring into QA', ['dump'], ['begin', 'end']],
]) {
  test(`Stop during '${phase}' — when no tool is running — never starts the DROP`, async () => {
    pressAtPhase = label;
    const r = await svc.runQaDbRefresh();
    assert.equal(r.cancelled, true, 'the run must report it was stopped');
    assert.equal(r.ok, false);
    assert.deepEqual(started, expectStarted, `after Stop nothing new may start — QA must be untouched (${phase})`);
    assert.ok(!started.includes('drop'), 'DROP DATABASE after a Stop leaves QA empty');
    assert.deepEqual(gate, expectGate, 'the maintenance gate, if raised, must be lowered again');
    assert.deepEqual(leftovers(), [], 'a stopped run leaves no dump behind');
  });
}

test('Stop while the dump is running kills it, and nothing destructive follows', async () => {
  pressWhile = 'dump';
  const r = await svc.runQaDbRefresh();
  assert.equal(r.cancelled, true);
  assert.deepEqual(started, ['dump']);
  assert.deepEqual(gate, []);
  assert.deepEqual(leftovers(), []);
});

test('a DRY RUN stopped while verifying reports stopped — not a success', async () => {
  pressAtPhase = 'Verifying the copy is complete';
  const r = await svc.runQaDbRefresh({ dryRun: true });
  assert.equal(r.ok, false, 'a stopped rehearsal must not claim the pipeline works');
  assert.equal(r.cancelled, true);
  assert.deepEqual(started, ['dump']);
});
