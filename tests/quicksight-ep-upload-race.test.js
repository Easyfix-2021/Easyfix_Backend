/*
 * QuickSight Employee Performance — two overlapping uploads.
 *
 * S3 is stubbed so the two writes of each upload can interleave the way they
 * do against real S3: A data, B data, B meta, A meta. Before each upload had
 * its own data object, meta ended up saying A while the object held B, and the
 * instance that took A served A from its cache while every other one served B.
 * The contract: whatever meta says is what every reader gets, and the object
 * it names is never tagged for expiry.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// [data write, meta write] delays per uploader, chosen to force the interleave.
const DELAY = { A: [5, 60], B: [20, 5] };
const store = new Map();
const tagged = new Set();
let dataWrites = 0;

const s3Path = require.resolve('../utils/s3-storage.js');
require.cache[s3Path] = {
  id: s3Path, filename: s3Path, loaded: true,
  exports: {
    isEnabled: () => true,
    async putAtKey({ key, buffer }) {
      const isMeta = key.endsWith('meta.json');
      const who = isMeta ? JSON.parse(buffer).uploadedBy.name : (dataWrites++ === 0 ? 'A' : 'B');
      await new Promise((r) => setTimeout(r, DELAY[who][isMeta ? 1 : 0]));
      store.set(key, buffer);
    },
    getObjectBuffer: async (key) => store.get(key) ?? null,
    async tagObject(key, tags) {
      assert.deepEqual(tags, { superseded: 'true' });
      tagged.add(key);
    },
  },
};

const service = require('../services/quicksight/quicksight-employee-performance.service');

const dataJs = (date) => Buffer.from(`const D=${JSON.stringify({
  employees: { Asha: { vertical: 'V' } }, verticals: ['V'], months: [date.slice(0, 7)], dates: [date],
  primarySpocs: ['Asha'], zonalManagers: [], teamMembers: {}, displayNames: {},
  txRows: [], unassigned: [], zmBreakdown: [],
})};`);

test('overlapping uploads: meta, this instance and a fresh instance all agree', async () => {
  const a = service.saveSnapshot({ buffer: dataJs('2026-08-01'), originalName: 'data.js', user: { user_id: 1, user_name: 'A' } });
  const b = service.saveSnapshot({ buffer: dataJs('2026-09-01'), originalName: 'data.js', user: { user_id: 2, user_name: 'B' } });
  await Promise.all([a, b]);

  const meta = await service.getMeta();
  // Positive control: the stub really produced the interleave (A's meta landed last).
  assert.equal(meta.uploadedBy.name, 'A', 'A meta written last');
  assert.equal(dataWrites, 2);

  assert.equal((await service.getSnapshotD()).dates[0], meta.dateFrom, 'this instance serves what meta says');
  const live = `QuickSight/EmployeePerformance/${meta.dataKey}`;
  assert.ok(store.has(live), 'meta names a stored object');
  assert.equal(tagged.has(live), false, 'the live object is never marked superseded');

  // A second instance: same storage, empty cache.
  delete require.cache[require.resolve('../services/quicksight/quicksight-employee-performance.service')];
  const other = require('../services/quicksight/quicksight-employee-performance.service');
  assert.equal((await other.getSnapshotD()).dates[0], meta.dateFrom, 'another instance serves what meta says');
});

test('a later upload marks the one it replaced superseded, and only that one', async () => {
  const before = await service.getMeta();
  tagged.clear();
  dataWrites = 1;   // any delay entry: this upload runs alone
  const meta = await service.saveSnapshot({ buffer: dataJs('2026-10-01'), originalName: 'data.js', user: { user_id: 2, user_name: 'B' } });
  assert.deepEqual([...tagged], [`QuickSight/EmployeePerformance/${before.dataKey}`]);
  assert.notEqual(before.dataKey, meta.dataKey);
});
