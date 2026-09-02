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
const s3Storage = require('../utils/s3-storage');
const validClaimAddress = Object.freeze({
  line: '12 Main Street',
  city: 'Gurugram',
  pincode: '122001',
  phone: '9999999999',
});

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

test('mobile shop is one capped active-item projection without admin counts', async () => {
  const r = route([
    [/FROM reward_items i[\s\S]*WHERE i\.status = 1/i, [{
      id: 1,
      name: 'Helmet',
      description: 'ISI marked',
      image_key: null,
      points_cost: 450,
      sizes: 'M,L',
      stock: 8,
    }]],
  ]);
  try {
    const rows = await rewards.listMobileShopItems({ limit: 999 });
    assert.equal(r.calls.length, 1, 'mobile Shop must execute one catalogue query');
    assert.equal(r.calls[0].params.at(-1), 50, 'the mobile catalogue has a hard 50-card cap');
    assert.doesNotMatch(r.calls[0].sql, /COUNT\s*\(|reward_claims|created_at|updated_at/i);
    assert.deepEqual(rows, [{
      id: 1,
      name: 'Helmet',
      description: 'ISI marked',
      points_cost: 450,
      stock: 8,
      sizeOptions: ['M', 'L'],
      imageUrl: null,
    }]);
  } finally {
    r.restore();
  }
});

test('mobile rewards summary leaves ledger history to the paginated Earn endpoint', async () => {
  const router = require('../routes/mobile/rewards');
  const layer = router.stack.find((entry) => (
    entry.route?.path === '/summary' && entry.route.methods?.get
  ));
  assert.ok(layer, 'GET /summary route must exist');
  const handler = layer.route.stack.at(-1).handle;

  const originals = {
    balanceFor: rewards.balanceFor,
    ledgerFor: rewards.ledgerFor,
    listMobileShopItems: rewards.listMobileShopItems,
    referralSummary: rewards.referralSummary,
    pointsConfig: rewards.pointsConfig,
  };
  let ledgerCalls = 0;
  rewards.balanceFor = async () => 720;
  rewards.ledgerFor = async () => {
    ledgerCalls += 1;
    throw new Error('summary must not preload ledger history');
  };
  rewards.listMobileShopItems = async () => [{ id: 1, name: 'Helmet' }];
  rewards.referralSummary = async () => ({ code: 'EFTEST', joined: 2, qualified: 1 });
  rewards.pointsConfig = () => ({ rules: [], earningPaused: false });

  let response;
  let failure;
  try {
    await handler(
      { tech: { efr_id: 8379 } },
      { json: (body) => { response = body; return body; } },
      (error) => { failure = error; },
    );
    assert.equal(failure, undefined);
    assert.equal(ledgerCalls, 0);
    assert.equal(response.success, true);
    assert.deepEqual(response.data.items, [{ id: 1, name: 'Helmet' }]);
    assert.ok(!Object.hasOwn(response.data, 'history'));
    assert.ok(!Object.hasOwn(response.data, 'historyTotal'));
  } finally {
    Object.assign(rewards, originals);
  }
});

test('mobile shop DTO resolves bounded image keys without exposing storage internals', async () => {
  const originalEnabled = s3Storage.isEnabled;
  const originalPresign = s3Storage.getPresignedUrl;
  const originalResolve = s3Storage.resolveImageUrl;
  s3Storage.isEnabled = () => true;
  s3Storage.getPresignedUrl = async (key) => `https://signed.example/${key}`;
  s3Storage.resolveImageUrl = async (key) => {
    if (key === 'broken-key') throw new Error('signing unavailable');
    return `https://cdn.example/${key}`;
  };
  try {
    const rows = await rewards.itemsForMobile([
      { id: 1, name: 'Helmet', image_key: 'Rewards/helmet-key' },
      { id: 2, name: 'Bottle', image_key: 'broken-key' },
    ]);
    assert.equal(rows[0].imageUrl, 'https://signed.example/Rewards/helmet-key',
      'canonical object keys are signed directly without an S3 HEAD probe');
    assert.equal(rows[1].imageUrl, null, 'one bad image must not fail the shop');
    assert.ok(rows.every((row) => !Object.hasOwn(row, 'image_key')),
      'raw object-store keys must remain server-side');
  } finally {
    s3Storage.isEnabled = originalEnabled;
    s3Storage.getPresignedUrl = originalPresign;
    s3Storage.resolveImageUrl = originalResolve;
  }
});

test('mobile shop bounds concurrent legacy image resolution', async () => {
  const originalEnabled = s3Storage.isEnabled;
  const originalResolve = s3Storage.resolveImageUrl;
  let active = 0;
  let peak = 0;
  s3Storage.isEnabled = () => true;
  s3Storage.resolveImageUrl = async (key) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return `https://cdn.example/${key}`;
  };
  try {
    const rows = await rewards.itemsForMobile(Array.from({ length: 17 }, (_, index) => ({
      id: index + 1,
      name: `Reward ${index + 1}`,
      image_key: `legacy-${index + 1}`,
    })));
    assert.equal(rows.length, 17);
    assert.ok(peak <= 5, `expected at most 5 concurrent legacy resolutions, saw ${peak}`);
  } finally {
    s3Storage.isEnabled = originalEnabled;
    s3Storage.resolveImageUrl = originalResolve;
  }
});

