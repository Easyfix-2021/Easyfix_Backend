const { test } = require('node:test');
const assert = require('node:assert/strict');

const idempotency = require('../middleware/idempotency');

function request(headers = {}, body = { value: 1 }) {
  return {
    method: 'PUT',
    originalUrl: '/api/mobile/registration/work-area',
    headers,
    body,
    tech: { efr_id: 8379 },
  };
}

function response() {
  let resolveDelivered;
  const delivered = new Promise((resolve) => { resolveDelivered = resolve; });
  const sent = [];
  const headers = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    locals: {},
    status(code) { this.statusCode = code; return this; },
    type(value) { headers['content-type'] = value; return this; },
    setHeader(name, value) { headers[String(name).toLowerCase()] = String(value); },
    json(body) {
      this.headersSent = true;
      sent.push({ kind: 'json', status: this.statusCode, body });
      resolveDelivered();
      return this;
    },
    send(body) {
      this.headersSent = true;
      sent.push({ kind: 'send', status: this.statusCode, body });
      resolveDelivered();
      return this;
    },
  };
  return { res, sent, headers, delivered };
}

function duplicateError() {
  const error = new Error('duplicate');
  error.code = 'ER_DUP_ENTRY';
  return error;
}

test('awaits durable response persistence before sending a successful JSON response', async () => {
  let releaseUpdate;
  let markUpdateStarted;
  const updateStarted = new Promise((resolve) => { markUpdateStarted = resolve; });
  const updateGate = new Promise((resolve) => { releaseUpdate = resolve; });
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/^\s*INSERT INTO tbl_idempotency_key/i.test(sql)) return [{ affectedRows: 1 }, []];
      if (/^\s*UPDATE tbl_idempotency_key/i.test(sql)) {
        markUpdateStarted();
        await updateGate;
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const { res, sent, delivered } = response();
  const middleware = idempotency({ database });

  await middleware(request({ 'idempotency-key': 'work-area-1' }), res, (error) => {
    assert.ifError(error);
    res.status(201).json({ success: true, data: { ok: true } });
  });
  await updateStarted;
  assert.equal(sent.length, 0, 'the client must not receive 2xx before the ledger UPDATE commits');
  releaseUpdate();
  await delivered;

  assert.equal(sent[0].status, 201);
  const completion = calls.find((call) => /^\s*UPDATE tbl_idempotency_key/i.test(call.sql));
  assert.match(completion.sql, /state = 'done'/i);
  assert.match(completion.sql, /lease_token = \?/i);
  assert.equal(completion.params[0], 201);
});

