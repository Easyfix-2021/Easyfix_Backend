const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * LMS chase-log characterization tests.
 *
 * Three invariants, each chosen because breaking it produces something that
 * LOOKS fine:
 *
 *   1. Masking happens INSIDE recordChase. If a caller could pass a
 *      pre-masked value — or if the mask were applied at the call site — the
 *      first caller to forget turns an audit log into a second copy of every
 *      technician's mobile number. Same posture as the bank log.
 *   2. recordChase NEVER rejects. A WhatsApp message that has already left
 *      the building must not be reported as a failure because the note did
 *      not write. The audit hole is logged loudly instead.
 *   3. The cooldown fails OPEN. A cooldown is a courtesy; refusing to chase
 *      because the cooldown lookup broke would make a failed query
 *      indistinguishable from a completed chase — the one outcome this
 *      module exists to prevent.
 */

let scenario = [];
let failNext = false;
const fake = installFakePool([[/.*/, (sql, params) => {
  if (failNext) throw new Error('simulated DB outage');
  for (const [re, rows] of scenario) if (re.test(sql)) return typeof rows === 'function' ? rows(sql, params) : rows;
  return [];
}]]);
const chase = require('../services/lms-chase.service');
const props = require('../services/properties.service');

after(() => fake.restore());

function insertCall() {
  return fake.calls.find((c) => /INSERT INTO lms_chase_log/i.test(c.sql));
}

// ─── 1. Masking is not optional ──────────────────────────────────────

test('recordChase MASKS the mobile — the full number never reaches the table', async () => {
  fake.reset(); scenario = [];
  const res = await chase.recordChase({
    efrId: 8379, channel: 'whatsapp', outcome: 'sent',
    targetType: 'course', courseId: 4,
    recipientMobile: '9876543210',
    actor: { user_id: 12 }, actorRoleName: 'Admin', actorSource: 'crm',
  });
  assert.equal(res.logged, true);
  const call = insertCall();
  assert.ok(call, 'the row must be written');
  const asText = JSON.stringify(call.params);
  assert.ok(!asText.includes('9876543210'), 'the unmasked number must NOT be in the bound parameters');
  const masked = call.params[13];
  assert.match(String(masked), /•/, 'the stored value must be the masked form');
});

test('recordChase writes NULL, not "undefined", when there is no number to mask', async () => {
  fake.reset(); scenario = [];
  await chase.recordChase({ efrId: 1, channel: 'nudge', outcome: 'sent', targetType: 'technician' });
  assert.equal(insertCall().params[13], null);
});

test('actor_role_name is stored as passed — a SNAPSHOT, not resolved later', async () => {
  fake.reset(); scenario = [];
  await chase.recordChase({
    efrId: 1, channel: 'call', outcome: 'noted', targetType: 'technician',
    actor: { user_id: 7 }, actorRoleName: 'Zonal Field Team',
  });
  const p = insertCall().params;
  assert.equal(p[10], 7, 'actor_user_id');
  assert.equal(p[11], 'Zonal Field Team',
    'the role at the time of the chase — a later rename must not rewrite history');
});

// ─── 2. Never rejects ────────────────────────────────────────────────

test('recordChase NEVER rejects when the DB is down — the chase already happened', async () => {
  fake.reset(); failNext = true;
  try {
    const res = await chase.recordChase({
      efrId: 5, channel: 'whatsapp', outcome: 'sent', targetType: 'course', recipientMobile: '9000000000',
    });
    assert.equal(res.logged, false, 'it reports the hole rather than throwing into the caller');
  } finally { failNext = false; }
});

test('recordChaseBatch NEVER rejects either, and reports zero rows written', async () => {
  fake.reset(); failNext = true;
  try {
    const res = await chase.recordChaseBatch([
      { efrId: 1, channel: 'nudge', outcome: 'sent', targetType: 'course' },
      { efrId: 2, channel: 'nudge', outcome: 'sent', targetType: 'course' },
    ]);
    assert.equal(res.logged, false);
    assert.equal(res.count, 0);
  } finally { failNext = false; }
});

test('recordChaseBatch of nothing is a no-op, not an INSERT with no VALUES', async () => {
  fake.reset(); scenario = [];
  const res = await chase.recordChaseBatch([]);
  assert.deepEqual(res, { logged: true, count: 0 });
  assert.equal(insertCall(), undefined, 'no statement at all');
});

// ─── 3. The batch path and the single path agree ─────────────────────

