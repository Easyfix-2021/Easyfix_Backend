'use strict';

const crypto = require('node:crypto');

const { pool } = require('../db');
const logger = require('../logger');
const fieldCrypto = require('../lib/field-crypto');
const { recordReveal } = require('./profile-self.service');

/*
 * field-rekey — BULK RE-KEYING of every value protected by lib/field-crypto.js.
 *
 * Backs Admin Actions → "Re-Key Encrypted Fields" (routes/admin/field-rekey.js).
 * Three modes, ONE piece of machinery:
 *
 *   rotate   The operational key is being replaced and THE CURRENT ONE STILL
 *            WORKS. Each data key is unwrapped with the current operational key
 *            and re-wrapped under the new one. NO RECOVERY KEY IS INVOLVED, and
 *            the form must not ask for one — this is the ordinary path and by
 *            far the commonest, and every time a recovery private key is typed
 *            somewhere is an exposure that the ordinary path should not create.
 *
 *   recover  The operational key is LOST (or was already replaced, so the rows
 *            name a fingerprint nobody holds). The data key is unsealed with the
 *            supplied recovery PRIVATE key and re-wrapped under the new
 *            operational key. This is break-glass.
 *
 *   reseal   The RECOVERY key leaked and the operator still holds it. Each data
 *            key is unsealed with the OLD recovery private key and re-sealed to
 *            the ACTIVE recovery public key from the store. THE OPERATIONAL WRAP
 *            IS UNTOUCHED, so normal reads keep working throughout and there is
 *            no restart.
 *
 *            ⚠ THE NEW PUBLIC KEY IS NEVER PASTED. It is already the active row
 *            in tbl_field_recovery_key — the operator generated that keypair in
 *            the browser and POSTed its public half. Accepting it again as a
 *            request field would add a way for a typo or a stale paste to seal
 *            every value in the company to a key NOBODY HOLDS, which is
 *            unrecoverable in exactly the way this feature exists to prevent.
 *            There is no upside to balance that against: the store already has
 *            the authoritative copy.
 *
 * ── RE-WRAP, NOT RE-ENCRYPT ─────────────────────────────────────────────
 * Only the wrapped/sealed DATA KEY changes. The value ciphertext is byte
 * identical afterwards — nothing here ever holds an account number in the
 * clear, in memory or otherwise. That is what makes this operation small enough
 * to be safe: an interrupted run has re-wrapped 32-byte blobs and damaged
 * nothing, and every row it did not reach is still perfectly readable.
 *
 * ── THE WINDOW A ROTATION IMPLIES ───────────────────────────────────────
 * After `rotate` completes, the rows want the NEW key and the process still
 * holds the OLD one in EASYFIX_FIELD_ENC_KEY, so reads of protected fields fail
 * until the environment is updated and the app restarted. That window is
 * INHERENT to keeping exactly one key in env — it is the cost of the owner's
 * "no second key" constraint, not a defect here. The dry run reports the row
 * count precisely so an operator can judge how long it will be before starting.
 *
 * ── IDEMPOTENT BY FINGERPRINT, NEVER BY A PROGRESS FLAG ─────────────────
 * A row whose envelope already names the TARGET key is skipped. There is no
 * "rekeyed_on" column and there must not be: a flag records what a previous RUN
 * believed, and the two disagree the moment a run dies between the write and
 * the flag, or a row is restored from a backup taken before it. The fingerprint
 * is carried by the value itself, so it cannot be wrong. Re-running after an
 * interruption is therefore safe, cheap, and finishes the job.
 *
 * ── BATCHED, WITH PER-ROW COMMITS ───────────────────────────────────────
 * Rows are walked in id order in batches, and each row's re-wrap is a SINGLE
 * UPDATE on the pool — one statement, its own implicit transaction. One long
 * transaction over the whole table would hold locks for the duration and make a
 * partial failure all-or-nothing; per-row commits mean an interrupted run
 * leaves every row INDIVIDUALLY VALID and the re-run picks up the remainder.
 *
 * ── THE SUPPLIED PRIVATE KEY IS THE SECURITY BOUNDARY OF THIS FEATURE ───
 * It is never logged, never persisted, never echoed in a response, never in an
 * error message and never in the audit row. Nothing below interpolates it into
 * a string. The audit records THAT recovery mode was used, not the key. The
 * route scrubs it off req.body the moment this module returns. See
 * routes/admin/field-rekey.js for the transport-side half (no-store, POST only,
 * a hard rate limit, and a Joi schema whose messages cannot carry a value).
 */

