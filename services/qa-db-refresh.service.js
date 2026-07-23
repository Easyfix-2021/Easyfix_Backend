/*
 * QA database refresh from PRODUCTION — scheduled 1st + 16th at 00:30 IST.
 *
 * QA's data drifts away from production, so bugs that only appear on real data
 * can't be reproduced. This reloads QA from prod twice a month and emails the
 * outcome.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NON-NEGOTIABLE: PRODUCTION MUST BE UNAFFECTED.
 *
 * 1. WE DUMP THE REPLICA, NEVER THE PRIMARY. `PROD_SLAVE_DB_HOST` is the read
 *    replica, so the primary's query path is entirely outside the blast radius.
 *    The only cost is brief replication lag on a box nothing user-facing reads.
 *
 * 2. THE CREDENTIALS ARE THE REAL GUARANTEE, NOT THIS CODE. The MySQL user must
 *    be granted SELECT, SHOW VIEW, TRIGGER and nothing else, host-restricted to
 *    the QA box. Flags can be edited by anyone; a grant cannot. Even a total
 *    logic bug here then cannot mutate production.
 *
 * 3. THE mysqldump FLAGS ARE CHOSEN TO TAKE NO LOCKS. `--single-transaction`
 *    gives an InnoDB MVCC snapshot with no table locks; `--quick` streams rows
 *    instead of buffering a table in RAM on either end. We explicitly do NOT
 *    pass --master-data/--source-data (needs RELOAD and takes a brief GLOBAL
 *    lock), --lock-all-tables or --flush-logs, and we never STOP REPLICA.
 *    They are also restricted to options BOTH the MySQL and MariaDB clients
 *    accept — see dumpFromReplica(), the image ships MariaDB's dumper.
 *
 * 4. THE SNAPSHOT IS TIME-BOUNDED. --single-transaction holds one long
 *    REPEATABLE READ open, and InnoDB must retain undo history for its whole
 *    life. A hung dump would grow the undo tablespace and slow purge on the
 *    replica, so the dump is killed at DUMP_TIMEOUT_MS rather than left to hang.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * TWO HARD GUARDS run BEFORE anything destructive (see assertSafeToRun):
 *   - ENVIRONMENT must be 'qa'. The SAME image runs in production
 *     (deploy/docker-compose.prod-backend.yml) — this is what stops a prod
 *     backend from ever dropping its own database.
 *   - The restore target must be the configured QA host AND must differ from the
 *     dump source, so a config typo cannot point the restore at production.
 * Neither is overridable.
 *
 * Both guards protect PRODUCTION. Protecting real customers from a QA test run
 * is a separate concern and lives one layer down, at each send site's
 * TEST_MOBILE / TEST_FCM_TOKEN redirect — see the note in assertSafeToRun().
 *
 * RESTORE MODEL: this runs INSIDE the backend container, so it cannot stop that
 * container to take traffic offline. Instead it raises the in-process
 * maintenance gate (middleware/maintenance.js) for the restore window. See that
 * file for why /api/health stays exempt.
 */

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fssync = require('fs');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');

const logger = require('../logger');
const { pool, testConnection } = require('../db');
const email = require('./email.service');
const properties = require('./properties.service');
const maintenance = require('../middleware/maintenance');

const DUMP_DIR = process.env.QA_DB_REFRESH_DIR || '/app/dbdumps';
// A full dump + restore of a multi-GB schema over a private link. Generous, but
// finite — the point is that a HUNG dump can never hold the replica's snapshot
// open indefinitely (see header note 4).
const DUMP_TIMEOUT_MS = Number(process.env.QA_DB_REFRESH_DUMP_TIMEOUT_MS) || 90 * 60 * 1000;
const RESTORE_TIMEOUT_MS = Number(process.env.QA_DB_REFRESH_RESTORE_TIMEOUT_MS) || 120 * 60 * 1000;
// A dump smaller than this is definitionally broken for a database this size —
// treated as a failed dump rather than restored over live QA data.
const MIN_DUMP_BYTES = Number(process.env.QA_DB_REFRESH_MIN_BYTES) || 1024 * 1024;
// Keep a couple of generations so a bad refresh can be rolled back by hand.
const KEEP_DUMPS = Number(process.env.QA_DB_REFRESH_KEEP) || 2;
// Refuse to start a dump without this much headroom.
const MIN_FREE_BYTES = Number(process.env.QA_DB_REFRESH_MIN_FREE_BYTES) || 5 * 1024 * 1024 * 1024;