test('replays a completed response without invoking the protected handler', async () => {
  const fingerprint = idempotency._internals.requestFingerprint(request(), '');
  const database = {
    async query(sql) {
      if (/^\s*INSERT INTO tbl_idempotency_key/i.test(sql)) throw duplicateError();
      if (/^\s*SELECT request_fingerprint/i.test(sql)) {
        return [[{
          request_fingerprint: fingerprint,
          state: 'done',
          response_status: 202,
          response_json: '{"success":true,"data":{"queued":true}}',
          retry_after_seconds: 0,
        }], []];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const { res, sent, headers, delivered } = response();
  let reachedHandler = false;

  await idempotency({ database })(request({ 'idempotency-key': 'done-1' }), res, () => {
    reachedHandler = true;
  });
  await delivered;
  assert.equal(reachedHandler, false);
  assert.equal(headers['idempotent-replay'], 'true');
  assert.deepEqual(sent[0], {
    kind: 'send',
    status: 202,
    body: '{"success":true,"data":{"queued":true}}',
  });
});

test('returns the existing 409 message plus machine code and Retry-After for a live lease', async () => {
  const req = request({ 'idempotency-key': 'busy-1' });
  const database = {
    async query(sql) {
      if (/^\s*INSERT INTO tbl_idempotency_key/i.test(sql)) throw duplicateError();
      if (/^\s*SELECT request_fingerprint/i.test(sql)) {
        return [[{
          request_fingerprint: idempotency._internals.requestFingerprint(req, ''),
          state: 'in_flight',
          response_status: null,
          response_json: null,
          retry_after_seconds: 37,
        }], []];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const { res, sent, headers, delivered } = response();

  await idempotency({ database })(req, res, () => assert.fail('busy lease must not reach handler'));
  await delivered;
  assert.equal(sent[0].status, 409);
  assert.equal(sent[0].body.error, idempotency._internals.IN_PROGRESS_MESSAGE);
  assert.equal(sent[0].body.details.code, 'IDEMPOTENCY_IN_PROGRESS');
  assert.equal(sent[0].body.details.retryAfterSeconds, 37);
  assert.equal(headers['retry-after'], '37');
});

test('rejects same-key different-request reuse with the existing message and a machine code', async () => {
  const database = {
    async query(sql) {
      if (/^\s*INSERT INTO tbl_idempotency_key/i.test(sql)) throw duplicateError();
      if (/^\s*SELECT request_fingerprint/i.test(sql)) {
        return [[{
          request_fingerprint: 'not-the-current-request-fingerprint',
          state: 'done',
          response_status: 200,
          response_json: '{"success":true}',
          retry_after_seconds: 0,
        }], []];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const { res, sent, delivered } = response();

  await idempotency({ database })(
    request({ 'idempotency-key': 'reused-1' }),
    res,
    () => assert.fail('fingerprint mismatch must not reach handler'),
  );
  await delivered;
  assert.equal(sent[0].status, 409);
  assert.equal(sent[0].body.error, 'Idempotency-Key reused with a different request');
  assert.equal(sent[0].body.details.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('atomically reclaims an expired lease and completes under a new owner token', async () => {
  const req = request({ 'idempotency-key': 'expired-1' });
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/^\s*INSERT INTO tbl_idempotency_key/i.test(sql)) throw duplicateError();
      if (/^\s*SELECT request_fingerprint/i.test(sql)) {
        return [[{
          request_fingerprint: idempotency._internals.requestFingerprint(req, ''),
          state: 'in_flight',
          response_status: null,
          response_json: null,
          retry_after_seconds: 0,
        }], []];
      }
      if (/state = 'in_flight', completed_at = NULL/i.test(sql)) return [{ affectedRows: 1 }, []];
      if (/state = 'done'/i.test(sql)) return [{ affectedRows: 1 }, []];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const { res, sent, delivered } = response();

  await idempotency({ database })(req, res, (error) => {
    assert.ifError(error);
    res.json({ success: true });
  });
  await delivered;
  assert.equal(sent[0].status, 200);
  const reclaim = calls.find((call) => /state = 'in_flight', completed_at = NULL/i.test(call.sql));
  const completion = calls.find((call) => /state = 'done'/i.test(call.sql));
  assert.ok(reclaim);
  assert.ok(completion);
  assert.equal(reclaim.params[3], completion.params.at(-1), 'only the new lease owner may complete');
});

test('releases a 5xx reservation and never stores it as done', async () => {
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/^\s*INSERT INTO tbl_idempotency_key/i.test(sql)) return [{ affectedRows: 1 }, []];
      if (/^\s*DELETE FROM tbl_idempotency_key/i.test(sql)) return [{ affectedRows: 1 }, []];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const { res, sent, delivered } = response();

  await idempotency({ database })(request({ 'idempotency-key': 'server-error-1' }), res, (error) => {
    assert.ifError(error);
    res.status(503).json({ success: false, error: 'temporary' });
  });
  await delivered;
  assert.equal(sent[0].status, 503);
  assert.ok(calls.some((call) => /^\s*DELETE FROM tbl_idempotency_key/i.test(call.sql)));
  assert.equal(calls.some((call) => /state = 'done'/i.test(call.sql)), false);
});

test('does not send 2xx when completion persistence fails', async () => {
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/^\s*INSERT INTO tbl_idempotency_key/i.test(sql)) return [{ affectedRows: 1 }, []];
      if (/state = 'done'/i.test(sql)) throw new Error('ledger unavailable');
      if (/^\s*DELETE FROM tbl_idempotency_key/i.test(sql)) return [{ affectedRows: 1 }, []];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const { res, sent } = response();
  let resolveFailure;
  const failed = new Promise((resolve) => { resolveFailure = resolve; });

  await idempotency({ database })(request({ 'idempotency-key': 'ledger-failure-1' }), res, (error) => {
    if (error) return resolveFailure(error);
    res.json({ success: true });
    return undefined;
  });
  const error = await failed;
  assert.match(error.message, /ledger unavailable/i);
  assert.equal(sent.length, 0);
  assert.ok(calls.some((call) => /^\s*DELETE FROM tbl_idempotency_key/i.test(call.sql)));
});

test('binds an optional multipart digest without changing historical digest-free fingerprints', () => {
  const req = request({}, {});
  const noDigest = idempotency._internals.requestFingerprint(req, '');
  const historical = require('crypto')
    .createHash('sha256')
    .update(`${req.method}\n${req.originalUrl}\n{}`)
    .digest('hex');
  const firstFile = idempotency._internals.requestFingerprint(req, 'sha256:first-file');
  const secondFile = idempotency._internals.requestFingerprint(req, 'sha256:second-file');

  assert.equal(noDigest, historical);
  assert.notEqual(firstFile, noDigest);
  assert.notEqual(firstFile, secondFile);
});

test('requires a valid app MD5 digest before reserving a keyed multipart mutation', async () => {
  let queries = 0;
  const database = {
    async query() { queries += 1; throw new Error('must not query'); },
  };

  for (const [headers, expectedCode] of [
    [{ 'idempotency-key': 'upload-1', 'content-type': 'multipart/form-data; boundary=x' },
      'IDEMPOTENCY_CONTENT_DIGEST_REQUIRED'],
    [{
      'idempotency-key': 'upload-2',
      'content-type': 'multipart/form-data; boundary=x',
      'idempotency-content-digest': 'not-an-md5',
    }, 'IDEMPOTENCY_CONTENT_DIGEST_INVALID'],
  ]) {
    const { res, sent, delivered } = response();
    await idempotency({ database })(request(headers), res, () => assert.fail('invalid upload must not proceed'));
    await delivered;
    assert.equal(sent[0].status, 400);
    assert.equal(sent[0].body.details.code, expectedCode);
  }
  assert.equal(queries, 0);
});

test('accepts the app 32-hex multipart digest and binds it to the reservation fingerprint', async () => {
  const digest = '1234567890abcdef1234567890abcdef';
  let insertParams;
  const database = {
    async query(sql, params) {
      if (/^\s*INSERT INTO tbl_idempotency_key/i.test(sql)) {
        insertParams = params;
        return [{ affectedRows: 1 }, []];
      }
      if (/state = 'done'/i.test(sql)) return [{ affectedRows: 1 }, []];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const req = request({
    'idempotency-key': 'upload-3',
    'content-type': 'multipart/form-data; boundary=x',
    'idempotency-content-digest': digest.toUpperCase(),
  }, {});
  const { res, delivered } = response();

  await idempotency({ database })(req, res, (error) => {
    assert.ifError(error);
    res.json({ success: true });
  });
  await delivered;
  assert.equal(insertParams[5], idempotency._internals.requestFingerprint(req, digest));
});

test('rejects idempotency keys on reads so the retention ledger only tracks mutations', async () => {
  const req = request({ 'idempotency-key': 'read-1' });
  req.method = 'GET';
  const { res, sent, delivered } = response();

  await idempotency({ database: { query: async () => assert.fail('must not query') } })(
    req,
    res,
    () => assert.fail('keyed read must not proceed'),
  );
  await delivered;
  assert.equal(sent[0].status, 400);
  assert.equal(sent[0].body.details.code, 'IDEMPOTENCY_METHOD_NOT_SUPPORTED');
});

test('renews a lease only for its current owner token', async () => {
  let call;
  const database = {
    async query(sql, params) {
      call = { sql: String(sql), params };
      return [{ affectedRows: 1 }, []];
    },
  };
  const owner = {
    actorType: 'efr', actorId: '8379', key: 'slow-1', leaseToken: 'owner-token',
  };

  assert.equal(await idempotency._internals.renewReservationLease(database, owner), true);
  assert.match(call.sql, /lease_expires_at = DATE_ADD\(NOW\(\), INTERVAL 5 MINUTE\)/i);
  assert.match(call.sql, /state = 'in_flight' AND lease_token = \?/i);
  assert.deepEqual(call.params, ['efr', '8379', 'slow-1', 'owner-token']);
});

test('fails closed when a new reservation cannot be confirmed', async () => {
  const database = {
    async query(sql) {
      if (/^\s*INSERT INTO tbl_idempotency_key/i.test(sql)) return [{ affectedRows: 0 }, []];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const { res, sent } = response();
  let reachedHandler = false;
  let receivedError;

  await idempotency({ database })(
    request({ 'idempotency-key': 'unconfirmed-reservation-1' }),
    res,
    (error) => {
      if (error) receivedError = error;
      else reachedHandler = true;
    },
  );

  assert.equal(reachedHandler, false);
  assert.equal(sent.length, 0);
  assert.equal(receivedError?.status, 503);
  assert.match(receivedError?.message || '', /reservation could not be confirmed/i);
});