// ── THE GROUP REGISTRY — DATA, NOT CODE ─────────────────────────────────
/*
 * A group names a SET OF COLUMNS that hold field-crypto envelopes. Adding the
 * next one — a PAN, an Aadhaar, a salary — is a TABLE ENTRY here and a dropdown
 * option in the CRM, not a new code path: everything below walks this structure
 * and knows nothing about banks. The owner asked explicitly for the dropdown to
 * grow, and a feature that has to be re-implemented per field is a feature that
 * gets re-implemented badly the second time.
 *
 * `columns` are envelope-bearing columns. `json: true` marks a column holding
 * JSON in which envelopes are NESTED at unknown depth — the walk finds them by
 * asking fieldCrypto.isEncrypted() rather than by knowing key names, so a new
 * protected key inside that JSON is covered the day it is added.
 *
 * ⚠ THE REQUEST TABLE IS NOT OPTIONAL. tbl_user_profile_update_request.changes
 * and .old_values hold the SAME account number as the personal-details row,
 * inside their bank object. Re-keying only the user table would leave half the
 * ciphertext wrapped under a key the application no longer holds — the pending
 * approval queue would start failing to decrypt while the profile page worked,
 * which is the confusing half-broken state this entry exists to prevent. There
 * is a test that asserts this table appears in the SQL the run actually issues.
 */
const FIELD_GROUPS = {
  bank: {
    label: 'Bank Details',
    tables: [
      {
        table: 'tbl_user_personal_details',
        idColumn: 'user_id',
        columns: ['bank_account_number', 'bank_account_name'],
      },
      {
        table: 'tbl_user_profile_update_request',
        idColumn: 'request_id',
        columns: ['changes', 'old_values'],
        json: true,
      },
    ],
  },
};

const GROUP_KEYS = Object.keys(FIELD_GROUPS);
const REKEY_MODES = ['rotate', 'recover', 'reseal'];

/*
 * 200 rows per SELECT. Small enough that the result set is bounded on a table
 * that will one day hold every employee, large enough that the round trips do
 * not dominate. It is not a transaction size — each row commits on its own —
 * so this number trades memory against latency and nothing else.
 */
const BATCH = 200;

/* The house error shape: routes surface e.status plus the machine `code`. */
function mkErr(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// ── FINGERPRINTS ────────────────────────────────────────────────────────
/*
 * A fingerprint is the PUBLIC NAME of a key: a SHA-256 prefix, derived from the
 * key itself so it can never disagree with what it names, and short enough to
 * print in a log. It is not key material — a truncated digest does not reverse.
 *
 * ⚠ THESE TWO DERIVATIONS ARE A CONTRACT WITH lib/field-crypto.js, which does
 * not export either of them. The operational one is sha256 over the RAW key
 * bytes (not the base64 text, so the same key names itself identically however
 * it was pasted); the recovery one is sha256 over the DER SPKI bytes — the
 * canonical encoding of a public key, so PEM whitespace and line wrapping
 * cannot change the answer. Both take the first 8 hex chars, matching that
 * module's `fingerprint()` and `publicKeyFingerprint()` exactly.
 *
 * Two derivations that disagreed would mean an envelope naming a recovery key
 * that no row of tbl_field_recovery_key could be found by — at the one moment
 * it matters. So they are not merely copied and hoped over: the tests build a
 * real envelope through lib/field-crypto and assert the fingerprints read out
 * of it here are the ones these functions produce. If it ever exports them,
 * delete these two and call them instead.
 */
const FP_CHARS = 8;

function operationalFingerprint(base64Key) {
  const raw = Buffer.from(String(base64Key || '').trim(), 'base64');
  if (raw.length !== 32) {
    // The LENGTH is named, never the value.
    throw mkErr(400, 'INVALID_OPERATIONAL_KEY',
      `the new key must decode to 32 bytes of base64, got ${raw.length}`);
  }
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, FP_CHARS);
}

function recoveryFingerprint(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, FP_CHARS);
}

/*
 * The fingerprints an envelope carries: the OPERATIONAL key that wrapped its
 * data key, and the RECOVERY key it was sealed to.
 *
 * Read positionally from the head of the envelope, which is `v2:<op>[:<rec>]:…`
 * followed by base64 blobs. Both slots are accepted as optional and identified
 * by SHAPE (lowercase hex of exactly FP_CHARS) rather than by position alone,
 * so this reads an envelope with one fingerprint and an envelope with two
 * without caring which lib/field-crypto.js currently emits. A base64 blob
 * consisting only of hex characters would be misread; for the 16-character
 * fields that follow, that is a ~1-in-4-billion coincidence, and the fallback
 * is a needless re-wrap rather than a wrong one.
 *
 * Returns nulls rather than throwing: an unparseable head is a value the caller
 * should skip, not an exception that aborts a bulk run at row 40,000.
 */
const FP_RE = new RegExp(`^[0-9a-f]{${FP_CHARS}}$`);

function envelopeFingerprints(envelope) {
  const parts = String(envelope).split(':');
  const operational = FP_RE.test(parts[1] || '') ? parts[1] : null;
  const recovery = FP_RE.test(parts[2] || '') ? parts[2] : null;
  return { operational, recovery };
}