function src() {
  return {
    host: process.env.PROD_SLAVE_DB_HOST || '',
    port: process.env.PROD_SLAVE_DB_PORT || '3306',
    user: process.env.PROD_SLAVE_DB_USER || '',
    password: process.env.PROD_SLAVE_DB_PASSWORD || '',
    database: process.env.PROD_SLAVE_DB_NAME || process.env.DB_NAME || '',
  };
}
function dst() {
  return {
    host: process.env.DB_HOST || '',
    port: process.env.DB_PORT || '3306',
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || '',
  };
}

/*
 * Everything that must be true before we touch anything. Throws with a plain
 * operator-readable reason; the caller turns that into the failure email.
 */
function assertSafeToRun() {
  const s = src();
  const d = dst();

  // GUARD 1 — environment. The prod backend runs this same image.
  const envLabel = String(process.env.ENVIRONMENT || '').toLowerCase();
  if (envLabel !== 'qa') {
    throw new Error(
      `refusing to run: ENVIRONMENT is "${envLabel || '(unset)'}", not "qa". `
      + 'This job DROPS the target database and must never run outside QA.',
    );
  }

  if (!s.host || !s.user || !s.database) {
    throw new Error('refusing to run: PROD_SLAVE_DB_HOST / _USER / _NAME are not fully configured.');
  }
  if (!d.host || !d.user || !d.database) {
    throw new Error('refusing to run: the QA target (DB_HOST / DB_USER / DB_NAME) is not fully configured.');
  }

  // GUARD 2 — target identity. A typo that pointed the restore at the source
  // would drop production. Compare host AND port so same-host/different-port
  // setups are still distinguishable.
  if (`${s.host}:${s.port}` === `${d.host}:${d.port}`) {
    throw new Error(
      `refusing to run: dump source and restore target are the same server (${d.host}:${d.port}). `
      + 'The restore would drop the database it is reading from.',
    );
  }
  const expected = process.env.QA_DB_REFRESH_HOST;
  if (expected && expected !== d.host) {
    throw new Error(
      `refusing to run: restore target is ${d.host} but QA_DB_REFRESH_HOST is ${expected}.`,
    );
  }

  /*
   * OUTBOUND-MESSAGING SAFETY is deliberately NOT gated here.
   *
   * This job restores production data as-is, so QA ends up holding real
   * customers' mobile numbers. Storing them is not the danger; SENDING to them
   * is — and that is already prevented one layer down, at every send site:
   *   services/sms.service.js:61          TEST_MOBILE redirect
   *   services/gallabox.whatsapp.service.js:92   TEST_MOBILE redirect
   *   services/fcm.service.js:99                 TEST_FCM_TOKEN redirect
   * Those redirects are INDEPENDENT of NOTIFICATIONS_DISABLE, so an earlier
   * guard here on that flag blocked the refresh without adding protection the
   * channels didn't already have — it even blocked the read-only DRY RUN, which
   * loads nothing into QA at all.
   *
   * What still matters, and is an OPS responsibility rather than a check this
   * job can make: keep TEST_MOBILE (and TEST_EMAILS / TEST_FCM_TOKEN) set on QA.
   * They are what stand between prod contact data and a real customer's phone.
   */
}

// Free bytes on the dump volume. statfs is Node 18.15+; if it's unavailable we
// skip the check rather than block the refresh on a missing syscall.
async function freeBytes(dir) {
  try {
    const st = await fs.statfs(dir);
    return Number(st.bsize) * Number(st.bavail);
  } catch {
    return null;
  }
}

/*
 * LIVE RUN STATE — module-level, so progress survives the operator navigating
 * away or closing the tab. The browser holds nothing; it polls this. Single
 * container, and the process that runs the job is the one that serves the
 * poll, so there is no cross-replica coordination to do.
 */
