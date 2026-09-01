/*
 * HRMS "My Profile" — the self-service surface (/api/profile) and the HR
 * approval queue behind it.
 *
 * ─── WHAT THESE TESTS ARE FOR ──────────────────────────────────────────────
 *
 * Four properties, each of which is a real incident if it silently regresses:
 *
 *   1. SELF-SERVICE ACTS ON THE CALLER, NEVER ON AN ID FROM THE CLIENT.
 *      /api/profile is reachable by EVERY authenticated CRM user — unlike
 *      /api/admin/users, which is role-gated. A user id honoured from a body or
 *      a path here is "edit anyone's bank details", so the tests assert that a
 *      supplied id is ignored and that the withdraw statement scopes itself.
 *
 *   2. THE DATE OF BIRTH IS SET ONCE. The "only while NULL" lives in the
 *      STATEMENT, not in a read followed by a write — two tabs would both read
 *      NULL and both write. The test pins the conditional SQL, the order of the
 *      two ON DUPLICATE KEY assignments (load-bearing; see the service), and
 *      that affectedRows===0 is the 409.
 *
 *   3. ONE OPEN REQUEST PER USER, ACCUMULATING. Submitting MERGES into the open
 *      request. It must NEVER 409 on "you already have one", must not drop a
 *      field the second submission did not mention, and must keep `old_values`
 *      at the value each key had when it FIRST entered the request.
 *
 *   4. APPROVE APPLIES AND FLIPS ATOMICALLY. Every field lands with the status
 *      flip or nothing does; a double-approve is 409; a reject writes nothing
 *      but the status.
 *
 *   5. BANK DETAILS ARE ENCRYPTED IN BOTH TABLES, MASKED ON EVERY READ, AND
 *      REVEALED ONLY WITH AN AUDIT ROW. The account number and the holder name
 *      are AES-256-GCM ciphertext in tbl_user_personal_details AND inside the
 *      `changes` / `old_values` JSON — missing the second is the failure that
 *      makes the first pointless, since an attacker would simply read the
 *      pending queue instead. These tests assert on the ACTUAL BOUND SQL
 *      PARAMETER rather than on a helper's return value, because that is the
 *      only assertion that catches a leak: a helper can be correct and still be
 *      called on the wrong side of the JSON.stringify.
 *
 * Non-destructive: hand-built fake connections and the fake-pool harness. No
 * network, no DB, nothing written anywhere.
 *
 * Runner: `npm test` (node --test --test-force-exit).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * A throwaway key for this process. `node --test` runs each test FILE in its
 * own process, so this cannot reach another suite — and setting it BEFORE the
 * services are required is not load-order superstition: lib/field-crypto reads
 * the env on every call precisely so a late-populated environment cannot freeze
 * a permanent outage into the module.
 */
process.env.EASYFIX_FIELD_ENC_KEY = crypto.randomBytes(32).toString('base64');
const fieldCrypto = require('../lib/field-crypto');

const USER_ID = 7;
const OTHER_USER_ID = 999;
const CURRENT_MOBILE = '9000000000';
const NEW_MOBILE = '9876543210';
const DOB = '1994-03-08';
const BANK = {
  account_number: '12345678901',
  ifsc: 'HDFC0001234',
  account_name: 'Priya Sharma',
  bank_name: 'HDFC Bank',
};
const BANK_LAST4 = '8901';                 // the tail of BANK.account_number
const OLD_ACCOUNT = '99988877766';
const OLD_HOLDER = 'Priya S Sharma';

/* The STORED shape — what actually sits in a column or in the request JSON. */
function storedBank(plain = BANK) {
  return {
    account_number: fieldCrypto.encryptField(plain.account_number),
    ifsc:           plain.ifsc,
    account_name:   fieldCrypto.encryptField(plain.account_name),
    bank_name:      plain.bank_name,
    account_last4:  plain.account_number.slice(-4),
  };
}

