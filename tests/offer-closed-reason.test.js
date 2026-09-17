'use strict';
/*
 * tbl_job_offer.closed_reason — WHY an offer closed, at all nine writers.
 *
 * ─── WHAT THIS IS FOR (2026-09-10) ─────────────────────────────────────────
 * `offer_status = 3 EXPIRED` is written by nine call sites and only ONE is the
 * 30-minute timeout. On job 538177 two offers read EXPIRED after ~22 hours
 * with the timeout switched OFF; both were closed in the same second, six
 * seconds before a re-offer went out. The status could not say that, so the
 * rows read as two technicians ignoring a job they were never given a chance
 * to answer — and candidate-ranking scores acceptance from these rows.
 *
 * ─── WHAT IS ACTUALLY ASSERTED, AND WHY ────────────────────────────────────
 * The load-bearing risk in this change is NOT whether a reason is passed — it
 * is PARAMETER ORDER. The reason binds in the SET clause, so its param must be
 * spread BEFORE the caller's WHERE params. Get that wrong and the UPDATE still
 * runs, still reports affectedRows, and silently matches the wrong rows (or
 * none) — a bug no status code or return value reveals. So the runtime tests
 * below capture the emitted SQL and its params TOGETHER and check the binding
 * position, not merely that the column appears.
 *
 * The other half is coverage: a writer that was missed would leave NULL, which
 * the migration defines as "closed before this column existed". A missed
 * writer would therefore be indistinguishable from a legacy row — silent by
 * construction — so the count of writers is pinned too.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { readMigration } = require('./helpers/migration-file');
const {
  OFFER_CLOSED_REASON, OFFER_CLOSED_REASON_LABEL, closedReasonSet,
} = require(path.join(ROOT, 'services/offer-closed-reason'));

/* ─── the enumeration ──────────────────────────────────────────────────── */

test('every reason has an operator-facing label, and only one blames the technician', () => {
  for (const v of Object.values(OFFER_CLOSED_REASON)) {
    assert.ok(OFFER_CLOSED_REASON_LABEL[v], `${v} has no label — it would render as a raw code`);
  }
  assert.equal(Object.keys(OFFER_CLOSED_REASON_LABEL).length,
    Object.values(OFFER_CLOSED_REASON).length, 'no orphan labels');
  /*
   * The point of the column. Exactly ONE reason may read as "the technician
   * did not answer"; every other label must describe something done TO the
   * offer. A future reason worded like a decline would quietly reintroduce the
   * misattribution this exists to remove.
   */
  const blaming = Object.entries(OFFER_CLOSED_REASON_LABEL)
    .filter(([, l]) => /no response|did not respond|ignored|no answer/i.test(l));
  assert.deepEqual(blaming.map(([k]) => k), [OFFER_CLOSED_REASON.TTL_ELAPSED],
    'only ttl_elapsed may be phrased as the technician not responding');
});

test('every value fits the column', () => {
  // VARCHAR(40). A longer value would be silently TRUNCATED in non-strict mode
  // and become a reason no reader recognises.
  for (const v of Object.values(OFFER_CLOSED_REASON)) {
    assert.ok(v.length <= 40, `${v} is ${v.length} chars — exceeds VARCHAR(40)`);
  }
});

test('an unknown reason throws rather than storing a dead string', async () => {
  await assert.rejects(() => closedReasonSet('made_up'), /Unknown offer closed_reason/);
});

/* ─── the probe, and deploy-order safety ───────────────────────────────── */

/** Swap the shared pool, then load a FRESH module so its memo starts cold. */
function loadWith(handler) {
  const calls = [];
  const db = require(path.join(ROOT, 'db'));
  const real = db.pool.query;
  db.pool.query = async (sql, params) => {
    const text = Array.isArray(sql) ? String(sql[0]) : String(sql);
    calls.push({ sql: text, params });
    return [await handler(text, params), []];
  };
  delete require.cache[require.resolve(path.join(ROOT, 'services/offer-closed-reason'))];
  const mod = require(path.join(ROOT, 'services/offer-closed-reason'));
  return { mod, calls, restore: () => { db.pool.query = real; } };
}

