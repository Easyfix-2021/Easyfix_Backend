const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const HASH = 'AbCdEf123+/';
const originalHash = process.env.TECHNICIAN_SMS_RETRIEVER_APP_HASH;
const originalProvider = process.env.WHATSAPP_PROVIDER;
process.env.TECHNICIAN_SMS_RETRIEVER_APP_HASH = HASH;
process.env.WHATSAPP_PROVIDER = 'gallabox';

const moduleStubs = new Map();
function stubModule(request, exports) {
  const id = require.resolve(request);
  moduleStubs.set(id, require.cache[id]);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const sentSms = [];
const logged = [];
let template = 'Dear Customer, Your OTP is {#var#} - Team EasyFix';
let configuredChannel = 'sms';
let dualChannel = 'false';
let whatsappResult = { delivered: false, error: 'not sent in SMS-primary test' };

stubModule('../logger', {
  info: (...args) => logged.push(args),
  warn: (...args) => logged.push(args),
  error: (...args) => logged.push(args),
});
stubModule('../services/sms.service', {
  send: async (payload) => {
    sentSms.push(payload);
    return { delivered: true };
  },
});
stubModule('../services/email.service', { send: async () => ({ delivered: false }) });
stubModule('../services/gallabox.whatsapp.service', {
  sendTemplate: async () => whatsappResult,
});
stubModule('../services/sms-template.service', {
  getTemplate: async () => template,
  fill: (body, vars) => body.replace('{#var#}', String(vars[0])),
});
stubModule('../services/properties.service', {
  getProperty: (key) => {
    if (key === 'login.otp.channel') return configuredChannel;
    if (key === 'login.otp.dual.channel') return dualChannel;
    return undefined;
  },
});
stubModule('../services/entra-provisioning.service', {
  mailboxExists: async () => ({ status: 'skipped' }),
});

const deliveryPath = require.resolve('../services/otp-delivery.service');
const originalDeliveryModule = require.cache[deliveryPath];
delete require.cache[deliveryPath];
const { deliverOtp } = require('../services/otp-delivery.service');

beforeEach(() => {
  sentSms.length = 0;
  logged.length = 0;
  template = 'Dear Customer, Your OTP is {#var#} - Team EasyFix';
  configuredChannel = 'sms';
  dualChannel = 'false';
  whatsappResult = { delivered: false, error: 'not sent in SMS-primary test' };
  process.env.TECHNICIAN_SMS_RETRIEVER_APP_HASH = HASH;
});

after(() => {
  delete require.cache[deliveryPath];
  if (originalDeliveryModule) require.cache[deliveryPath] = originalDeliveryModule;
  for (const [id, original] of moduleStubs) {
    delete require.cache[id];
    if (original) require.cache[id] = original;
  }
  if (originalHash === undefined) delete process.env.TECHNICIAN_SMS_RETRIEVER_APP_HASH;
  else process.env.TECHNICIAN_SMS_RETRIEVER_APP_HASH = originalHash;
  if (originalProvider === undefined) delete process.env.WHATSAPP_PROVIDER;
  else process.env.WHATSAPP_PROVIDER = originalProvider;
});

test('enabled Retriever sends a formatted technician SMS in bounded parallel delivery', async () => {
  const tech = await deliverOtp({
    identifier: '9013877370', mobile: '9013877370', email: null,
    name: 'Tech', otp: 2468, contextLabel: 'technician',
  });
  assert.equal(tech.primaryChannel, 'whatsapp+sms');
  assert.equal(tech.finalDelivered, true);
  assert.deepEqual(tech.attempts.map((attempt) => attempt.channel), ['whatsapp', 'sms']);
  assert.equal(
    sentSms[0].message,
    `Dear Customer, Your OTP is 2468 - Team EasyFix\n${HASH}`,
  );

  await deliverOtp({
    identifier: '9013877371', mobile: '9013877371', email: null,
    name: 'Staff', otp: 1357, contextLabel: 'staff',
  });
  assert.equal(sentSms[1].message, 'Dear Customer, Your OTP is 1357 - Team EasyFix');
  assert.doesNotMatch(JSON.stringify(logged), new RegExp(HASH.replace(/[+/]/g, '\\$&')),
    'the app hash must never enter OTP delivery logs');
});

test('an enabled over-140-byte technician message fails before SMS dispatch', async () => {
  const sendsBefore = sentSms.length;
  template = `${'₹'.repeat(43)}{#var#}`;
  const result = await deliverOtp({
    identifier: '9013877372', mobile: '9013877372', email: null,
    name: 'Tech', otp: 2468, contextLabel: 'technician',
  });

  assert.equal(sentSms.length, sendsBefore, 'oversized message must not reach the provider');
  const smsAttempt = result.attempts.find((attempt) => attempt.channel === 'sms');
  assert.equal(smsAttempt.delivered, false);
  assert.equal(smsAttempt.error, 'technician OTP SMS exceeds the SMS Retriever 140-byte limit');
  assert.doesNotMatch(smsAttempt.error, new RegExp(HASH.replace(/[+/]/g, '\\$&')));
});

test('admin-selected WhatsApp still cannot suppress the required Retriever SMS attempt', async () => {
  configuredChannel = 'whatsapp';
  const result = await deliverOtp({
    identifier: '9013877373', mobile: '9013877373', email: null,
    name: 'Tech', otp: 8642, contextLabel: 'technician',
  });

  assert.equal(result.primaryChannel, 'whatsapp+sms');
  assert.equal(result.attempts[1].channel, 'sms');
  assert.equal(result.attempts[1].parallel, true);
  assert.equal(
    sentSms[0].message,
    `Dear Customer, Your OTP is 8642 - Team EasyFix\n${HASH}`,
  );
});

test('provider-reported WhatsApp success still sends SMS when Retriever is enabled', async () => {
  configuredChannel = 'whatsapp';
  whatsappResult = { delivered: true, providerMessageId: 'wa-1' };

  const result = await deliverOtp({
    identifier: '9013877374', mobile: '9013877374', email: null,
    name: 'Tech', otp: 9753, contextLabel: 'technician',
  });

  assert.equal(result.finalDelivered, true);
  assert.deepEqual(result.attempts.map((attempt) => attempt.channel), ['whatsapp', 'sms']);
  assert.equal(sentSms.length, 1, 'Retriever readiness guarantees one SMS provider attempt');
  assert.match(sentSms[0].message, new RegExp(`\\n${HASH.replace(/[+/]/g, '\\$&')}$`));
});

test('unset Retriever hash preserves the historical admin-selected fallback path', async () => {
  delete process.env.TECHNICIAN_SMS_RETRIEVER_APP_HASH;
  configuredChannel = 'whatsapp';
  whatsappResult = { delivered: true, providerMessageId: 'wa-2' };

  const result = await deliverOtp({
    identifier: '9013877375', mobile: '9013877375', email: null,
    name: 'Tech', otp: 8642, contextLabel: 'technician',
  });

  assert.equal(result.primaryChannel, 'whatsapp');
  assert.deepEqual(result.attempts.map((attempt) => attempt.channel), ['whatsapp']);
  assert.equal(sentSms.length, 0);
});
