'use strict';
/*
 * fetchRecordingMeta reports the recording's duration in SECONDS (2026-09-11).
 *
 * Plivo's Recording object has no `recording_duration`: it documents
 * `recording_duration_ms` (a string, in milliseconds) and
 * `rounded_recording_duration` (rounded UP to 60 s billing blocks — not a
 * duration). The lookup read the absent field, so every duration the backfill
 * pulled was NULL. It feeds tbl_plivo_call_log.recording_duration, the column
 * the XML callback fills with RecordingDuration in seconds — so seconds here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PLIVO_AUTH_ID = process.env.PLIVO_AUTH_ID || 'MATESTAUTHID';
process.env.PLIVO_AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN || 'test-token';
const plivo = require('../services/plivo.service');

function withFetch(body, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body });
  return fn().finally(() => { globalThis.fetch = real; });
}

// Shape copied from Plivo's documented Recording object (duration fields only).
const recording = (over) => ({ objects: [{ recording_id: 'r1', recording_url: 'https://media/r1.mp3',
  recording_duration_ms: '236480.00000', rounded_recording_duration: 240, ...over }] });

test('duration comes from recording_duration_ms, in seconds — not the billing-rounded field', async () => {
  const meta = await withFetch(recording(), () => plivo.fetchRecordingMeta({ callUuid: 'u1' }));
  assert.equal(meta.ok, true, 'the stubbed lookup must have run');
  assert.equal(meta.duration, 236, '236,480 ms is a 3m 56s call — 236 s, not 240 (rounded) and not null');
  assert.equal(meta.url, 'https://media/r1.mp3');
});

test('no duration field → null, never NaN or 0', async () => {
  // 'abc' used to become NaN — which setRecording's UPDATE sends as a bare `NaN`
  // token MySQL rejects, losing the URL too — and ' ' used to become 0.
  for (const over of [{ recording_duration_ms: undefined }, { recording_duration_ms: '' }, { recording_duration_ms: null },
    { recording_duration_ms: 'abc' }, { recording_duration_ms: ' ' }]) {
    const meta = await withFetch(recording(over), () => plivo.fetchRecordingMeta({ callUuid: 'u2' }));
    assert.equal(meta.url, 'https://media/r1.mp3', 'the stubbed lookup must have run');
    assert.equal(meta.duration, null, `recording_duration_ms=${JSON.stringify(over.recording_duration_ms)}`);
  }
});

test('a numeric recording_duration_ms (not a string) still converts', async () => {
  const meta = await withFetch(recording({ recording_duration_ms: 12400 }), () => plivo.fetchRecordingMeta({ callUuid: 'u3' }));
  assert.equal(meta.duration, 12);
});