/* A tbl_user_personal_details row carrying bank details already at rest. */
function personalRowWithBank(plain = {
  account_number: OLD_ACCOUNT, ifsc: 'ICIC0000123',
  account_name: OLD_HOLDER, bank_name: 'ICICI Bank',
}) {
  const s = storedBank(plain);
  return {
    personal_email: 'priya@example.com',
    date_of_birth: null,
    bank_account_number: s.account_number,
    bank_ifsc: s.ifsc,
    bank_account_name: s.account_name,
    bank_name: s.bank_name,
    bank_account_last4: s.account_last4,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * A hand-built db double. Pool and connection share ONE query function, so
 * `calls` is a single ordered transcript of everything the flow issued —
 * which is what lets the approve tests assert ORDER, not just presence.
 * ──────────────────────────────────────────────────────────────────────── */
function fakeDb({
  pending = null,            // the caller's open pending row, or null
  personal = null,           // their tbl_user_personal_details row, or null
  mobileTaken = false,       // does another active user hold the new mobile?
  requestRow = null,         // the row processRequest locks FOR UPDATE
  revealRow = null,          // the row revealRequestBank reads (changes+old_values)
  insertId = 55,
  flipRows = 1,              // affectedRows on the conditional status UPDATE
  deleteRows = 1,            // affectedRows on the withdraw DELETE
} = {}) {
  const calls = [];

  async function query(sql, params) {
    const text = String(sql);
    calls.push({ sql: text, params });

    // ── reads ─────────────────────────────────────────────────────────
    if (/FROM tbl_user_profile_update_request[\s\S]*WHERE user_id = \? AND status = 'pending'/.test(text)) {
      return [pending ? [pending] : [], []];
    }
    if (/SELECT request_id, user_id, changes, status[\s\S]*WHERE request_id = \? FOR UPDATE/.test(text)) {
      return [requestRow ? [requestRow] : [], []];
    }
    // revealRequestBank — same table, no FOR UPDATE, and it needs old_values too.
    if (/SELECT request_id, user_id, changes, old_values[\s\S]*WHERE request_id = \?/.test(text)) {
      return [revealRow ? [revealRow] : [], []];
    }
    // revealOwnBank / getMyProfile read the full personal-details projection.
    if (/SELECT personal_email, date_of_birth/.test(text)) {
      return [personal ? [personal] : [], []];
    }
    if (/SELECT user_id FROM tbl_user\s+WHERE mobile_no = \?/.test(text)) {
      return [mobileTaken ? [{ user_id: OTHER_USER_ID }] : [], []];
    }
    if (/SELECT mobile_no FROM tbl_user/.test(text)) {
      return [[{ mobile_no: CURRENT_MOBILE }], []];
    }
    if (/SELECT date_of_birth, bank_account_number/.test(text)) {
      return [personal ? [personal] : [], []];
    }
    if (/LEFT JOIN tbl_user p ON p\.user_id = r\.processed_by/.test(text)) {
      return [[{
        request_id: (requestRow && requestRow.request_id) || insertId,
        user_id: USER_ID,
        changes: (requestRow && requestRow.changes) || '{}',
        old_values: '{}',
        status: 'approved',
      }], []];
    }

    // ── writes ────────────────────────────────────────────────────────
    if (/INSERT INTO tbl_user_profile_update_request/.test(text)) {
      return [{ insertId, affectedRows: 1 }, []];
    }
    if (/UPDATE tbl_user_profile_update_request[\s\S]*SET status = \?/.test(text)) {
      return [{ affectedRows: flipRows }, []];
    }
    if (/UPDATE tbl_user_profile_update_request/.test(text)) {
      return [{ affectedRows: 1 }, []];
    }
    if (/DELETE FROM tbl_user_profile_update_request/.test(text)) {
      return [{ affectedRows: deleteRows }, []];
    }
    if (/UPDATE tbl_user SET mobile_no/.test(text)) {
      return [{ affectedRows: 1 }, []];
    }
    if (/INSERT INTO tbl_user_personal_details/.test(text)) {
      return [{ affectedRows: 1 }, []];
    }
    if (/INSERT INTO tbl_sensitive_reveal_log/.test(text)) {
      return [{ insertId: 1, affectedRows: 1 }, []];
    }
    throw new Error(`unexpected SQL: ${text}`);
  }

  const conn = {
    committed: false,
    rolledBack: false,
    released: false,
    query,
    async beginTransaction() { calls.push({ sql: '__BEGIN__', params: null }); },
    async commit() { this.committed = true; calls.push({ sql: '__COMMIT__', params: null }); },
    async rollback() { this.rolledBack = true; calls.push({ sql: '__ROLLBACK__', params: null }); },
    release() { this.released = true; },
  };

  return { calls, conn, query, async getConnection() { return conn; } };
}

const sqlIndex = (calls, re) => calls.findIndex((c) => re.test(c.sql));
const sqlCall  = (calls, re) => calls.find((c) => re.test(c.sql));
const sqlCount = (calls, re) => calls.filter((c) => re.test(c.sql)).length;

/*
 * The fake-pool harness is installed for the ROUTE tests below (they use the
 * shared `pool` singleton that routes/profile.js hands to the services). The
 * SERVICE tests pass their own db double, so they are unaffected by it.
 */
const routeScenario = {
  pending: null,
  deleteRows: 1,
  personal: null,      // the caller's tbl_user_personal_details row
  revealRow: null,     // the request row POST /:id/reveal reads
};

const fake = installFakePool([
  [/FROM tbl_user_profile_update_request[\s\S]*WHERE user_id = \? AND status = 'pending'/,
    () => (routeScenario.pending ? [routeScenario.pending] : [])],
  [/SELECT request_id, user_id, changes, old_values[\s\S]*WHERE request_id = \?/,
    () => (routeScenario.revealRow ? [routeScenario.revealRow] : [])],
  [/SELECT mobile_no FROM tbl_user/, () => [{ mobile_no: CURRENT_MOBILE }]],
  [/SELECT date_of_birth, bank_account_number/, () => []],
  [/SELECT user_code, mobile_no, alternate_no FROM tbl_user/,
    () => [{ user_code: 'E000007', mobile_no: CURRENT_MOBILE, alternate_no: null }]],
  [/SELECT personal_email, date_of_birth/, () => (routeScenario.personal ? [routeScenario.personal] : [])],
  [/SELECT user_id FROM tbl_user\s+WHERE mobile_no = \?/, () => []],
  [/INSERT INTO tbl_user_profile_update_request/, () => ({ insertId: 55, affectedRows: 1 })],
  [/DELETE FROM tbl_user_profile_update_request/, () => ({ affectedRows: routeScenario.deleteRows })],
  [/INSERT INTO tbl_sensitive_reveal_log/, () => ({ insertId: 1, affectedRows: 1 })],
]);

const selfService = require('../services/profile-self.service');
const requestService = require('../services/profile-update-request.service');

// ═══════════════════════════════════════════════════════════════════════
// 1. DATE OF BIRTH — THE ONE FREE SET
// ═══════════════════════════════════════════════════════════════════════

test('the first date-of-birth write is conditional IN SQL, not read-then-write', async () => {
  const db = fakeDb();
  const out = await selfService.setDateOfBirthOnce(USER_ID, DOB, db);
  assert.deepEqual(out, { date_of_birth: DOB, dob_locked: true });

  const writes = db.calls.filter((c) => /INSERT INTO tbl_user_personal_details/.test(c.sql));
  assert.equal(writes.length, 1);
  assert.equal(db.calls.length, 1, 'no SELECT may precede the write — that is the race');
  assert.match(writes[0].sql, /date_of_birth IS NULL/,
    'the "only while NULL" guard must live in the statement');
  assert.deepEqual(writes[0].params.slice(0, 2), [USER_ID, DOB]);

  /*
   * ORDER IS LOAD-BEARING. MySQL evaluates ON DUPLICATE KEY UPDATE left to
   * right and a later expression sees what an earlier one assigned, so
   * updated_on must be guarded BEFORE date_of_birth is overwritten. Reversed,
   * date_of_birth's own guard would read the value just written, and a locked
   * row would still report affectedRows=2 — making the 409 unreachable.
   */
  const dup = writes[0].sql.slice(writes[0].sql.indexOf('ON DUPLICATE KEY UPDATE'));
  assert.ok(dup.indexOf('updated_on') < dup.indexOf('date_of_birth ='),
    'updated_on must be assigned before date_of_birth in ON DUPLICATE KEY UPDATE');
});

test('a second date-of-birth write is refused with DOB_ALREADY_SET, not silently ignored', async () => {
  // affectedRows 0 = both IF() guards held: a value was already on file, so the
  // upsert changed nothing. That is the ONLY signal distinguishing "set" from
  // "already set" — there is no preceding read to compare against, by design.
  const seen = [];
  const runner = {
    async query(sql, params) {
      seen.push({ sql: String(sql), params });
      return [{ affectedRows: 0 }, []];
    },
  };
  await assert.rejects(
    selfService.setDateOfBirthOnce(USER_ID, DOB, runner),
    (e) => e.status === 409 && e.code === 'DOB_ALREADY_SET',
  );
  assert.equal(seen.length, 1, 'still exactly one statement — no read-then-write');
});

test('date-of-birth validation rejects the future, the impossible and the out-of-range', async () => {
  const db = fakeDb();
  const bad = ['2099-01-01', '2026-02-30', '2020-01-01', '1800-01-01', '08-03-1994', ''];
  for (const value of bad) {
    await assert.rejects(
      selfService.setDateOfBirthOnce(USER_ID, value, db),
      (e) => e.status === 400,
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
  assert.equal(db.calls.length, 0, 'an invalid date must never reach a write');
});

// ═══════════════════════════════════════════════════════════════════════
// 2. ONE OPEN REQUEST PER USER — THE MERGE
// ═══════════════════════════════════════════════════════════════════════

test('the first submission creates the one pending request, holding only that field', async () => {
  const db = fakeDb({ pending: null });
  const out = await requestService.submitChanges(USER_ID, { date_of_birth: DOB }, db);

  assert.equal(out.request_id, 55);
  assert.equal(out.merged, false);
  assert.deepEqual(out.changes, { date_of_birth: DOB });
  assert.deepEqual(out.old_values, { date_of_birth: null });

  // The decision to insert must be taken UNDER THE LOCK, not before it.
  const lock = sqlIndex(db.calls, /WHERE user_id = \? AND status = 'pending'[\s\S]*FOR UPDATE/);
  const ins  = sqlIndex(db.calls, /INSERT INTO tbl_user_profile_update_request/);
  assert.ok(lock >= 0, 'the pending row must be selected FOR UPDATE');
  assert.ok(lock < ins, 'the lock must be taken before the merge-vs-insert decision');
  assert.equal(db.conn.committed, true);
});

test("the owner's case: submit DOB, then submit ONLY mobile → ONE request holding BOTH", async () => {
  // Step 1 — DOB alone.
  const first = fakeDb({ pending: null });
  await requestService.submitChanges(USER_ID, { date_of_birth: DOB }, first);
  const insert = sqlCall(first.calls, /INSERT INTO tbl_user_profile_update_request/);
  assert.deepEqual(JSON.parse(insert.params[1]), { date_of_birth: DOB });

  // Step 2 — mobile alone, against the request step 1 created.
  const second = fakeDb({
    pending: {
      request_id: 55,
      changes: JSON.stringify({ date_of_birth: DOB }),
      old_values: JSON.stringify({ date_of_birth: null }),
    },
  });
  const out = await requestService.submitChanges(USER_ID, { mobile_no: NEW_MOBILE }, second);

  // THE assertion: one request, both fields. The DOB is not dropped just
  // because the second submission did not mention it.
  assert.equal(out.request_id, 55, 'must reuse the open request, never open a second');
  assert.equal(out.merged, true);
  assert.deepEqual(out.changes, { date_of_birth: DOB, mobile_no: NEW_MOBILE });
  assert.equal(
    sqlCount(second.calls, /INSERT INTO tbl_user_profile_update_request/), 0,
    'a second pending row must never be inserted',
  );
  const update = sqlCall(second.calls, /UPDATE tbl_user_profile_update_request/);
  assert.deepEqual(JSON.parse(update.params[0]), { date_of_birth: DOB, mobile_no: NEW_MOBILE });
  assert.match(update.sql, /WHERE request_id = \? AND status = 'pending'/);

  // old_values grew by exactly the newly-entered key, snapshotted live.
  assert.deepEqual(out.old_values, { date_of_birth: null, mobile_no: CURRENT_MOBILE });
});

test('a re-submitted field overwrites `changes` but NOT its original `old_values`', async () => {
  const db = fakeDb({
    pending: {
      request_id: 55,
      changes: JSON.stringify({ mobile_no: '9111111111' }),
      old_values: JSON.stringify({ mobile_no: CURRENT_MOBILE }),
    },
  });
  const out = await requestService.submitChanges(USER_ID, { mobile_no: NEW_MOBILE }, db);

  assert.equal(out.changes.mobile_no, NEW_MOBILE);
  assert.equal(out.old_values.mobile_no, CURRENT_MOBILE,
    'the "before" is the value when the key FIRST entered the request, not the previous draft');
  // Nothing needed re-snapshotting, so no live read was issued.
  assert.equal(sqlCount(db.calls, /SELECT mobile_no FROM tbl_user/), 0);
});

test('submitting while a request is open NEVER 409s — merging is the behaviour', async () => {
  const db = fakeDb({
    pending: {
      request_id: 55,
      changes: JSON.stringify({ date_of_birth: DOB }),
      old_values: JSON.stringify({ date_of_birth: null }),
    },
  });
  await assert.doesNotReject(requestService.submitChanges(USER_ID, { bank: BANK }, db));
});

test('a submitted mobile already held by another active user is refused before anything is stored', async () => {
  const db = fakeDb({ mobileTaken: true });
  await assert.rejects(
    requestService.submitChanges(USER_ID, { mobile_no: NEW_MOBILE }, db),
    (e) => e.status === 409 && e.code === 'MOBILE_TAKEN',
  );
  assert.equal(sqlCount(db.calls, /INSERT INTO tbl_user_profile_update_request/), 0);
  // Same rule services/user.service.js applies on create/update: ACTIVE
  // INTERNAL users only, excluding the requester.
  const probe = sqlCall(db.calls, /SELECT user_id FROM tbl_user\s+WHERE mobile_no = \?/);
  assert.match(probe.sql, /user_status = 1/);
  assert.match(probe.sql, /user_type_id = \?/);
  assert.match(probe.sql, /user_id <> \?/);
});

test('an unknown or empty changes payload is rejected, never stored', async () => {
  const db = fakeDb();
  for (const payload of [{}, { salary: 1 }, { mobile_no: '12345' }, { bank: { ifsc: 'X' } }]) {
    await assert.rejects(
      requestService.submitChanges(USER_ID, payload, db),
      (e) => e.status === 400,
      `expected ${JSON.stringify(payload)} to be rejected`,
    );
  }
  assert.equal(db.calls.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. APPROVE / REJECT
// ═══════════════════════════════════════════════════════════════════════

/*
 * A stored pending row. `changes` is given in PLAIN form for readability and
 * the bank block is encrypted on the way in — because that is how it would
 * actually be on disk, and approve now has to decrypt before it can
 * re-validate. A fixture holding a plaintext bank would test a state the
 * submit path can no longer produce.
 */
function pendingRequestRow(changes) {
  const stored = changes.bank ? { ...changes, bank: storedBank(changes.bank) } : changes;
  return {
    request_id: 55,
    user_id: USER_ID,
    changes: JSON.stringify(stored),
    status: 'pending',
  };
}

test('approve applies EVERY field and flips the status inside ONE transaction', async () => {
  const db = fakeDb({
    requestRow: pendingRequestRow({ mobile_no: NEW_MOBILE, date_of_birth: DOB, bank: BANK }),
  });
  await requestService.processRequest(55, { action: 'approve', remarks: 'ok' }, { user_id: 3 }, db);

  const begin   = sqlIndex(db.calls, /__BEGIN__/);
  const lock    = sqlIndex(db.calls, /SELECT request_id, user_id, changes, status[\s\S]*FOR UPDATE/);
  const probe   = sqlIndex(db.calls, /SELECT user_id FROM tbl_user\s+WHERE mobile_no = \?/);
  const mobile  = sqlIndex(db.calls, /UPDATE tbl_user SET mobile_no/);
  const details = sqlIndex(db.calls, /INSERT INTO tbl_user_personal_details/);
  const flip    = sqlIndex(db.calls, /UPDATE tbl_user_profile_update_request[\s\S]*SET status = \?/);
  const commit  = sqlIndex(db.calls, /__COMMIT__/);

  // Row lock first, re-validation next, then every write, then the flip, then commit.
  assert.ok(begin < lock, 'the row must be locked inside the transaction');
  assert.ok(lock < probe, 'uniqueness is re-checked on the LOCKED connection');
  assert.ok(probe < mobile && mobile < flip && details < flip,
    'both applies must precede the status flip');
  assert.ok(flip < commit, 'the flip and the applies commit together or not at all');
  assert.equal(db.conn.committed, true);
  assert.equal(db.conn.rolledBack, false);

  // The flip is CONDITIONAL — that is the concurrency guard the contract names.
  assert.match(db.calls[flip].sql, /WHERE request_id = \? AND status = 'pending'/);
  assert.equal(db.calls[flip].params[0], 'approved');
  assert.equal(db.calls[flip].params[2], 3, 'processed_by is the approver');
  assert.equal(db.calls[flip].params[3], 'ok');

  // The personal-details write carries the DOB and all five bank columns, and
  // leaves personal_email alone.
  const detailSql = db.calls[details].sql;
  for (const col of ['date_of_birth', 'bank_account_number', 'bank_ifsc',
    'bank_account_name', 'bank_name', 'bank_account_last4']) {
    assert.match(detailSql, new RegExp(col));
  }
  assert.doesNotMatch(detailSql, /personal_email/);
});

test('a second approve of the same request is 409 ALREADY_PROCESSED and writes nothing', async () => {
  const db = fakeDb({
    requestRow: { request_id: 55, user_id: USER_ID, changes: '{}', status: 'approved' },
  });
  await assert.rejects(
    requestService.processRequest(55, { action: 'approve' }, { user_id: 3 }, db),
    (e) => e.status === 409 && e.code === 'ALREADY_PROCESSED',
  );
  assert.equal(db.conn.rolledBack, true);
  assert.equal(db.conn.committed, false);
  assert.equal(sqlCount(db.calls, /UPDATE tbl_user SET mobile_no/), 0);
  assert.equal(sqlCount(db.calls, /INSERT INTO tbl_user_personal_details/), 0);
});

test('losing the conditional flip rolls back the applies rather than half-approving', async () => {
  // The row was still 'pending' when we read it but somebody else flipped it
  // before our UPDATE landed. affectedRows 0 must undo the tbl_user write.
  const db = fakeDb({
    requestRow: pendingRequestRow({ mobile_no: NEW_MOBILE }),
    flipRows: 0,
  });
  await assert.rejects(
    requestService.processRequest(55, { action: 'approve' }, { user_id: 3 }, db),
    (e) => e.status === 409 && e.code === 'ALREADY_PROCESSED',
  );
  assert.equal(db.conn.rolledBack, true);
  assert.equal(db.conn.committed, false);
  assert.equal(sqlCount(db.calls, /UPDATE tbl_user SET mobile_no/), 1,
    'the write happened — and was rolled back, which is the point');
});

test('approve refuses a mobile that became someone else\'s between submit and approve', async () => {
  const db = fakeDb({
    requestRow: pendingRequestRow({ mobile_no: NEW_MOBILE }),
    mobileTaken: true,
  });
  await assert.rejects(
    requestService.processRequest(55, { action: 'approve' }, { user_id: 3 }, db),
    (e) => e.status === 409 && e.code === 'MOBILE_TAKEN',
  );
  assert.equal(db.conn.rolledBack, true);
  assert.equal(sqlCount(db.calls, /UPDATE tbl_user SET mobile_no/), 0,
    'a duplicate must never be written');
});

test('approve refuses a stored value that is no longer valid instead of writing it', async () => {
  const db = fakeDb({ requestRow: pendingRequestRow({ mobile_no: '123' }) });
  await assert.rejects(
    requestService.processRequest(55, { action: 'approve' }, { user_id: 3 }, db),
    (e) => e.status === 409 && e.code === 'CHANGES_INVALID_NOW',
  );
  assert.equal(db.conn.rolledBack, true);
  assert.equal(sqlCount(db.calls, /UPDATE tbl_user SET mobile_no/), 0);
});

test('reject flips the status and writes NONE of the requested values', async () => {
  const db = fakeDb({
    requestRow: pendingRequestRow({ mobile_no: NEW_MOBILE, date_of_birth: DOB, bank: BANK }),
  });
  await requestService.processRequest(55, { action: 'reject', remarks: 'wrong IFSC' },
    { user_id: 3 }, db);

  assert.equal(sqlCount(db.calls, /UPDATE tbl_user SET mobile_no/), 0);
  assert.equal(sqlCount(db.calls, /INSERT INTO tbl_user_personal_details/), 0);
  assert.equal(sqlCount(db.calls, /SELECT user_id FROM tbl_user\s+WHERE mobile_no = \?/), 0,
    'a reject does not need to re-validate anything');
  const flip = sqlCall(db.calls, /UPDATE tbl_user_profile_update_request[\s\S]*SET status = \?/);
  assert.equal(flip.params[0], 'rejected');
  assert.equal(db.conn.committed, true);
});

// ═══════════════════════════════════════════════════════════════════════
// 4. THE SECURITY BOUNDARY — SELF-SERVICE ACTS ON THE CALLER ONLY
// ═══════════════════════════════════════════════════════════════════════

test('withdraw scopes the DELETE to the caller in the statement itself', async () => {
  const db = fakeDb();
  await requestService.withdrawRequest(USER_ID, 55, db);
  const del = sqlCall(db.calls, /DELETE FROM tbl_user_profile_update_request/);
  assert.match(del.sql, /WHERE request_id = \? AND user_id = \? AND status = 'pending'/);
  assert.deepEqual(del.params, [55, USER_ID]);
});

test("withdrawing another user's request matches nothing and 404s", async () => {
  const db = fakeDb({ deleteRows: 0 });
  await assert.rejects(
    requestService.withdrawRequest(USER_ID, 55, db),
    (e) => e.status === 404 && e.code === 'REQUEST_NOT_FOUND',
  );
});

/*
 * Route-level half of the same property. requireAuth is stubbed out (it has its
 * own tests, and a real JWT here would only prove jsonwebtoken works) so what
 * is under test is exactly the code this file owns: the CRM-only principal
 * guard and the fact that no handler reads a user id from the request.
 */
const express = require('express');

const principal = { user_id: USER_ID, user_name: 'Priya Sharma' };
const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: (req, _res, next) => { req.user = principal; next(); },
};
const profileRouter = require('../routes/profile');

/*
 * The admin half needs its ACTION GATE stubbed, not bypassed: the reveal route
 * is deliberately behind isProfileApprovalProcess rather than the broader
 * isProfileApprovalView, and a stub that always passed would silently stop
 * testing that distinction. `grantedActions` lets a test grant or withhold a
 * specific key, so the 403 path is exercised too.
 */
const grantedActions = new Set();
const requireActionPath = require.resolve('../middleware/require-action');
require.cache[requireActionPath] = {
  id: requireActionPath,
  filename: requireActionPath,
  loaded: true,
  exports: (key) => (req, res, next) => (grantedActions.has(key)
    ? next()
    : res.status(403).json({ success: false, error: `Missing permission: ${key}` })),
};
const adminRequestsRouter = require('../routes/admin/profile-update-requests');

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = principal; next(); });
  app.use('/profile', profileRouter);
  app.use('/admin/profile-update-requests', adminRequestsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err && err.message) }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  delete require.cache[authPath];
  delete require.cache[requireActionPath];
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  routeScenario.pending = null;
  routeScenario.deleteRows = 1;
  routeScenario.personal = null;
  routeScenario.revealRow = null;
  grantedActions.clear();
  principal.user_id = USER_ID;
  delete principal.__principal;
});

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    headers: res.headers,
    body: await res.json().catch(() => null),
  };
}

