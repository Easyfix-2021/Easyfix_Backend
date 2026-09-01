'use strict';

/*
 * field-rekey — the bulk re-key of every field-crypto data key.
 *
 * ─── WHAT THIS FILE IS FOR ──────────────────────────────────────────────
 *
 * This is the operation that touches every protected value in the company, and
 * it is performed a handful of times in the life of the system — which means it
 * is almost never exercised by hand, and the day it IS exercised is a day
 * somebody has already lost a key or leaked one. There is no acceptable way to
 * find out then that `reseal` also rewrote the operational wrap, or that a
 * resumed run re-wrapped rows it had already finished, or that the pasted
 * recovery key came back in the response body.
 *
 * So the properties pinned below are the ones that are expensive to be wrong
 * about rather than the ones that are easy to assert:
 *
 *   · the dry run writes NOTHING
 *   · `rotate` needs no recovery key, and `recover` works when the operational
 *     key is wrong or absent — the two halves of "the master key is optional"
 *   · `reseal` leaves the operational wrap and the value ciphertext byte
 *     identical, so normal reads keep working through it
 *   · a row already on the target fingerprint is SKIPPED, by fingerprint and
 *     not by any progress flag
 *   · an interrupted run re-runs to completion without touching what it already
 *     did — the property that makes a partial failure survivable
 *   · the REQUEST TABLE is in the `bank` group, asserted on the SQL actually
 *     issued rather than on a registry lookup, because the registry agreeing
 *     with itself proves nothing
 *   · exactly one recovery key stays active, under a transaction
 *   · THE PASTED PRIVATE KEY APPEARS IN NO LOG LINE, NO RESPONSE BODY AND NO
 *     AUDIT ROW
 *
 * ─── HOW IT AVOIDS A DATABASE AND THE REAL CIPHER ───────────────────────
 *
 * fake-pool for the DB, and lib/field-crypto's rewrap/reseal/isEncrypted are
 * STUBBED on the module object (the service calls them through the namespace,
 * so the stub takes) with faithful, checkable stand-ins: the fake rewrap
 * verifies the key it was handed really is the one the envelope names, and
 * returns an envelope with only the intended field changed. That keeps these
 * tests about the RE-KEY MACHINERY — batching, idempotency, ordering, leakage —
 * and immune to lib/field-crypto's envelope layout, which is being finished in
 * parallel. The cipher has its own tests; this file must not become a second
 * copy of them.
 *
 * The RSA keys are real, and generated once: "is this the private half of the
 * key this row was sealed to" is precisely the question the pre-flight exists
 * to answer, and a fake would let it answer wrongly.
 *
 * Non-destructive: no DB, no network. Runner: `npm test`.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { installFakePool } = require('./helpers/fake-pool');

// ── The in-memory tables the fake pool serves ───────────────────────────
const store = {
  personal: [],
  requests: [],
  recoveryKeys: [],
  audit: [],
  txn: [],
};

/* `UPDATE t SET `a` = ?, `b` = ? WHERE `id` = ?` → the columns it writes. */
function setColumns(sql) {
  return [...sql.matchAll(/`([A-Za-z0-9_]+)` = \?/g)].map((m) => m[1]);
}

function selectRows(rows, idCol, columns, params) {
  const [cursor, limit] = params;
  return rows
    .filter((r) => r[idCol] > cursor && columns.some((c) => r[c] != null))
    .sort((a, b) => a[idCol] - b[idCol])
    .slice(0, limit)
    .map((r) => {
      const out = { __id: r[idCol] };
      for (const c of columns) out[c] = r[c];
      return out;
    });
}

function applyUpdate(rows, idCol, sql, params) {
  const cols = setColumns(sql);
  const id = params[params.length - 1];
  const row = rows.find((r) => r[idCol] === id);
  cols.forEach((c, i) => { row[c] = params[i]; });
  return { affectedRows: 1 };
}

/*
 * Set by a test that wants the Nth write to blow up, so "an interrupted run
 * re-runs to completion" can be driven by a real mid-run failure rather than by
 * a hand-built half-finished fixture.
 */
let failWriteAfter = null;
let writeCount = 0;

