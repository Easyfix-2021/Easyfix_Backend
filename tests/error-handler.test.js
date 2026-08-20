const { test } = require('node:test');
const assert = require('node:assert/strict');

const logger = require('../logger');
const { errorHandler } = require('../middleware/error-handler');

function invoke(error, originalUrl = '/api/mobile/profile-extra/withdraw') {
  const response = {
    locals: {},
    statusCode: null,
    body: null,
    status(statusCode) { this.statusCode = statusCode; return this; },
    json(body) { this.body = body; return this; },
  };
  const request = { originalUrl, method: 'POST' };
  const originalLog = logger.error;
  logger.error = () => {};
  try {
    errorHandler(error, request, response, () => {});
  } finally {
    logger.error = originalLog;
  }
  return response;
}

test('modern 4xx envelope exposes a bounded application error code', () => {
  const error = Object.assign(new Error('Add PAN details before withdrawing'), {
    status: 400,
    code: 'PAN_REQUIRED',
  });
  const response = invoke(error);

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    success: false,
    error: 'Add PAN details before withdrawing',
    code: 'PAN_REQUIRED',
  });
});

test('modern envelope never exposes dependency or 5xx error codes', () => {
  const databaseError = Object.assign(new Error('Duplicate entry'), {
    status: 409,
    code: 'ER_DUP_ENTRY',
  });
  assert.equal(invoke(databaseError).body.code, undefined);

  const serverError = Object.assign(new Error('connection failed'), {
    status: 500,
    code: 'PAYOUT_DATABASE_FAILED',
  });
  assert.deepEqual(invoke(serverError).body, {
    success: false,
    error: 'Internal Server Error',
  });
});

test('legacy integration error contract remains byte-compatible', () => {
  const error = Object.assign(new Error('Invalid request'), {
    status: 400,
    code: 'PAN_REQUIRED',
  });
  assert.deepEqual(invoke(error, '/api/integration/v1/jobs').body, {
    status: '400',
    message: 'Invalid request',
    data: null,
  });
});