/*
 * The fingerprint of the key the PROCESS is currently running with, or null.
 * Null is a legitimate state here and not an error: `recover` exists precisely
 * for the case where EASYFIX_FIELD_ENC_KEY is absent or wrong, and the dry run
 * must still be able to report the fingerprint distribution so the operator can
 * see which key the rows actually want.
 */
function activeOperationalFingerprint() {
  try {
    return operationalFingerprint(process.env.EASYFIX_FIELD_ENC_KEY);
  } catch {
    return null;
  }
}

// ── THE PLAN — what a run is going to do to one envelope ────────────────
/*
 * Resolving the plan ONCE, before the first row, is what keeps the per-row path
 * free of mode branching and — more importantly — is what makes a bad input
 * fail on row zero instead of after re-wrapping forty thousand rows and then
 * discovering the new key was mistyped. The private key is held in this closure
 * for the duration of the run and in nothing else.
 */
function resolvePlan({ mode, newKey, recoveryPrivateKey }, activeRecovery) {
  if (!REKEY_MODES.includes(mode)) {
    throw mkErr(400, 'INVALID_MODE', `mode must be one of ${REKEY_MODES.join(', ')}`);
  }

  if (mode === 'reseal') {
    if (!recoveryPrivateKey) {
      throw mkErr(400, 'RECOVERY_KEY_REQUIRED',
        'reseal needs the OLD recovery private key — it is what unseals each data key');
    }
    /*
     * The target is the ACTIVE STORE ROW, full stop — see the header. The normal
     * sequence is: generate a keypair in the browser, POST the public half
     * (which becomes active and starts sealing NEW rows to it), then re-seal the
     * existing rows to catch up. Every input this needs is already on the
     * server, so there is nothing here for a paste to get wrong.
     */
    if (!activeRecovery || !activeRecovery.public_key) {
      throw mkErr(400, 'NO_ACTIVE_RECOVERY_KEY',
        'no recovery public key is registered — generate one and register it first');
    }
    const pem = activeRecovery.public_key;
    return {
      mode,
      targetFingerprint: recoveryFingerprint(pem),
      // Compares the RECOVERY half: the operational wrap is not touched.
      currentOf: (fps) => fps.recovery,
      transform: (envelope) => fieldCrypto.resealToRecoveryKey(envelope, pem, { recoveryPrivateKey }),
    };
  }

  if (!newKey) {
    throw mkErr(400, 'NEW_KEY_REQUIRED', 'a new operational key is required for this mode');
  }
  const targetFingerprint = operationalFingerprint(newKey);

  if (mode === 'recover') {
    if (!recoveryPrivateKey) {
      throw mkErr(400, 'RECOVERY_KEY_REQUIRED',
        'recover needs the recovery private key — the operational key is what it replaces');
    }
    return {
      mode,
      targetFingerprint,
      currentOf: (fps) => fps.operational,
      transform: (env) => fieldCrypto.rewrapToOperationalKey(env, newKey, { recoveryPrivateKey }),
    };
  }

  /*
   * rotate. The unwrapping key is the one the PROCESS is running with — that is
   * the entire meaning of "the current key still works", and it is why this
   * path asks the operator for nothing but the new key. If it is absent or
   * wrong, the answer is `recover`, not a prompt for a master key here.
   */
  const currentKey = process.env.EASYFIX_FIELD_ENC_KEY;
  if (!currentKey) {
    throw mkErr(400, 'NO_CURRENT_KEY',
      'EASYFIX_FIELD_ENC_KEY is not set, so there is no current key to unwrap with —'
      + ' use recover mode with the recovery private key');
  }
  return {
    mode,
    targetFingerprint,
    currentOf: (fps) => fps.operational,
    transform: (env) => fieldCrypto.rewrapToOperationalKey(env, newKey, { currentKey }),
  };
}

// ── VALUE-LEVEL TRANSFORM ───────────────────────────────────────────────
/*
 * One stored column value → { value, changed, seen, skipped }.
 *
 * `seen` counts envelopes examined, `skipped` those already on the target key.
 * A value that is not an envelope at all (NULL, '', or — a defect — plaintext)
 * is left strictly alone: re-keying is not the place to discover or to "fix"
 * that, and touching it would be the one write in this module that could lose
 * data.
 */
function transformScalar(value, plan) {
  if (!fieldCrypto.isEncrypted(value)) return { value, changed: false, seen: 0, skipped: 0 };
  const current = plan.currentOf(envelopeFingerprints(value));
  if (current && current === plan.targetFingerprint) {
    return { value, changed: false, seen: 1, skipped: 1 };
  }
  return { value: plan.transform(value), changed: true, seen: 1, skipped: 0 };
}

/*
 * The JSON column case. Walks the parsed structure and transforms every STRING
 * that is an envelope, wherever it sits — so `changes.bank.account_number` is
 * covered without this module knowing that `bank` or `account_number` exist,
 * and so is whatever protected key the request JSON grows next.
 *
 * Re-serialised only when something actually changed, so an untouched row's
 * JSON keeps its exact stored bytes (key order and all) rather than being
 * silently rewritten by a round trip.
 */