const fake = installFakePool([
  // ── the recovery key store ────────────────────────────────────────────
  /* Serves BOTH fingerprint lookups: storeRecoveryPublicKey's `… FOR UPDATE`
   * and the store adapter's plain read. */
  [/FROM tbl_field_recovery_key WHERE fingerprint = \?/i, (_sql, p) => {
    const row = store.recoveryKeys.find((k) => k.fingerprint === p[0]);
    return row ? [row] : [];
  }],
  [/FROM tbl_field_recovery_key WHERE is_active = 1/i,
    () => store.recoveryKeys.filter((k) => k.is_active)],
  [/UPDATE tbl_field_recovery_key SET is_active = 0/i, () => {
    store.recoveryKeys.forEach((k) => { k.is_active = 0; });
    return { affectedRows: 1 };
  }],
  [/INSERT INTO tbl_field_recovery_key/i, (_sql, p) => {
    store.recoveryKeys.push({
      id: store.recoveryKeys.length + 1,
      fingerprint: p[0], public_key: p[1], is_active: 1, created_on: p[2], created_by: p[3],
    });
    return { insertId: store.recoveryKeys.length };
  }],

  // ── the audit trail ───────────────────────────────────────────────────
  [/INSERT INTO tbl_sensitive_reveal_log/i, (sql, p) => {
    store.audit.push({ sql, params: p });
    return { insertId: store.audit.length };
  }],

  // ── the protected columns ─────────────────────────────────────────────
  [/^UPDATE tbl_user_personal_details/i, (sql, p) => {
    writeCount++;
    if (failWriteAfter !== null && writeCount > failWriteAfter) throw new Error('__DISK_FULL__');
    return applyUpdate(store.personal, 'user_id', sql, p);
  }],
  [/^UPDATE tbl_user_profile_update_request/i, (sql, p) => {
    writeCount++;
    if (failWriteAfter !== null && writeCount > failWriteAfter) throw new Error('__DISK_FULL__');
    return applyUpdate(store.requests, 'request_id', sql, p);
  }],
  [/FROM tbl_user_personal_details/i, (_sql, p) =>
    selectRows(store.personal, 'user_id', ['bank_account_number', 'bank_account_name'], p)],
  [/FROM tbl_user_profile_update_request/i, (_sql, p) =>
    selectRows(store.requests, 'request_id', ['changes', 'old_values'], p)],

  // ── requireAction → getEffectivePermissions, all three statements ─────
  [/SELECT user_role FROM tbl_user/i, [{ user_role: 2 }]],
  [/FROM tbl_role/i, [{ role_id: 2, role_name: 'Admin', role_status: 1, menu_ids: '' }]],
  [/ma\.action_name/i, [{ action_name: 'isFieldRekeyRun' }, { action_name: 'isRecoveryKeyManage' }]],
]);

/*
 * The fake connection's beginTransaction/commit/rollback are no-ops that record
 * nothing, and "exactly one active recovery key" is a claim about a
 * TRANSACTION. So the seam is widened by one wrapper rather than asserted
 * around: without this, the test could not tell an atomic swap from a
 * deactivate that happened to be followed by an insert.
 */
const db = require('../db');
const bareGetConnection = db.pool.getConnection;
db.pool.getConnection = async () => {
  const conn = await bareGetConnection();
  return Object.assign({}, conn, {
    beginTransaction: async () => { store.txn.push('begin'); },
    commit: async () => { store.txn.push('commit'); },
    rollback: async () => { store.txn.push('rollback'); },
  });
};

// ── logger capture — the leak test's primary sink ───────────────────────
const logger = require('../logger');
const realLog = { info: logger.info, warn: logger.warn, error: logger.error, db: logger.db };
let logLines = [];
function captureLogger() {
  const grab = (a, b) => { logLines.push(JSON.stringify(a) + ' ' + JSON.stringify(b || '')); };
  logger.info = grab; logger.warn = grab; logger.error = grab; logger.db = grab;
}

// ── field-crypto stubs ──────────────────────────────────────────────────
const fieldCrypto = require('../lib/field-crypto');
const realCrypto = {
  isEncrypted: fieldCrypto.isEncrypted,
  rewrapToOperationalKey: fieldCrypto.rewrapToOperationalKey,
  resealToRecoveryKey: fieldCrypto.resealToRecoveryKey,
};

const svc = require('../services/field-rekey.service');
const { operationalFingerprint, recoveryFingerprint, envelopeFingerprints } = svc._internals;

/* `v2:<operational fp>:<recovery fp>:<value ciphertext>` — enough head for the
 * service to read, and a tail it must never touch. */
const mkEnv = (opFp, recFp, ct) => `v2:${opFp}:${recFp}:${ct}`;
const part = (env, i) => String(env).split(':')[i];

/*
 * The recovery fingerprint a PRIVATE key corresponds to. crypto.createPublicKey
 * derives the public half from a PKCS#8 PEM, so recoveryFingerprint() answers
 * this directly — and identically to the value taken from the matching SPKI
 * PEM, which is what makes "is this the private half of that key" checkable.
 * (Handing it an already-public KeyObject throws, so do not "simplify" this.)
 */
const recFpOfPrivate = (pem) => recoveryFingerprint(pem);

let OLD_KEY;      // base64 operational key the fixtures are wrapped under
let NEW_KEY;      // base64 operational key a rotation targets
let OLD_FP;
let NEW_FP;
let oldRecovery;  // { publicKey, privateKey } — what the rows are sealed to
let newRecovery;  // the replacement, registered as active in the store
let OLD_REC_FP;
let NEW_REC_FP;

