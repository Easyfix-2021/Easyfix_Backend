'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { redactUrl } = require('../utils/log-format');

/*
 * A request URL is logged on every request (middleware/http-log.js) and on every
 * unhandled error (middleware/error-handler.js). Any route carrying a sensitive
 * value in its path therefore writes that value into the log at request rate —
 * which is exactly how an advisory Aadhaar duplicate-check endpoint came to log
 * Aadhaar numbers on every call.
 *
 * Redaction is by VALUE SHAPE, not by parameter name, so a newly added route
 * cannot silently reintroduce the leak. These tests pin both halves of that
 * bargain: sensitive shapes are masked, and ordinary surrogate ids are NOT —
 * over-redaction would make the access log useless for debugging.
 */

test('masks an Aadhaar number anywhere in the path or query', () => {
  assert.equal(redactUrl('/api/admin/aadhaar-check/123456789012'), '/api/admin/aadhaar-check/<aadhaar>');
  assert.equal(redactUrl('/api/x?number=123456789012'), '/api/x?number=<aadhaar>');
});

test('masks a PAN', () => {
  assert.equal(redactUrl('/api/mobile/kyc/ABCDE1234F'), '/api/mobile/kyc/<pan>');
});

test('masks an Indian mobile number — the live /customers/mobile/:mobile route', () => {
  assert.equal(redactUrl('/api/mobile/customers/mobile/9876543210'), '/api/mobile/customers/mobile/<mobile>');
  assert.equal(redactUrl('/api/client/customers/mobile/6012345678'), '/api/client/customers/mobile/<mobile>');
});

test('masks a magic-link token — a credential, not merely PII', () => {
  const token = 'aB3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z';
  assert.equal(redactUrl(`/api/public/shared-job/${token}`), '/api/public/shared-job/<token>');
  assert.equal(redactUrl(`/api/public/verify-email/${token}/confirm`), '/api/public/verify-email/<token>/confirm');
});

test('leaves ordinary surrogate ids intact so logs stay debuggable', () => {
  // Job / user / client ids are 1-9 digits. Redacting these would gut the log.
  for (const path of [
    '/api/admin/jobs/123',
    '/api/admin/jobs/98765/location',
    '/api/admin/easyfixers/8379/lifecycle-status',
    '/api/client/customers/42',
    '/api/admin/validate/ai-calling/7',
  ]) {
    assert.equal(redactUrl(path), path, path);
  }
});

test('a 12-digit value is read as an Aadhaar, not as a mobile', () => {
  // Ordering guard: the 10-digit mobile rule must not carve a mobile out of a
  // longer digit run, or an Aadhaar would leak as '<mobile>23' and stay partly
  // visible in the log.
  const redacted = redactUrl('/x/912345678901');
  assert.equal(redacted, '/x/<aadhaar>');
  assert.equal(redacted.includes('9123456789'), false);
});

test('does not alter the route shapes http-log matches on', () => {
  // http-log.js tests the REDACTED path against these patterns to downgrade
  // high-frequency lines to debug; redaction must not break them.
  assert.match(redactUrl('/api/mobile/jobs/123/location'), /\/jobs\/\d+\/location(?:[/?]|$)/);
  assert.match(redactUrl('/api/admin/validate/ai-calling/42'), /\/admin\/validate\/ai-calling\//);
});

test('is null-safe', () => {
  assert.equal(redactUrl(undefined), '');
  assert.equal(redactUrl(null), '');
});