function transformJson(text, plan) {
  const unchanged = { value: text, changed: false, seen: 0, skipped: 0 };
  if (text == null || text === '') return unchanged;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* Not our JSON to repair. Counted nowhere and left byte-identical. */
    return unchanged;
  }

  let changed = false;
  let seen = 0;
  let skipped = 0;

  const walk = (node) => {
    if (typeof node === 'string') {
      const r = transformScalar(node, plan);
      seen += r.seen;
      skipped += r.skipped;
      if (r.changed) changed = true;
      return r.value;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };

  const next = walk(parsed);
  if (!changed) return { value: text, changed: false, seen, skipped };
  return { value: JSON.stringify(next), changed: true, seen, skipped };
}

function transformColumn(spec, value, plan) {
  return spec.json ? transformJson(value, plan) : transformScalar(value, plan);
}

// ── SCANNING ────────────────────────────────────────────────────────────
/*
 * One batch of candidate rows, keyed off the id column so the walk is a range
 * scan on the primary key and resumes exactly where the last batch stopped.
 * OFFSET paging would re-read everything before the cursor on every batch AND
 * would skip rows if anything were inserted mid-run.
 *
 * The identifiers are interpolated, and they are safe to interpolate because
 * they come from FIELD_GROUPS — a frozen literal in this file — and never from
 * a request. `assertGroup()` is what guarantees that: a caller cannot reach here
 * with a table name it invented. Backticks so a column that collides with a
 * reserved word (there is none today) cannot break the statement later.
 */
function selectSql(spec) {
  const cols = spec.columns.map((c) => `\`${c}\``);
  const notNull = spec.columns.map((c) => `\`${c}\` IS NOT NULL`).join(' OR ');
  return `SELECT \`${spec.idColumn}\` AS __id, ${cols.join(', ')}`
    + ` FROM ${spec.table}`
    + ` WHERE \`${spec.idColumn}\` > ? AND (${notNull})`
    + ` ORDER BY \`${spec.idColumn}\` LIMIT ?`;
}

function assertGroup(group) {
  const def = FIELD_GROUPS[group];
  if (!def) {
    throw mkErr(400, 'UNKNOWN_GROUP', `unknown field group "${group}" — expected one of ${GROUP_KEYS.join(', ')}`);
  }
  return def;
}

/*
 * Walk one table in batches, handing every row to `onRow`. Shared by the dry
 * run and the real run so the two can never disagree about WHICH ROWS ARE IN
 * SCOPE — a dry run that counted a different set from the one the run touches
 * would be worse than no dry run, because it would be believed.
 */
async function scanTable(spec, runner, onRow) {
  const sql = selectSql(spec);
  let cursor = 0;
  let rows = 0;
  for (;;) {
    const [batch] = await runner.query(sql, [cursor, BATCH]);
    if (!batch || !batch.length) break;
    for (const row of batch) {
      cursor = row.__id;
      rows++;
      // An onRow that returns exactly `false` stops the walk. Used by the
      // pre-flight, which wants ONE row and would otherwise read the whole table
      // a second time on every run to learn nothing after the first hit.
      if (await onRow(row) === false) return rows;
    }
    if (batch.length < BATCH) break;
  }
  return rows;
}

// ── DRY RUN ─────────────────────────────────────────────────────────────
/*
 * Reports what a run would do, and WRITES NOTHING. It never decrypts and never
 * needs a key of any kind: every question it answers is answered by the
 * fingerprints the envelopes carry.
 *
 * WHY IT DOES NOT TAKE THE NEW KEY. The dry run exists so an operator can see
 * the size of the job BEFORE handling key material; asking for the key here
 * would create a second endpoint that a secret is pasted into, for a report
 * that does not need it. So "the target" is expressed relative to the key the
 * process is running with, which is exactly what an operator needs to know:
 *
 *   would_change       rows holding at least one value wrapped under the ACTIVE
 *                      operational key. A `rotate` re-wraps precisely these.
 *   already_on_target  rows whose values are all wrapped under some OTHER
 *                      fingerprint. On a RESUMED rotation these are the rows the
 *                      previous run already finished — the environment still
 *                      holds the old key at that point, so they read as "other".
 *                      They are also what `recover` exists for when the count
 *                      does not fall to zero after a completed run.
 *   fingerprints       the distribution, so "already_on_target" can be seen
 *                      collapsing into ONE new fingerprint rather than taken on
 *                      trust. Fingerprints are hash prefixes, not key material.
 */