test('a user id smuggled into the body is ignored — the request is stored against the caller', async () => {
  const res = await call('POST', '/profile/update-requests', {
    user_id: OTHER_USER_ID,
    userId: OTHER_USER_ID,
    changes: { date_of_birth: DOB },
  });
  assert.equal(res.status, 200);

  const insert = fake.calls.find((c) => /INSERT INTO tbl_user_profile_update_request/.test(c.sql));
  assert.ok(insert, 'the request should have been stored');
  assert.equal(insert.params[0], USER_ID, 'the row belongs to the authenticated caller');
  const everyParam = fake.calls.flatMap((c) => c.params || []).map(String);
  assert.equal(everyParam.includes(String(OTHER_USER_ID)), false,
    'no statement anywhere may carry a client-supplied user id');
});

test('DELETE of a request id is scoped to the caller and 404s when it is not theirs', async () => {
  routeScenario.deleteRows = 0;
  const res = await call('DELETE', '/profile/update-requests/55');
  assert.equal(res.status, 404);
  const del = fake.calls.find((c) => /DELETE FROM tbl_user_profile_update_request/.test(c.sql));
  assert.deepEqual(del.params, [55, USER_ID]);
});

test('a technician bearer is refused outright — /api/profile is CRM-only', async () => {
  // requireAuth resolves `efr:<id>` subjects against tbl_easyfixer; that
  // principal has no tbl_user row and its user_id is a STRING, which every
  // statement here would coerce to 0.
  principal.user_id = 'efr:3';
  principal.__principal = 'mobile';
  const res = await call('GET', '/profile/details');
  assert.equal(res.status, 403);
  assert.equal(fake.calls.length, 0, 'a refused principal must not reach any statement');
});