before(() => {
  captureLogger();

  OLD_KEY = crypto.randomBytes(32).toString('base64');
  NEW_KEY = crypto.randomBytes(32).toString('base64');
  OLD_FP = operationalFingerprint(OLD_KEY);
  NEW_FP = operationalFingerprint(NEW_KEY);

  const gen = () => crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  oldRecovery = gen();
  newRecovery = gen();
  OLD_REC_FP = recoveryFingerprint(oldRecovery.publicKey);
  NEW_REC_FP = recoveryFingerprint(newRecovery.publicKey);

  fieldCrypto.isEncrypted = (v) => typeof v === 'string' && v.startsWith('v2:');

  /*
   * Faithful stand-ins. Each REFUSES a key that does not match what the
   * envelope names — which is what lets the pre-flight tests below mean
   * something — and changes exactly one field, leaving the value ciphertext
   * byte identical.
   */
  fieldCrypto.rewrapToOperationalKey = (env, newKey, opts = {}) => {
    if (opts.currentKey) {
      if (operationalFingerprint(opts.currentKey) !== part(env, 1)) {
        throw new Error('current key does not match this envelope');
      }
    } else if (opts.recoveryPrivateKey) {
      if (recFpOfPrivate(opts.recoveryPrivateKey) !== part(env, 2)) {
        throw new Error('recovery key does not open this envelope');
      }
    } else {
      throw new Error('no unwrapping key supplied');
    }
    return mkEnv(operationalFingerprint(newKey), part(env, 2), part(env, 3));
  };

  fieldCrypto.resealToRecoveryKey = (env, newPem, opts = {}) => {
    if (!opts.recoveryPrivateKey) throw new Error('no recovery key supplied');
    if (recFpOfPrivate(opts.recoveryPrivateKey) !== part(env, 2)) {
      throw new Error('recovery key does not open this envelope');
    }
    return mkEnv(part(env, 1), recoveryFingerprint(newPem), part(env, 3));
  };
});

after(() => {
  Object.assign(logger, realLog);
  Object.assign(fieldCrypto, realCrypto);
  db.pool.getConnection = bareGetConnection;
  fake.restore();
});

// ── Fixtures ────────────────────────────────────────────────────────────
/*
 * Four users and two approval requests, all wrapped under OLD_KEY and sealed to
 * OLD_REC_FP. User 3 carries no bank details at all (the majority case in
 * production) and must never be selected.
 */
function seed({ alreadyRotated = [] } = {}) {
  const opFor = (id) => (alreadyRotated.includes(id) ? NEW_FP : OLD_FP);
  store.personal = [1, 2, 3, 4].map((id) => (id === 3
    ? { user_id: id, bank_account_number: null, bank_account_name: null }
    : {
      user_id: id,
      bank_account_number: mkEnv(opFor(id), OLD_REC_FP, `ACCT${id}`),
      bank_account_name: mkEnv(opFor(id), OLD_REC_FP, `NAME${id}`),
    }));

  store.requests = [10, 11].map((id) => ({
    request_id: id,
    changes: JSON.stringify({
      mobile_no: '9876543210',
      bank: {
        account_number: mkEnv(OLD_FP, OLD_REC_FP, `REQACCT${id}`),
        ifsc: 'HDFC0001234',
        account_name: mkEnv(OLD_FP, OLD_REC_FP, `REQNAME${id}`),
        bank_name: 'HDFC Bank',
        account_last4: '4321',
      },
    }),
    old_values: null,
  }));

  store.recoveryKeys = [{
    id: 1,
    fingerprint: NEW_REC_FP,
    public_key: newRecovery.publicKey,
    is_active: 1,
    created_on: new Date('2026-09-01T10:00:00'),
    created_by: 7,
  }];
  store.audit = [];
  store.txn = [];
}

beforeEach(() => {
  process.env.EASYFIX_FIELD_ENC_KEY = OLD_KEY;
  failWriteAfter = null;
  writeCount = 0;
  logLines = [];
  fake.reset();
  seed();
});

const ACTOR = { user_id: 7, user_name: 'Shaifali' };

/* Every write of any kind — used where the claim is "this wrote NOTHING". */
const writes = () => fake.calls.filter((c) => /^\s*(UPDATE|INSERT|DELETE)/i.test(c.sql));

/*
 * Writes to the DATA, excluding the audit row. A refused run deliberately still
 * files its audit row, so "nothing was written" about a run always means
 * "nothing was written TO THE PROTECTED COLUMNS".
 */
const dataWrites = () => writes().filter((c) => !/tbl_sensitive_reveal_log/i.test(c.sql));

// ════════════════════════════════════════════════════════════════════════
// 1. THE DRY RUN WRITES NOTHING
// ════════════════════════════════════════════════════════════════════════
test('dry run writes nothing and reports what a rotation would touch', async () => {
  const report = await svc.dryRunReKey({ group: 'bank' });

  assert.deepEqual(writes(), [], 'a dry run must issue no write of any kind');
  assert.equal(report.active_key_fingerprint, OLD_FP);
  assert.equal(report.active_recovery_key_fingerprint, NEW_REC_FP);
  // 3 users with details + 2 requests. User 3 has none and is not selected.
  assert.equal(report.totals.rows, 5);
  assert.equal(report.totals.would_change, 5);
  assert.equal(report.totals.already_on_target, 0);
  // 6 personal values + 4 nested in the request JSON.
  assert.equal(report.totals.values, 10);
  assert.equal(report.tables.map((t) => t.table).join(','),
    'tbl_user_personal_details,tbl_user_profile_update_request');
});

test('dry run separates rows already carrying another fingerprint', async () => {
  seed({ alreadyRotated: [1, 2] });
  const report = await svc.dryRunReKey({ group: 'bank' });

  assert.deepEqual(writes(), []);
  assert.equal(report.totals.would_change, 3, 'user 4 + the two requests are still on the old key');
  assert.equal(report.totals.already_on_target, 2, 'users 1 and 2 are done');
  const personal = report.tables[0];
  assert.equal(personal.fingerprints[NEW_FP], 4, 'two users × two columns already rotated');
  assert.equal(personal.fingerprints[OLD_FP], 2);
  // The recovery distribution is what a re-seal is judged on.
  assert.equal(personal.recovery_fingerprints[OLD_REC_FP], 6);
});

