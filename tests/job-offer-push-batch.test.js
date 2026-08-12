/*
 * Focused characterization for set-based job-offer push fan-out.
 * Fake pool only: no real DB writes and no network sends.
 */

const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

let appRows = [];
let deviceRows = [];
let failAppLookup = false;
let failDeviceLookup = false;

const fake = installFakePool([
  [/FROM tbl_easyfixer_app/i, () => {
    if (failAppLookup) throw new Error('app token store unavailable');
    return appRows;
  }],
  [/FROM device_info/i, () => {
    if (failDeviceLookup) throw new Error('device token store unavailable');
    return deviceRows;
  }],
]);

const pushDelivery = require('../services/push-delivery.service');
const alertFlags = require('../services/job-offer-alert-flags');
const jobOfferPush = require('../services/job-offer-push.service');

const originals = {
  deliverToEfr: pushDelivery.deliverToEfr,
  resolveTokensForEfrs: pushDelivery.resolveTokensForEfrs,
  deliver: pushDelivery.deliver,
  loudSoundEnabled: alertFlags.loudSoundEnabled,
  loudAlertMasterEnabled: alertFlags.loudAlertMasterEnabled,
};

beforeEach(() => {
  appRows = [];
  deviceRows = [];
  failAppLookup = false;
  failDeviceLookup = false;
  fake.reset();
});

afterEach(() => {
  pushDelivery.deliverToEfr = originals.deliverToEfr;
  pushDelivery.resolveTokensForEfrs = originals.resolveTokensForEfrs;
  pushDelivery.deliver = originals.deliver;
  alertFlags.loudSoundEnabled = originals.loudSoundEnabled;
  alertFlags.loudAlertMasterEnabled = originals.loudAlertMasterEnabled;
});

after(() => fake.restore());

test('50 targeted technicians resolve with exactly two set-based token queries', async () => {
  const ids = Array.from({ length: 50 }, (_, index) => index + 1);
  await pushDelivery.resolveTokensForEfrs(ids);

  assert.equal(fake.calls.length, 2, 'query count must not grow with recipient count');
  assert.match(fake.calls[0].sql, /tbl_easyfixer_app/i);
  assert.match(fake.calls[1].sql, /device_info/i);
  assert.deepEqual(fake.calls[0].params, ids);
  assert.deepEqual(fake.calls[1].params, ids);
});

test('bulk resolver dedupes tokens globally and retains a deterministic efrId', async () => {
  appRows = [
    { efrId: 2, token: 'shared-token' },
    { efrId: 1, token: 'app-one' },
  ];
  deviceRows = [
    { efrId: 1, token: ' shared-token ' },
    { efrId: 1, token: 'app-one' },
    { efrId: 2, token: 'device-two' },
    { efrId: 99, token: 'not-requested' },
  ];

  const recipients = await pushDelivery.resolveTokensForEfrs([2, 1, 2]);
  assert.deepEqual(recipients, [
    { efrId: 1, token: 'app-one' },
    { efrId: 1, token: 'shared-token' },
    { efrId: 2, token: 'device-two' },
  ]);
  assert.deepEqual(fake.calls[0].params, [1, 2], 'IDs must be deduped and sorted before SQL');
});

test('either token store may fail without discarding the other store results', async () => {
  failAppLookup = true;
  deviceRows = [{ efrId: 7, token: 'device-token' }];
  assert.deepEqual(
    await pushDelivery.resolveTokensForEfrs([7]),
    [{ efrId: 7, token: 'device-token' }],
  );

  fake.reset();
  failAppLookup = false;
  failDeviceLookup = true;
  appRows = [{ efrId: 7, token: 'app-token' }];
  assert.deepEqual(
    await pushDelivery.resolveTokensForEfrs([7]),
    [{ efrId: 7, token: 'app-token' }],
  );
  assert.equal(fake.calls.length, 2);
});

test('batch sender uses the exact single-send payload and bounded delivery concurrency', async () => {
  alertFlags.loudSoundEnabled = () => true;
  alertFlags.loudAlertMasterEnabled = () => true;

  let singleCall;
  pushDelivery.deliverToEfr = async (efrId, message, opts) => {
    singleCall = { efrId, message, opts };
    return { delivered: true, deliveredCount: 1, tokenCount: 1 };
  };
  await jobOfferPush.sendJobOfferPush(1, { jobId: 900, reminder: true });

  let resolvedIds;
  let batchCall;
  pushDelivery.resolveTokensForEfrs = async (ids) => {
    resolvedIds = ids;
    return [{ efrId: 1, token: 'token-one' }];
  };
  pushDelivery.deliver = async (recipients, message, opts) => {
    batchCall = { recipients, message, opts };
    return { delivered: true, deliveredCount: 1, tokenCount: 1 };
  };

  const result = await jobOfferPush.sendJobOfferPushBatch([3, '1', 3, 2], {
    jobId: 900,
    reminder: true,
  });

  assert.deepEqual(resolvedIds, [1, 2, 3]);
  assert.deepEqual(batchCall.message, singleCall.message);
  assert.equal(batchCall.opts.channel, singleCall.opts.channel);
  assert.equal(batchCall.opts.concurrency, 10);
  assert.deepEqual(result, { delivered: true, deliveredCount: 1, tokenCount: 1 });
});

test('batch sender skips delivery when no technician has a token', async () => {
  let delivered = false;
  pushDelivery.resolveTokensForEfrs = async () => [];
  pushDelivery.deliver = async () => {
    delivered = true;
    return { delivered: true, deliveredCount: 1, tokenCount: 1 };
  };

  const result = await jobOfferPush.sendJobOfferPushBatch([5, 5], { jobId: 901 });
  assert.deepEqual(result, { delivered: false, reason: 'no tokens' });
  assert.equal(delivered, false);
});

test('batch sender fails closed above the 50-technician API cap', async () => {
  let resolved = false;
  pushDelivery.resolveTokensForEfrs = async () => {
    resolved = true;
    return [];
  };

  const ids = Array.from({ length: 51 }, (_, index) => index + 1);
  const result = await jobOfferPush.sendJobOfferPushBatch(ids, { jobId: 902 });
  assert.deepEqual(result, { delivered: false, reason: 'recipient limit exceeded' });
  assert.equal(resolved, false, 'oversized input must not reach SQL resolution');
});