test('GET /details reports dob_locked and a null pending when nothing is open', async () => {
  const res = await call('GET', '/profile/details');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.dob_locked, false);
  assert.equal(res.body.data.date_of_birth, null);
  assert.equal(res.body.data.pending, null);
  assert.equal(res.body.data.user_code, 'E000007');
  // Every read was parameterised with the caller's own id.
  for (const c of fake.calls) {
    if (c.params) assert.equal(c.params.includes(OTHER_USER_ID), false);
  }
});

test('dob_locked is exactly "a date is stored" — never true alongside a null date', async () => {
  const dbNoDob = fakeDb();
  dbNoDob.query = async (sql) => {
    if (/SELECT user_code, mobile_no, alternate_no/.test(String(sql))) {
      return [[{ user_code: 'E000007', mobile_no: CURRENT_MOBILE, alternate_no: null }], []];
    }
    return [[], []];
  };
  const unset = await selfService.getMyProfile(USER_ID, dbNoDob);
  assert.equal(unset.date_of_birth, null);
  assert.equal(unset.dob_locked, false);

  const dbWithDob = fakeDb();
  dbWithDob.query = async (sql) => {
    const text = String(sql);
    if (/SELECT user_code, mobile_no, alternate_no/.test(text)) {
      return [[{ user_code: 'E000007', mobile_no: CURRENT_MOBILE, alternate_no: null }], []];
    }
    if (/SELECT personal_email, date_of_birth/.test(text)) {
      // A DATE read back with a time component must not defeat the check.
      return [[{ personal_email: 'p@example.com', date_of_birth: `${DOB} 00:00:00` }], []];
    }
    return [[], []];
  };
  const set = await selfService.getMyProfile(USER_ID, dbWithDob);
  assert.equal(set.date_of_birth, DOB);
  assert.equal(set.dob_locked, true);
});

