/*
 * Characterization tests for services/address.service — the shared tbl_address
 * probe + write helpers.
 *
 * These pin the DIVERGENCES the helper exists to keep explicit. tbl_address has
 * five writers that disagree on purpose, and the helper's options are the seam
 * that keeps each caller's behaviour intact. The load-bearing facts:
 *
 *   - is_instruction_added is pinned to literal 0 (2026-06-03 ops invariant),
 *     never derived from whether instruction text is present.
 *   - insertCustomerAddress drops address_instruction ENTIRELY on deploys
 *     without the column, rather than failing (degraded, not broken).
 *   - the COALESCE builder never blind-sets a column, so a field the customer
 *     didn't supply can't blank an existing value...
 *   - ...but it does NOT normalise, so '' still overwrites — the callers own
 *     that, because they deliberately disagree about it.
 *   - probe caching + probe-failure handling are per-caller options, because
 *     one write path degrades on probe failure and another aborts its txn.
 *
 * These take an injected executor, so the fake is handed over directly — no
 * monkeypatch. Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const addr = require('../services/address.service');

// Minimal executor stub: records calls, answers the catalog probe per `present`.
function makeExec({ present = true, throwOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (throwOn && throwOn.test(String(sql))) throw new Error('probe exploded');
      if (/INFORMATION_SCHEMA/i.test(String(sql))) return [present ? [{ n: 1 }] : [], []];
      return [{ insertId: 4242 }, []];
    },
  };
}

const probes = (exec) => exec.calls.filter((c) => /INFORMATION_SCHEMA/i.test(c.sql)).length;
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const columnsOf = (sql) => norm(sql).match(/\(([^)]*)\)/)[1].split(',').map((s) => s.trim());

// ─── insertCustomerAddress ───────────────────────────────────────────

const ADDR = {
  address: '12 MG Road', building: 'Tower A', landmark: 'Near Park', locality: 'Indiranagar',
  city_id: 5, pin_code: '560038', gps_location: '12.9716,77.5946',
  mobile_number: '9876543210', address_instruction: 'Ring the bell twice',
};

test('insertCustomerAddress — pins is_instruction_added to 0 even when text IS supplied', async () => {
  const exec = makeExec({ present: true });
  await addr.insertCustomerAddress(exec, 42, ADDR, { user_id: 77 });
  const ins = exec.calls.find((c) => /INSERT INTO tbl_address/.test(c.sql));
  const cols = columnsOf(ins.sql);
  const i = cols.indexOf('is_instruction_added');
  assert.ok(i >= 0, 'the flag column is written when the column exists');
  assert.equal(ins.params[i], 0, '2026-06-03 ops invariant: literal 0, NEVER derived from the text');
  // The text itself still persists — the flag is decoupled from it, not a proxy.
  assert.equal(ins.params[cols.indexOf('address_instruction')], 'Ring the bell twice');
});

test('insertCustomerAddress — drops address_instruction + flag on a deploy without the column', async () => {
  const exec = makeExec({ present: false });
  await addr.insertCustomerAddress(exec, 42, ADDR, { user_id: 77 });
  const ins = exec.calls.find((c) => /INSERT INTO tbl_address/.test(c.sql));
  assert.doesNotMatch(ins.sql, /address_instruction/, 'silently dropped, not an Unknown-column 500');
  assert.doesNotMatch(ins.sql, /is_instruction_added/, 'the flag goes with it');
  // Degraded, not broken: the rest of the address still lands.
  assert.ok(ins.params.includes('12 MG Road'));
  assert.ok(ins.params.includes('Indiranagar'), 'locality is an insert-only column and must persist');
});

test('insertCustomerAddress — writes locality + mobile_number (the columns update() cannot touch)', async () => {
  const exec = makeExec({ present: true });
  await addr.insertCustomerAddress(exec, 42, ADDR, { user_id: 77 });
  const ins = exec.calls.find((c) => /INSERT INTO tbl_address/.test(c.sql));
  const cols = columnsOf(ins.sql);
  assert.equal(ins.params[cols.indexOf('locality')], 'Indiranagar');
  assert.equal(ins.params[cols.indexOf('mobile_number')], '9876543210');
  assert.equal(ins.params[cols.indexOf('customer_id')], 42, 'customer-keyed, NOT user-keyed');
});

test('insertCustomerAddress — a probe failure degrades the INSERT, never aborts the create', async () => {
  const exec = makeExec({ throwOn: /INFORMATION_SCHEMA/i });
  const id = await addr.insertCustomerAddress(exec, 42, ADDR, { user_id: 77 });
  assert.equal(id, 4242, 'the create still completes');
  const ins = exec.calls.find((c) => /INSERT INTO tbl_address/.test(c.sql));
  assert.doesNotMatch(ins.sql, /address_instruction/, 'probe failure assumes absent');
});

test('insertCustomerAddress — re-probes per call (uncached), matching the pre-refactor write path', async () => {
  const exec = makeExec({ present: true });
  await addr.insertCustomerAddress(exec, 42, ADDR, { user_id: 1 });
  await addr.insertCustomerAddress(exec, 42, ADDR, { user_id: 1 });
  assert.equal(probes(exec), 2, 'a cached answer would go stale against a live column-adding deploy');
});

test('insertCustomerAddress — nulls optional fields and tolerates a missing actor', async () => {
  const exec = makeExec({ present: true });
  await addr.insertCustomerAddress(exec, 42, { address: 'Plot 9', city_id: 2, pin_code: '110001' }, undefined);
  const ins = exec.calls.find((c) => /INSERT INTO tbl_address/.test(c.sql));
  const cols = columnsOf(ins.sql);
  assert.equal(ins.params[cols.indexOf('building')], null);
  assert.equal(ins.params[cols.indexOf('created_by')], null, 'no actor → created_by NULL, not a crash');
});

// ─── buildCoalesceAddressUpdate ──────────────────────────────────────

test('buildCoalesceAddressUpdate — every customer field is COALESCE-guarded, never blind-set', () => {
  const w = addr.buildCoalesceAddressUpdate(10, { gps_location: '28.6315,77.2167' });
  assert.match(w.sql, /gps_location = COALESCE\(\?, gps_location\)/);
  assert.doesNotMatch(w.sql, /address\s*=\s*\?/, 'the booked address must never be blind-overwritten');
  // Unsupplied fields ride along as NULL so COALESCE keeps what's there.
  assert.deepEqual(w.params, [null, null, null, null, null, '28.6315,77.2167', 10]);
});

test('buildCoalesceAddressUpdate — address_id is the last bound param (the WHERE key)', () => {
  const w = addr.buildCoalesceAddressUpdate(99, { address: 'A' });
  assert.match(w.sql, /WHERE address_id = \?$/);
  assert.equal(w.params[w.params.length - 1], 99);
});

test('buildCoalesceAddressUpdate — omits the instruction SET when the column is absent', () => {
  const w = addr.buildCoalesceAddressUpdate(10, { address_instruction: 'Ring' }, { hasInstructionColumn: false });
  assert.doesNotMatch(w.sql, /address_instruction/);
  assert.doesNotMatch(w.sql, /is_instruction_added/);
  assert.ok(!w.params.includes('Ring'), 'the text is dropped, not silently bound to the wrong column');
});

test('buildCoalesceAddressUpdate — resetInstructionFlag clears a stale 1 with a BARE assignment', () => {
  const w = addr.buildCoalesceAddressUpdate(10, { address_instruction: 'Ring' },
    { hasInstructionColumn: true, resetInstructionFlag: true });
  assert.match(w.sql, /address_instruction = COALESCE\(\?, address_instruction\)/);
  // NOT COALESCE-guarded — a COALESCE(0, flag) would never clear an existing 1.
  assert.match(w.sql, /is_instruction_added = \?/);
  assert.doesNotMatch(w.sql, /is_instruction_added = COALESCE/);
  assert.equal(w.params[w.params.length - 2], 0, 'pinned to literal 0');
});

test('buildCoalesceAddressUpdate — no flag reset when the caller supplied no instruction text', () => {
  const w = addr.buildCoalesceAddressUpdate(10, { address: 'A' },
    { hasInstructionColumn: true, resetInstructionFlag: true });
  assert.match(w.sql, /address_instruction = COALESCE/, 'the column is still COALESCE-touched');
  assert.doesNotMatch(w.sql, /is_instruction_added/, 'but the flag is left alone entirely');
});

test('buildCoalesceAddressUpdate — the chat flow (no resetInstructionFlag) NEVER touches the flag', () => {
  const w = addr.buildCoalesceAddressUpdate(10, { address: 'A', address_instruction: 'Ring' },
    { hasInstructionColumn: true });
  assert.match(w.sql, /address_instruction = COALESCE/);
  assert.doesNotMatch(w.sql, /is_instruction_added/, 'this divergence from the form flow is deliberate');
});

test('buildCoalesceAddressUpdate — does NOT normalise: \'\' is passed through and WILL overwrite', () => {
  // COALESCE('', address) returns '' — empty string is not NULL. The callers
  // normalise (and deliberately disagree about `address`), so the builder must
  // not quietly "help" or it would change one of them.
  const w = addr.buildCoalesceAddressUpdate(10, { address: '' });
  assert.equal(w.params[0], '', 'passed through verbatim — normalisation is the caller\'s job');
});

// ─── hasAddressInstructionColumn ─────────────────────────────────────
// Ordering matters: the memo is process-wide, so the cache:false cases run
// first and the cache:true cases (which populate it) run last.

test('hasAddressInstructionColumn — cache:false re-probes every call and skips the memo', async () => {
  const exec = makeExec({ present: true });
  assert.equal(await addr.hasAddressInstructionColumn(exec, { cache: false }), true);
  assert.equal(await addr.hasAddressInstructionColumn(exec, { cache: false }), true);
  assert.equal(probes(exec), 2);
});

test('hasAddressInstructionColumn — an empty catalog result means absent', async () => {
  const exec = makeExec({ present: false });
  assert.equal(await addr.hasAddressInstructionColumn(exec, { cache: false }), false);
});

test('hasAddressInstructionColumn — onProbeError:assume-absent degrades to false', async () => {
  const exec = makeExec({ throwOn: /INFORMATION_SCHEMA/i });
  assert.equal(await addr.hasAddressInstructionColumn(exec, { cache: false, onProbeError: 'assume-absent' }), false);
});

test('hasAddressInstructionColumn — onProbeError:throw propagates, so a txn can roll back', async () => {
  const exec = makeExec({ throwOn: /INFORMATION_SCHEMA/i });
  await assert.rejects(
    () => addr.hasAddressInstructionColumn(exec, { cache: false, onProbeError: 'throw' }),
    /probe exploded/,
    'job.service update() relies on this to abort rather than drop instruction text',
  );
});

test('hasAddressInstructionColumn — cache:true probes once, then serves the memo', async () => {
  const first = makeExec({ present: true });
  assert.equal(await addr.hasAddressInstructionColumn(first, { cache: true }), true);
  assert.equal(probes(first), 1);
  // A second executor that would answer "absent" is never consulted.
  const second = makeExec({ present: false });
  assert.equal(await addr.hasAddressInstructionColumn(second, { cache: true }), true);
  assert.equal(probes(second), 0, 'served from the memo — no round-trip');
});

// ─── addressColumnSet ────────────────────────────────────────────────
// Also ordered: the failure case must run before the memo is populated.

test('addressColumnSet — a probe failure PROPAGATES and caches nothing', async () => {
  const exec = {
    async query() { throw new Error('catalog unavailable'); },
  };
  await assert.rejects(() => addr.addressColumnSet(exec), /catalog unavailable/,
    'an empty set would read as "no writable columns" and silently skip the write');
});

test('addressColumnSet — returns the live column set, then memoises it', async () => {
  let calls = 0;
  const exec = {
    async query() {
      calls++;
      return [[{ COLUMN_NAME: 'address_id' }, { COLUMN_NAME: 'user_id' }, { COLUMN_NAME: 'city1' }], []];
    },
  };
  const set = await addr.addressColumnSet(exec);
  assert.ok(set.has('city1'), 'resolves the city/city1 drift for the technician writer');
  assert.ok(set.has('user_id'), 'the polymorphic key');
  assert.equal(calls, 1);
  await addr.addressColumnSet(exec);
  assert.equal(calls, 1, 'memoised on success');
});
