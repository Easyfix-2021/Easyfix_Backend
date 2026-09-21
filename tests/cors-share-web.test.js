const test = require('node:test');
const assert = require('node:assert/strict');

/*
 * The shared-job WEB link runs the technician app from the CRM origin and calls
 * this backend cross-origin, so — unlike the native app — every write is
 * preflighted. The app sends Idempotency-Key on job writes and uploads, and
 * Idempotency-Content-Digest on uploads; if the preflight does not allow them,
 * the browser drops check-in, photo attach and checkout before they reach us.
 */
process.env.CRM_URL = 'https://qa.crm.easyfix.in';

test('a preflight from the CRM origin allows the headers the app sends on writes', async () => {
  const express = require('express');
  const app = express();
  app.use(require('../cors'));
  app.post('/api/mobile/jobs/1/checkin', (_req, res) => res.json({ ok: true }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/mobile/jobs/1/checkin`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://qa.crm.easyfix.in',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key,idempotency-content-digest,accept-language',
      },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://qa.crm.easyfix.in');
    const allowed = String(res.headers.get('access-control-allow-headers') || '').toLowerCase().split(/\s*,\s*/);
    for (const h of ['authorization', 'content-type', 'idempotency-key', 'idempotency-content-digest', 'accept-language']) {
      assert.ok(allowed.includes(h), `preflight must allow ${h} (got: ${allowed.join(', ')})`);
    }
  } finally {
    server.close();
  }
});