let _run = null;      // { phase, startedAt, dryRun, file, bytes, cancelled, child }

const PHASES = {
  idle: 'Idle',
  checking: 'Running safety checks',
  probing: 'Checking connectivity to the replica',
  dumping: 'Downloading data from the production replica',
  verifying: 'Verifying the copy is complete',
  restoring: 'Restoring into QA',
  finishing: 'Finishing up',
};

function setPhase(phase) {
  if (!_run) return;
  _run.phase = phase;
  /*
   * Mirror the phase onto the scheduler's generic progress channel so the
   * Scheduled Jobs card can render it from the LIST endpoint it already polls —
   * no dedicated progress endpoint, and no knowledge of this job inside the
   * scheduler. Required lazily to avoid a require cycle (scheduler → this
   * service → scheduler).
   */
  try {
    const id = _run.dryRun ? 'qa-db-refresh-dry-run' : 'qa-db-refresh';
    require('../server/scheduler').setJobProgress(id, PHASES[phase] || phase);
  } catch { /* scheduler not loaded (unit tests) — progress is cosmetic */ }
}

/*
 * Snapshot for the admin card. Returns a plain object (never the child handle).
 * `bytes` is read from the file on disk rather than counted in memory, so it
 * stays accurate even though the dump streams straight through gzip to disk.
 */
function getProgress() {
  if (!_run) return { running: false, phase: 'idle', label: PHASES.idle };
  let bytes = null;
  try { bytes = fssync.statSync(_run.file).size; } catch { /* not created yet */ }
  return {
    running: true,
    dryRun: _run.dryRun,
    phase: _run.phase,
    label: PHASES[_run.phase] || _run.phase,
    startedAt: new Date(_run.startedAt).toISOString(),
    elapsedMs: Date.now() - _run.startedAt,
    bytes,
    cancelled: _run.cancelled,
    file: path.basename(_run.file),
  };
}

/*
 * Operator-requested stop. Kills the in-flight mysqldump/mysql child, which
 * makes runTool reject and unwinds runQaDbRefresh through its normal failure
 * path — so the maintenance gate is lowered and the partial dump is cleaned up
 * by the same code that handles any other failure. We do NOT tear down state
 * here; letting the existing error path do it keeps one exit route.
 */
function cancelRun() {
  if (!_run) return { cancelled: false, reason: 'nothing is running' };
  _run.cancelled = true;
  try { _run.child?.kill('SIGKILL'); } catch { /* already gone */ }
  logger.warn('QA refresh · CANCELLED by operator during phase=' + _run.phase);
  return { cancelled: true, phase: _run.phase };
}

/*
 * Run a binary with a timeout. Uses execFile — NOT a shell string — so no
 * argument can ever be interpreted as shell syntax.
 *
 * The password goes in the child's ENV as MYSQL_PWD, never in argv: argv is
 * world-readable through /proc on the host, so `--password=` would leak the
 * production credential to anything that can run `ps`.
 *
 * The child handle is parked on `_run` so cancelRun() can kill it mid-stream —
 * a multi-GB dump is otherwise uninterruptible for its whole duration.
 */
function runTool(bin, args, { timeoutMs, password, stdout = null, stdin = null }) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, MYSQL_PWD: password || '' },
    }, (err) => {
      if (_run && _run.child === child) _run.child = null;
      if (_run?.cancelled) return reject(new Error('cancelled by operator'));
      if (err) return reject(err);
      return resolve({ ok: true });
    });
    if (_run) _run.child = child;
    if (stdout) child.stdout.pipe(stdout);
    if (stdin) stdin.pipe(child.stdin);
    child.on('error', reject);
  });
}

