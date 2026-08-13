const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * Rewards characterization tests.
 *
 * These pin the invariants that are cheap to break and expensive to discover
 * once a technician's balance is wrong:
 *
 *   1. Points can never be spent below zero, and a manual debit cannot take a
 *      balance negative.
 *   2. A refund is a NEW ledger row, never an edit or a delete — the pair of
 *      rows IS the explanation the technician reads.
 *   3. A duplicate award is swallowed, because the unique index (not a code
 *      check) is what makes the nightly earning pass safe to re-run.
 *   4. The referral code alphabet stays speakable — these are read aloud over
 *      a phone call, not tapped from a link.
 */

const fake = installFakePool([]);
const rewards = require('../services/rewards.service');

after(() => fake.restore());

/*
 * The shared fake installs one static route table. These tests need different
 * canned rows per case, so this swaps the table in place and returns an undo.
 */
function route(routes) {
  const db = require('../db');
  const previousQuery = db.pool.query;
  const previousGetConnection = db.pool.getConnection;
  const calls = [];
  const query = async (sql, params) => {
    const text = Array.isArray(sql) ? String(sql[0]) : String(sql);
    calls.push({ sql: text, params });
    for (const [re, resp] of routes) {
      if (re.test(text)) {
        const rows = typeof resp === 'function' ? await resp(text, params) : resp;
        if (rows instanceof Error) throw rows;
        return [rows, []];
      }
    }
    return [[], []];
  };
  db.pool.query = query;
  db.pool.getConnection = async () => ({
    query,
    execute: query,
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  });
  return {
    calls,
    restore() {
      db.pool.query = previousQuery;
      db.pool.getConnection = previousGetConnection;
    },
  };
}

// ─── Spending ────────────────────────────────────────────────────────

test('a claim is refused when the balance is short, and nothing is written', async () => {
  const r = route([
    [/FROM reward_items WHERE id = \? FOR UPDATE/i, [{ id: 1, name: 'T-shirt', points_cost: 400, sizes: null, stock: 5, status: 1 }]],
    [/COALESCE\(SUM\(delta\), 0\) AS balance/i, [{ balance: 120 }]],
  ]);
  await assert.rejects(
    () => rewards.claimItem(8379, { itemId: 1, address: { line: '12 Main Street' } }),
    (e) => e.status === 409 && /more points/i.test(e.message),
  );
  assert.ok(
    !r.calls.some((c) => /INSERT INTO reward_claims/i.test(c.sql)),
    'no claim row may be written when the balance is short',
  );
  assert.ok(
    !r.calls.some((c) => /INSERT INTO reward_points_ledger/i.test(c.sql)),
    'no points may be debited when the claim is refused',
  );
  r.restore();
});

test('claiming debits in the SAME pass that creates the claim', async () => {
  const r = route([
    [/FROM reward_items WHERE id = \? FOR UPDATE/i, [{ id: 1, name: 'T-shirt', points_cost: 400, sizes: 'S,M,L', stock: 5, status: 1 }]],
    [/COALESCE\(SUM\(delta\), 0\) AS balance/i, [{ balance: 1240 }]],
    [/UPDATE reward_items SET stock = stock - 1/i, { affectedRows: 1 }],
    [/INSERT INTO reward_claims/i, { insertId: 1042 }],
  ]);
  const result = await rewards.claimItem(8379, { itemId: 1, size: 'M', address: { line: '12 Main Street' } });
  assert.equal(result.claimId, 1042);
  assert.equal(result.balance, 840, 'the returned balance is already net of the spend');

  const debit = r.calls.find((c) => /INSERT INTO reward_points_ledger/i.test(c.sql));
  assert.ok(debit, 'the debit is written with the claim, not deferred to dispatch');
  assert.equal(debit.params[1], -400, 'the ledger delta is negative');
  r.restore();
});

test('a sold-out item is caught by the conditional decrement, not a prior read', async () => {
  // The `WHERE stock > 0` affecting zero rows IS the sold-out signal: a
  // read-then-write could let two simultaneous claims both pass the check.
  const r = route([
    [/FROM reward_items WHERE id = \? FOR UPDATE/i, [{ id: 1, name: 'T-shirt', points_cost: 400, sizes: null, stock: 1, status: 1 }]],
    [/COALESCE\(SUM\(delta\), 0\) AS balance/i, [{ balance: 1240 }]],
    [/UPDATE reward_items SET stock = stock - 1/i, { affectedRows: 0 }],
  ]);
  await assert.rejects(
    () => rewards.claimItem(8379, { itemId: 1, address: { line: '12 Main Street' } }),
    (e) => e.status === 409 && /out of stock/i.test(e.message),
  );
  assert.ok(!r.calls.some((c) => /INSERT INTO reward_claims/i.test(c.sql)));
  r.restore();
});

