/*
 * /get-app/:code — the referral install link routes each opener to THEIR store,
 * not the sharer's. Drives the real router over HTTP; getProperty is stubbed
 * before require because app-version.js destructures it at load time.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

require('../services/properties.service').getProperty = () => '';
const router = require('../routes/public/get-app');

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36';

async function get(path, ua) {
  const server = express().use('/', router).listen(0);
  try {
    const { port } = server.address();
    return await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'user-agent': ua }, redirect: 'manual' });
  } finally {
    server.close();
  }
}

test('Android → Play Store carrying the code as install referrer', async () => {
  const res = await get('/get-app/ef3qg8qx', ANDROID);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(
    res.headers.get('location'),
    'https://play.google.com/store/apps/details?id=com.dev.easyfix&referrer=ref%3DEF3QG8QX',
  );
});

test('iPhone → App Store', async () => {
  const res = await get('/get-app/EF3QG8QX', IPHONE);
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /^https:\/\/apps\.apple\.com\/.*id1635539236$/);
});

test('desktop / unknown → chooser page with both stores and the code', async () => {
  const res = await get('/get-app/EF3QG8QX', DESKTOP);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /play\.google\.com/);
  assert.match(html, /apps\.apple\.com/);
  assert.match(html, /EF3QG8QX/);
});

test('malformed code is dropped, never echoed, and the link still works', async () => {
  const res = await get('/get-app/%3Cscript%3E', ANDROID);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), 'https://play.google.com/store/apps/details?id=com.dev.easyfix');
  const page = await (await get('/get-app/%3Cscript%3E', DESKTOP)).text();
  assert.doesNotMatch(page, /<script>/i);
});

test('bare /get-app (no code) still redirects', async () => {
  const res = await get('/get-app', IPHONE);
  assert.strictEqual(res.status, 302);
});
