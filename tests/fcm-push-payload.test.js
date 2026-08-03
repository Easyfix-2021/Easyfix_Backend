/*
 * Characterization tests for fcm.service.buildMessage — the FCM v1 request body.
 *
 * THE point of this file: the loud-alert work (2026-07-29) added optional
 * notification styling to a sender shared by SIX callers. Five of them pass no
 * styling options and MUST keep emitting the exact payload they always did — a
 * stray key here changes every push in the platform. So test (a) deep-equals the
 * default payload against a literal, and additionally pins the key ORDER, which
 * a plain deepEqual would not catch.
 *
 * Pure function, no DB, no network, no env. Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildMessage } = require('../services/fcm.service');

// The exact data payload the job-offer push sends (minus loudAlert, which is
// the caller's business — see job-offer-loud-alert.test.js).
const DATA = { type: 'job_offer', job_id: '100', key: '100', screen: 'NewTicket' };

test('NO styling options → payload is EXACTLY today\'s shape (the no-drift guarantee)', () => {
  const msg = buildMessage({ token: 'tok123', title: 'EasyFix', body: 'New job offer — tap to accept', data: DATA });

  assert.deepEqual(msg, {
    message: {
      token: 'tok123',
      notification: { title: 'EasyFix', body: 'New job offer — tap to accept' },
      data: { type: 'job_offer', job_id: '100', key: '100', screen: 'NewTicket' },
      android: { priority: 'high' },
    },
  });

  // deepEqual ignores key order and treats an explicit `undefined` value as
  // absent, so pin the literal key sets too — that is where accidental drift
  // (an `apns: undefined`, a reordered android block) would actually show up.
  assert.deepEqual(Object.keys(msg), ['message']);
  assert.deepEqual(Object.keys(msg.message), ['token', 'notification', 'data', 'android']);
  assert.deepEqual(Object.keys(msg.message.android), ['priority']);
});

test('data values are stringified and null/undefined become "" (v1 requires strings)', () => {
  const msg = buildMessage({ token: 't', title: 'x', data: { n: 7, nil: null, un: undefined, b: false } });
  assert.deepEqual(msg.message.data, { n: '7', nil: '', un: '', b: 'false' });
});

test('styling options → adds EXACTLY the android.notification + apns blocks', () => {
  const msg = buildMessage({
    token: 'tok123',
    title: 'EasyFix',
    body: 'New job offer — tap to accept',
    data: { ...DATA, loudAlert: '1' },
    androidChannelId: 'job_offer_v1',
    sound: 'offer_alert',
    iosSound: 'offer_alert.wav',
    interruptionLevel: 'time-sensitive',
  });

  // The default part of the message is untouched by the opt-in.
  assert.equal(msg.message.token, 'tok123');
  assert.deepEqual(msg.message.notification, { title: 'EasyFix', body: 'New job offer — tap to accept' });
  assert.equal(msg.message.data.loudAlert, '1');
  assert.equal(msg.message.android.priority, 'high', 'the pre-existing android.priority must survive');

  // Android — cross-repo contract: channel id 'job_offer_v1', sound resource
  // 'offer_alert' with NO extension.
  assert.deepEqual(Object.keys(msg.message.android.notification), [
    'channel_id', 'sound', 'notification_priority', 'vibrate_timings',
  ]);
  assert.equal(msg.message.android.notification.channel_id, 'job_offer_v1');
  assert.equal(msg.message.android.notification.sound, 'offer_alert');
  assert.equal(msg.message.android.notification.notification_priority, 'PRIORITY_MAX');
  assert.ok(Array.isArray(msg.message.android.notification.vibrate_timings));
  // FCM wants protobuf Durations, not milliseconds — "500" would be rejected.
  for (const d of msg.message.android.notification.vibrate_timings) {
    assert.match(d, /^\d+(\.\d+)?s$/, 'vibrate timings must be protobuf Durations');
  }

  // iOS — cross-repo contract: sound file WITH extension, priority 10 header,
  // time-sensitive so it breaks through Focus.
  assert.deepEqual(msg.message.apns, {
    headers: { 'apns-priority': '10' },
    payload: { aps: { sound: 'offer_alert.wav', 'interruption-level': 'time-sensitive' } },
  });

  // And nothing else was bolted onto the message.
  assert.deepEqual(Object.keys(msg.message), ['token', 'notification', 'data', 'android', 'apns']);
});

test('iosSound defaults to the android resource name + .wav', () => {
  const msg = buildMessage({ token: 't', title: 'x', sound: 'offer_alert', androidChannelId: 'job_offer_v1' });
  assert.equal(msg.message.apns.payload.aps.sound, 'offer_alert.wav');
});

test('an explicitly falsy/absent option set does NOT attach the blocks', () => {
  // Guards the gate itself: passing the keys through as undefined (which is what
  // a spread of an empty style object produces) must behave like passing nothing.
  const msg = buildMessage({
    token: 't', title: 'x', data: DATA,
    androidChannelId: undefined, sound: undefined, iosSound: undefined, interruptionLevel: undefined,
  });
  assert.deepEqual(Object.keys(msg.message), ['token', 'notification', 'data', 'android']);
  assert.deepEqual(Object.keys(msg.message.android), ['priority']);
});
