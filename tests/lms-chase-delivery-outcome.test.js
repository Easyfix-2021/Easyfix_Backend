/*
 * A chase must record what actually happened to each technician.
 *
 * Until 2026-09-04 the nudge route decided the outcome from whether a device
 * TOKEN existed, not from whether FCM accepted it — so a technician whose push
 * was rejected was logged 'sent', identically to one who received it. That is
 * worse than a cosmetic audit lie: withinCooldown and chaseSummaryFor both
 * filter `outcome IN ('sent','noted','queued')`, so the false success then
 * SUPPRESSED the retry that would have worked, and advanceHandoff moved the
 * field-view status on for a push nobody got.
 *
 * These tests pin the three-way split at its source — deliver() must report
 * WHICH technicians were reached, not just how many — because the route's own
 * mapping is only as honest as that. Fake pool, no network.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/FROM tbl_easyfixer_app/i, () => []],
  [/FROM device_info/i, () => []],
]);

const pushDelivery = require('../services/push-delivery.service');
const fcmService = require('../services/fcm.service');

const originalSendPush = fcmService.sendPush;

beforeEach(() => {
  fake.reset();
  fcmService.sendPush = originalSendPush;
});

/** Accept some tokens and reject others, the way a real FCM batch does. */
function stubFcm(acceptedTokens) {
  fcmService.sendPush = async ({ token }) => ({ delivered: acceptedTokens.has(token) });
}

test('deliver reports which technicians were reached, not only how many', async () => {
  stubFcm(new Set(['tok-a']));
  const out = await pushDelivery.deliver(
    [{ efrId: 1, token: 'tok-a' }, { efrId: 2, token: 'tok-b' }],
    { title: 't', body: 'b', data: {} },
    { prune: false },
  );

  assert.equal(out.deliveredCount, 1);
  assert.equal(out.tokenCount, 2);
  assert.ok(out.deliveredEfrIds instanceof Set, 'deliveredEfrIds must be a Set');
  assert.deepEqual([...out.deliveredEfrIds], [1], 'only the accepted technician is reached');
});

test('one accepted token is enough when a technician has several devices', async () => {
  // The old phone still holds a dead token; the new one works. The technician
  // HAS been reached, and recording 'failed' here would suppress nothing but
  // would misreport a push they are holding in their hand.
  stubFcm(new Set(['tok-new']));
  const out = await pushDelivery.deliver(
    [{ efrId: 7, token: 'tok-dead' }, { efrId: 7, token: 'tok-new' }],
    { title: 't', body: 'b', data: {} },
    { prune: false },
  );

  assert.equal(out.deliveredCount, 1);
  assert.deepEqual([...out.deliveredEfrIds], [7]);
});

test('a rejected technician is absent from deliveredEfrIds, so the route can log failed', async () => {
  stubFcm(new Set());
  const out = await pushDelivery.deliver(
    [{ efrId: 3, token: 'tok-c' }],
    { title: 't', body: 'b', data: {} },
    { prune: false },
  );

  assert.equal(out.delivered, false);
  assert.equal(out.deliveredCount, 0);
  assert.equal(out.tokenCount, 1, 'the token existed — this is a rejection, not a missing device');
  assert.equal(out.deliveredEfrIds.size, 0);

  /*
   * This is the whole point. The route distinguishes the three cases from
   * exactly these two facts, and before the fix it had only the second:
   *   in deliveredEfrIds          -> 'sent'
   *   had a token, not delivered  -> 'failed'   (was wrongly 'sent')
   *   no token at all             -> 'skipped'
   */
  const hadToken = new Set([3]);
  const outcome = out.deliveredEfrIds.has(3) ? 'sent' : hadToken.has(3) ? 'failed' : 'skipped';
  assert.equal(outcome, 'failed');
});

test('a thrown send is a rejection, not a crash and not a success', async () => {
  fcmService.sendPush = async () => { throw new Error('FCM 401'); };
  const out = await pushDelivery.deliver(
    [{ efrId: 9, token: 'tok-d' }],
    { title: 't', body: 'b', data: {} },
    { prune: false },
  );

  assert.equal(out.deliveredCount, 0);
  assert.equal(out.deliveredEfrIds.size, 0);
});

test('the added field does not disturb the shape the other two callers read', async () => {
  // job-offer-push and notice-push read delivered/deliveredCount/tokenCount only.
  stubFcm(new Set(['tok-e']));
  const out = await pushDelivery.deliver(
    [{ efrId: 5, token: 'tok-e' }],
    { title: 't', body: 'b', data: {} },
    { prune: false },
  );

  assert.equal(out.delivered, true);
  assert.equal(out.deliveredCount, 1);
  assert.equal(out.tokenCount, 1);
});