test('the pending strip carries old_values and IST wall-clock timestamps, never UTC', async () => {
  routeScenario.pending = {
    request_id: 55,
    changes: JSON.stringify({ mobile_no: NEW_MOBILE }),
    old_values: JSON.stringify({ mobile_no: CURRENT_MOBILE }),
    requested_on: '2026-09-01 14:30:00',
    updated_on: null,
  };
  const res = await call('GET', '/profile/details');
  const pending = res.body.data.pending;

  // The "before" travels with the request. Inferring it from the live record
  // goes wrong the moment an admin edits that record while a request is open.
  assert.deepEqual(pending.old_values, { mobile_no: CURRENT_MOBILE });
  assert.deepEqual(pending.changes, { mobile_no: NEW_MOBILE });
  // Stored IST wall clock, verbatim: no Z, no T, no 5h30m shift.
  assert.equal(pending.requested_on, '2026-09-01 14:30:00');
  assert.equal(pending.updated_on, null);
});

test('the HR list returns { rows, total } and joins the requester name + employee code', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/COUNT\(\*\) AS total/.test(String(sql))) return [[{ total: 1 }], []];
      return [[{
        request_id: 55,
        user_id: USER_ID,
        changes: JSON.stringify({ mobile_no: NEW_MOBILE }),
        old_values: JSON.stringify({ mobile_no: CURRENT_MOBILE }),
        status: 'pending',
        requested_on: '2026-09-01 14:30:00',
        updated_on: null,
        processed_on: null,
        user_code: 'E000007',
        user_name: 'Priya Sharma',
      }], []];
    },
  };
  const out = await requestService.listRequests({ page: 1, limit: 20 }, db);

  assert.ok(Array.isArray(out.rows), 'the envelope key is `rows`, not `items`');
  assert.equal(out.total, 1);
  assert.equal(out.page, 1, 'page is 1-indexed');
  // "Raised By" is name + employee code; without the join it can only show
  // "ID <user_id>".
  assert.equal(out.rows[0].user_name, 'Priya Sharma');
  assert.equal(out.rows[0].user_code, 'E000007');
  assert.deepEqual(out.rows[0].changes, { mobile_no: NEW_MOBILE });
  assert.deepEqual(out.rows[0].old_values, { mobile_no: CURRENT_MOBILE });
  assert.equal(out.rows[0].requested_on, '2026-09-01 14:30:00');

  const listSql = calls[0].sql;
  assert.match(listSql, /LEFT JOIN tbl_user u ON u\.user_id = r\.user_id/);
  assert.match(listSql, /u\.user_name/);
  assert.match(listSql, /u\.user_code/);
});