// ════════════════════════════════════════════════════════════════════════
// 2. ROTATE NEEDS NO RECOVERY KEY
// ════════════════════════════════════════════════════════════════════════
test('rotate re-wraps with the CURRENT key and never asks for a recovery key', async () => {
  const seen = [];
  const stub = fieldCrypto.rewrapToOperationalKey;
  fieldCrypto.rewrapToOperationalKey = (env, k, opts) => { seen.push(opts); return stub(env, k, opts); };

  const summary = await svc.runReKey({ group: 'bank', mode: 'rotate', newKey: NEW_KEY }, ACTOR);
  fieldCrypto.rewrapToOperationalKey = stub;

  assert.equal(summary.mode, 'rotate');
  assert.equal(summary.recovery_mode_used, false);
  assert.equal(summary.target_fingerprint, NEW_FP);
  assert.equal(summary.totals.changed, 5);

  assert.ok(seen.length > 0);
  assert.ok(seen.every((o) => o.currentKey === OLD_KEY),
    'rotate must unwrap with the key the process is running with');
  assert.ok(seen.every((o) => o.recoveryPrivateKey === undefined),
    'rotate must not reach for the recovery key — that is the whole design correction');

  // Every value now names the new operational key; nothing else moved.
  for (const row of store.personal.filter((r) => r.bank_account_number)) {
    assert.equal(part(row.bank_account_number, 1), NEW_FP);
    assert.equal(part(row.bank_account_number, 2), OLD_REC_FP, 'the recovery seal is untouched');
    assert.equal(part(row.bank_account_number, 3), `ACCT${row.user_id}`,
      'the VALUE ciphertext must be byte identical after a re-wrap');
  }
});

// ════════════════════════════════════════════════════════════════════════
// 3. RECOVER WORKS WHEN THE OPERATIONAL KEY IS WRONG OR ABSENT
// ════════════════════════════════════════════════════════════════════════
test('rotate refuses when there is no current key; recover does the same job with the recovery key', async () => {
  delete process.env.EASYFIX_FIELD_ENC_KEY;

  await assert.rejects(
    () => svc.runReKey({ group: 'bank', mode: 'rotate', newKey: NEW_KEY }, ACTOR),
    (e) => e.code === 'NO_CURRENT_KEY',
  );
  assert.deepEqual(dataWrites(), [], 'a refused rotate must not have written');

  const summary = await svc.runReKey({
    group: 'bank', mode: 'recover', newKey: NEW_KEY, recoveryPrivateKey: oldRecovery.privateKey,
  }, ACTOR);

  assert.equal(summary.recovery_mode_used, true);
  assert.equal(summary.totals.changed, 5);
  assert.equal(part(store.personal[0].bank_account_number, 1), NEW_FP);
});

test('recover works when the operational key in env is the WRONG one', async () => {
  process.env.EASYFIX_FIELD_ENC_KEY = crypto.randomBytes(32).toString('base64');

  await assert.rejects(
    () => svc.runReKey({ group: 'bank', mode: 'rotate', newKey: NEW_KEY }, ACTOR),
    (e) => e.code === 'CURRENT_KEY_MISMATCH',
  );
  assert.deepEqual(dataWrites(), [],
    'the pre-flight must catch a wrong key on ONE row, before any write');

  const summary = await svc.runReKey({
    group: 'bank', mode: 'recover', newKey: NEW_KEY, recoveryPrivateKey: oldRecovery.privateKey,
  }, ACTOR);
  assert.equal(summary.totals.changed, 5);
});

test('a wrong recovery private key fails the whole request before a single write', async () => {
  const stranger = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  await assert.rejects(
    () => svc.runReKey({
      group: 'bank', mode: 'recover', newKey: NEW_KEY, recoveryPrivateKey: stranger.privateKey,
    }, ACTOR),
    (e) => e.code === 'RECOVERY_KEY_MISMATCH',
  );

  assert.deepEqual(dataWrites(), []);
  assert.equal(store.audit.length, 1,
    'a failed break-glass attempt still leaves an audit row — that is the point of it');
});

// ════════════════════════════════════════════════════════════════════════
// 4. RESEAL LEAVES THE OPERATIONAL WRAP UNTOUCHED
// ════════════════════════════════════════════════════════════════════════
test('reseal moves only the recovery seal, and takes its target from the active store row', async () => {
  const before = store.personal.map((r) => r.bank_account_number);

  const summary = await svc.runReKey({
    group: 'bank', mode: 'reseal', recoveryPrivateKey: oldRecovery.privateKey,
  }, ACTOR);

  assert.equal(summary.mode, 'reseal');
  assert.equal(summary.target_fingerprint, NEW_REC_FP,
    'the target is the ACTIVE recovery key in the store — it is never pasted');
  assert.equal(summary.totals.changed, 5);

  store.personal.forEach((row, i) => {
    if (!row.bank_account_number) return;
    assert.equal(part(row.bank_account_number, 1), part(before[i], 1),
      'the OPERATIONAL wrap must be byte identical after a reseal — reads keep working');
    assert.equal(part(row.bank_account_number, 2), NEW_REC_FP);
    assert.equal(part(row.bank_account_number, 3), part(before[i], 3),
      'the value ciphertext must be byte identical');
  });
});