test('column ABSENT → an empty fragment, so the code ships before the migration', async () => {
  const { mod, restore } = loadWith(() => []);
  try {
    const cr = await mod.closedReasonSet(OFFER_CLOSED_REASON.JOB_ASSIGNED);
    assert.equal(cr.sql, '', 'naming a column that does not exist turns every closure into a 500');
    assert.deepEqual(cr.params, []);
  } finally { restore(); }
});

test('column PRESENT → the fragment and exactly one param', async () => {
  const { mod, restore } = loadWith((t) => (/SHOW COLUMNS/i.test(t) ? [{ Field: 'closed_reason' }] : []));
  try {
    const cr = await mod.closedReasonSet(OFFER_CLOSED_REASON.REOFFERED);
    assert.equal(cr.sql, ', closed_reason = ?');
    assert.deepEqual(cr.params, ['reoffered']);
  } finally { restore(); }
});

test('a probe FAILURE is not cached as "column absent"', async () => {
  // Caching a transient fault would disable reason-recording for the life of
  // the process, silently, because absent is a legitimate answer.
  let first = true;
  const { mod, restore } = loadWith((t) => {
    if (/SHOW COLUMNS/i.test(t)) {
      if (first) { first = false; throw new Error('ER_CON_COUNT_ERROR'); }
      return [{ Field: 'closed_reason' }];
    }
    return [];
  });
  try {
    assert.equal((await mod.closedReasonSet(OFFER_CLOSED_REASON.JOB_CLOSED)).sql, '',
      'a failed probe degrades to no reason');
    assert.equal((await mod.closedReasonSet(OFFER_CLOSED_REASON.JOB_CLOSED)).sql, ', closed_reason = ?',
      'the very next call must re-probe');
  } finally { restore(); }
});

/* ─── PARAMETER ORDER — the bug this change could actually introduce ───── */

test('RUNTIME: the reason binds in the SET clause, before the WHERE params', async () => {
  /*
   * expireStaleOffers is the site where a mis-ordered param is most damaging:
   * its WHERE carries the TTL (`INTERVAL ? MINUTE`). Swap the two and the
   * statement still succeeds — it just expires offers older than however many
   * minutes 'ttl_elapsed' coerces to (0), i.e. EVERY open offer. Nothing in
   * the return value would show it.
   */
  const db = require(path.join(ROOT, 'db'));
  const real = db.pool.query;
  const calls = [];
  db.pool.query = async (sql, params) => {
    const text = Array.isArray(sql) ? String(sql[0]) : String(sql);
    calls.push({ sql: text, params });
    if (/SHOW COLUMNS FROM tbl_job_offer LIKE 'closed_reason'/i.test(text)) return [[{ Field: 'closed_reason' }], []];
    if (/SHOW COLUMNS|SHOW TABLES|information_schema/i.test(text)) return [[{ x: 1 }], []];
    if (/^\s*UPDATE tbl_job_offer/i.test(text)) return [{ affectedRows: 2 }, []];
    return [[], []];
  };
  for (const m of ['services/offer-closed-reason', 'services/job.service']) {
    delete require.cache[require.resolve(path.join(ROOT, m))];
  }
  try {
    const jobSvc = require(path.join(ROOT, 'services/job.service'));
    // Force the expiry regime ON so the gate does not short-circuit.
    const props = require(path.join(ROOT, 'services/properties.service'));
    const realGet = props.getProperty;
    props.getProperty = (k) => (k === 'job.offer_expiry.enabled' ? 'true' : realGet(k));
    try {
      await jobSvc.expireStaleOffers(30, 4242);
    } finally { props.getProperty = realGet; }

    const upd = calls.find((c) => /^\s*UPDATE tbl_job_offer/i.test(c.sql));
    assert.ok(upd, 'the sweep must have issued its UPDATE');
    assert.match(upd.sql, /closed_reason = \?/, 'the reason must be recorded');

    // The decisive assertion: order, read off the emitted statement itself.
    const setIdx = upd.sql.indexOf('closed_reason = ?');
    const whereIdx = upd.sql.search(/INTERVAL \? MINUTE/);
    assert.ok(setIdx > -1 && whereIdx > -1);
    assert.ok(setIdx < whereIdx, 'the SET placeholder precedes the WHERE placeholder in the SQL');
    // responded_at's own bound Date leads (it is the first SET placeholder,
    // ahead of closed_reason), then the reason, then the WHERE params — whose
    // offered_at freshness comparison ALSO binds an app-side Date (offered_at
    // is app-written since cffaa49) ahead of the TTL, never SQL NOW().
    assert.ok(upd.params[0] instanceof Date, 'responded_at is bound as a Date, never SQL NOW()');
    assert.equal(upd.params[1], 'ttl_elapsed',
      `params must follow responded_at with the reason; got ${JSON.stringify(upd.params)} — a swapped order `
      + 'would make the TTL "ttl_elapsed" (0 minutes) and expire EVERY open offer');
    assert.ok(upd.params[2] instanceof Date, 'the offered_at freshness comparison is bound as a Date, never SQL NOW()');
    assert.equal(upd.params[3], 30, 'then the TTL');
    assert.equal(upd.params[4], 4242, 'then the job id');
  } finally {
    db.pool.query = real;
    for (const m of ['services/offer-closed-reason', 'services/job.service']) {
      delete require.cache[require.resolve(path.join(ROOT, m))];
    }
  }
});