test('the list page size is capped at 1000, matching the route Joi max', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/COUNT\(\*\) AS total/.test(String(sql))) return [[{ total: 0 }], []];
      return [[], []];
    },
  };
  const out = await requestService.listRequests({ page: 1, limit: 99999 }, db);
  assert.equal(out.limit, requestService.MAX_PAGE_SIZE);
  assert.equal(requestService.MAX_PAGE_SIZE, 1000);
  assert.equal(calls[0].params.at(-1), 1000);
});

test('alternate_no accepts a blank and stores NULL — clearing needs no approval', async () => {
  for (const blank of ['', null, '   ']) {
    const calls = [];
    const db = { async query(sql, params) { calls.push({ sql: String(sql), params }); return [{ affectedRows: 1 }, []]; } };
    const out = await selfService.setAlternateNo(USER_ID, blank, db);
    assert.equal(out.alternate_no, null);
    assert.deepEqual(calls[0].params, [null, USER_ID]);
  }
  const calls = [];
  const db = { async query(sql, params) { calls.push({ sql: String(sql), params }); return [{ affectedRows: 1 }, []]; } };
  await selfService.setAlternateNo(USER_ID, NEW_MOBILE, db);
  assert.deepEqual(calls[0].params, [NEW_MOBILE, USER_ID]);
});

test('the mobile rule is the canonical [6-9] one, app-wide on both sides', async () => {
  /*
   * This test previously asserted the OPPOSITE — that self-service kept the
   * loose /^[0-9]{10}$/ so it could not disagree with Add User. The premise was
   * right and the conclusion was backwards: the fix for a mismatch is to
   * tighten the looser side, not to loosen the tighter one. routes/admin/users.js
   * now enforces /^[6-9][0-9]{9}$/ too, so the two still agree — on the rule
   * that is actually true of Indian mobiles.
   *
   * It matters here specifically because tbl_user.mobile_no is an OTP login
   * channel: a number outside 6-9 cannot receive the SMS, so storing one costs
   * the employee a way into the CRM without ever reporting an error.
   */
  const db = { async query() { return [{ affectedRows: 1 }, []]; } };
  await assert.rejects(
    () => selfService.setAlternateNo(USER_ID, '1234567890', db),
    (e) => e.code === 'INVALID_MOBILE',
    'a 10-digit number starting 1 is not a mobile and must be refused',
  );
  const ok = await selfService.setAlternateNo(USER_ID, '9812345678', db);
  assert.equal(ok.alternate_no, '9812345678');
});

// ═══════════════════════════════════════════════════════════════════════
// 5. BANK DETAILS — ENCRYPTED AT REST, MASKED ON READ, AUDITED ON REVEAL
// ═══════════════════════════════════════════════════════════════════════
/*
 * EVERY assertion in this section is on the BOUND SQL PARAMETER or on the
 * SERIALISED RESPONSE, never on what a helper returned. That distinction is the
 * whole value of the section: encryptBank() can be perfectly correct and the
 * account number still land in the table in clear, because the only thing that
 * matters is whether it was called on the right side of the JSON.stringify.
 * A test that asserted `encryptBank(x).account_number is a ciphertext` would
 * have passed throughout the leak it exists to catch.
 */

test('the request table stores CIPHERTEXT — asserted on the parameter actually bound to the INSERT', async () => {
  const db = fakeDb({ pending: null });
  await requestService.submitChanges(USER_ID, { bank: BANK }, db);

  const insert = sqlCall(db.calls, /INSERT INTO tbl_user_profile_update_request/);
  const stored = JSON.parse(insert.params[1]);   // the `changes` TEXT column

  assert.equal(fieldCrypto.isEncrypted(stored.bank.account_number), true,
    'the account number in the request JSON must be a v1 envelope');
  assert.equal(fieldCrypto.isEncrypted(stored.bank.account_name), true,
    'the holder name is PII and is encrypted too');
  assert.equal(fieldCrypto.decryptField(stored.bank.account_number), BANK.account_number);
  assert.equal(fieldCrypto.decryptField(stored.bank.account_name), BANK.account_name);

  // Clear ON PURPOSE: a published RBI branch code, a lookup label, and the four
  // digits the masked display is built from.
  assert.equal(stored.bank.ifsc, BANK.ifsc);
  assert.equal(stored.bank.bank_name, BANK.bank_name);
  assert.equal(stored.bank.account_last4, BANK_LAST4);

  /*
   * THE assertion this whole feature turns on. Not "the column is encrypted" —
   * "nothing this flow sent to the database contains the number anywhere". The
   * request table is one table over from the encrypted column and has no
   * masking layer in front of it; a plaintext copy here means an attacker reads
   * the pending queue and the encryption bought nothing.
   */
  const everythingSent = JSON.stringify(db.calls);
  assert.equal(everythingSent.includes(BANK.account_number), false,
    'the account number must not appear in ANY statement or parameter');
  assert.equal(everythingSent.includes(BANK.account_name), false);
});