/*
 * CREDENTIALS VIA A TEMP DEFAULTS FILE — not MYSQL_PWD, not argv.
 *
 * We originally relied on the MYSQL_PWD env var. On QA the client still reported
 * "insecure passwordless login" with the password correctly present in
 * backend.env, i.e. MYSQL_PWD was not being honoured by MariaDB's client. Rather
 * than chase which env var this particular build reads, use the mechanism BOTH
 * MySQL and MariaDB document and have always supported.
 *
 * Still safe: the file is written 0600 into the container's own tmp and deleted
 * in a finally, so the secret never reaches argv (world-readable via /proc, which
 * is why `--password=` is never an option) and never lands in a log.
 *
 * The value is single-quoted with embedded quotes escaped — passwords here
 * legitimately contain '@' and other punctuation that an unquoted my.cnf value
 * would mangle.
 */
async function withDefaultsFile(password, fn) {
  const file = path.join(
    os.tmpdir(),
    `easyfix-dbrefresh-${process.pid}-${Math.random().toString(36).slice(2)}.cnf`,
  );
  const safe = String(password ?? '').replace(/'/g, "''");
  await fs.writeFile(file, `[client]\npassword='${safe}'\n`, { mode: 0o600 });
  try {
    return await fn(file);
  } finally {
    await fs.unlink(file).catch(() => { /* already gone */ });
  }
}

/*
 * One-line, secret-free statement of what the client will actually use. This is
 * the diagnostic that was missing: the QA failure showed "passwordless login"
 * while the operator could see the password in backend.env, and nothing in our
 * logs said whether the process had in fact resolved one.
 */
function logCredentialState(label, conn) {
  const pw = String(conn.password ?? '');
  logger.info(
    `QA refresh · ${label} · host=${conn.host}:${conn.port} db=${conn.database} user=${conn.user || '(unset)'}`
    + ` · password=${pw ? `set (${pw.length} chars)` : 'NOT SET'}`,
  );
}

/*
 * PRE-FLIGHT REACHABILITY PROBE.
 *
 * Without this, an unreachable replica shows up as `mysqldump` sitting on a TCP
 * connect until the OS gives up — 2m16s of no output, then a raw errno buried in
 * stderr (observed on QA: errno 115, "Can't connect"). A plain socket attempt
 * with a short timeout turns that into a few seconds and a sentence naming the
 * likely cause, which for a private-subnet EC2 reaching another VPC host is
 * almost always a security-group / routing gap rather than anything in the DB.
 */
function probeReachable(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const net = require('net');
    const sock = new net.Socket();
    const done = (ok, why) => {
      try { sock.destroy(); } catch { /* noop */ }
      resolve({ ok, why });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true, null));
    sock.once('timeout', () => done(false, `no response within ${timeoutMs} ms`));
    sock.once('error', (e) => done(false, e.code || e.message));
    sock.connect(Number(port), host);
  });
}

/*
 * mysqldump the REPLICA to a gzipped file.
 *
 * ⚠ EVERY FLAG HERE MUST BE ACCEPTED BY *BOTH* CLIENTS. The image installs
 * Alpine's `mariadb-client`, whose `mysqldump` is a symlink to MariaDB's
 * `mariadb-dump` — there is no Oracle MySQL client in Alpine's repos. MariaDB's
 * dumper rejects MySQL-only options outright ("unknown variable"), and it does so
 * while PARSING ARGS, i.e. before connecting — so a single bad flag fails the
 * whole run instantly with no dump at all. Two that bit us / would:
 *   --set-gtid-purged=OFF  MySQL-only. REMOVED (2026-07-23) — MariaDB errors on
 *     it. Nothing is lost: it suppresses a `SET @@GLOBAL.gtid_purged` line that
 *     only Oracle's mysqldump ever emits, so with this client it was already
 *     a no-op.
 *   --column-statistics=0  MySQL-8-client-only. Deliberately never added.
 *
 * Flag rationale for the rest is in the header; the easy-to-miss one:
 *   --routines/--triggers/--events — the schema has stored programs (see the SP
 *     referenced at routes/admin/finance.js:1031). Omit these and the restore
 *     silently produces a database that is missing behaviour, not just rows.
 */