test('claim history is bounded, counted, and includes the frozen delivery destination', async () => {
  const r = route([
    [/SELECT id, item_id, item_name,[\s\S]*FROM reward_claims/i, [{
      id: 9,
      item_name: 'Helmet',
      points_spent: 450,
      status: 'ORDERED',
      address_line: '12 Main Street',
      address_city: 'Gurugram',
      address_pincode: '122001',
      address_phone: '9999999999',
    }]],
    [/SELECT COUNT\(\*\) AS total FROM reward_claims/i, [{ total: 1 }]],
  ]);
  try {
    const result = await rewards.claimsFor(8379, { limit: 20, offset: 0 });
    assert.equal(result.total, 1);
    assert.equal(result.rows[0].address_phone, '9999999999');
    assert.ok(r.calls.every((call) => call.params[0] === 8379),
      'both page and count stay scoped to the authenticated technician');
  } finally {
    r.restore();
  }
});

// ─── Spending ────────────────────────────────────────────────────────

test('a claim requires a complete delivery snapshot before any database work', async () => {
  await assert.rejects(
    () => rewards.claimItem(8379, {
      itemId: 1,
      address: { line: '12 Main Street', city: '', pincode: '', phone: '' },
      idempotencyKey: 'claim-invalid-address',
    }),
    (e) => e.status === 400 && /delivery city/i.test(e.message),
  );
});