test('MERGING into an open request encrypts the new bank AND snapshots the old one encrypted', async () => {
  const db = fakeDb({
    pending: {
      request_id: 55,
      changes: JSON.stringify({ date_of_birth: DOB }),
      old_values: JSON.stringify({ date_of_birth: null }),
    },
    personal: personalRowWithBank(),
  });
  await requestService.submitChanges(USER_ID, { bank: BANK }, db);

  const update = sqlCall(db.calls, /UPDATE tbl_user_profile_update_request/);
  const merged    = JSON.parse(update.params[0]);
  const oldValues = JSON.parse(update.params[1]);

  assert.equal(fieldCrypto.isEncrypted(merged.bank.account_number), true);
  assert.equal(fieldCrypto.decryptField(merged.bank.account_number), BANK.account_number);
  assert.equal(merged.date_of_birth, DOB, 'the merge must not drop the other field');

  // old_values is the STORED column value copied across — already ciphertext,
  // never decrypted and re-encrypted on the way.
  assert.equal(fieldCrypto.isEncrypted(oldValues.bank.account_number), true);
  assert.equal(fieldCrypto.decryptField(oldValues.bank.account_number), OLD_ACCOUNT);

  const everythingSent = JSON.stringify(db.calls);
  assert.equal(everythingSent.includes(BANK.account_number), false);
  assert.equal(everythingSent.includes(OLD_ACCOUNT), false,
    'the PREVIOUS account number must not be written back in clear either');
});

test('approve writes ciphertext to both encrypted columns and the plaintext TAIL to last4', async () => {
  const db = fakeDb({ requestRow: pendingRequestRow({ bank: BANK }) });
  await requestService.processRequest(55, { action: 'approve' }, { user_id: 3 }, db);

  const write = sqlCall(db.calls, /INSERT INTO tbl_user_personal_details/);
  // applyChanges binds [user_id, …cols in order…, created_on, updated_on] and
  // this request carries only `bank`, so the five bank columns follow the id.
  const [userId, acct, ifsc, name, bankName, last4] = write.params;
  assert.equal(userId, USER_ID);
  assert.equal(fieldCrypto.isEncrypted(acct), true);
  assert.equal(fieldCrypto.decryptField(acct), BANK.account_number);
  assert.equal(fieldCrypto.isEncrypted(name), true);
  assert.equal(fieldCrypto.decryptField(name), BANK.account_name);
  assert.equal(ifsc, BANK.ifsc);
  assert.equal(bankName, BANK.bank_name);

  assert.equal(last4, BANK_LAST4);
  assert.equal(BANK.account_number.endsWith(last4), true,
    'last4 is the tail of the PLAINTEXT — it is what the masked display is built from');
  assert.equal(fieldCrypto.isEncrypted(last4), false, 'last4 is clear on purpose');

  const everythingSent = JSON.stringify(db.calls);
  assert.equal(everythingSent.includes(BANK.account_number), false);
});

test('GET /details returns the MASKED bank — never the plaintext, and never the ciphertext', async () => {
  routeScenario.personal = personalRowWithBank();
  const res = await call('GET', '/profile/details');
  assert.equal(res.status, 200);

  const bank = res.body.data.bank;
  assert.deepEqual(Object.keys(bank).sort(),
    ['account_name_masked', 'account_number_masked', 'bank_name', 'has_details', 'ifsc'],
    'the response shape carries no raw account_number / account_name key at all');
  assert.equal(bank.account_number_masked, '••••7766');
  assert.equal(bank.account_name_masked, 'P•••• S•••• S••••');
  assert.equal(bank.has_details, true);
  assert.equal(bank.ifsc, 'ICIC0000123');

  const wire = JSON.stringify(res.body);
  assert.equal(wire.includes(OLD_ACCOUNT), false, 'the plaintext must not cross the wire');
  assert.equal(wire.includes(OLD_HOLDER), false);
  /*
   * And not the ciphertext either. "It is encrypted, so it is safe to ship" is
   * the tempting mistake: the value in the browser is one config leak from
   * being the plaintext, and it is a value nothing in the UI can render.
   */
  assert.equal(wire.includes('v1:'), false, 'a ciphertext is not a display value');
});

test('the HR queue masks the bank inside BOTH changes and old_values', async () => {
  const newBank = storedBank();
  const oldBank = storedBank({
    account_number: OLD_ACCOUNT, ifsc: 'ICIC0000123',
    account_name: OLD_HOLDER, bank_name: 'ICICI Bank',
  });
  const db = {
    async query(sql) {
      if (/COUNT\(\*\) AS total/.test(String(sql))) return [[{ total: 1 }], []];
      return [[{
        request_id: 55, user_id: USER_ID,
        changes:    JSON.stringify({ bank: newBank }),
        old_values: JSON.stringify({ bank: oldBank }),
        status: 'pending', requested_on: '2026-09-01 14:30:00',
        updated_on: null, processed_on: null,
      }], []];
    },
  };
  const out = await requestService.listRequests({ page: 1, limit: 20 }, db);
  const row = out.rows[0];

  assert.equal(row.changes.bank.account_number_masked, '••••8901');
  assert.equal(row.changes.bank.account_name_masked, 'P•••• S••••');
  assert.equal(row.old_values.bank.account_number_masked, '••••7766');
  assert.equal(row.changes.bank.ifsc, BANK.ifsc, 'the IFSC stays readable — it is public');

  const wire = JSON.stringify(out);
  assert.equal(wire.includes(BANK.account_number), false);
  assert.equal(wire.includes(BANK.account_name), false);
  assert.equal(wire.includes(OLD_ACCOUNT), false);
  assert.equal(wire.includes('v1:'), false);
});

test('a self reveal writes EXACTLY ONE audit row, inside the transaction, before the commit', async () => {
  const db = fakeDb({ personal: personalRowWithBank() });
  const out = await selfService.revealOwnBank(USER_ID, db);
  assert.equal(out.account_number, OLD_ACCOUNT);
  assert.equal(out.account_name, OLD_HOLDER);

  assert.equal(sqlCount(db.calls, /INSERT INTO tbl_sensitive_reveal_log/), 1,
    'exactly one row per reveal — not zero, and not one per column read');

  /*
   * ORDER IS THE POINT. An audit row written after the response, or on a
   * different connection, is the row that is missing when the process is killed
   * mid-request or the transaction rolls back — which is to say during exactly
   * the incident the log exists to explain.
   */
  const begin  = sqlIndex(db.calls, /__BEGIN__/);
  const audit  = sqlIndex(db.calls, /INSERT INTO tbl_sensitive_reveal_log/);
  const commit = sqlIndex(db.calls, /__COMMIT__/);
  assert.ok(begin >= 0 && begin < audit, 'the audit must be inside the transaction');
  assert.ok(audit < commit, 'the audit must be written before the commit');

  const [actor, subject, context, refId] = sqlCall(db.calls, /tbl_sensitive_reveal_log/).params;
  assert.equal(actor, USER_ID);
  assert.equal(subject, USER_ID, 'a self reveal names itself as subject rather than leaving it NULL');
  assert.equal(context, 'profile_self');
  assert.equal(refId, null, 'the live record has no second id to name');
});