async function dumpFromReplica(file) {
  const s = src();
  logCredentialState('dump source (production replica, read-only user)', s);
  return withDefaultsFile(s.password, async (cnf) => {
    const args = [
      // MUST be first — both clients require --defaults-file to precede
      // every other option, and silently ignore it otherwise.
      `--defaults-file=${cnf}`,
      `--host=${s.host}`, `--port=${s.port}`, `--user=${s.user}`,
      '--single-transaction',   // MVCC snapshot — no table locks
      '--skip-lock-tables',     // never take the default read locks
      '--quick',                // stream rows; don't buffer a table in RAM
      '--no-tablespaces',       // avoids needing the PROCESS privilege
      '--hex-blob',
      '--routines', '--triggers', '--events',
      '--default-character-set=utf8mb4',
      s.database,
    ];
    logger.info(`QA refresh · dumping ${s.host}:${s.port}/${s.database} → ${path.basename(file)}`);
    const gz = zlib.createGzip();
    const out = fssync.createWriteStream(file);
    /*
     * `.catch()` attached IMMEDIATELY, not at the await below. When the dump is
     * cancelled or fails, runTool rejects first and we never reach `await done`
     * — leaving this pipeline's rejection unhandled, which in Node is a process-
     * level warning today and a hard crash under --unhandled-rejections=strict.
     * Capturing it here means the failure path can still await it safely.
     */
    let pipeErr = null;
    const done = pipeline(gz, out).catch((e) => { pipeErr = e; });
    try {
      await runTool('mysqldump', args, { timeoutMs: DUMP_TIMEOUT_MS, password: s.password, stdout: gz });
      await done;
      if (pipeErr) throw pipeErr;
    } catch (e) {
      // Tear the streams down so the file descriptor is released now rather than
      // whenever GC gets to it — the caller deletes the partial file straight
      // after, and on some filesystems an open handle keeps the space allocated.
      gz.destroy();
      out.destroy();
      await done;
      throw e;
    }
  });
}

/*
 * Integrity check — the single most important step, because the failure it
 * catches is SILENT. A network drop mid-dump yields a perfectly valid .gz whose
 * SQL just stops partway. Restoring that gives QA a database that looks fine and
 * is quietly missing rows and tables. mysqldump writes a "-- Dump completed"
 * trailer as its last line, so its presence is proof the dump ran to the end.
 */
async function verifyDump(file) {
  const st = await fs.stat(file);
  if (st.size < MIN_DUMP_BYTES) {
    throw new Error(`dump looks truncated — ${st.size} bytes is below the ${MIN_DUMP_BYTES}-byte floor`);
  }
  const tail = await readGzipTail(file);
  if (!/--\s*Dump completed/i.test(tail)) {
    throw new Error('dump is incomplete — mysqldump\'s "-- Dump completed" trailer is missing (likely a truncated transfer)');
  }
  return st.size;
}

// Decompress and keep only the last few KB — we never hold the whole dump in RAM.
function readGzipTail(file, keepBytes = 4096) {
  return new Promise((resolve, reject) => {
    let tail = Buffer.alloc(0);
    const rs = fssync.createReadStream(file).pipe(zlib.createGunzip());
    rs.on('data', (chunk) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > keepBytes) tail = tail.subarray(tail.length - keepBytes);
    });
    rs.on('end', () => resolve(tail.toString('utf8')));
    rs.on('error', reject);
  });
}

// Drop + recreate the QA schema, then stream the dump into it.
async function restoreIntoQa(file) {
  const d = dst();
  logCredentialState('restore target (QA)', d);
  return withDefaultsFile(d.password, async (cnf) => {
    // --defaults-file first (see withDefaultsFile).
    const base = [
      `--defaults-file=${cnf}`,
      `--host=${d.host}`, `--port=${d.port}`, `--user=${d.user}`,
      '--default-character-set=utf8mb4',
    ];

    logger.warn(`QA refresh · DROPPING and recreating ${d.host}:${d.port}/${d.database}`);
    await runTool('mysql', [...base, '--execute',
      `DROP DATABASE IF EXISTS \`${d.database}\`; CREATE DATABASE \`${d.database}\` `
      + 'CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;',
    ], { timeoutMs: 60_000, password: d.password });

    logger.info('QA refresh · restoring dump into QA…');
    const gunzip = fssync.createReadStream(file).pipe(zlib.createGunzip());
    await runTool('mysql', [...base, d.database], {
      timeoutMs: RESTORE_TIMEOUT_MS, password: d.password, stdin: gunzip,
    });
  });
}

