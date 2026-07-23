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
 * Run a binary with a timeout, returning {code}. Uses execFile — NOT a shell
 * string — so no argument can ever be interpreted as shell syntax.
 *
 * The password goes in the child's ENV as MYSQL_PWD, never in argv: argv is
 * world-readable through /proc on the host, so `--password=` would leak the
 * production credential to anything that can run `ps`.
 */
function runTool(bin, args, { timeoutMs, password, stdout = null, stdin = null }) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, MYSQL_PWD: password || '' },
    }, (err) => {
      if (err) return reject(err);
      return resolve({ ok: true });
    });
    if (stdout) child.stdout.pipe(stdout);
    if (stdin) stdin.pipe(child.stdin);
    child.on('error', reject);
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
  const args = [
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
  logger.info(`QA refresh · dumping ${s.host}:${s.port}/${s.database} (replica, read-only user) → ${path.basename(file)}`);
  const gz = zlib.createGzip();
  const out = fssync.createWriteStream(file);
  const done = pipeline(gz, out);
  await runTool('mysqldump', args, { timeoutMs: DUMP_TIMEOUT_MS, password: s.password, stdout: gz });
  await done;
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
  const base = [`--host=${d.host}`, `--port=${d.port}`, `--user=${d.user}`, '--default-character-set=utf8mb4'];

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
  const startedAt = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(DUMP_DIR, `qa-refresh-${stamp}.sql.gz`);
  const summary = { dumpBytes: null, durationMs: null, pruned: 0, file, dryRun };
  let maintenanceRaised = false;

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
    const free = await freeBytes(DUMP_DIR);
    if (free != null && free < MIN_FREE_BYTES) {
      throw new Error(`not enough disk on ${DUMP_DIR} — ${mb(free)} free, need at least ${mb(MIN_FREE_BYTES)}`);
    }

    // Dump + verify happen with QA still fully serving traffic: if either fails,
    // QA is untouched and nobody noticed.
    await dumpFromReplica(file);
    summary.dumpBytes = await verifyDump(file);
    logger.info(`QA refresh · dump verified · ${mb(summary.dumpBytes)}`);

    /*
     * DRY RUN stops here — everything up to this line is read-only with respect
     * to QA. It has already exercised the guards, the replica connectivity, the
     * read-only credentials, disk headroom, the dump itself and the truncation
     * check. Nothing below this point has run, so QA is untouched and no
     * maintenance window was ever opened. This is the safe first run.
     */
    if (dryRun) {
      summary.pruned = await pruneOldDumps();
      summary.durationMs = Date.now() - startedAt;
      logger.ready(`QA refresh DRY RUN complete · ${mb(summary.dumpBytes)} · ${Math.round(summary.durationMs / 1000)}s · QA untouched`);
      await notify({ ok: true, summary });
      return { ok: true, ...summary };
    }

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
    const reason = err?.message || String(err);
    logger.error(`QA refresh FAILED · ${reason}`);
    await notify({ ok: false, summary, error: reason });
    return { ok: false, error: reason, ...summary };
  }
}

module.exports = { runQaDbRefresh, assertSafeToRun };