test('reseal REFUSES when every value is already on the active recovery key', async () => {
  // The state after a successful reseal — or after registering nothing new.
  await svc.runReKey({ group: 'bank', mode: 'reseal', recoveryPrivateKey: oldRecovery.privateKey }, ACTOR);
  fake.reset();

  await assert.rejects(
    () => svc.runReKey({
      group: 'bank', mode: 'reseal', recoveryPrivateKey: newRecovery.privateKey,
    }, ACTOR),
    (e) => e.code === 'RESEAL_NO_OP' && /generate a NEW keypair/i.test(e.message),
  );
  assert.deepEqual(dataWrites(), []);
});

test('reseal refuses when no recovery key is registered at all', async () => {
  store.recoveryKeys = [];
  await assert.rejects(
    () => svc.runReKey({
      group: 'bank', mode: 'reseal', recoveryPrivateKey: oldRecovery.privateKey,
    }, ACTOR),
    (e) => e.code === 'NO_ACTIVE_RECOVERY_KEY',
  );
});

// ════════════════════════════════════════════════════════════════════════
// 5. IDEMPOTENT BY FINGERPRINT
// ════════════════════════════════════════════════════════════════════════
test('a row already on the target fingerprint is SKIPPED, not re-wrapped', async () => {
  seed({ alreadyRotated: [1, 2] });
  fake.reset();

  const summary = await svc.runReKey({ group: 'bank', mode: 'rotate', newKey: NEW_KEY }, ACTOR);

  assert.equal(summary.totals.changed, 3, 'user 4 + two requests');
  assert.equal(summary.totals.skipped, 4, 'two users × two columns already on the new key');

  const touched = writes()
    .filter((c) => /^UPDATE tbl_user_personal_details/i.test(c.sql))
    .map((c) => c.params[c.params.length - 1]);
  assert.deepEqual(touched, [4], 'only the row that still needed it was written');
});

test('a second full run is a complete no-op', async () => {
  await svc.runReKey({ group: 'bank', mode: 'rotate', newKey: NEW_KEY }, ACTOR);
  // Rotating again to the SAME key: every row already names it.
  fake.reset();
  const again = await svc.runReKey({ group: 'bank', mode: 'rotate', newKey: NEW_KEY }, ACTOR);

  assert.equal(again.totals.changed, 0);
  assert.equal(again.totals.skipped, 10, 'every envelope examined and skipped');
  assert.deepEqual(dataWrites(), []);
});

// ════════════════════════════════════════════════════════════════════════
// 6. AN INTERRUPTED RUN RE-RUNS TO COMPLETION
// ════════════════════════════════════════════════════════════════════════
test('an interrupted run leaves every row valid and the re-run finishes the job', async () => {
  failWriteAfter = 2;   // rows 1 and 2 commit, row 4 blows up

  await assert.rejects(
    () => svc.runReKey({ group: 'bank', mode: 'rotate', newKey: NEW_KEY }, ACTOR),
    /__DISK_FULL__/,
  );

  const done = store.personal.filter((r) => r.bank_account_number
    && part(r.bank_account_number, 1) === NEW_FP);
  assert.equal(done.length, 2, 'per-row commits mean the finished rows stayed finished');
  assert.equal(store.audit.length, 1, 'a run that died still recorded itself');
  assert.equal(store.audit[0].params[3], 2, 'and recorded the PARTIAL row count');

  // Every row is individually valid: nothing is half-written.
  for (const r of store.personal) {
    if (!r.bank_account_number) continue;
    assert.equal(part(r.bank_account_number, 1), part(r.bank_account_name, 1),
      'both columns of a row moved together');
  }

  // The re-run picks up exactly the remainder.
  failWriteAfter = null;
  writeCount = 0;
  fake.reset();
  const resumed = await svc.runReKey({ group: 'bank', mode: 'rotate', newKey: NEW_KEY }, ACTOR);

  assert.equal(resumed.totals.changed, 3, 'user 4 and the two requests');
  assert.equal(resumed.totals.skipped, 4, 'the two rows the first attempt finished');
  assert.ok(store.personal.filter((r) => r.bank_account_number)
    .every((r) => part(r.bank_account_number, 1) === NEW_FP));
});

// ════════════════════════════════════════════════════════════════════════
// 7. THE REQUEST TABLE IS IN THE GROUP — ASSERTED ON THE ACTUAL SQL
// ════════════════════════════════════════════════════════════════════════
test('the bank group re-keys the APPROVAL REQUEST table, not only the user table', async () => {
  /*
   * Asserted on the statements the run actually issued rather than on
   * FIELD_GROUPS, because a registry that agrees with itself proves nothing —
   * the failure this guards against is the run never reaching the second entry.
   *
   * tbl_user_profile_update_request.changes holds the SAME account number as
   * the personal-details row. Re-keying only the user table would leave the
   * pending approval queue wrapped under a key the app no longer holds.
   */
  await svc.runReKey({ group: 'bank', mode: 'rotate', newKey: NEW_KEY }, ACTOR);

  const sql = fake.calls.map((c) => c.sql);
  assert.ok(sql.some((s) => /^SELECT .*FROM tbl_user_profile_update_request/i.test(s)),
    'the run must SELECT from the approval request table');
  assert.ok(sql.some((s) => /^UPDATE tbl_user_profile_update_request SET `changes` = \?/i.test(s)),
    'and must UPDATE its `changes` column');
  assert.ok(sql.some((s) => /^SELECT .*FROM tbl_user_personal_details/i.test(s)));

  // The bank envelopes nested in the JSON moved; the clear fields did not.
  const changes = JSON.parse(store.requests[0].changes);
  assert.equal(part(changes.bank.account_number, 1), NEW_FP);
  assert.equal(part(changes.bank.account_name, 1), NEW_FP);
  assert.equal(part(changes.bank.account_number, 3), 'REQACCT10',
    'the value ciphertext inside the JSON is byte identical');
  assert.equal(changes.bank.ifsc, 'HDFC0001234', 'clear fields are not touched');
  assert.equal(changes.bank.account_last4, '4321');
  assert.equal(changes.mobile_no, '9876543210');
});