async function dryRunReKey({ group }, runner = pool) {
  const def = assertGroup(group);
  const activeFp = activeOperationalFingerprint();
  const activeRecovery = await readActiveRecoveryKey(runner);

  const tables = [];
  for (const spec of def.tables) {
    const t = {
      table: spec.table,
      rows: 0,
      values: 0,
      would_change: 0,
      already_on_target: 0,
      fingerprints: {},
      /*
       * The RECOVERY-key distribution, reported alongside the operational one
       * because it is what a `reseal` is judged on: after a leak the operator
       * needs to watch the leaked fingerprint's count fall to zero, and no other
       * number tells them that.
       */
      recovery_fingerprints: {},
    };
    t.rows = await scanTable(spec, runner, (row) => {
      let onActive = 0;
      let onOther = 0;
      for (const col of spec.columns) {
        const collect = (v) => {
          if (!fieldCrypto.isEncrypted(v)) return;
          t.values++;
          const fps = envelopeFingerprints(v);
          const fp = fps.operational || 'unknown';
          t.fingerprints[fp] = (t.fingerprints[fp] || 0) + 1;
          const rfp = fps.recovery || 'unknown';
          t.recovery_fingerprints[rfp] = (t.recovery_fingerprints[rfp] || 0) + 1;
          if (activeFp && fp === activeFp) onActive++; else onOther++;
        };
        if (spec.json) collectJsonEnvelopes(row[col], collect);
        else collect(row[col]);
      }
      if (onActive) t.would_change++;
      else if (onOther) t.already_on_target++;
    });
    tables.push(t);
  }

  const totals = tables.reduce((a, t) => ({
    rows: a.rows + t.rows,
    values: a.values + t.values,
    would_change: a.would_change + t.would_change,
    already_on_target: a.already_on_target + t.already_on_target,
  }), { rows: 0, values: 0, would_change: 0, already_on_target: 0 });

  logger.info('Field re-key DRY RUN · group=' + group + ' rows=' + totals.rows
    + ' would_change=' + totals.would_change + ' already_on_target=' + totals.already_on_target);

  return {
    group,
    label: def.label,
    active_key_fingerprint: activeFp,
    active_recovery_key_fingerprint: activeRecovery ? activeRecovery.fingerprint : null,
    tables,
    totals,
  };
}

/* Feed every envelope STRING nested anywhere in a JSON column to `sink`. */
function collectJsonEnvelopes(text, sink) {
  if (text == null || text === '') return;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return; }
  const walk = (node) => {
    if (typeof node === 'string') return sink(node);
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') return Object.values(node).forEach(walk);
    return undefined;
  };
  walk(parsed);
}

// ── PRE-FLIGHT ──────────────────────────────────────────────────────────
/*
 * The FIRST envelope in the group that is not already on the target key, or
 * null when every one of them is.
 *
 * Deliberately "first one that still needs doing" rather than "first one at
 * all": a RESUMED run legitimately starts on rows a previous attempt already
 * finished, and probing those would either refuse a valid resume or test the
 * key against a value it is no longer meant to open.
 */
async function findPendingEnvelope(def, plan, runner) {
  for (const spec of def.tables) {
    let found = null;
    await scanTable(spec, runner, (row) => {
      for (const col of spec.columns) {
        const consider = (v) => {
          if (found || !fieldCrypto.isEncrypted(v)) return;
          if (plan.currentOf(envelopeFingerprints(v)) !== plan.targetFingerprint) found = v;
        };
        if (spec.json) collectJsonEnvelopes(row[col], consider);
        else consider(row[col]);
      }
      return found ? false : undefined;   // stop the walk at the first hit
    });
    if (found) return found;
  }
  return null;
}

/*
 * PROVE THE KEYS BEFORE WRITING ANYTHING.
 *
 * Both checks are about the same failure: a run that reports success while
 * having achieved nothing, or that fails halfway with the table in two states.
 *
 *   1. NOTHING LEFT TO DO. For `reseal` this is an ERROR, not a no-op. An
 *      operator re-sealing after a leak who sees "0 rows changed" cannot tell
 *      whether they are safe or whether they forgot to generate a new keypair —
 *      and the second is by far the likelier. So it fails, naming the
 *      fingerprint the rows already carry. For `rotate` / `recover`, "already
 *      done" is exactly what idempotency is supposed to look like on a re-run,
 *      so it returns an honest zero.
 *
 *   2. THE SUPPLIED KEY MUST ACTUALLY WORK. One envelope is transformed IN
 *      MEMORY and thrown away. A wrong recovery private key, or a `rotate`
 *      whose current key does not match what the rows name, fails here on one
 *      row with nothing written — rather than after re-wrapping some fraction
 *      of the table and leaving the operator to work out where it stopped.
 *
 * The cause is deliberately NOT chained onto the thrown error. It comes from a
 * crypto primitive that was handed key material, and an error that travels to a
 * client and to a log is not a place to risk any of it appearing.
 */