/* ─── coverage: no writer left silent ─────────────────────────────────── */

test('EVERY site that writes EXPIRED also records a reason', () => {
  /*
   * A missed writer leaves closed_reason NULL, which the migration defines as
   * "closed before this column existed" — indistinguishable from a legacy row,
   * so the omission would never surface. Hence a count, not a spot check.
   */
  const FILES = [
    'services/job.service.js',
    'services/job-offer-persistence.service.js',
    'services/easyfixer-lifecycle.service.js',
  ];
  let writes = 0;
  let reasons = 0;
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // A statement that SETS offer_status to EXPIRED (constant or bound).
    for (const m of src.matchAll(/UPDATE tbl_job_offer[\s\S]{0,400}?SET offer_status = (?:\$\{OFFER_STATUS\.EXPIRED\}|\?)/g)) {
      // Only count the ones whose surrounding statement really targets EXPIRED.
      const tail = src.slice(m.index, m.index + 900);
      if (/OFFER_STATUS\.EXPIRED/.test(tail)) writes += 1;
    }
    reasons += [...src.matchAll(/closedReasonSet\(OFFER_CLOSED_REASON\./g)].length;
  }
  assert.ok(writes >= 9, `expected at least 9 EXPIRED writers, found ${writes} — the scanner broke, `
    + 'so a clean result would be vacuous');
  assert.equal(reasons, 9,
    `${reasons} of ${writes} EXPIRED writers record a reason. Every one must: a writer left out `
    + 'produces NULL, which is indistinguishable from a pre-migration row.');
});

test('the migration and the enumeration agree on the column', () => {
  /*
   * readMigration(), NOT a hardcoded path. The repo has a guard
   * (tests/migration-file-helper.test.js) because a test pinning
   * `migrations/<name>.sql` breaks the build the day the file is moved to
   * migrations/executed/ — which has failed a Production deploy before, on a
   * commit that changed no behaviour. This test tripped that guard on its
   * first run.
   */
  const sql = readMigration('2026-09-10-job-offer-closed-reason.sql');
  assert.match(sql, /ADD COLUMN closed_reason VARCHAR\(40\) NULL/,
    'the enumeration assumes VARCHAR(40) NULL');
  assert.match(sql, /no row-writing statement against this\s*--\s*table anywhere in the legacy codebase/,
    'the migration must carry the legacy-safety evidence — tbl_job_offer is shared with the '
    + 'Java CRM, so "additive is safe" has to be shown, not assumed');
});
