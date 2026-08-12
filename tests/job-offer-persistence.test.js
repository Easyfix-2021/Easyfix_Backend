const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OFFER_STATUS } = require('../services/offer-status');
const {
  MAX_OFFER_RECIPIENTS,
  persistJobOfferBatch,
} = require('../services/job-offer-persistence.service');

function makeConnection(latestRows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^SELECT jo\.fk_easyfixter_id/i.test(sql.trim())) return [latestRows, []];
      return [{ affectedRows: 0 }, []];
    },
  };
}

function callsMatching(conn, pattern) {
  return conn.calls.filter(({ sql }) => pattern.test(sql));
}

test('all-new recipients use one latest-row read and one multi-row INSERT', async () => {
  const conn = makeConnection();

  const offeredIds = await persistJobOfferBatch(conn, {
    jobId: '700',
    efrIds: [11, 12, 13],
    source: 'search',
    offeredBy: 91,
  });

  assert.deepEqual(offeredIds, [11, 12, 13]);
  assert.equal(conn.calls.length, 2);
  assert.equal(callsMatching(conn, /^\s*INSERT INTO tbl_job_offer/i).length, 1);
  const insert = conn.calls[1];
  assert.equal((insert.sql.match(/\(\?, \?, \?, NOW\(\), NOW\(\), NOW\(\), 1, \?, \?\)/g) || []).length, 3);
  assert.deepEqual(insert.params, [
    700, 11, OFFER_STATUS.OFFERED, 'search', 91,
    700, 12, OFFER_STATUS.OFFERED, 'search', 91,
    700, 13, OFFER_STATUS.OFFERED, 'search', 91,
  ]);
});

test('mixed existing and new recipients use one bulk statement per operation', async () => {
  const conn = makeConnection([
    { fk_easyfixter_id: 11, latest_job_offer_id: 501 },
    { fk_easyfixter_id: 13, latest_job_offer_id: 503 },
  ]);

  await persistJobOfferBatch(conn, {
    jobId: 700,
    efrIds: [11, 12, 13],
  });

  assert.equal(conn.calls.length, 4, 'SELECT + reopen + duplicate expiry + INSERT');
  assert.equal(callsMatching(conn, /^\s*UPDATE tbl_job_offer/i).length, 2);
  assert.equal(callsMatching(conn, /^\s*INSERT INTO tbl_job_offer/i).length, 1);
  const insert = conn.calls.find(({ sql }) => /^\s*INSERT INTO tbl_job_offer/i.test(sql));
  assert.deepEqual(insert.params, [700, 12, OFFER_STATUS.OFFERED, null, null]);
});

test('bulk reopen refreshes counters and clears response fields; one cleanup expires older open rows', async () => {
  const conn = makeConnection([
    { fk_easyfixter_id: 11, latest_job_offer_id: 501 },
    { fk_easyfixter_id: 13, latest_job_offer_id: 503 },
  ]);

  await persistJobOfferBatch(conn, {
    jobId: 700,
    efrIds: [11, 13],
  });

  assert.equal(conn.calls.length, 3);
  const [, reopen, expire] = conn.calls;
  assert.match(reopen.sql, /offer_count = offer_count \+ 1/);
  assert.match(reopen.sql, /offered_at = NOW\(\)/);
  assert.match(reopen.sql, /updated_on = NOW\(\)/);
  assert.match(reopen.sql, /responded_at = NULL/);
  assert.match(reopen.sql, /reject_reason = NULL/);
  assert.match(reopen.sql, /reject_reason_id = NULL/);
  assert.deepEqual(reopen.params, [
    OFFER_STATUS.OFFERED,
    501, null,
    503, null,
    null,
    501, 503,
  ]);

  assert.match(expire.sql, /offer_status = \?, responded_at = NOW\(\)/);
  assert.match(expire.sql, /job_offer_id NOT IN \(\?, \?\)/);
  assert.deepEqual(expire.params, [
    OFFER_STATUS.EXPIRED,
    700,
    11, 13,
    OFFER_STATUS.OFFERED,
    501, 503,
  ]);
});

test('per-technician source overrides the fallback for both reopen and insert', async () => {
  const conn = makeConnection([
    { fk_easyfixter_id: 11, latest_job_offer_id: 501 },
  ]);

  await persistJobOfferBatch(conn, {
    jobId: 700,
    efrIds: [11, 12],
    source: 'auto',
    sourceByEfr: { 11: 'search', 12: 'top10' },
    offeredBy: 91,
  });

  const reopen = conn.calls.find(({ sql }) => /SET offer_status/.test(sql));
  const insert = conn.calls.find(({ sql }) => /^\s*INSERT INTO tbl_job_offer/i.test(sql));
  assert.deepEqual(reopen.params, [
    OFFER_STATUS.OFFERED,
    501, 'search',
    91,
    501,
  ]);
  assert.deepEqual(insert.params, [700, 12, OFFER_STATUS.OFFERED, 'top10', 91]);
  assert.match(reopen.sql, /offer_source = COALESCE/);
  assert.match(reopen.sql, /offered_by_user_id = COALESCE/);
});

test('a mixed 50-recipient batch stays at four SQL statements', async () => {
  const ids = Array.from({ length: MAX_OFFER_RECIPIENTS }, (_, index) => index + 1);
  const latestRows = ids.slice(0, 25).map((efrId) => ({
    fk_easyfixter_id: efrId,
    latest_job_offer_id: 1000 + efrId,
  }));
  const conn = makeConnection(latestRows);

  const offeredIds = await persistJobOfferBatch(conn, {
    jobId: 700,
    efrIds: ids,
    source: 'top10',
  });

  assert.deepEqual(offeredIds, ids);
  assert.equal(conn.calls.length, 4, 'query count must not grow with recipient count');
  const reopen = conn.calls.find(({ sql }) => /SET offer_status/.test(sql));
  const insert = conn.calls.find(({ sql }) => /^\s*INSERT INTO tbl_job_offer/i.test(sql));
  assert.equal((reopen.sql.match(/WHEN \? THEN \?/g) || []).length, 25);
  assert.equal((insert.sql.match(/\(\?, \?, \?, NOW\(\), NOW\(\), NOW\(\), 1, \?, \?\)/g) || []).length, 25);
});

test('more than 50 recipients is rejected before any SQL', async () => {
  const conn = makeConnection();
  const ids = Array.from({ length: MAX_OFFER_RECIPIENTS + 1 }, (_, index) => index + 1);

  await assert.rejects(
    () => persistJobOfferBatch(conn, { jobId: 700, efrIds: ids }),
    (error) => error.status === 400 && error.code === 'TOO_MANY_OFFER_RECIPIENTS',
  );
  assert.equal(conn.calls.length, 0);
});
