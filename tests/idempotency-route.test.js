const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const idempotency = require('../middleware/idempotency');
const { modernOk } = require('../utils/response');

let ledger = null;
const database = {
  async query(sql, params) {
    const text = String(sql);
    if (/^\s*INSERT INTO tbl_idempotency_key/i.test(text)) {
      if (ledger) {
        const error = new Error('duplicate');
        error.code = 'ER_DUP_ENTRY';
        throw error;
      }
      ledger = {
        request_fingerprint: params[5],
        state: 'in_flight',
        response_status: null,
        response_json: null,
        retry_after_seconds: 300,
        leaseToken: params[6],
      };
      return [{ affectedRows: 1 }, []];
    }
    if (/^\s*SELECT request_fingerprint/i.test(text)) return [[ledger], []];
    if (/state = 'done'/i.test(text)) {
      assert.equal(params.at(-1), ledger.leaseToken);
      ledger = {
        ...ledger,
        response_status: params[0],
        response_json: params[1],
        state: 'done',
        retry_after_seconds: 0,
      };
      return [{ affectedRows: 1 }, []];
    }
    if (/^\s*DELETE FROM tbl_idempotency_key/i.test(text)) {
      ledger = null;
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`unexpected SQL: ${text}`);
  },
};

let server;
let baseUrl;
let executions = 0;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tech = { efr_id: 8379 }; next(); });
  app.use(idempotency({ database }));
  app.put('/work-area', (req, res) => {
    executions += 1;
    modernOk(res, { execution: executions, name: req.body.name });
  });
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function put() {
  return fetch(`${baseUrl}/work-area`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'integration-work-area-1',
    },
    body: JSON.stringify({ name: 'Ramesh' }),
  });
}

test('real Express delivery persists once and replays without executing the handler twice', async () => {
  ledger = null;
  executions = 0;
  const first = await put();
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('idempotent-replay'), null);
  assert.equal(firstBody.data.execution, 1);

  const replay = await put();
  const replayBody = await replay.json();
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  assert.equal(replayBody.data.execution, 1);
  assert.equal(executions, 1);
});