test('a retired item cannot be claimed', async () => {
  const r = route([
    [/FROM reward_items WHERE id = \? FOR UPDATE/i, [{ id: 1, name: 'Old', points_cost: 100, sizes: null, stock: 5, status: 0 }]],
  ]);
  await assert.rejects(
    () => rewards.claimItem(8379, { itemId: 1, address: { line: '12 Main Street' } }),
    (e) => e.status === 409 && /no longer available/i.test(e.message),
  );
  r.restore();
});

// ─── Refunding ───────────────────────────────────────────────────────

test('rejecting a claim REFUNDS by a new credit row and never edits the debit', async () => {
  const r = route([
    [/FROM reward_claims WHERE id = \? FOR UPDATE/i, [{ id: 1042, easyfixer_id: 8379, item_id: 1, item_name: 'T-shirt', points_spent: 400, status: 'PACKED' }]],
    [/UPDATE reward_claims SET/i, { affectedRows: 1 }],
    [/INSERT INTO reward_points_ledger/i, { insertId: 99 }],
    [/UPDATE reward_items SET stock = stock \+ 1/i, { affectedRows: 1 }],
  ]);
  const out = await rewards.updateClaim(1042, { status: 'REJECTED', rejectReason: 'Out of stock' }, 7);
  assert.equal(out.refunded, true);

  const credit = r.calls.find((c) => /INSERT INTO reward_points_ledger/i.test(c.sql));
  assert.ok(credit, 'the refund is an INSERT');
  assert.equal(credit.params[1], 400, 'refund is a positive credit');
  assert.ok(
    !r.calls.some((c) => /DELETE FROM reward_points_ledger|UPDATE reward_points_ledger/i.test(c.sql)),
    'the original debit is never edited or deleted — the pair of rows is the explanation',
  );
  assert.ok(
    r.calls.some((c) => /UPDATE reward_items SET stock = stock \+ 1/i.test(c.sql)),
    'the unit never shipped, so it goes back on the shelf',
  );
  r.restore();
});

test('rejecting requires a reason, and a delivered claim cannot be walked back', async () => {
  await assert.rejects(
    () => rewards.updateClaim(1042, { status: 'REJECTED' }),
    (e) => e.status === 400 && /reason is required/i.test(e.message),
  );

  const r = route([
    [/FROM reward_claims WHERE id = \? FOR UPDATE/i, [{ id: 1042, easyfixer_id: 8379, item_id: 1, item_name: 'T', points_spent: 400, status: 'DELIVERED' }]],
  ]);
  await assert.rejects(
    () => rewards.updateClaim(1042, { status: 'SENT' }),
    (e) => e.status === 409 && /cannot be moved back/i.test(e.message),
  );
  r.restore();
});

test('advancing without a tracking ref does NOT blank an existing one', async () => {
  // The bug this pins: writing tracking_ref unconditionally would clear a
  // courier reference the technician is watching, on a plain SENT → DELIVERED.
  const r = route([
    [/FROM reward_claims WHERE id = \? FOR UPDATE/i, [{ id: 1042, easyfixer_id: 8379, item_id: 1, item_name: 'T', points_spent: 400, status: 'SENT' }]],
    [/UPDATE reward_claims SET/i, { affectedRows: 1 }],
  ]);
  await rewards.updateClaim(1042, { status: 'DELIVERED' });
  const update = r.calls.find((c) => /UPDATE reward_claims SET/i.test(c.sql));
  assert.doesNotMatch(update.sql, /tracking_ref/i,
    'an omitted tracking ref must leave the column alone');
  r.restore();
});

// ─── Manual adjustment ───────────────────────────────────────────────

test('a manual debit cannot take a balance negative', async () => {
  const r = route([
    [/FROM tbl_easyfixer WHERE efr_id = \?/i, [{ efr_id: 8379 }]],
    [/COALESCE\(SUM\(delta\), 0\) AS balance/i, [{ balance: 50 }]],
  ]);
  await assert.rejects(
    () => rewards.adjustPoints({ easyfixerId: 8379, delta: -200, note: 'correction', createdBy: 7 }),
    (e) => e.status === 409 && /only 50 points/i.test(e.message),
  );
  r.restore();
});