/*
 * Delete leftover *.part files.
 *
 * A dump is written to `<name>.sql.gz.part` and only renamed to `.sql.gz` once
 * it has been verified complete. That makes orphan detection UNAMBIGUOUS: a
 * `.part` file can only be the remains of a run that died before verification —
 * a hard kill, an OOM, a deploy mid-dump. Age-based sweeping could not do this
 * safely, because a legitimately RETAINED dump from a successful refresh also
 * gets old, and deleting it would destroy the rollback copy.
 */
async function sweepPartials() {
  try {
    const names = (await fs.readdir(DUMP_DIR)).filter((n) => n.endsWith('.part'));
    for (const n of names) {
      await fs.unlink(path.join(DUMP_DIR, n)).catch(() => { /* raced */ });
      logger.warn(`QA refresh · removed orphaned partial dump ${n} (previous run died before it completed)`);
    }
    return names.length;
  } catch {
    return 0;   // dir not created yet
  }
}

// Keep the newest KEEP_DUMPS files so a bad refresh can be rolled back by hand.
async function pruneOldDumps() {
  try {
    const names = (await fs.readdir(DUMP_DIR)).filter((n) => /^qa-refresh-.*\.sql\.gz$/.test(n)).sort();
    const stale = names.slice(0, Math.max(0, names.length - KEEP_DUMPS));
    for (const n of stale) {
      await fs.unlink(path.join(DUMP_DIR, n));
      logger.info(`QA refresh · pruned old dump ${n}`);
    }
    return stale.length;
  } catch (e) {
    logger.warn(`QA refresh · prune failed (non-fatal) · ${e.message}`);
    return 0;
  }
}

function istNow() {
  try { return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }); }
  catch { return new Date().toISOString(); }
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function mb(bytes) {
  return bytes == null ? 'n/a' : `${(Number(bytes) / 1024 / 1024).toFixed(1)} MB`;
}

async function recipients() {
  await properties.getAllProperties();
  const list = [...properties.parseEmailAllowlist('qa.dbrefresh.alert.emails')];
  return list.length ? list : ['harshit@channelplay.in'];
}

/*
 * Outcome email.
 *
 * NOTE the bypass: email.service.send() short-circuits entirely when
 * NOTIFICATIONS_DISABLE is set — a flag QA legitimately runs with. Left alone,
 * the success/failure alert would be silently swallowed on exactly the hosts
 * this job runs on, so we clear it for the duration of this one send.
 *
 * That is safe because this is an OPS alert to a fixed internal allowlist
 * (qa.dbrefresh.alert.emails), never a customer-facing message — the flag's
 * intent, "don't message real people from QA", is untouched. TEST_EMAILS still
 * applies on top, so the send is redirected like any other in test mode.
 */
