/*
 * EVERY STOP BUTTON, PRESSED — server/scheduler.js.
 *
 * The Scheduled Jobs page shows Stop for a job when getJobs() reports
 * cancellable:true. That promise has two halves, and either half alone is a
 * button that does nothing:
 *   - a job with a `canceller` is interrupted for real — requestCancel() must
 *     reach that canceller while the job runs;
 *   - a job with `cooperativeCancel` polls isCancelRequested() — its runner must
 *     hand the work a checkpoint that turns true when THIS job's Stop is
 *     pressed, not some other job's.
 *
 * THE JOBS ARE NOT LISTED HERE. The real init() runs, and every job getJobs()
 * calls cancellable is started with Trigger Now and has Stop pressed mid-run.
 * A job added tomorrow with cooperativeCancel:true and no checkpoint fails this
 * file without anyone editing it. (e18669a shipped exactly that shape of bug:
 * registerJob dropped cooperativeCancel, so no polling job had a Stop button,
 * while a test that matched source text passed.)
 *
 * NOTHING REAL CAN RUN. Every require() the scheduler makes — each service, the
 * DB-backed properties service, node-cron, the logger — resolves to an inert
 * stub, and CRON_DISABLED keeps init() from scheduling anything. That matters:
 * one of these jobs DROPs a database.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'server', 'scheduler.js');

/* A callable that returns itself for any property or call: the logger. */
const quiet = new Proxy(function quiet() {}, {
  get: (_t, p) => (p === 'then' ? undefined : quiet),
  apply: () => quiet,
});

let onCall = null;   // per-run hook: sees every call the scheduler makes into a stub

function loadScheduler() {
  const stub = (id) => new Proxy({}, {
    get(_t, fn) {
      if (typeof fn === 'symbol' || fn === 'then' || fn === '__esModule') return undefined;
      return (...args) => (onCall ? onCall({ call: `${id}.${fn}`, args }) : undefined);
    },
  });
  const requireStub = (id) => (id === '../logger' ? quiet : stub(id));
  const src = fs.readFileSync(FILE, 'utf8');
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) {${src}\n})`, { filename: FILE });
  const mod = { exports: {} };
  wrapper(mod.exports, requireStub, mod, FILE, path.dirname(FILE));
  return mod.exports;
}

let sched;
let jobs;

before(() => {
  const saved = process.env.CRON_DISABLED;
  process.env.CRON_DISABLED = 'true';
  try {
    sched = loadScheduler();
    sched.init();
  } finally {
    if (saved === undefined) delete process.env.CRON_DISABLED; else process.env.CRON_DISABLED = saved;
  }
  jobs = sched.getJobs();
});

const checkpointsIn = (args) => args.flatMap((a) =>
  (a && typeof a === 'object' && typeof a.shouldStop === 'function' ? [a.shouldStop] : []));

/*
 * Run a job with Trigger Now. `pressAt(i, checkpoints)` decides, per stubbed
 * call, whether to press Stop there. Returns what was observed.
 */
async function run(id, pressAt = () => false) {
  const seen = { calls: [], checkpoints: [], press: null, before: [], after: [], byCanceller: [] };
  let pressed = false;
  onCall = ({ call, args }) => {
    seen.calls.push(call);
    const cps = checkpointsIn(args);
    seen.checkpoints.push(...cps);
    if (!pressed && pressAt(seen.calls.length - 1, cps)) {
      pressed = true;
      seen.before = seen.checkpoints.map((f) => f());
      const n = seen.calls.length;
      seen.press = sched.requestCancel(id);       // the Stop button's route calls exactly this
      seen.byCanceller = seen.calls.slice(n);      // calls the press itself caused
      seen.after = seen.checkpoints.map((f) => f());
    }
    return undefined;
  };
  // A stub returns nothing, so a runner may throw after its first call. That is
  // not what is under test; the job's running/cancel state is.
  try { await sched.triggerJob(id); } catch { /* see above */ } finally { onCall = null; }
  return seen;
}

test('init() really ran — positive control on the job list', () => {
  assert.ok(jobs.length >= 20, `expected the full job list, got ${jobs.length}`);
  const ids = jobs.filter((j) => j.cancellable).map((j) => j.id);
  assert.ok(ids.length >= 2, `expected at least the two backfills to offer Stop, got [${ids}]`);
});

test('every job that offers Stop actually stops when it is pressed mid-run', async (t) => {
  const cancellable = jobs.filter((j) => j.cancellable);
  const report = [];
  for (const { id } of cancellable) {
    // 1. Observe, without pressing: which call, if any, hands the work a checkpoint?
    let cpIdx = -1;
    const dry = await run(id, (i, cps) => { if (cps.length && cpIdx < 0) cpIdx = i; return false; });
    assert.ok(dry.calls.length > 0, `${id}: made no call Stop could be pressed during`);

    // 2. Press Stop there — or, with no checkpoint, at the first call: a
    //    canceller job is interrupted whatever it is doing.
    const pressIdx = cpIdx >= 0 ? cpIdx : 0;
    const s = await run(id, (i) => i === pressIdx);
    assert.ok(s.press && s.press.cancelled === true, `${id}: Stop was refused mid-run — ${JSON.stringify(s.press)}`);

    if (s.checkpoints.length) {
      // Jobs run in turn and a pressed flag stays set after its run, so a
      // checkpoint polling ANOTHER job's id usually fails here, not below.
      assert.ok(s.before.every((v) => v === false),
        `${id}: its checkpoint read "stop" BEFORE its own Stop was pressed — it polls another job's id, or is always true`);
      assert.ok(s.after.every((v) => v === true),
        `${id}: pressing ITS Stop did not flip its checkpoint — is it polling another job's id?`);
      report.push(`${id}: checkpoint`);
    } else {
      assert.equal(s.press.immediate, true,
        `${id}: offers Stop but hands its work no checkpoint and has no canceller`);
      assert.ok(s.byCanceller.length > 0,
        `${id}: its canceller touched nothing, so it cannot have stopped anything`);
      // It must reach something that cancels, not merely something — wired to
      // e.g. runQaDbRefresh it would START work instead. What the cancel then
      // does is the service's to prove: tests/qa-db-refresh-stop.test.js presses
      // this job's Stop at every phase against the real run.
      assert.ok(s.byCanceller.some((c) => /cancel|abort|stop|kill/i.test(c.split('.').pop())),
        `${id}: its canceller called ${s.byCanceller.join(', ')} — none of which is a cancel`);
      report.push(`${id}: canceller → ${s.byCanceller.join(', ')}`);
    }
  }
  assert.equal(report.length, cancellable.length);
  t.diagnostic(`Stop pressed on ${report.length} job(s): ${report.join(' | ')}`);
});

test('every checkpoint in the scheduler belongs to a job that offers Stop', () => {
  // The reverse half. A job that polls isCancelRequested('x') but is not
  // cancellable has a checkpoint nobody can ever trip.
  const src = fs.readFileSync(FILE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const polled = [...src.matchAll(/isCancelRequested\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.ok(polled.length >= 2, `positive control: expected the backfills' checkpoints, found [${polled}]`);
  const offered = new Set(jobs.filter((j) => j.cancellable).map((j) => j.id));
  for (const id of polled) {
    assert.ok(offered.has(id), `${id} polls isCancelRequested() but getJobs() offers it no Stop button`);
  }
});