// ════════════════════════════════════════════════════════════════════════
// 8. EXACTLY ONE RECOVERY KEY STAYS ACTIVE
// ════════════════════════════════════════════════════════════════════════
test('registering a key deactivates the previous one, atomically', async () => {
  const third = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const out = await svc.storeRecoveryPublicKey({ publicKeyPem: third.publicKey }, ACTOR);

  assert.equal(out.fingerprint, recoveryFingerprint(third.publicKey));
  assert.equal(out.already_active, false);
  assert.equal(store.recoveryKeys.filter((k) => k.is_active).length, 1,
    'exactly one active row — the invariant the schema cannot express');
  assert.equal(store.recoveryKeys.length, 2, 'and the superseded key is KEPT, never overwritten');
  assert.deepEqual(store.txn, ['begin', 'commit'],
    'the swap runs in one transaction — otherwise there is a window with zero active keys');

  const order = fake.calls.map((c) => c.sql).filter((s) => /tbl_field_recovery_key/i.test(s));
  assert.ok(order.findIndex((s) => /SET is_active = 0/i.test(s))
    < order.findIndex((s) => /^INSERT/i.test(s)), 'deactivate, then insert');
});

test('re-registering the live key is a no-op; a superseded key is refused', async () => {
  const same = await svc.storeRecoveryPublicKey({ publicKeyPem: newRecovery.publicKey }, ACTOR);
  assert.equal(same.already_active, true);
  assert.equal(store.recoveryKeys.length, 1, 'no duplicate row');

  // Supersede it, then try to bring the old one back.
  await svc.storeRecoveryPublicKey({ publicKeyPem: oldRecovery.publicKey }, ACTOR);
  await assert.rejects(
    () => svc.storeRecoveryPublicKey({ publicKeyPem: newRecovery.publicKey }, ACTOR),
    (e) => e.code === 'RECOVERY_KEY_SUPERSEDED',
  );
  assert.deepEqual(store.txn.slice(-1), ['rollback']);
});

test('a PRIVATE key pasted into the registration endpoint is refused, not stored', async () => {
  await assert.rejects(
    () => svc.storeRecoveryPublicKey({ publicKeyPem: newRecovery.privateKey }, ACTOR),
    (e) => e.code === 'PRIVATE_KEY_SUBMITTED',
  );
  assert.equal(store.recoveryKeys.length, 1, 'nothing was written');
  assert.ok(!JSON.stringify(store.recoveryKeys).includes('PRIVATE KEY'));
});

test('the GET payload carries the fingerprint and no key material', async () => {
  const active = await svc.getActiveRecoveryKey();
  assert.deepEqual(Object.keys(active).sort(), ['created_on', 'fingerprint']);
  assert.ok(!JSON.stringify(active).includes('BEGIN'));
});

// ════════════════════════════════════════════════════════════════════════
// 9. THE PASTED PRIVATE KEY REACHES NO SINK
// ════════════════════════════════════════════════════════════════════════
/*
 * The single most important assertion in this file. The key is in the process
 * for the length of one request; the question is whether any of it survives
 * that. Three sinks are checked directly, and a fourth (the HTTP response +
 * req.body) in the route test below.
 *
 * Matched on a distinctive INTERIOR slice of the PEM rather than on the whole
 * string, so a truncated or re-wrapped copy is caught too — a leak that logged
 * the first 200 characters would pass a whole-string comparison.
 */
function keyFragments(pem) {
  const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  return [pem, body, body.slice(0, 40), body.slice(60, 120)];
}

test('the recovery private key appears in no log line, no result and no audit row', async () => {
  const fragments = keyFragments(oldRecovery.privateKey);

  const summary = await svc.runReKey({
    group: 'bank', mode: 'recover', newKey: NEW_KEY, recoveryPrivateKey: oldRecovery.privateKey,
  }, ACTOR, undefined, '10.1.2.3');

  const logged = logLines.join('\n');
  assert.ok(logged.length > 0, 'the run must have logged SOMETHING, or this test proves nothing');
  for (const f of fragments) {
    assert.ok(!logged.includes(f), 'the private key must never reach a log line');
    assert.ok(!JSON.stringify(summary).includes(f), 'nor the returned summary');
    assert.ok(!JSON.stringify(store.audit).includes(f), 'nor the audit row');
    assert.ok(!JSON.stringify(store.personal).includes(f), 'nor any column');
  }
  // Nor the NEW OPERATIONAL KEY, which is equally a secret.
  assert.ok(!logged.includes(NEW_KEY));
  assert.ok(!JSON.stringify(summary).includes(NEW_KEY));

  // What the audit DOES carry: actor, context+group+mode, count, ip.
  const [row] = store.audit;
  assert.equal(row.params[0], 7, 'actor');
  assert.equal(row.params[2], 'field_rekey:bank:recover', 'context carries the group and the mode');
  assert.equal(row.params[3], 5, 'the row count');
  assert.equal(row.params[4], '10.1.2.3', 'the client address');
  assert.ok(logged.includes('recovery_mode=true'),
    'THAT recovery mode was used is recorded — the key is not');
});