function preflight(plan, probe) {
  if (!probe) {
    if (plan.mode !== 'reseal') return;
    throw mkErr(409, 'RESEAL_NO_OP',
      `every protected value is already sealed to the active recovery key ${plan.targetFingerprint}`
      + ' — this run would change nothing. If the old recovery key leaked, generate a NEW keypair,'
      + ' register it, and re-seal to that.');
  }
  try {
    plan.transform(probe);
  } catch {
    throw plan.mode === 'rotate'
      ? mkErr(400, 'CURRENT_KEY_MISMATCH',
        'the running EASYFIX_FIELD_ENC_KEY cannot unwrap these values, so a rotate cannot'
        + ' re-wrap them — use recover mode with the recovery private key')
      : mkErr(400, 'RECOVERY_KEY_MISMATCH',
        'that recovery private key does not open these values — it is not the private half of'
        + ' the recovery key they were sealed to. Nothing was written.');
  }
}

// ── THE RUN ─────────────────────────────────────────────────────────────
/*
 * Re-key one group. Returns a summary carrying counts and FINGERPRINTS ONLY —
 * no key, no PEM, no ciphertext, nothing that could be replayed.
 *
 * The audit row is written in a `finally`, so a run that dies at row 40,000
 * still records the 39,999 rows it changed. An audit written only on success is
 * the audit that is missing from precisely the incident it exists to explain.
 * The pre-flight sits INSIDE that try for the same reason: an attempt to unseal
 * the company's data with a guessed recovery key must leave a trace even though
 * it wrote nothing.
 */
async function runReKey(params, actor, runner = pool, ipAddress = null) {
  const def = assertGroup(params.group);
  const activeRecovery = params.mode === 'reseal' ? await readActiveRecoveryKey(runner) : null;
  const plan = resolvePlan(params, activeRecovery);

  const summary = {
    group: params.group,
    label: def.label,
    mode: plan.mode,
    target_fingerprint: plan.targetFingerprint,
    recovery_mode_used: plan.mode !== 'rotate',
    tables: [],
    totals: { rows: 0, values: 0, changed: 0, skipped: 0 },
  };

  try {
    preflight(plan, await findPendingEnvelope(def, plan, runner));

    for (const spec of def.tables) {
      /*
       * The per-table counter is attached to the summary and incremented in
       * step with the totals, BEFORE the scan rather than after it. A run that
       * dies mid-table must still report what it managed — the audit row is
       * built from these numbers, and accumulating them only on a clean exit
       * would file "0 rows changed" for a run that had already re-wrapped
       * thousands, which is worse than no number at all.
       */
      const t = { table: spec.table, rows: 0, values: 0, changed: 0, skipped: 0 };
      summary.tables.push(t);

      await scanTable(spec, runner, async (row) => {
        t.rows++;
        summary.totals.rows++;
        const sets = [];
        const args = [];
        for (const col of spec.columns) {
          const r = transformColumn(spec, row[col], plan);
          t.values += r.seen;
          t.skipped += r.skipped;
          summary.totals.values += r.seen;
          summary.totals.skipped += r.skipped;
          if (!r.changed) continue;
          sets.push(`\`${col}\` = ?`);
          args.push(r.value);
        }
        if (!sets.length) return;   // already on the target key — nothing to do
        /*
         * ONE STATEMENT PER ROW, on the pool: its own implicit transaction, its
         * own commit. Both columns of a row move together (a row half re-keyed
         * would still be readable, but there is no reason to leave one), and
         * nothing is held across rows.
         */
        await runner.query(
          `UPDATE ${spec.table} SET ${sets.join(', ')} WHERE \`${spec.idColumn}\` = ?`,
          [...args, row.__id],
        );
        t.changed++;
        summary.totals.changed++;
      });
    }
    return summary;
  } finally {
    await auditRun(summary, actor, runner, ipAddress);
  }
}

/*
 * ONE audit row per RUN — not per record. A bulk re-key touches every protected
 * value in the company, and forty thousand rows in tbl_sensitive_reveal_log
 * would bury the per-reveal rows that table exists for while adding nothing:
 * the run is the event.
 *
 * The table has six columns and this event has more facts than that, so the
 * group and the mode are PACKED INTO `context` as `field_rekey:<group>:<mode>`
 * (well inside VARCHAR(64)) and the row count goes in `ref_id`. Search with
 * `WHERE context LIKE 'field_rekey%'`. Widening a shared audit table for one
 * caller is the alternative, and hrms-03's whole argument is that this table
 * stops being altered.
 *
 * subject_user_id is 0: the column is NOT NULL and this run has no single
 * subject. The actor's own id would read as a self-reveal, which is the one
 * thing a bulk re-key is not.
 *
 * NEVER RECORDED: the recovery private key, the new operational key, or any
 * part of either. `recovery_mode_used` is in the log LINE below — that a
 * break-glass key was used is the fact worth keeping; the key is not.
 */