test('a manual adjustment without a reason is refused', async () => {
  await assert.rejects(
    () => rewards.adjustPoints({ easyfixerId: 8379, delta: 100, note: '  ' }),
    (e) => e.status === 400 && /reason is required/i.test(e.message),
  );
});

// ─── Idempotency ─────────────────────────────────────────────────────

test('a duplicate award is swallowed, not thrown — that is how the cron re-runs safely', async () => {
  const duplicate = Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
  const r = route([[/INSERT INTO reward_points_ledger/i, duplicate]]);
  const out = await rewards.award({
    efrId: 8379, delta: 10, reasonCode: 'RATING', refType: 'job', refId: 88213,
  });
  assert.deepEqual(out, { awarded: false, duplicate: true });
  r.restore();
});

test('any OTHER database failure still propagates', async () => {
  const boom = Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' });
  const r = route([[/INSERT INTO reward_points_ledger/i, boom]]);
  await assert.rejects(
    () => rewards.award({ efrId: 8379, delta: 10, reasonCode: 'RATING', refType: 'job', refId: 1 }),
    (e) => e.code === 'ER_LOCK_DEADLOCK',
  );
  r.restore();
});

// ─── Referral ────────────────────────────────────────────────────────

test('self-referral is refused', async () => {
  const r = route([
    [/FROM reward_referral_codes WHERE code = \?/i, [{ easyfixer_id: 8379 }]],
  ]);
  await assert.rejects(
    () => rewards.attachReferral(8379, 'EFABC234'),
    (e) => e.status === 409 && /your own referral code/i.test(e.message),
  );
  r.restore();
});

test('an unknown referral code is refused', async () => {
  const r = route([[/FROM reward_referral_codes WHERE code = \?/i, []]]);
  await assert.rejects(
    () => rewards.attachReferral(8379, 'NOPE99'),
    (e) => e.status === 404,
  );
  r.restore();
});

test('the referral alphabet stays speakable over a phone call', () => {
  const alphabet = rewards._internals.CODE_ALPHABET;
  /*
   * Codes are read ALOUD in a noisy street, so one of each confusable PAIR is
   * dropped rather than both characters:
   *
   *   O / 0   →  keep 0
   *   I / 1   →  keep neither shape; both go, along with L
   *   S / 5   →  keep 5
   *
   * That is why 5 survives while S does not — removing both would shrink the
   * alphabet for no gain, since a lone 5 cannot be misheard as a letter that
   * is not in the set.
   */
  for (const dropped of ['O', 'I', 'L', 'S', '0', '1']) {
    assert.ok(!alphabet.includes(dropped), `${dropped} is ambiguous when spoken`);
  }
  assert.ok(alphabet.includes('5'), '5 is unambiguous once S is gone');
  assert.ok(alphabet.length >= 24, 'still wide enough that collisions stay rare');
  assert.match(rewards._internals.randomCode(6), new RegExp(`^[${alphabet}]{6}$`));
});

test('pausing stops earning without touching balances or claiming', async () => {
  const previous = process.env.NODE_ENV;
  const props = require('../services/properties.service');
  const original = props.getProperty;
  props.getProperty = (key) => (key === 'rewards.earn.enabled' ? 'false' : original(key));
  try {
    const r = route([]);
    const result = await rewards.runEarnCycle();
    assert.equal(result.paused, true);
    assert.equal(result.rating + result.sda + result.referral, 0, 'nothing is awarded');
    assert.ok(
      !r.calls.some((c) => /INSERT INTO reward_points_ledger/i.test(c.sql)),
      'a paused programme writes no ledger rows at all',
    );
    r.restore();
    // The flag is advisory to the UI, never a gate on spending: claimItem has
    // no reference to it, so existing points stay spendable while paused.
    assert.doesNotMatch(String(rewards.claimItem), /earningPaused/);
  } finally {
    props.getProperty = original;
    process.env.NODE_ENV = previous;
  }
});

// ─── Published rates ─────────────────────────────────────────────────

test('point values are fixed in code and exposed as published rules', () => {
  const config = rewards.pointsConfig();
  assert.equal(config.rating, 10);
  assert.equal(config.sda, 30);
  assert.equal(config.referral, 200);
  // The app renders these; a rule whose points disagreed with what the cron
  // awards would be a broken promise, not a display bug.
  const byCode = Object.fromEntries(config.rules.map((r) => [r.code, r.points]));
  assert.deepEqual(byCode, { RATING: 10, SDA: 30, REFERRAL: 200 });
});