async function notify({ ok, summary, error }) {
  const to = await recipients();
  const envLabel = process.env.ENVIRONMENT || 'qa';
  // The mode MUST be in the subject. A dry-run success that reads "QA refreshed"
  // would have someone believe QA holds fresh data when nothing was restored.
  const dry = summary?.dryRun === true;
  const subject = ok
    ? (dry
      ? `✅ QA DB refresh DRY RUN passed — nothing restored (${envLabel})`
      : `✅ QA DB refreshed from production (${envLabel})`)
    : `⚠ QA DB refresh${dry ? ' DRY RUN' : ''} FAILED (${envLabel})`;
  const rows = [
    ['Mode', dry ? 'Dry run — dump + verify only, QA untouched' : 'Full refresh — QA reloaded'],
    ['When (IST)', istNow()],
    ['Source (replica)', `${src().host}:${src().port}/${src().database}`],
    ['Target (QA)', `${dst().host}:${dst().port}/${dst().database}`],
    ['Dump size', mb(summary?.dumpBytes)],
    ['Duration', summary?.durationMs != null ? `${Math.round(summary.durationMs / 1000)}s` : 'n/a'],
  ];
  const okBody = dry
    ? `<p>The rehearsal passed: safety guards, replica connectivity, the read-only credentials, disk
         headroom, the dump and its completeness check all succeeded.
         <strong>QA was NOT modified and still holds its previous data</strong> — the restore step was
         skipped. The only untested step remaining is the restore itself.</p>`
    : '<p>QA is serving production-shaped data. Production was never written to — the dump came from the read replica using a read-only user.</p>';
  const html = `
    <p><strong>${ok
    ? (dry ? 'The QA refresh dry run passed.' : 'QA was refreshed from production.')
    : `The QA refresh${dry ? ' dry run' : ''} did not complete.`}</strong></p>
    <table cellpadding="4" style="border-collapse:collapse;font-family:sans-serif;font-size:13px">
      ${rows.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}
    </table>
    ${ok
    ? okBody
    : `<p style="color:#b91c1c"><b>Reason:</b> ${esc(error || 'unknown')}</p>
         <p>${dry
    ? 'Nothing was restored, so QA is exactly as it was. Fix the reason above and re-run the dry run.'
    : `QA was left as it was unless the failure happened during the restore step — check the
            Scheduled Jobs page and the container logs before retrying.`}</p>`}
  `;

  const savedFlag = process.env.NOTIFICATIONS_DISABLE;
  try {
    process.env.NOTIFICATIONS_DISABLE = 'false';
    return await email.send({ to, subject, html, category: 'transactional' });
  } catch (e) {
    logger.error(`QA refresh · outcome email failed · ${e.message}`);
    return { delivered: false, error: e.message };
  } finally {
    if (savedFlag === undefined) delete process.env.NOTIFICATIONS_DISABLE;
    else process.env.NOTIFICATIONS_DISABLE = savedFlag;
  }
}

/*
 * The whole run. Never throws for the cron path — always resolves to a summary
 * and always emails, because a silent failure here means a stale QA nobody
 * notices until testing gives a wrong answer.
 */