test('batch rows are built by the SAME mapper as single rows — one INSERT, N placeholder groups', async () => {
  fake.reset(); scenario = [];
  await chase.recordChaseBatch([
    { efrId: 1, channel: 'nudge', outcome: 'sent', targetType: 'course', courseId: 4, recipientMobile: '9111111111' },
    { efrId: 2, channel: 'nudge', outcome: 'skipped', outcomeDetail: 'cooldown', targetType: 'course', courseId: 4 },
  ]);
  const call = insertCall();
  assert.equal((call.sql.match(/\(\?, \?, \?/g) || []).length, 2, 'exactly two placeholder groups');
  assert.equal(call.params.length, 34, '17 columns x 2 rows — the two paths cannot drift');
  assert.ok(!JSON.stringify(call.params).includes('9111111111'), 'batch masks too');
});

test('a SKIPPED chase is logged — a skip that leaves no trace looks like a bug', async () => {
  fake.reset(); scenario = [];
  await chase.recordChase({
    efrId: 3, channel: 'nudge', outcome: 'skipped', outcomeDetail: 'cooldown', targetType: 'course',
  });
  const p = insertCall().params;
  assert.equal(p[2], 'skipped');
  assert.equal(p[3], 'cooldown');
});

// ─── 4. Hand-off advance is narrow ───────────────────────────────────

test('a skipped or failed chase does NOT advance a hand-off to "chased"', async () => {
  for (const outcome of ['skipped', 'failed']) {
    fake.reset(); scenario = [];
    await chase.recordChase({ efrId: 9, channel: 'nudge', outcome, targetType: 'course', courseId: 4 });
    const advanced = fake.calls.find((c) => /UPDATE lms_chase_assignment/i.test(c.sql));
    assert.equal(advanced, undefined, `outcome=${outcome} must not mark the field's work done`);
  }
});

test('a successful chase DOES advance an open hand-off', async () => {
  fake.reset(); scenario = [];
  await chase.recordChase({ efrId: 9, channel: 'whatsapp', outcome: 'sent', targetType: 'course', courseId: 4 });
  const advanced = fake.calls.find((c) => /UPDATE lms_chase_assignment/i.test(c.sql));
  assert.ok(advanced, 'the field team should never have to remember to tick anything');
  assert.match(advanced.sql, /status = 'open'/, 'only OPEN rows advance');
  assert.match(advanced.sql, /created_at <= \?/, 'a hand-off issued AFTER this chase was not actioned by it');
});

// ─── 5. Cooldown ─────────────────────────────────────────────────────

test('withinCooldown fails OPEN — a broken lookup must not look like a completed chase', async () => {
  fake.reset(); failNext = true;
  try {
    const skip = await chase.withinCooldown([1, 2, 3], 'nudge');
    assert.equal(skip.size, 0, 'nobody is skipped when we cannot tell');
  } finally { failNext = false; }
});

test('withinCooldown returns the set to SKIP, keyed by technician', async () => {
  fake.reset();
  scenario = [[/FROM lms_chase_log/i, [{ efr_id: 2 }, { efr_id: 3 }]]];
  const skip = await chase.withinCooldown([1, 2, 3], 'nudge');
  assert.deepEqual([...skip].sort(), [2, 3]);
});

test('cooldownHours: a BLANK property falls back rather than becoming zero', () => {
  const original = props.getProperty;
  try {
    props.getProperty = () => '';
    assert.equal(chase.cooldownHours(), 20, 'Number("") is 0 — a 0 here silently removes the cooldown');
    props.getProperty = () => '6';
    assert.equal(chase.cooldownHours(), 6);
    props.getProperty = () => '0';
    assert.equal(chase.cooldownHours(), 0, 'an explicit 0 is a deliberate "no cooldown"');
  } finally { props.getProperty = original; }
});

test('chaseSummaryFor fails soft — history is context, not correctness', async () => {
  fake.reset(); failNext = true;
  try {
    const m = await chase.chaseSummaryFor([1, 2]);
    assert.equal(m.size, 0, 'the drilldown still renders, just without "last chased"');
  } finally { failNext = false; }
});

test('chaseSummaryFor issues ONE grouped read, never one per row', async () => {
  fake.reset();
  scenario = [[/FROM lms_chase_log/i, [{ efr_id: 1, last_chased_at: new Date(), count_7d: 2, last_channel: 'nudge' }]]];
  await chase.chaseSummaryFor([1, 2, 3, 4, 5]);
  const reads = fake.calls.filter((c) => /FROM lms_chase_log/i.test(c.sql));
  assert.equal(reads.length, 1, 'a per-row query is how a list screen dies at 50 rows');
});