async function auditRun(summary, actor, runner, ipAddress) {
  const actorId = (actor && actor.user_id) || 0;
  try {
    await recordReveal(runner, {
      actorUserId: actorId,
      subjectUserId: 0,
      context: `field_rekey:${summary.group}:${summary.mode}`,
      refId: summary.totals.changed,
      ipAddress,
    });
  } catch (e) {
    // An audit failure must not swallow the run's own error, nor hide that the
    // trace is missing. Logged loudly; never rethrown from a finally.
    logger.error('Field re-key AUDIT ROW FAILED · group=' + summary.group
      + ' mode=' + summary.mode + ' changed=' + summary.totals.changed + ' · ' + e.message);
  }
  logger.warn('Field re-key run · actor=' + actorId + ' group=' + summary.group
    + ' mode=' + summary.mode + ' target_fp=' + summary.target_fingerprint
    + ' rows=' + summary.totals.rows + ' changed=' + summary.totals.changed
    + ' skipped=' + summary.totals.skipped
    + ' recovery_mode=' + summary.recovery_mode_used
    + ' ip=' + (ipAddress || '-'));
}

// ── THE RECOVERY PUBLIC KEY STORE ───────────────────────────────────────
/*
 * Register a NEW recovery public key and make it the active one.
 *
 * ONLY THE PUBLIC HALF EVER ARRIVES HERE. The private half is generated in the
 * operator's browser with WebCrypto, shown once, and never posted — a
 * server-side generator would put the very thing this protects into the place
 * it is being protected from, and would then have to be trusted not to keep it.
 * This function therefore has no code path that could receive a private key,
 * and the parse below REJECTS one: crypto.createPublicKey() on a PKCS#8 private
 * PEM yields the public half rather than throwing, so the check is on what the
 * PEM DECLARES ITSELF to be, before anything is stored.
 *
 * "EXACTLY ONE ACTIVE" IS HELD HERE, UNDER A TRANSACTION, because MySQL cannot
 * express it (see migrations/2026-09-01-hrms-06-recovery-key-store.sql for the
 * three shapes that look like they can and are each worse). The transaction is
 * the load-bearing part: deactivate-then-insert without one leaves a window
 * with ZERO active keys, and every encrypted WRITE fails closed during it.
 */
const PRIVATE_PEM_RE = /-----BEGIN[A-Z ]*PRIVATE KEY-----/;
const MIN_RECOVERY_MODULUS_BITS = 2048;

async function storeRecoveryPublicKey({ publicKeyPem }, actor, runner = pool) {
  /*
   * CRLF → LF before anything looks at it. OpenSSL's PEM decoder rejects a
   * CRLF-wrapped key with "DECODER routines::unsupported", which reads as "your
   * key is broken" rather than "your key came through a Windows editor" — and a
   * key pasted through a browser form arrives that way routinely. The
   * fingerprint is over the DER, so the normalisation cannot move it.
   */
  const pem = String(publicKeyPem || '').replace(/\r\n/g, '\n').trim();
  if (PRIVATE_PEM_RE.test(pem)) {
    /*
     * The message names no part of the input. It exists to catch the paste
     * mistake that would otherwise put a private key in a database column — the
     * exact inversion this whole feature is built to prevent.
     */
    throw mkErr(400, 'PRIVATE_KEY_SUBMITTED',
      'that is a PRIVATE key. Only the PUBLIC half is registered here — the private half'
      + ' must never leave the browser it was generated in');
  }

  let key;
  try {
    key = crypto.createPublicKey(pem);
  } catch {
    // The parser's own message is not surfaced: it can quote the offending
    // bytes, and this input is a key.
    throw mkErr(400, 'INVALID_PUBLIC_KEY', 'that did not parse as a public key PEM');
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw mkErr(400, 'INVALID_PUBLIC_KEY',
      `the recovery key must be RSA, got ${key.asymmetricKeyType} — RSA-OAEP is the sealing scheme`);
  }
  const bits = (key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength) || 0;
  if (bits < MIN_RECOVERY_MODULUS_BITS) {
    throw mkErr(400, 'WEAK_PUBLIC_KEY',
      `the recovery key is ${bits}-bit; the minimum is ${MIN_RECOVERY_MODULUS_BITS}`
      + ' and 4096 is recommended for a key this long-lived');
  }

  const fingerprint = recoveryFingerprint(pem);
  const conn = await runner.getConnection();
  try {
    await conn.beginTransaction();

    const [[existing]] = await conn.query(
      'SELECT id, is_active, created_on FROM tbl_field_recovery_key WHERE fingerprint = ? FOR UPDATE',
      [fingerprint],
    );
    if (existing && existing.is_active) {
      // Idempotent: registering the live key again is a no-op, not an error.
      await conn.commit();
      return { fingerprint, created_on: existing.created_on, already_active: true };
    }
    if (existing) {
      /*
       * Deliberately NOT reactivated. A superseded key is superseded for a
       * reason — usually that it leaked — and silently making it live again on
       * a re-paste would undo the rotation it was retired by.
       */
      throw mkErr(409, 'RECOVERY_KEY_SUPERSEDED',
        'that key was registered before and has since been superseded — generate a new keypair');
    }

    const now = new Date();
    await conn.query('UPDATE tbl_field_recovery_key SET is_active = 0 WHERE is_active = 1');
    await conn.query(
      `INSERT INTO tbl_field_recovery_key (fingerprint, public_key, is_active, created_on, created_by)
       VALUES (?, ?, 1, ?, ?)`,
      [fingerprint, pem, now, (actor && actor.user_id) || null],
    );

    await conn.commit();
    logger.warn('Recovery public key registered · fingerprint=' + fingerprint
      + ' actor=' + ((actor && actor.user_id) || '-')
      + ' — rows written BEFORE now are still sealed to the previous key; run mode=reseal'
      + ' with the OLD private key to move them');
    await primeRecoveryKey(runner);
    return { fingerprint, created_on: now, already_active: false };
  } catch (e) {
    try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
    throw e;
  } finally {
    conn.release();
  }
}

