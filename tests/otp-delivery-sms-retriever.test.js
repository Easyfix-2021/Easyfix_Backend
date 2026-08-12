const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const smsTemplate = require('../services/sms-template.service');
const {
  buildOtpSmsBody,
  formatOtpSmsForContext,
  SMS_RETRIEVER_MAX_BYTES,
} = require('../services/otp-delivery.service');

const ENV_KEY = 'TECHNICIAN_SMS_RETRIEVER_APP_HASH';
const originalHash = process.env[ENV_KEY];
const VALID_HASH = 'AbCdEf123+/';

after(() => {
  if (originalHash === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalHash;
});

function setHash(value) {
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
}

test('absent or malformed hash preserves the DLT body byte-for-byte', () => {
  const body = 'Dear Customer, Your OTP is 1234 - Team EasyFix';
  for (const value of [undefined, '', 'too-short', 'ABCDEFGHIJK\n', 'ABCDEFGHIJ=']) {
    setHash(value);
    const result = formatOtpSmsForContext(body, 'technician');
    assert.equal(result, body);
    assert.deepEqual(Buffer.from(result, 'utf8'), Buffer.from(body, 'utf8'));
  }
});

test('valid hash is appended as the final line for technician OTP only', () => {
  setHash(VALID_HASH);
  const body = 'Your EasyFix OTP is 1234';
  assert.equal(
    formatOtpSmsForContext(body, 'technician'),
    `${body}\n${VALID_HASH}`,
  );

  for (const context of ['staff', 'spoc', 'spoc-change-phone', 'login', undefined]) {
    assert.equal(formatOtpSmsForContext(body, context), body);
  }
});

test('140-byte ceiling uses UTF-8 bytes rather than JavaScript character count', () => {
  setHash(VALID_HASH);
  const exactly128Bytes = 'é'.repeat(64);
  const accepted = formatOtpSmsForContext(exactly128Bytes, 'technician');
  assert.equal(Buffer.byteLength(accepted, 'utf8'), SMS_RETRIEVER_MAX_BYTES);

  const tooLong = '₹'.repeat(43); // 129 bytes + newline/hash (12) = 141 bytes
  assert.throws(
    () => formatOtpSmsForContext(tooLong, 'technician'),
    (err) => {
      assert.equal(err.code, 'TECHNICIAN_SMS_RETRIEVER_MESSAGE_TOO_LONG');
      assert.doesNotMatch(err.message, new RegExp(VALID_HASH.replace(/[+/]/g, '\\$&')));
      return true;
    },
  );
});

test('DB/DLT template filling remains unchanged before the final hash line', async (t) => {
  const originalGetTemplate = smsTemplate.getTemplate;
  const originalFill = smsTemplate.fill;
  t.after(() => {
    smsTemplate.getTemplate = originalGetTemplate;
    smsTemplate.fill = originalFill;
  });

  const dltTemplate = 'Dear Customer, Your OTP for login is {#var#} - Team EasyFix';
  smsTemplate.getTemplate = async () => dltTemplate;
  smsTemplate.fill = (template, vars) => template.replace('{#var#}', String(vars[0]));

  setHash(VALID_HASH);
  const base = 'Dear Customer, Your OTP for login is 2468 - Team EasyFix';
  assert.equal(await buildOtpSmsBody(2468, 'technician'), `${base}\n${VALID_HASH}`);
  assert.equal(await buildOtpSmsBody(2468, 'staff'), base);
});