async function runQaDbRefresh({ dryRun = false } = {}) {
  // One at a time. Two concurrent runs would race on the same DUMP_DIR and, in
  // the real mode, on the same schema — and the progress card can only describe
  // one of them.
  if (_run) {
    return { ok: false, error: `a ${_run.dryRun ? 'dry run' : 'refresh'} is already in progress (${_run.phase})`, dryRun };
  }

  const startedAt = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(DUMP_DIR, `qa-refresh-${stamp}.sql.gz`);
  // Written here first; renamed to `file` only after verifyDump passes, so an
  // unverified dump can never masquerade as a usable one. See sweepPartials().
  const partFile = `${file}.part`;
  const summary = { dumpBytes: null, durationMs: null, pruned: 0, file, dryRun };
  let maintenanceRaised = false;
  _run = { phase: 'checking', startedAt, dryRun, file: partFile, cancelled: false, child: null };

  try {
    /*
     * Guards FIRST — before a single byte moves. A DRY RUN runs the SAME guards,
     * deliberately: the entire point of a rehearsal is to prove the real run
     * will work, so skipping the checks that gate the real run would make it
     * prove nothing. A dry run that passes means the only untested step left is
     * the restore itself.
     */
    assertSafeToRun();

    await fs.mkdir(DUMP_DIR, { recursive: true });
    // Clear any .part left by a run that was hard-killed (deploy, OOM) — those
    // are pure junk and could otherwise accumulate unbounded.
    await sweepPartials();
    const free = await freeBytes(DUMP_DIR);
    if (free != null && free < MIN_FREE_BYTES) {
      throw new Error(`not enough disk on ${DUMP_DIR} — ${mb(free)} free, need at least ${mb(MIN_FREE_BYTES)}`);
    }

    /*
     * Fail fast on an unreachable replica. mysqldump would otherwise sit on a
     * TCP connect for minutes and then report a bare errno — see probeReachable.
     */
    setPhase('probing');
    const s = src();
    const reach = await probeReachable(s.host, s.port);
    if (!reach.ok) {
      throw new Error(
        `cannot reach the production replica at ${s.host}:${s.port} (${reach.why}). `
        + 'The database is not the problem — nothing accepted the connection. Check that the QA host '
        + "is allowed to reach it: the replica's security group / firewall must permit this EC2's IP "
        + 'on the MySQL port, and a route must exist between the two networks.',
      );
    }

    // Dump + verify happen with QA still fully serving traffic: if either fails,
    // QA is untouched and nobody noticed.
    setPhase('dumping');
    await dumpFromReplica(partFile);
    setPhase('verifying');
    summary.dumpBytes = await verifyDump(partFile);
    logger.info(`QA refresh · dump verified · ${mb(summary.dumpBytes)}`);

    /*
     * DRY RUN stops here — everything up to this line is read-only with respect
     * to QA. It has already exercised the guards, the replica connectivity, the
     * read-only credentials, disk headroom, the dump itself and the truncation
     * check. Nothing below this point has run, so QA is untouched and no
     * maintenance window was ever opened. This is the safe first run.
     */
    if (dryRun) {
      setPhase('finishing');
      /*
       * DELETE the dump a dry run produced. A rehearsal proves the pipeline
       * works; the bytes themselves are worthless — the real run takes its own
       * fresh copy. Keeping them would silently consume GBs on a shared EC2
       * every time someone presses the button, and the pruner only trims to
       * KEEP_DUMPS, so a few dry runs could still hold multiple copies.
       */
      await fs.unlink(partFile).catch(() => { /* never existed / already gone */ });
      summary.deletedDump = true;
      summary.durationMs = Date.now() - startedAt;
      logger.ready(`QA refresh DRY RUN complete · ${mb(summary.dumpBytes)} verified then deleted · ${Math.round(summary.durationMs / 1000)}s · QA untouched`);
      await notify({ ok: true, summary });
      return { ok: true, ...summary };
    }

    // Verified — promote to the real name. Only from here can the file be
    // picked up as a rollback copy or by the retention pruner.
    await fs.rename(partFile, file);

    // Only now does anything destructive happen.
    maintenance.begin('QA database refresh');
    maintenanceRaised = true;
    await restoreIntoQa(file);
    maintenance.end();
    maintenanceRaised = false;

    const alive = await testConnection();
    if (!alive) logger.warn('QA refresh · pool did not confirm a connection immediately after restore');
    // Prove the restore produced a usable schema rather than an empty one.
    const [[{ tables }]] = await pool.query(
      'SELECT COUNT(*) AS tables FROM information_schema.tables WHERE table_schema = ?',
      [dst().database],
    );
    if (!tables) throw new Error('restore finished but the QA schema has no tables');
    summary.tables = tables;

    summary.pruned = await pruneOldDumps();
    summary.durationMs = Date.now() - startedAt;
    logger.ready(`QA refresh complete · ${tables} tables · ${mb(summary.dumpBytes)} · ${Math.round(summary.durationMs / 1000)}s`);
    await notify({ ok: true, summary });
    return { ok: true, ...summary };
  } catch (err) {
    // The gate must never be left up on a failure — that would strand QA in 503.
    if (maintenanceRaised) maintenance.end();
    summary.durationMs = Date.now() - startedAt;
    const cancelled = _run?.cancelled === true;
    const reason = cancelled ? 'stopped by operator' : (err?.message || String(err));
    /*
     * A failed or cancelled run leaves a PARTIAL .sql.gz behind. It can never be
     * used (verifyDump would reject it) but it still occupies disk, so remove it
     * here rather than waiting for the pruner — which trims by count and would
     * happily keep a broken file while deleting a good one.
     */
    await fs.unlink(partFile).catch(() => { /* never created */ });
    await fs.unlink(file).catch(() => { /* only exists post-rename */ });
    if (cancelled) logger.warn('QA refresh stopped by operator · partial dump removed');
    else logger.error(`QA refresh FAILED · ${reason}`);
    await notify({ ok: false, summary, error: reason });
    return { ok: false, error: reason, cancelled, ...summary };
  } finally {
    // ALWAYS clear the live-run state, or the single-run guard above would
    // permanently refuse every later run after one crash.
    _run = null;
  }
}

module.exports = {
  runQaDbRefresh, assertSafeToRun,
  getProgress, cancelRun,
};