/* The active row INCLUDING the PEM. Internal — reseal needs the key itself. */
async function readActiveRecoveryKey(runner = pool) {
  const [[row]] = await runner.query(
    `SELECT id, fingerprint, public_key, created_on, created_by
       FROM tbl_field_recovery_key WHERE is_active = 1 ORDER BY id DESC LIMIT 1`,
  );
  return row || null;
}

/*
 * THE STORE ADAPTER lib/field-crypto.js CONSUMES.
 *
 * That module owns the KEY; this one owns the TABLE, and this object is the
 * whole of the seam between them — two methods returning rows whose shape it
 * reads directly (`public_key`, cross-checked against `fingerprint`). It is a
 * plain object rather than a query because field-crypto must not carry SQL for
 * a table it does not own, and this service must not carry PEM parsing for a
 * key it does not interpret.
 *
 * Exported so the BOOT sequence can prime the key from the database before the
 * first encrypted write. ⚠ WITHOUT THAT CALL, field-crypto falls back to
 * EASYFIX_FIELD_RECOVERY_PUBLIC_KEY and rows are sealed to the ENV key no
 * matter what this table says — the store would be write-only, and a rotation
 * performed through the UI would silently not take. One line in server.js:
 *   await fieldCrypto.resolveRecoveryPublicKey(recoveryKeyStore());
 */
function recoveryKeyStore(runner = pool) {
  return {
    activeRecoveryKey: () => readActiveRecoveryKey(runner),
    recoveryKeyByFingerprint: async (fp) => {
      const [[row]] = await runner.query(
        `SELECT id, fingerprint, public_key, created_on, created_by
           FROM tbl_field_recovery_key WHERE fingerprint = ? LIMIT 1`,
        [fp],
      );
      return row || null;
    },
  };
}

/*
 * Re-point this process at the newly registered key, so the very next encrypted
 * write seals to it WITHOUT a restart. Putting the key in the database instead
 * of env is pointless otherwise — a rotation that needs a deploy is the thing
 * that design exists to avoid.
 *
 * FAIL-SOFT, and only here. The registration has already COMMITTED; throwing now
 * would report a failure for a key that is live in the table, and the operator
 * would register it again. A failed re-prime means this process keeps sealing to
 * the previous key until it restarts — visible, recoverable, and loudly logged.
 *
 * ⚠ ONE PROCESS. Other replicas keep the old key until they restart or run their
 * own boot prime. Registration is a once-in-years operation, so a rolling
 * restart afterwards is the intended sequence rather than a gap to engineer
 * around; new rows written by a stale replica in the meantime are sealed to the
 * PREVIOUS key, which is still a valid recovery path, not a lost one.
 */
async function primeRecoveryKey(runner) {
  try {
    const desc = await fieldCrypto.resolveRecoveryPublicKey(recoveryKeyStore(runner));
    logger.info('Recovery key primed from the store · fingerprint=' + desc.fingerprint
      + ' source=' + desc.source);
  } catch (e) {
    logger.error('Recovery key registered but this process could NOT re-prime from it ·'
      + ' new writes keep sealing to the previous key until restart · ' + e.message);
  }
}

/*
 * What the GET endpoint returns: the fingerprint and when it was registered.
 * The PEM is public and would be harmless, but it is also not an answer to any
 * question the screen asks — the operator already has it — so it is not shipped.
 */
async function getActiveRecoveryKey(runner = pool) {
  const row = await readActiveRecoveryKey(runner);
  if (!row) return null;
  return { fingerprint: row.fingerprint, created_on: row.created_on };
}

module.exports = {
  FIELD_GROUPS,
  GROUP_KEYS,
  REKEY_MODES,
  dryRunReKey,
  runReKey,
  storeRecoveryPublicKey,
  getActiveRecoveryKey,
  // The seam lib/field-crypto.js reads the store through. Call it at BOOT —
  // see the note on recoveryKeyStore().
  recoveryKeyStore,
  // Exported for the tests that pin the fingerprint contract with
  // lib/field-crypto.js and the envelope-head parse.
  _internals: { operationalFingerprint, recoveryFingerprint, envelopeFingerprints },
};
