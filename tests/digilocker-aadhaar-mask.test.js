/*
 * DigiLocker usually returns only `masked_aadhaar` (xxxxxxxx1234). That value
 * must never come back as `aadhaarNumber`: the legacy Flutter app saved it as
 * the technician's real Aadhaar, and what gets stored that way can't be undone.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const kyc = require('../services/mobile-kyc.service');

const originalFetch = global.fetch;
const originalKey = process.env.SUREPASS_VERIFICATION_KEY;
let vendorData;

before(() => {
  process.env.SUREPASS_VERIFICATION_KEY = 'test-key';
  global.fetch = async () => ({
    status: 200,
    json: async () => ({ success: true, status_code: 200, data: vendorData }),
  });
});

after(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.SUREPASS_VERIFICATION_KEY;
  else process.env.SUREPASS_VERIFICATION_KEY = originalKey;
});

test('a mask-only DigiLocker reply yields NO aadhaarNumber', async () => {
  vendorData = { masked_aadhaar: 'xxxxxxxx1234', name: 'Ravi Kumar' };
  const out = await kyc.digilockerDownloadAadhaar(1, 'client-1');
  assert.equal(out.name, 'Ravi Kumar', 'positive control: the reply was parsed');
  assert.equal(out.aadhaarNumber, null);
});

test('a full aadhaar_number is still passed through', async () => {
  vendorData = { aadhaar_number: '234567890123', masked_aadhaar: 'xxxxxxxx0123' };
  const out = await kyc.digilockerDownloadAadhaar(1, 'client-1');
  assert.equal(out.aadhaarNumber, '234567890123');
});
