'use strict';
/*
 * downloadRecording sends the Plivo Basic-auth header ONLY to https *.plivo.com
 * (2026-09-11).
 *
 * The URL it fetches is stored data, and /api/public/plivo/ai-recording stores
 * whatever record_url it is POSTed, unauthenticated. Playing that session's
 * recording (GET /admin/validate/ai-calling/:id/recording) then fetched the URL
 * WITH PLIVO_AUTH_ID/TOKEN — a planted URL harvested the account credentials.
 * All three callers (routes/admin/calls.js, routes/admin/validate.js,
 * services/call-recording.service.js) route through this one function.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PLIVO_AUTH_ID = process.env.PLIVO_AUTH_ID || 'MATESTAUTHID';
process.env.PLIVO_AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN || 'test-token';
const plivo = require('../services/plivo.service');

async function download(url) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    calls.push({ url: String(u), auth: init?.headers?.Authorization || null });
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(3), headers: { get: () => 'audio/mpeg' } };
  };
  try { return { result: await plivo.downloadRecording(url), calls }; } finally { globalThis.fetch = real; }
}

test('a Plivo https URL is fetched WITH the Basic-auth header', async () => {
  for (const url of [
    // The shape stored on QA (tbl_plivo_call_log.recording_url, 3 of 3 rows).
    'https://aps1.media.plivo.com/v1/Account/MATESTAUTHID/Recording/458d1e9b-3f9e-40a2-8e45-af95704eaed4.mp3',
    'https://media.plivo.com/v1/Account/MATESTAUTHID/Recording/r1.mp3',
  ]) {
    const { result, calls } = await download(url);
    assert.equal(result.ok, true, url);
    assert.equal(calls.length, 1, url + ' must be fetched');
    assert.match(calls[0].auth, /^Basic /, url + ' must carry the credentials');
  }
});

test('anything else is refused BEFORE any request — no credentials leave', async () => {
  for (const url of [
    'https://evil.example/r1.mp3',
    // plivo.com but NOT a media host: some subdomains are third-party-hosted.
    'https://status.plivo.com/x.mp3',
    'https://plivo.com/r1.mp3',
    'https://api.plivo.com/v1/Account/MATESTAUTHID/Recording/r1.mp3',
    'http://aps1.media.plivo.com/v1/Account/MATESTAUTHID/Recording/r1.mp3', // cleartext
    'https://plivo.com.evil.example/r1.mp3',
    'https://evilplivo.com/r1.mp3',
    'https://aps1.media.plivo.com@evil.example/r1.mp3', // userinfo — host is evil.example
    'https://evil.example/aps1.media.plivo.com/r1.mp3',
    'https://evil.example/?u=https://media.plivo.com/r1.mp3',
    'not a url',
  ]) {
    const { result, calls } = await download(url);
    assert.equal(result.ok, false, url);
    assert.deepEqual(calls, [], url + ' must never be fetched');
  }
});
