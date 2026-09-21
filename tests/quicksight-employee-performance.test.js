/*
 * QuickSight — Employee Performance snapshot.
 *
 * The uploaded file is data.js: JavaScript by extension, executed in every
 * viewer's browser once injected into the dashboard page. So the guarantees
 * that matter, worst first:
 *
 *   1. ONLY DATA IS STORED. Anything that is not exactly `const D=<json>;`
 *      is refused, and what is stored is a re-serialisation, never the upload.
 *   2. NOTHING IN THE DATA CAN CLOSE THE <script> it is injected into, and no
 *      `$&`-style sequence in it is expanded by the injection.
 *   3. A ROUND TRIP (upload → meta → page) hands the page the same D.
 *
 * No S3, no DB: S3 is forced off before the service loads, so storage is a
 * throwaway directory.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

process.env.S3_BUCKET_NAME = '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-emp-perf-'));
process.env.QS_EMPLOYEE_PERFORMANCE_DIR = TMP;

const service = require('../services/quicksight/quicksight-employee-performance.service');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const sample = (over = {}) => ({
  employees: { 'Abhishek Yadav': { team: 'Thor', revenue: 28925, daily: [] } },
  verticals: ['Retail Maintenance'],
  months: ['2026-08', '2026-09'],
  dates: ['2026-08-01', '2026-08-02', '2026-09-13'],
  primarySpocs: ['Abhishek Yadav'],
  zonalManagers: ['Unassigned'],
  teamMembers: { Thor: ['Abhishek Yadav'] },
  displayNames: { 'Abhishek Yadav': 'Abhishek Yadav' },
  txRows: [],
  unassigned: [],
  zmBreakdown: [],
  ...over,
});
// Exactly what build_data.py writes.
const asDataJs = (d) => Buffer.from(`const D=${JSON.stringify(d)};\n`);

test('accepts the data.js build_data.py writes and summarises it', () => {
  const { data, summary } = service.parseDashboardData(asDataJs(sample()));
  assert.deepEqual(data, sample());
  assert.deepEqual(summary, { dateFrom: '2026-08-01', dateTo: '2026-09-13', employeeCount: 1, spocCount: 1 });
});

test('accepts the same file gzipped (what the CRM sends)', () => {
  const { summary } = service.parseDashboardData(zlib.gzipSync(asDataJs(sample())));
  assert.equal(summary.dateTo, '2026-09-13');
});

test('refuses anything that is not purely the data literal', () => {
  const bad = [
    Buffer.from(`const D=${JSON.stringify(sample())};alert(1);`),
    Buffer.from(`alert(1);const D=${JSON.stringify(sample())};`),
    Buffer.from('const D=(function(){return {}})();'),
    Buffer.from('<html></html>'),
    Buffer.from(''),
  ];
  for (const b of bad) {
    assert.throws(() => service.parseDashboardData(b), (e) => e.status === 400, b.toString().slice(0, 40));
  }
});

test('names the missing / malformed keys of a wrong JSON file', () => {
  const d = sample();
  delete d.employees;
  d.dates = 'not-an-array';
  assert.throws(() => service.parseDashboardData(asDataJs(d)),
    (e) => e.status === 400 && /employees/.test(e.message) && /dates/.test(e.message));
  assert.throws(() => service.parseDashboardData(asDataJs(sample({ dates: ['13/09/2026'] }))),
    (e) => e.status === 400 && /dates/.test(e.message));
  assert.throws(() => service.parseDashboardData(asDataJs(sample({ employees: {} }))),
    (e) => e.status === 400 && /no employees/.test(e.message));
});

test('rejects malformed rows at upload instead of failing every read later', () => {
  const rejects = (over, pattern) => assert.throws(
    () => service.parseDashboardData(asDataJs(sample(over))),
    (e) => e.status === 400 && pattern.test(e.message),
    pattern.source,
  );
  const emp = (fields) => ({ employees: { 'Abhishek Yadav': { team: 'Thor', ...fields } } });

  rejects(emp({ daily: [{ date: '2026-08-01' }, null] }), /employee "Abhishek Yadav" daily row 2 is not an object/);
  rejects(emp({ openRows: ['JOB1'] }), /openRows row 1 is not an object/);
  rejects(emp({ byZm: { Ravi: { clients: [7] } } }), /byZm "Ravi" clients row 1/);
  rejects(emp({ byZm: { Ravi: 'x' } }), /byZm "Ravi" is not an object/);
  rejects(emp({ vertical: 5 }), /vertical is not text/);
  rejects({ employees: { A: null } }, /employee "A" is not an object/);
  rejects({ teamMembers: { Thor: 'Abhishek Yadav' } }, /teamMembers "Thor" must be a list of names/);
  rejects({ txRows: [{}, 3] }, /txRows row 2/);
  rejects({ primarySpocs: [{ name: 'x' }] }, /primarySpocs must list names only/);

  // Many problems (one per list): the first five, then a count.
  const many = emp(Object.fromEntries(
    ['daily', 'clients', 'tatSda', 'productivity', 'cityWise', 'pendingReasons', 'openRows'].map((k) => [k, [null]]),
  ));
  rejects(many, /daily row 1 is not an object; .*\(and 2 more\)$/);

  // Positive control: lists that are absent, null or well-formed pass, as
  // aggregate.js reads them through list().
  assert.doesNotThrow(() => service.parseDashboardData(asDataJs(sample(emp({
    daily: [{ date: '2026-08-01', target: 1 }], clients: null, byZm: { Ravi: { openRows: [{ aging: 3 }] } },
  })))));
});

test('round trip: upload → meta → the stored D, script-safe', async () => {
  assert.equal(await service.getMeta(), null, 'nothing uploaded yet');
  assert.equal(await service.getSnapshotD(), null);

  const hostile = sample({
    employees: { 'X</script><script>alert(1)</script>': { team: '$& $1 $`', revenue: 1, daily: [] } },
  });
  const meta = await service.saveSnapshot({
    buffer: asDataJs(hostile),
    originalName: 'data.js',
    user: { user_id: 7, user_name: 'MIS User' },
  });
  assert.equal(meta.employeeCount, 1);
  assert.deepEqual(meta.uploadedBy, { userId: 7, name: 'MIS User' });
  assert.deepEqual(await service.getMeta(), meta);

  const stored = zlib.gunzipSync(fs.readFileSync(path.join(TMP, meta.dataKey))).toString('utf8');
  assert.equal(stored.includes('</script>'), false, 'no string can close a <script>');
  assert.deepEqual(JSON.parse(stored), hostile, 'D is stored unchanged');
  assert.deepEqual(await service.getSnapshotD(), hostile);
});