test('a claim is refused when the balance is short, and nothing is written', async () => {
  const r = route([
    [/FROM reward_items WHERE id = \? FOR UPDATE/i, [{ id: 1, name: 'T-shirt', points_cost: 400, sizes: null, stock: 5, status: 1 }]],
    [/COALESCE\(SUM\(delta\), 0\) AS balance/i, [{ balance: 120 }]],
  ]);
  await assert.rejects(
    () => rewards.claimItem(8379, {
      itemId: 1,
      address: validClaimAddress,
      idempotencyKey: 'claim-short-balance',
    }),
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
  const result = await rewards.claimItem(8379, {
    itemId: 1,
    size: 'M',
    address: validClaimAddress,
    idempotencyKey: 'claim-success-1042',
  });
  assert.equal(result.claimId, 1042);
  assert.equal(result.balance, 840, 'the returned balance is already net of the spend');

  const debit = r.calls.find((c) => /INSERT INTO reward_points_ledger/i.test(c.sql));
  assert.ok(debit, 'the debit is written with the claim, not deferred to dispatch');
  assert.equal(debit.params[1], -400, 'the ledger delta is negative');
  const technicianLock = r.calls.findIndex((c) => /FROM tbl_easyfixer WHERE efr_id = \? FOR UPDATE/i.test(c.sql));
  const itemLock = r.calls.findIndex((c) => /FROM reward_items WHERE id = \? FOR UPDATE/i.test(c.sql));
  const balanceRead = r.calls.findIndex((c) => /COALESCE\(SUM\(delta\), 0\) AS balance/i.test(c.sql));
  assert.ok(technicianLock >= 0 && technicianLock < itemLock && itemLock < balanceRead,
    'one technician-scoped mutex must serialize claims for different products before balance is read');
  r.restore();
});

test('domain claim replay survives generic idempotency response loss without a second debit', async () => {
  let persistedClaim = null;
  const r = route([
    [/FROM reward_claims[\s\S]*idempotency_key = \?[\s\S]*FOR UPDATE/i,
      () => (persistedClaim ? [persistedClaim] : [])],
    [/FROM reward_items WHERE id = \? FOR UPDATE/i,
      [{ id: 1, name: 'T-shirt', points_cost: 400, sizes: 'S,M,L', stock: 5, status: 1 }]],
    [/COALESCE\(SUM\(delta\), 0\) AS balance/i,
      () => [{ balance: persistedClaim ? 840 : 1240 }]],
    [/UPDATE reward_items SET stock = stock - 1/i, { affectedRows: 1 }],
    [/INSERT INTO reward_claims/i, (_sql, params) => {
      persistedClaim = {
        id: 1042,
        item_id: params[1],
        size: params[3],
        points_spent: params[4],
        address_line: params[6],
        address_city: params[7],
        address_pincode: params[8],
        address_phone: params[9],
      };
      return { insertId: persistedClaim.id };
    }],
    [/INSERT INTO reward_points_ledger/i, { insertId: 7001 }],
  ]);
  try {
    const request = {
      itemId: 1,
      size: 'M',
      address: validClaimAddress,
      idempotencyKey: 'claim-response-lost-1042',
    };

    const first = await rewards.claimItem(8379, request);
    // Model the business commit followed by loss of the generic middleware's
    // stored response: the same service request reaches the domain again.
    const replay = await rewards.claimItem(8379, request);

    assert.deepEqual(replay, first);
    assert.equal(r.calls.filter((c) => /UPDATE reward_items SET stock = stock - 1/i.test(c.sql)).length, 1,
      'a domain replay must not decrement stock again');
    assert.equal(r.calls.filter((c) => /INSERT INTO reward_claims/i.test(c.sql)).length, 1,
      'a domain replay must not create another claim');
    assert.equal(r.calls.filter((c) => /INSERT INTO reward_points_ledger/i.test(c.sql)).length, 1,
      'a domain replay must not debit points again');
    assert.equal(r.calls.filter((c) => /FROM reward_items WHERE id = \? FOR UPDATE/i.test(c.sql)).length, 1,
      'the replay must return before taking the product lock');
  } finally {
    r.restore();
  }
});

test('a reward claim key cannot be reused with a different item, size, or address', async () => {
  const existing = {
    id: 1042,
    item_id: 1,
    size: 'M',
    points_spent: 400,
    address_line: validClaimAddress.line,
    address_city: validClaimAddress.city,
    address_pincode: validClaimAddress.pincode,
    address_phone: validClaimAddress.phone,
  };
  const variants = [
    { itemId: 2, size: 'M', address: validClaimAddress },
    { itemId: 1, size: 'L', address: validClaimAddress },
    { itemId: 1, size: 'M', address: { ...validClaimAddress, line: '99 Other Street' } },
  ];

  for (const variant of variants) {
    const r = route([
      [/FROM reward_claims[\s\S]*idempotency_key = \?[\s\S]*FOR UPDATE/i, [existing]],
    ]);
    try {
      await assert.rejects(
        () => rewards.claimItem(8379, {
          ...variant,
          idempotencyKey: 'claim-response-lost-1042',
        }),
        (error) => error.status === 409
          && error.details?.code === 'IDEMPOTENCY_KEY_REUSED',
      );
      assert.ok(!r.calls.some((call) => /FROM reward_items|UPDATE reward_items|INSERT INTO reward_points_ledger/i.test(call.sql)),
        'a mismatched replay must stop before product stock or points are touched');
    } finally {
      r.restore();
    }
  }
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
    () => rewards.claimItem(8379, {
      itemId: 1,
      address: validClaimAddress,
      idempotencyKey: 'claim-sold-out',
    }),
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
    () => rewards.claimItem(8379, {
      itemId: 1,
      address: validClaimAddress,
      idempotencyKey: 'claim-retired',
    }),
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

test('replaying the same referral code succeeds, but a different code remains immutable', async () => {
  const same = route([
    [/FROM reward_referral_codes WHERE code = \?/i, [{ easyfixer_id: 100 }]],
    [/SELECT id, referrer_efr_id, code[\s\S]*FROM reward_referrals[\s\S]*FOR UPDATE/i,
      [{ id: 55, referrer_efr_id: 100, code: 'EFFRIEND' }]],
    [/SELECT id FROM reward_referrals WHERE referred_efr_id = \?/i, []],
  ]);
  const replay = await rewards.attachReferral(200, '  effriend ');
  assert.equal(replay.idempotent, true);
  assert.equal(replay.code, 'EFFRIEND');
  assert.ok(!same.calls.some((call) => /INSERT INTO reward_referrals/i.test(call.sql)));
  same.restore();

  const different = route([
    [/FROM reward_referral_codes WHERE code = \?/i, [{ easyfixer_id: 101 }]],
    [/SELECT id, referrer_efr_id, code[\s\S]*FROM reward_referrals[\s\S]*FOR UPDATE/i,
      [{ id: 55, referrer_efr_id: 100, code: 'EFFRIEND' }]],
  ]);
  await assert.rejects(
    () => rewards.attachReferral(200, 'EFOTHER'),
    (error) => error.status === 409 && /different referral code/i.test(error.message),
  );
  different.restore();
});

test('a concurrent same-code insert collision is retried on a fresh transaction', async () => {
  const duplicate = Object.assign(new Error('concurrent attribution won'), { code: 'ER_DUP_ENTRY' });
  let collisionObserved = false;
  const r = route([
    [/FROM reward_referral_codes WHERE code = \?/i, [{ easyfixer_id: 100 }]],
    [/SELECT id, referrer_efr_id, code[\s\S]*FROM reward_referrals[\s\S]*FOR UPDATE/i,
      () => (collisionObserved
        ? [{ id: 55, referrer_efr_id: 100, code: 'EFFRIEND' }]
        : [])],
    [/INSERT INTO reward_referrals/i, () => {
      collisionObserved = true;
      return duplicate;
    }],
    [/SELECT id FROM reward_referrals WHERE referred_efr_id = \?/i, []],
  ]);
  const out = await rewards.attachReferral(200, 'EFFRIEND');
  assert.equal(out.idempotent, true);
  assert.equal(
    r.calls.filter((call) => /SELECT id, referrer_efr_id, code[\s\S]*FROM reward_referrals/i.test(call.sql)).length,
    2,
    'the unique-key winner is re-read instead of surfacing a 500',
  );
  assert.equal(r.calls.filter((call) => /INSERT INTO reward_referrals/i.test(call.sql)).length, 1);
  r.restore();
});

test('a referral attach lock-wait timeout is retried instead of leaking a 500', async () => {
  const timeout = Object.assign(new Error('gap lock busy'), { code: 'ER_LOCK_WAIT_TIMEOUT' });
  let timeoutObserved = false;
  const r = route([
    [/FROM reward_referral_codes WHERE code = \?/i, [{ easyfixer_id: 100 }]],
    [/SELECT id, referrer_efr_id, code[\s\S]*FROM reward_referrals[\s\S]*FOR UPDATE/i,
      () => (timeoutObserved
        ? [{ id: 56, referrer_efr_id: 100, code: 'EFFRIEND' }]
        : [])],
    [/INSERT INTO reward_referrals/i, () => {
      timeoutObserved = true;
      return timeout;
    }],
    [/SELECT id FROM reward_referrals WHERE referred_efr_id = \?/i, []],
  ]);
  const out = await rewards.attachReferral(201, 'EFFRIEND');
  assert.equal(out.idempotent, true);
  assert.equal(out.referrerEfrId, 100);
  r.restore();
});

test('applying a code after Complete Profile qualifies it immediately', async () => {
  const r = route([
    [/FROM reward_referral_codes WHERE code = \?/i, [{ easyfixer_id: 100 }]],
    [/SELECT id, referrer_efr_id, code[\s\S]*FROM reward_referrals[\s\S]*FOR UPDATE/i, []],
    [/INSERT INTO reward_referrals/i, { insertId: 55 }],
    [/SELECT id, referrer_efr_id, referred_efr_id, qualified_at[\s\S]*FROM reward_referrals/i,
      [{ id: 55, referrer_efr_id: 100, referred_efr_id: 200, qualified_at: null }]],
    [/FROM tbl_easyfixer e[\s\S]*LEFT JOIN tbl_user u/i, [{
      efr_id: 200,
      efr_name: 'Referred Technician',
      efr_no: '9999999999',
      has_active_deep_skill: 1,
      efr_service_category: null,
      efr_service_type: null,
      adhaar_card_number: '123412341234',
      efr_profile_img: 'profile.jpg',
      user_is_personal_detail_filled: 1,
      dob_present: 1,
      serviceable_pincodes_present: 1,
    }]],
    [/SELECT efr_status[\s\S]*FROM tbl_easyfixer/i, [{ efr_status: 1 }]],
    [/INSERT INTO reward_points_ledger/i, { insertId: 900 }],
    [/UPDATE reward_referrals SET qualified_at/i, { affectedRows: 1 }],
  ]);
  const out = await rewards.attachReferral(200, 'EFFRIEND');
  assert.equal(out.idempotent, false);
  assert.equal(out.qualification.qualified, true);
  assert.equal(out.qualification.awarded, true);
  assert.ok(r.calls.some((call) => /UPDATE reward_referrals SET qualified_at/i.test(call.sql)));
  r.restore();
});

function qualificationDatabase({ complete = true, duplicateLedger = null } = {}) {
  const events = [];
  const calls = [];
  const referral = {
    id: 55,
    referrer_efr_id: 100,
    referred_efr_id: 200,
    qualified_at: null,
  };
  const profile = {
    efr_id: 200,
    efr_name: 'Referred Technician',
    efr_no: '9999999999',
    has_active_deep_skill: complete ? 1 : 0,
    efr_service_category: null,
    efr_service_type: null,
    adhaar_card_number: complete ? '123412341234' : null,
    efr_profile_img: complete ? 'profile.jpg' : null,
    user_is_personal_detail_filled: complete ? 1 : 0,
    /*
     * A complete profile now also carries a date of birth and at least one
     * serviceable pincode — the two fields the app's own cards had always asked
     * for and nothing had ever checked. A referral qualifies when the referred
     * technician's profile is complete, so it qualifies on the SAME definition
     * the technician is let past the Complete Profile screen on; a fixture
     * still describing the old two-field version would keep passing while the
     * two halves drifted.
     */
    dob_present: complete ? 1 : 0,
    serviceable_pincodes_present: complete ? 1 : 0,
  };

  const conn = {
    async beginTransaction() { events.push('begin'); },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); },
    release() { events.push('release'); },
    async query(sql) {
      const text = String(sql);
      calls.push(text);
      if (/FROM reward_referrals[\s\S]*WHERE id = \?/i.test(text)) {
        events.push('lock-referral');
        return [[referral], []];
      }
      if (/FROM tbl_easyfixer e/i.test(text)) {
        events.push('read-profile');
        return [[profile], []];
      }
      if (/SELECT efr_status[\s\S]*FROM tbl_easyfixer/i.test(text)) {
        events.push('read-referrer');
        return [[{ efr_status: 1 }], []];
      }
      if (/INSERT INTO reward_points_ledger/i.test(text)) {
        events.push('insert-ledger');
        if (duplicateLedger !== null) {
          throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
        }
        return [{ insertId: 900 }, []];
      }
      if (/FROM reward_points_ledger/i.test(text)) {
        events.push('verify-ledger');
        return [[duplicateLedger], []];
      }
      if (/UPDATE reward_referrals SET qualified_at/i.test(text)) {
        events.push('mark-qualified');
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected qualification SQL: ${text}`);
    },
  };
  return {
    events,
    calls,
    async query(sql) {
      assert.match(String(sql), /SELECT id FROM reward_referrals WHERE referred_efr_id/i);
      events.push('probe-referral');
      return [[{ id: 55 }], []];
    },
    async getConnection() { events.push('connection'); return conn; },
  };
}

test('profile qualification writes ledger and qualified_at atomically, in that order', async () => {
  const database = qualificationDatabase();
  const out = await rewards.qualifyReferralIfEligible(200, {
    database,
    config: { earningPaused: false, referral: 200 },
  });
  assert.equal(out.qualified, true);
  assert.equal(out.awarded, true);
  assert.ok(database.events.indexOf('insert-ledger') < database.events.indexOf('mark-qualified'));
  assert.ok(database.events.indexOf('mark-qualified') < database.events.indexOf('commit'));
  assert.ok(!database.events.includes('rollback'));
  assert.match(
    database.calls.find((sql) => /SELECT efr_status[\s\S]*FROM tbl_easyfixer/i.test(sql)),
    /FOR UPDATE/i,
    'active referrer eligibility is locked through the ledger insert',
  );
});

test('an incomplete profile stays pending and writes no reward state', async () => {
  const database = qualificationDatabase({ complete: false });
  const out = await rewards.qualifyReferralIfEligible(200, {
    database,
    config: { earningPaused: false, referral: 200 },
  });
  assert.equal(out.qualified, false);
  assert.equal(out.completion.profileComplete, false);
  assert.ok(!database.events.includes('insert-ledger'));
  assert.ok(!database.events.includes('mark-qualified'));
  assert.ok(database.events.includes('commit'));
});

test('a duplicate referral ledger repairs qualified_at only when technician and points match', async () => {
  const valid = qualificationDatabase({
    duplicateLedger: { id: 900, easyfixer_id: 100, delta: 200 },
  });
  const repaired = await rewards.qualifyReferralIfEligible(200, {
    database: valid,
    config: { earningPaused: false, referral: 200 },
  });
  assert.equal(repaired.repaired, true);
  assert.ok(valid.events.includes('mark-qualified'));
  assert.ok(valid.events.includes('commit'));

  const inconsistent = qualificationDatabase({
    duplicateLedger: { id: 900, easyfixer_id: 999, delta: 200 },
  });
  await assert.rejects(
    () => rewards.qualifyReferralIfEligible(200, {
      database: inconsistent,
      config: { earningPaused: false, referral: 200 },
    }),
    /ledger is inconsistent/i,
  );
  assert.ok(inconsistent.events.includes('rollback'));
  assert.ok(!inconsistent.events.includes('mark-qualified'));
});

test('referral attribution is one lightweight read with no own-code generation or outgoing list', async () => {
  const r = route([
    [/FROM tbl_easyfixer e[\s\S]*LEFT JOIN reward_referrals r/i, [{
      efr_id: 200,
      efr_name: 'Referred',
      efr_no: '9999999999',
      has_active_deep_skill: 1,
      efr_service_category: null,
      efr_service_type: null,
      adhaar_card_number: '123412341234',
      efr_profile_img: 'profile.jpg',
      user_is_personal_detail_filled: 1,
      dob_present: 1,
      serviceable_pincodes_present: 1,
      referral_code: 'EFFRIEND',
      joined_at: new Date('2026-08-01T00:00:00Z'),
      qualified_at: null,
      referrer_name: 'Referrer',
    }]],
  ]);
  const out = await rewards.referralAttribution(200);
  assert.equal(out.referredBy.code, 'EFFRIEND');
  assert.equal(out.qualification.profileComplete, true);
  assert.equal(out.qualification.workAreaComplete, true);
  assert.equal(r.calls.length, 1);
  assert.ok(!r.calls.some((call) => /reward_referral_codes|INSERT INTO/i.test(call.sql)));
  r.restore();
});

test('referral summary uses aggregate totals even when the recent list is capped at 50', async () => {
  const recent = Array.from({ length: 50 }, (_, index) => ({
    referred_efr_id: index + 1,
    joined_at: new Date(),
    qualified_at: index < 20 ? new Date() : null,
    referred_name: `Tech ${index + 1}`,
  }));
  const r = route([
    [/SELECT r\.referred_efr_id[\s\S]*WHERE r\.referrer_efr_id/i, recent],
    [/SELECT COUNT\(\*\) AS joined/i, [{ joined: 123, qualified: 87 }]],
    [/SELECT r\.code[\s\S]*WHERE r\.referred_efr_id/i, []],
    [/SELECT code FROM reward_referral_codes WHERE easyfixer_id/i, [{ code: 'EFOWNER' }]],
  ]);
  const out = await rewards.referralSummary(100);
  assert.equal(out.joined, 123);
  assert.equal(out.qualified, 87);
  assert.equal(out.referrals.length, 50);
  r.restore();
});

test('CRM referral list is bounded, keyset-paginated and matches the page DTO', async () => {
  const records = Array.from({ length: 201 }, (_, index) => ({
    id: 500 - index,
    code: 'EFFRIEND',
    joined_at: new Date('2026-08-01T00:00:00Z'),
    qualified_at: index === 0 ? new Date('2026-08-02T00:00:00Z') : null,
    referrer_efr_id: 100,
    referrer_name: 'Referrer',
    referrer_mobile: '8882322333',
    referred_efr_id: 200 + index,
    referred_name: 'Referred',
    referred_mobile: '9999999999',
    has_active_deep_skill: 1,
    efr_service_category: null,
    efr_service_type: null,
    adhaar_card_number: '123412341234',
    efr_profile_img: 'profile.jpg',
    user_is_personal_detail_filled: 1,
    dob_present: 1,
    serviceable_pincodes_present: 1,
  }));
  const r = route([[/FROM reward_referrals r/i, records]]);
  const out = await rewards.listReferrals({
    status: 'pending', code: 'effriend', search: 'Referred', cursor: 800, limit: 999,
  });
  assert.equal(out.items.length, 200, 'hard page cap is 200');
  assert.equal(out.hasMore, true);
  assert.equal(typeof out.nextCursor, 'string');
  assert.deepEqual(out.items[0].referrer, {
    efrId: 100,
    name: 'Referrer',
    mobileMasked: '8882322333',
  });
  assert.deepEqual(out.items[0].profile, {
    skillsComplete: true,
    identityComplete: true,
    workAreaComplete: true,
    complete: true,
  });
  const query = r.calls[0];
  assert.match(query.sql, /r\.qualified_at IS NULL/);
  assert.match(query.sql, /r\.id < \?/);
  assert.match(query.sql, /ORDER BY r\.id DESC[\s\S]*LIMIT \?/);
  assert.equal(query.params.at(-1), 201, 'fetches only one look-ahead row');
  r.restore();

  const { maskMobileInResponse } = require('../utils/mask-mobile');
  assert.equal(
    maskMobileInResponse({ mobileMasked: '8882322333' }).mobileMasked,
    '8882••••••',
    'the inherited admin response masker covers the CRM DTO alias',
  );
});

test('referral reconciliation examines at most 200 pending IDs in pages of 50', async () => {
  const r = route([
    [/SELECT GET_LOCK/i, [{ acquired: 1 }]],
    [/SELECT RELEASE_LOCK/i, [{ released: 1 }]],
    [/SELECT last_referral_id[\s\S]*FROM reward_reconciliation_state/i,
      [{ last_referral_id: 0 }]],
    [/SELECT id, referred_efr_id[\s\S]*FROM reward_referrals/i,
      (_sql, params) => {
        const cursor = Number(params[0]);
        const take = Number(params.at(-1));
        return Array.from({ length: take }, (_, index) => ({
          id: cursor + index + 1,
          referred_efr_id: 1000 + cursor + index + 1,
        }));
      }],
    [/UPDATE reward_reconciliation_state/i, { affectedRows: 1 }],
  ]);
  const out = await rewards.reconcileReferralQualifications({
    limit: 9999,
    pageSize: 9999,
    config: { earningPaused: false, referral: 200 },
    qualify: async () => ({ qualified: false }),
  });
  assert.equal(out.cap, 200);
  assert.equal(out.scanned, 200);
  assert.equal(out.skipped, 200);
  const candidateReads = r.calls.filter((call) => /FROM reward_referrals/i.test(call.sql));
  assert.equal(candidateReads.length, 4);
  assert.ok(candidateReads.every((call) => call.params.at(-1) <= 50));
  assert.ok(candidateReads.every((call) => !/JOIN|tbl_easyfixer|tbl_user/i.test(call.sql)),
    'the LIMIT is applied to indexed pending referral IDs before profile eligibility');
  r.restore();
});

test('reconciliation counts incomplete rows and isolates a corrupt candidate', async () => {
  const r = route([
    [/SELECT GET_LOCK/i, [{ acquired: 1 }]],
    [/SELECT RELEASE_LOCK/i, [{ released: 1 }]],
    [/SELECT last_referral_id[\s\S]*FROM reward_reconciliation_state/i,
      [{ last_referral_id: 0 }]],
    [/SELECT id, referred_efr_id[\s\S]*FROM reward_referrals/i, [
      { id: 1, referred_efr_id: 101 },
      { id: 2, referred_efr_id: 102 },
      { id: 3, referred_efr_id: 103 },
    ]],
    [/UPDATE reward_reconciliation_state/i, { affectedRows: 1 }],
  ]);
  const visited = [];
  const out = await rewards.reconcileReferralQualifications({
    limit: 10,
    pageSize: 10,
    config: { earningPaused: false, referral: 200 },
    qualify: async (efrId) => {
      visited.push(efrId);
      if (efrId === 102) throw Object.assign(new Error('bad legacy row'), { code: 'ER_BAD_FIELD_ERROR' });
      if (efrId === 103) return { awarded: true };
      return { qualified: false, reason: 'profile_incomplete' };
    },
  });
  assert.deepEqual(visited, [101, 102, 103], 'one bad row cannot poison later candidates');
  assert.deepEqual(
    { scanned: out.scanned, awarded: out.awarded, skipped: out.skipped, errors: out.errors },
    { scanned: 3, awarded: 1, skipped: 1, errors: 1 },
  );
  r.restore();
});

test('reconciliation cursor wraps once and persists the last claimed ID', async () => {
  const r = route([
    [/SELECT GET_LOCK/i, [{ acquired: 1 }]],
    [/SELECT RELEASE_LOCK/i, [{ released: 1 }]],
    [/SELECT last_referral_id[\s\S]*FROM reward_reconciliation_state/i,
      [{ last_referral_id: 50 }]],
    [/SELECT id, referred_efr_id[\s\S]*FROM reward_referrals/i,
      (sql) => (/id <= \?/i.test(sql)
        ? [
          { id: 10, referred_efr_id: 110 },
          { id: 20, referred_efr_id: 120 },
        ]
        : [{ id: 70, referred_efr_id: 170 }])],
    [/UPDATE reward_reconciliation_state/i, { affectedRows: 1 }],
  ]);
  const out = await rewards.reconcileReferralQualifications({
    limit: 3,
    pageSize: 2,
    config: { earningPaused: false, referral: 200 },
    qualify: async () => ({ qualified: false }),
  });
  assert.equal(out.scanned, 3);
  assert.equal(out.wrapped, true);
  assert.equal(out.cursor, 20);
  const update = r.calls.find((call) => /UPDATE reward_reconciliation_state/i.test(call.sql));
  assert.equal(update.params[0], 20);
  r.restore();
});

test('a parallel reconciliation replica skips without reading candidate rows', async () => {
  const r = route([[/SELECT GET_LOCK/i, [{ acquired: 0 }]]]);
  const out = await rewards.reconcileReferralQualifications({
    config: { earningPaused: false, referral: 200 },
  });
  assert.equal(out.lockSkipped, true);
  assert.equal(out.scanned, 0);
  assert.ok(!r.calls.some((call) => /FROM reward_referrals|reward_reconciliation_state/i.test(call.sql)));
  r.restore();
});

test('CRM referral audit stays masked even when unmasked=true is supplied', () => {
  const maskMobile = require('../middleware/mask-mobile');
  let responseBody;
  const req = {
    path: '/rewards/referrals',
    query: { unmasked: 'true' },
  };
  const res = {
    json(body) { responseBody = body; return body; },
  };
  let continued = false;
  maskMobile(req, res, () => { continued = true; });
  assert.equal(continued, true);
  res.json({ items: [{ referrer: { mobileMasked: '8882322333' } }] });
  assert.equal(responseBody.items[0].referrer.mobileMasked, '8882••••••');
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

  // ORDER is part of the contract: both the CRM panel and the app screen
  // render this array as-is, and "what earns the most?" is the question the
  // list is read to answer, so the largest sits first.
  assert.deepEqual(
    config.rules.map((r) => r.code),
    ['REFERRAL', 'SDA', 'RATING'],
    'published rules must be ordered highest-value first',
  );
  const points = config.rules.map((r) => r.points);
  assert.deepEqual(points, [...points].sort((a, b) => b - a), 'strictly descending');
});