test('a reveal with no bank details on file 404s and writes NO audit row', async () => {
  const db = fakeDb({ personal: null });
  await assert.rejects(
    selfService.revealOwnBank(USER_ID, db),
    (e) => e.status === 404 && e.code === 'NO_BANK_DETAILS',
  );
  assert.equal(sqlCount(db.calls, /INSERT INTO tbl_sensitive_reveal_log/), 0,
    'nothing was revealed, so nothing is logged');
  assert.equal(db.conn.rolledBack, true);
});

test('the admin reveal decrypts BOTH sides and audits actor ≠ subject with the request id', async () => {
  const db = fakeDb({
    revealRow: {
      request_id: 55,
      user_id: USER_ID,
      changes:    JSON.stringify({ bank: storedBank() }),
      old_values: JSON.stringify({
        bank: storedBank({
          account_number: OLD_ACCOUNT, ifsc: 'ICIC0000123',
          account_name: OLD_HOLDER, bank_name: 'ICICI Bank',
        }),
      }),
    },
  });
  const out = await requestService.revealRequestBank(55, { user_id: 3 }, db);

  // BOTH sides: approving a bank change is a comparison, and a reveal that
  // showed only the new value would send the approver back for a second one.
  assert.equal(out.bank.account_number, BANK.account_number);
  assert.equal(out.bank.account_name, BANK.account_name);
  assert.equal(out.old_bank.account_number, OLD_ACCOUNT);
  assert.equal(out.old_bank.account_name, OLD_HOLDER);

  assert.equal(sqlCount(db.calls, /INSERT INTO tbl_sensitive_reveal_log/), 1);
  const audit = sqlCall(db.calls, /tbl_sensitive_reveal_log/);
  assert.deepEqual(audit.params.slice(0, 4), [3, USER_ID, 'profile_update_request', 55],
    'actor is the approver, subject is the employee, ref_id names the request');
  const auditIdx  = sqlIndex(db.calls, /INSERT INTO tbl_sensitive_reveal_log/);
  const commitIdx = sqlIndex(db.calls, /__COMMIT__/);
  assert.ok(auditIdx < commitIdx);
});

test('POST /profile/bank/reveal is no-store and returns the value only after the audit', async () => {
  routeScenario.personal = personalRowWithBank();
  const res = await call('POST', '/profile/bank/reveal');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.account_number, OLD_ACCOUNT);
  assert.match(res.headers.get('cache-control'), /no-store/,
    'the one response that carries the value must not sit in the disk cache');
  assert.equal(
    fake.calls.filter((c) => /INSERT INTO tbl_sensitive_reveal_log/.test(c.sql)).length, 1,
  );
});

test('the admin reveal is gated on isProfileApprovalProcess, NOT on the view key', async () => {
  routeScenario.revealRow = {
    request_id: 55,
    user_id: USER_ID,
    changes: JSON.stringify({ bank: storedBank() }),
    old_values: null,
  };

  // Seeing the queue is the wider grant and must not carry the account number.
  grantedActions.add('isProfileApprovalView');
  const denied = await call('POST', '/admin/profile-update-requests/55/reveal');
  assert.equal(denied.status, 403);
  assert.equal(fake.calls.length, 0, 'a denied reveal reads nothing and audits nothing');

  grantedActions.add('isProfileApprovalProcess');
  const ok = await call('POST', '/admin/profile-update-requests/55/reveal');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('cache-control'), /no-store/);
  assert.equal(ok.body.data.bank.account_number, BANK.account_number);
  assert.equal(ok.body.data.old_bank, null, 'no prior bank on file → no "before" to show');
  assert.equal(
    fake.calls.filter((c) => /INSERT INTO tbl_sensitive_reveal_log/.test(c.sql)).length, 1,
  );
});

// ─── FAIL CLOSED, END TO END ──────────────────────────────────────────
/*
 * lib/field-crypto has its own key tests. These two assert the property that
 * only shows up at THIS layer: that a key outage stops at the boundary instead
 * of being caught somewhere and turned into a degraded write.
 */
async function withoutKey(fn) {
  const saved = process.env.EASYFIX_FIELD_ENC_KEY;
  delete process.env.EASYFIX_FIELD_ENC_KEY;
  try { await fn(); } finally { process.env.EASYFIX_FIELD_ENC_KEY = saved; }
}

test('with NO encryption key, submitting bank details is REFUSED and nothing is written', async () => {
  const db = fakeDb();
  await withoutKey(async () => {
    await assert.rejects(
      requestService.submitChanges(USER_ID, { bank: BANK }, db),
      (e) => e.status === 500 && e.code === 'FIELD_ENC_UNAVAILABLE',
    );
  });
  // Not one statement: the encrypt runs before the connection is taken, so the
  // refusal costs no lock — and, far more importantly, there is no partial path
  // on which a plaintext bank reaches a column or the request JSON.
  assert.equal(db.calls.length, 0, 'no lock, no INSERT, no UPDATE — nothing at all');
});

test('with NO encryption key, approving a bank request refuses rather than writing an unreadable row', async () => {
  const row = pendingRequestRow({ bank: BANK });   // encrypted while the key was present
  const db = fakeDb({ requestRow: row });
  await withoutKey(async () => {
    await assert.rejects(
      requestService.processRequest(55, { action: 'approve' }, { user_id: 3 }, db),
      (e) => e.status === 500,
    );
  });
  assert.equal(sqlCount(db.calls, /INSERT INTO tbl_user_personal_details/), 0,
    'a bank column must never be written with something that cannot be read back');
  assert.equal(sqlCount(db.calls, /UPDATE tbl_user_profile_update_request[\s\S]*SET status = \?/), 0,
    'and the request must NOT be flipped to approved — it stays pending, to be retried');
  assert.equal(db.conn.committed, false);
  assert.equal(db.conn.rolledBack, true);
});