test('a key that fails to parse does not come back inside the error message', async () => {
  const junk = '-----BEGIN PRIVATE KEY-----\nZm9vYmFyc2VjcmV0\n-----END PRIVATE KEY-----';
  await assert.rejects(
    () => svc.runReKey({
      group: 'bank', mode: 'recover', newKey: NEW_KEY, recoveryPrivateKey: junk,
    }, ACTOR),
    (e) => e.code === 'RECOVERY_KEY_MISMATCH' && !e.message.includes('Zm9vYmFyc2VjcmV0'),
  );
});

// ════════════════════════════════════════════════════════════════════════
// 10. THE ENVELOPE-HEAD PARSE
// ════════════════════════════════════════════════════════════════════════
test('fingerprints are read from an envelope with one OR two of them', () => {
  // Two fingerprints (operational + recovery).
  assert.deepEqual(envelopeFingerprints('v2:aabbccdd:11223344:AAAA:BBBB'),
    { operational: 'aabbccdd', recovery: '11223344' });
  // One, as an earlier envelope layout carries — the second slot is base64.
  assert.deepEqual(envelopeFingerprints('v2:aabbccdd:AAAAAAAAAAAAAAAA:BBBB'),
    { operational: 'aabbccdd', recovery: null });
  // Not an envelope at all: nulls, never a throw, so a bulk run cannot be
  // aborted at row 40,000 by one odd value.
  assert.deepEqual(envelopeFingerprints('9876543210'), { operational: null, recovery: null });
});

test('the operational fingerprint is derived from the RAW key bytes', () => {
  const raw = crypto.randomBytes(32);
  const expected = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
  assert.equal(operationalFingerprint(raw.toString('base64')), expected);
  // Padding / whitespace differences must not rename the key.
  assert.equal(operationalFingerprint(`  ${raw.toString('base64')}  `), expected);
  assert.throws(() => operationalFingerprint(crypto.randomBytes(16).toString('base64')),
    (e) => e.code === 'INVALID_OPERATIONAL_KEY' && /32 bytes/.test(e.message));
});

// ════════════════════════════════════════════════════════════════════════
// 11. THE ROUTE — no-store, the response body, and the scrub
// ════════════════════════════════════════════════════════════════════════
const express = require('express');
const fieldRekeyRouter = require('../routes/admin/field-rekey');

let server;
let baseUrl;
let lastReq = null;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { lastReq = req; req.user = { user_id: 7 }; next(); });
  app.use('/api/admin/field-rekey', fieldRekeyRouter);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/field-rekey`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

const post = (path, body) => fetch(baseUrl + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('POST /run is no-store, returns no key material, and scrubs the request body', async () => {
  const res = await post('/run', {
    group: 'bank', mode: 'recover', newKey: NEW_KEY, recoveryPrivateKey: oldRecovery.privateKey,
  });
  const text = await res.text();

  assert.equal(res.status, 200, text);
  assert.match(res.headers.get('cache-control'), /no-store/);

  for (const f of keyFragments(oldRecovery.privateKey)) {
    assert.ok(!text.includes(f), 'the response body must not echo the private key');
  }
  assert.ok(!text.includes(NEW_KEY), 'nor the new operational key');
  const body = JSON.parse(text);
  assert.equal(body.success, true);
  assert.equal(body.data.totals.changed, 5);
  assert.equal(body.data.target_fingerprint, NEW_FP);

  assert.equal(lastReq.body.recoveryPrivateKey, undefined,
    'the key is deleted from req.body before anything downstream can log it');
  assert.equal(lastReq.body.newKey, undefined);
  assert.equal(lastReq.body.group, 'bank', 'and only the key material is removed');
});

test('a rejected run scrubs the key too — the error path is the one that reaches the logger', async () => {
  const res = await post('/run', {
    group: 'bank', mode: 'recover', newKey: NEW_KEY, recoveryPrivateKey: newRecovery.privateKey,
  });
  const text = await res.text();

  assert.equal(res.status, 400, text);
  assert.equal(JSON.parse(text).details.code, 'RECOVERY_KEY_MISMATCH');
  assert.ok(!text.includes(keyFragments(newRecovery.privateKey)[2]));
  assert.equal(lastReq.body.recoveryPrivateKey, undefined);
});

test('Joi rejects an unknown group WITHOUT quoting the key that came with it', async () => {
  const res = await post('/run', {
    group: 'not-a-group', mode: 'recover', recoveryPrivateKey: oldRecovery.privateKey,
  });
  const text = await res.text();

  assert.equal(res.status, 400);
  for (const f of keyFragments(oldRecovery.privateKey)) {
    assert.ok(!text.includes(f),
      'a validation failure is exactly when a key is in flight — its details must not carry it');
  }
});

test('POST /dry-run over HTTP writes nothing and is no-store', async () => {
  fake.reset();
  const res = await post('/dry-run', { group: 'bank' });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.equal(body.data.totals.would_change, 5);
  assert.deepEqual(writes(), []);
});

// ════════════════════════════════════════════════════════════════════════
// 12. THE CONTRACT WITH THE REAL lib/field-crypto.js
// ════════════════════════════════════════════════════════════════════════
/*
 * Everything above stubs the cipher, which is right — those tests are about the
 * re-key machinery. But two things this service does are CLAIMS ABOUT ANOTHER
 * MODULE, and a stub cannot check a claim about the thing it replaces:
 *
 *   · the fingerprints it reads out of an envelope head, and derives from a
 *     key, must be the ones field-crypto WRITES. If they diverge, idempotency
 *     silently degrades to "re-wrap everything, every time", and — far worse —
 *     the fingerprint stored in tbl_field_recovery_key stops matching the one
 *     an envelope names, so break-glass cannot find the key it needs.
 *   · the ROW SHAPE this service stores must be the one field-crypto reads. It
 *     reads `row.public_key` and cross-checks `row.fingerprint`; a column named
 *     anything else makes the store write-only.
 *
 * So these two run against the REAL module. `encryptField` and
 * `resolveRecoveryPublicKey` are untouched by the stubs above — those replace
 * the module's EXPORTS, and its internals call their own local bindings.
 */
test('the fingerprints in a REAL envelope are the ones this service derives', async () => {
  const opKey = crypto.randomBytes(32).toString('base64');
  const prevEnc = process.env.EASYFIX_FIELD_ENC_KEY;
  const prevRec = process.env.EASYFIX_FIELD_RECOVERY_PUBLIC_KEY;
  process.env.EASYFIX_FIELD_ENC_KEY = opKey;
  process.env.EASYFIX_FIELD_RECOVERY_PUBLIC_KEY =
    Buffer.from(newRecovery.publicKey, 'utf8').toString('base64');

  try {
    const fc = require('../lib/field-crypto');
    /*
     * Drop any key an earlier test primed from the store. field-crypto PREFERS
     * the primed one over env — which is the whole point of the store — so
     * without this the envelope would name whichever key the last registration
     * test happened to leave behind, and this test would be asserting against a
     * value it did not choose.
     */
    await fc.resolveRecoveryPublicKey(null);

    const envelope = fc.encryptField('123456789012');
    assert.ok(typeof envelope === 'string' && envelope.startsWith('v2:'));

    const fps = envelopeFingerprints(envelope);
    assert.equal(fps.operational, operationalFingerprint(opKey),
      'the operational fingerprint this service derives must be the one the cipher writes');
    assert.equal(fps.recovery, recoveryFingerprint(newRecovery.publicKey),
      'and so must the recovery one — break-glass lookup joins on exactly this value');

    // And the real predicate agrees the head-parse is reading a real envelope.
    assert.ok(realCrypto.isEncrypted(envelope));
  } finally {
    process.env.EASYFIX_FIELD_ENC_KEY = prevEnc;
    if (prevRec === undefined) delete process.env.EASYFIX_FIELD_RECOVERY_PUBLIC_KEY;
    else process.env.EASYFIX_FIELD_RECOVERY_PUBLIC_KEY = prevRec;
  }
});

test('lib/field-crypto can read the recovery key store this service writes', async () => {
  const fc = require('../lib/field-crypto');
  const desc = await fc.resolveRecoveryPublicKey(svc.recoveryKeyStore());

  assert.deepEqual(desc, { fingerprint: NEW_REC_FP, source: 'database' },
    'the stored row must resolve unmapped — `public_key` plus a `fingerprint` '
    + 'that agrees with the key bytes');

  const found = await fc.recoveryKeyByFingerprint(NEW_REC_FP, svc.recoveryKeyStore());
  assert.equal(found.fp, NEW_REC_FP);
  assert.equal(await fc.recoveryKeyByFingerprint('00000000', svc.recoveryKeyStore()), null);
});

test('registering a key re-points THIS process at it, with no restart', async () => {
  const fc = require('../lib/field-crypto');
  const fresh = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  await svc.storeRecoveryPublicKey({ publicKeyPem: fresh.publicKey }, ACTOR);

  // The prime is fail-soft and only logs, so assert the OUTCOME rather than
  // trusting that it did not quietly fall over.
  const desc = await fc.resolveRecoveryPublicKey(svc.recoveryKeyStore());
  assert.equal(desc.fingerprint, recoveryFingerprint(fresh.publicKey));
  assert.equal(desc.source, 'database',
    'writes must seal to the STORE, not to the env bootstrap — otherwise rotating '
    + 'through the UI silently does nothing');
});

test('a CRLF-wrapped PEM — the routine browser paste — still registers', async () => {
  const crlf = newRecovery.publicKey.replace(/\n/g, '\r\n');
  store.recoveryKeys = [];
  const out = await svc.storeRecoveryPublicKey({ publicKeyPem: crlf }, ACTOR);
  assert.equal(out.fingerprint, NEW_REC_FP, 'line endings must not rename a key');
  assert.ok(!store.recoveryKeys[0].public_key.includes('\r'));
});
